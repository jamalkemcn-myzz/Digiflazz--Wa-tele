import crypto from 'node:crypto';
import { getDb, withTransaction } from '../database/connection';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import { resolveEffectiveMargin, selectAvailableUniqueCode, computeFinalPaymentAmount, type MarginRule, type MarginType } from '../domain/pricing';
import {
  ACTIVE_CUSTOMER_TRANSACTION_STATUSES,
  canTransitionTransaction,
  shouldTriggerCooldown,
  type PaymentStatus,
  type SupplierStatus,
  type TransactionStatus,
} from '../domain/state-machine';
import { maskDestination } from '../domain/masking';
import { resolveOrCreateCustomer, findCustomerByPlatform, type CustomerPlatform } from './customer.service';
import { getGlobalMarginRule, getProductBySkuOrId } from './product.service';
import { validateAndClaimCouponInTx, previewCouponReadOnly } from './coupon.service';
import { isMaintenanceMode } from './settings.service';
import { emitTransactionLogToGroups, notifyCustomerForTransaction } from './notification.service';
import { processAutomaticRefund } from './refund.service';
import { defaultPaymentGateway, type PaymentGatewayPort } from '../integrations/myzzstore.gateway';
import { digiflazzService, type DigiflazzService } from '../integrations/digiflazz.service';

export interface TransactionRow {
  id: number;
  transaction_id: string;
  idempotency_key: string | null;
  customer_id: number;
  platform: CustomerPlatform;
  product_id: number;
  product_sku_snapshot: string;
  product_name_snapshot: string;
  supplier_price_snapshot: number;
  margin_snapshot: number;
  coupon_code_snapshot: string | null;
  discount_snapshot: number;
  unique_code: number;
  payment_amount: number;
  payment_method: string;
  payment_status: PaymentStatus;
  supplier_status: SupplierStatus;
  transaction_status: TransactionStatus;
  gateway_reference: string | null;
  qris_payload_json: string | null;
  qr_message_ref_json: string | null;
  supplier_reference: string | null;
  supplier_sn: string | null;
  supplier_message: string | null;
  destination: string;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  paid_at: string | null;
  completed_at: string | null;
}

export interface CreateOrderInput {
  platform: CustomerPlatform;
  platformUserId: string;
  platformUsername?: string | null;
  productSkuOrId: string | number;
  destination: string;
  couponCode?: string | null;
  idempotencyKey?: string | null;
}

export interface CreateOrderResult {
  ok: boolean;
  code?:
    | 'MAINTENANCE_ACTIVE'
    | 'COOLDOWN_ACTIVE'
    | 'ACTIVE_INVOICE_EXISTS'
    | 'PRODUCT_UNAVAILABLE'
    | 'COUPON_INVALID'
    | 'GATEWAY_UNCONFIGURED'
    | 'GATEWAY_ERROR'
    | 'VALIDATION_ERROR';
  errorMessage?: string;
  cooldownRemainingSeconds?: number;
  transaction?: TransactionRow;
  activeInvoice?: TransactionRow;
  qris?: {
    qrString?: string;
    qrUrl?: string;
  };
}

function generateTransactionId(): string {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TRX-${datePart}-${randPart}`;
}

export function resolveGatewayReference(tx: Pick<TransactionRow, 'gateway_reference' | 'qris_payload_json'>): string | null {
  const direct = tx.gateway_reference?.trim();
  if (direct) return direct;
  if (!tx.qris_payload_json) return null;
  try {
    const parsed = JSON.parse(tx.qris_payload_json) as Record<string, unknown>;
    const candidate = parsed.trxId ?? parsed.trx_id ?? parsed.gatewayReference ?? parsed.orderId ?? parsed.order_id;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  } catch {
    // ignore malformed json
  }
  return null;
}

export function persistGatewayReferenceIfMissing(transactionId: string, gatewayReference?: string | null): void {
  const ref = gatewayReference?.trim();
  if (!ref) return;
  const db = getDb();
  db.prepare(
    `UPDATE transactions
     SET gateway_reference = ?, updated_at = ?
     WHERE transaction_id = ?
       AND (gateway_reference IS NULL OR TRIM(gateway_reference) = '')`
  ).run(ref, new Date().toISOString(), transactionId);
}

export function setCustomerCooldown(customerId: number, reason: string, transactionId?: string): void {
  if (config.transaction.cooldownSeconds <= 0) return;
  const db = getDb();
  const now = new Date();
  const untilAt = new Date(now.getTime() + config.transaction.cooldownSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO cooldowns (customer_id, until_at, reason, transaction_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET until_at = excluded.until_at, reason = excluded.reason, transaction_id = excluded.transaction_id, updated_at = excluded.updated_at`
  ).run(customerId, untilAt, reason, transactionId ?? null, now.toISOString());
}

export function transitionTransactionStatus(
  transactionId: string,
  newStatus: TransactionStatus,
  source: string,
  description: string,
  updates?: {
    paymentStatus?: PaymentStatus;
    supplierStatus?: SupplierStatus;
    gatewayReference?: string | null;
    qrisPayloadJson?: string | null;
    supplierReference?: string | null;
    supplierSn?: string | null;
    supplierMessage?: string | null;
    paidAt?: string | null;
    completedAt?: string | null;
  }
): TransactionRow {
  return withTransaction((txDb) => {
    const tx = txDb
      .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
      .get(transactionId) as TransactionRow | undefined;

    if (!tx) throw new Error(`Transaksi ${transactionId} tidak ditemukan`);
    if (!canTransitionTransaction(tx.transaction_status, newStatus)) {
      throw new Error(`Transisi status tidak valid: ${tx.transaction_status} -> ${newStatus}`);
    }

    const now = new Date().toISOString();
    txDb
      .prepare(
        `UPDATE transactions
         SET transaction_status = ?,
             payment_status = COALESCE(?, payment_status),
             supplier_status = COALESCE(?, supplier_status),
             gateway_reference = COALESCE(?, gateway_reference),
             qris_payload_json = COALESCE(?, qris_payload_json),
             supplier_reference = COALESCE(?, supplier_reference),
             supplier_sn = COALESCE(?, supplier_sn),
             supplier_message = COALESCE(?, supplier_message),
             paid_at = COALESCE(?, paid_at),
             completed_at = COALESCE(?, completed_at),
             updated_at = ?
         WHERE transaction_id = ?`
      )
      .run(
        newStatus,
        updates?.paymentStatus ?? null,
        updates?.supplierStatus ?? null,
        updates?.gatewayReference ?? null,
        updates?.qrisPayloadJson ?? null,
        updates?.supplierReference ?? null,
        updates?.supplierSn ?? null,
        updates?.supplierMessage ?? null,
        updates?.paidAt ?? null,
        updates?.completedAt ?? null,
        now,
        transactionId
      );

    txDb
      .prepare(
        `INSERT INTO transaction_status_history (transaction_id, old_status, new_status, source, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(transactionId, tx.transaction_status, newStatus, source, description, now);

    return txDb.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) as TransactionRow;
  });
}

export async function createOrder(
  input: CreateOrderInput,
  gateway: PaymentGatewayPort = defaultPaymentGateway
): Promise<CreateOrderResult> {
  if (isMaintenanceMode()) {
    return {
      ok: false,
      code: 'MAINTENANCE_ACTIVE',
      errorMessage:
        'Sistem sedang dalam mode pemeliharaan (maintenance). Pembuatan pesanan baru sementara dihentikan; transaksi yang sedang berjalan tetap diproses.',
    };
  }

  const destination = input.destination.trim();
  if (!destination || destination.length < 4 || destination.length > 40) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      errorMessage: 'Nomor tujuan / ID pelanggan produk tidak valid',
    };
  }

  if (!gateway.isConfigured()) {
    return {
      ok: false,
      code: 'GATEWAY_UNCONFIGURED',
      errorMessage: `Payment Gateway MyZZStore belum siap (${gateway.getMissingConfiguration().join(', ')})`,
    };
  }

  const { customer } = resolveOrCreateCustomer({
    platform: input.platform,
    platformUserId: input.platformUserId,
    platformUsername: input.platformUsername,
  });

  const db = getDb();

  // Check idempotency key first
  if (input.idempotencyKey) {
    const existingByIdem = db
      .prepare('SELECT * FROM transactions WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as TransactionRow | undefined;
    if (existingByIdem) {
      const parsedQris = existingByIdem.qris_payload_json
        ? (JSON.parse(existingByIdem.qris_payload_json) as { qrString?: string; qrUrl?: string })
        : undefined;
      return {
        ok: true,
        transaction: existingByIdem,
        qris: parsedQris,
      };
    }
  }

  // Validate product availability
  const product = getProductBySkuOrId(input.productSkuOrId);
  if (!product || product.status !== 'ACTIVE' || product.is_available !== 1) {
    return {
      ok: false,
      code: 'PRODUCT_UNAVAILABLE',
      errorMessage: 'Produk tidak ditemukan atau sedang nonaktif',
    };
  }

  let createdTx: TransactionRow;
  let earlyReject: CreateOrderResult | null = null;

  try {
    createdTx = withTransaction((txDb) => {
      // 1. Check active invoice (Anti-Double-Order)
      const activeList = Array.from(ACTIVE_CUSTOMER_TRANSACTION_STATUSES);
      const placeholders = activeList.map(() => '?').join(',');
      const activeTx = txDb
        .prepare(
          `SELECT * FROM transactions
           WHERE customer_id = ? AND transaction_status IN (${placeholders})
           ORDER BY id DESC LIMIT 1`
        )
        .get(customer.id, ...activeList) as TransactionRow | undefined;

      if (activeTx) {
        earlyReject = {
          ok: false,
          code: 'ACTIVE_INVOICE_EXISTS',
          errorMessage: `Anda masih memiliki transaksi aktif (${activeTx.transaction_id} - ${activeTx.transaction_status}). Selesaikan atau cek status terlebih dahulu.`,
          activeInvoice: activeTx,
        };
        throw new Error('__EARLY_REJECT__');
      }

      // 2. Check 30s cooldown
      const cooldown = txDb
        .prepare('SELECT until_at, reason FROM cooldowns WHERE customer_id = ?')
        .get(customer.id) as { until_at: string; reason: string } | undefined;

      if (cooldown) {
        const remainingMs = new Date(cooldown.until_at).getTime() - Date.now();
        if (remainingMs > 0) {
          const remainingSec = Math.ceil(remainingMs / 1000);
          earlyReject = {
            ok: false,
            code: 'COOLDOWN_ACTIVE',
            cooldownRemainingSeconds: remainingSec,
            errorMessage: `Harap tunggu ${remainingSec} detik sebelum membuat invoice baru.`,
          };
          throw new Error('__EARLY_REJECT__');
        }
      }

      // 3. Recompute official price + margin in backend
      const globalMargin = getGlobalMarginRule();
      let categoryMargin: MarginRule | null = null;
      if (product.category_id) {
        const cat = txDb
          .prepare('SELECT margin_type, margin_value, max_margin FROM categories WHERE id = ?')
          .get(product.category_id) as
          | { margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
          | undefined;
        if (cat?.margin_type && cat.margin_value !== null) {
          categoryMargin = { type: cat.margin_type, value: cat.margin_value, maxMargin: cat.max_margin };
        }
      }
      const productMargin: MarginRule | null =
        product.margin_type && product.margin_value !== null
          ? { type: product.margin_type, value: product.margin_value, maxMargin: product.max_margin }
          : null;

      const marginCalc = resolveEffectiveMargin({
        supplierPrice: product.supplier_price,
        productMargin,
        categoryMargin,
        globalMargin,
      });

      const transactionId = generateTransactionId();

      // 4. Validate and claim coupon atomically if provided
      let couponCodeSnapshot: string | null = null;
      let discountAmount = 0;
      if (input.couponCode && input.couponCode.trim()) {
        try {
          const claimed = validateAndClaimCouponInTx(txDb, {
            code: input.couponCode.trim(),
            customerId: customer.id,
            transactionId,
            sellingPrice: marginCalc.sellingPrice,
            productId: product.id,
            categoryId: product.category_id,
          });
          couponCodeSnapshot = claimed.couponCode;
          discountAmount = claimed.discountAmount;
        } catch (couponErr) {
          earlyReject = {
            ok: false,
            code: 'COUPON_INVALID',
            errorMessage: couponErr instanceof Error ? couponErr.message : 'Kupon tidak valid',
          };
          throw new Error('__EARLY_REJECT__');
        }
      }

      // 5. Select collision-free unique code 1..99
      const activeAmountRows = txDb
        .prepare(
          `SELECT payment_amount FROM transactions
           WHERE transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING')`
        )
        .all() as Array<{ payment_amount: number }>;
      const activeAmounts = new Set(activeAmountRows.map((r) => r.payment_amount));

      const baseAfterDiscount = Math.max(0, marginCalc.sellingPrice - discountAmount);
      const uniqueCode = selectAvailableUniqueCode(
        baseAfterDiscount,
        activeAmounts,
        config.transaction.uniqueCodeMin,
        config.transaction.uniqueCodeMax
      );
      const paymentAmount = computeFinalPaymentAmount(marginCalc.sellingPrice, discountAmount, uniqueCode);

      const now = new Date();
      const expiredAt = new Date(now.getTime() + config.transaction.invoiceExpiryMinutes * 60 * 1000).toISOString();
      const nowIso = now.toISOString();

      txDb
        .prepare(
          `INSERT INTO transactions (
            transaction_id, idempotency_key, customer_id, platform, product_id,
            product_sku_snapshot, product_name_snapshot, supplier_price_snapshot, margin_snapshot,
            coupon_code_snapshot, discount_snapshot, unique_code, payment_amount,
            payment_method, payment_status, supplier_status, transaction_status,
            destination, created_at, updated_at, expired_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QRIS', 'CREATED', 'NONE', 'CREATED', ?, ?, ?, ?)`
        )
        .run(
          transactionId,
          input.idempotencyKey ?? null,
          customer.id,
          input.platform,
          product.id,
          product.sku,
          product.name,
          product.supplier_price,
          marginCalc.marginAmount,
          couponCodeSnapshot,
          discountAmount,
          uniqueCode,
          paymentAmount,
          destination,
          nowIso,
          nowIso,
          expiredAt
        );

      txDb
        .prepare(
          `INSERT INTO transaction_status_history (transaction_id, old_status, new_status, source, description, created_at)
           VALUES (?, NULL, 'CREATED', ?, 'Order dibuat dan menunggu pembuatan invoice QRIS', ?)`
        )
        .run(transactionId, input.platform, nowIso);

      return txDb
        .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
        .get(transactionId) as TransactionRow;
    }, db);
  } catch (err) {
    if (earlyReject) return earlyReject;
    const msg = err instanceof Error ? err.message : 'Gagal membuat transaksi';
    if (msg.includes('idx_one_active_tx_per_customer')) {
      return {
        ok: false,
        code: 'ACTIVE_INVOICE_EXISTS',
        errorMessage: 'Anda sudah memiliki invoice aktif yang sedang diproses.',
      };
    }
    throw err;
  }

  // 6. Request official QRIS invoice from MyZZStore outside DB transaction lock
  const callbackUrl = `${config.appUrl}/api/webhooks/myzzstore`;
  const gwRes = await gateway.createPayment({
    transactionId: createdTx.transaction_id,
    amount: createdTx.payment_amount,
    productName: createdTx.product_name_snapshot,
    customerCode: customer.customer_code,
    expiredAt: createdTx.expired_at!,
    callbackUrl,
  });

  if (!gwRes.ok) {
    if (gwRes.mappedStatus === 'UNKNOWN' || gwRes.errorCode === 'GATEWAY_TIMEOUT') {
      const unknownTx = transitionTransactionStatus(
        createdTx.transaction_id,
        'UNKNOWN',
        'PAYMENT_GATEWAY',
        `Hasil pembuatan invoice belum pasti: ${gwRes.errorMessage}`,
        { paymentStatus: 'UNKNOWN' }
      );
      return {
        ok: false,
        code: 'GATEWAY_ERROR',
        errorMessage: 'Status pembuatan invoice belum pasti karena timeout gateway. Sistem akan melakukan rekonsiliasi otomatis.',
        transaction: unknownTx,
      };
    }

    const failedTx = transitionTransactionStatus(
      createdTx.transaction_id,
      'FAILED',
      'PAYMENT_GATEWAY',
      `Gagal membuat invoice gateway: ${gwRes.errorMessage}`,
      { paymentStatus: 'FAILED', completedAt: new Date().toISOString() }
    );
    if (shouldTriggerCooldown('FAILED')) {
      setCustomerCooldown(customer.id, 'INVOICE_CREATION_FAILED', createdTx.transaction_id);
    }
    return {
      ok: false,
      code: gwRes.errorCode === 'INTEGRATION_NOT_CONFIGURED' ? 'GATEWAY_UNCONFIGURED' : 'GATEWAY_ERROR',
      errorMessage: gwRes.errorMessage || 'Gagal membuat invoice QRIS pada gateway',
      transaction: failedTx,
    };
  }

  const gatewayRef = gwRes.gatewayReference?.trim() || null;
  const qrisPayload = {
    trxId: gatewayRef,
    qrString: gwRes.qrString,
    qrUrl: gwRes.qrUrl,
  };

  const pendingTx = transitionTransactionStatus(
    createdTx.transaction_id,
    'PENDING_PAYMENT',
    'PAYMENT_GATEWAY',
    'Invoice QRIS MyZZStore berhasil dibuat',
    {
      paymentStatus: 'PENDING',
      gatewayReference: gatewayRef,
      qrisPayloadJson: JSON.stringify(qrisPayload),
    }
  );

  emitTransactionLogToGroups({
    eventKey: 'created',
    transactionId: pendingTx.transaction_id,
    customerCode: customer.customer_code,
    productName: pendingTx.product_name_snapshot,
    amount: pendingTx.payment_amount,
    status: pendingTx.transaction_status,
    note: `Invoice QRIS dibuat (Ref: ${pendingTx.gateway_reference || '-'})`,
  });

  return {
    ok: true,
    transaction: pendingTx,
    qris: {
      qrString: gwRes.qrString,
      qrUrl: gwRes.qrUrl,
    },
  };
}

export function saveQrMessageReference(transactionId: string, ref: { platform: 'WHATSAPP' | 'TELEGRAM'; chatId: string; messageId: string | number | Record<string, unknown> }): void {
  const db = getDb();
  const tx = db.prepare('SELECT qr_message_ref_json FROM transactions WHERE transaction_id = ?').get(transactionId) as
    | { qr_message_ref_json: string | null }
    | undefined;
  const list = tx?.qr_message_ref_json ? (JSON.parse(tx.qr_message_ref_json) as unknown[]) : [];
  list.push(ref);
  db.prepare('UPDATE transactions SET qr_message_ref_json = ?, updated_at = ? WHERE transaction_id = ?').run(
    JSON.stringify(list),
    new Date().toISOString(),
    transactionId
  );
}

export function handleVerifiedPaymentPaid(
  transactionId: string,
  source: string,
  paidAt?: string,
  gatewayReference?: string
): { alreadyProcessed: boolean; transaction: TransactionRow } {
  const result = withTransaction((txDb) => {
    const tx = txDb
      .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
      .get(transactionId) as TransactionRow | undefined;

    if (!tx) {
      throw new Error(`Transaksi ${transactionId} tidak ditemukan`);
    }

    if (
      tx.payment_status === 'PAID' ||
      ['PAID', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING', 'SUCCESS', 'REFUNDED'].includes(
        tx.transaction_status
      )
    ) {
      // Ensure supplier job exists idempotently if somehow missing
      const now = new Date().toISOString();
      txDb
        .prepare(
          `INSERT OR IGNORE INTO supplier_jobs (transaction_id, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, 'PENDING', 0, ?, ?, ?)`
        )
        .run(transactionId, now, now, now);
      return { alreadyProcessed: true, transaction: tx };
    }

    const now = new Date().toISOString();
    const effectivePaidAt = paidAt || now;

    txDb
      .prepare(
        `UPDATE transactions
         SET payment_status = 'PAID',
             transaction_status = 'PAID_PROCESSING',
             gateway_reference = COALESCE(NULLIF(TRIM(?), ''), gateway_reference),
             paid_at = ?,
             updated_at = ?
         WHERE transaction_id = ?`
      )
      .run(gatewayReference ?? null, effectivePaidAt, now, transactionId);

    txDb
      .prepare(
        `INSERT INTO transaction_status_history (transaction_id, old_status, new_status, source, description, created_at)
         VALUES (?, ?, 'PAID_PROCESSING', ?, 'Pembayaran terverifikasi lunas; pekerjaan supplier dijadwalkan', ?)`
      )
      .run(transactionId, tx.transaction_status, source, now);

    // Single idempotent supplier job per transaction_id
    txDb
      .prepare(
        `INSERT OR IGNORE INTO supplier_jobs (transaction_id, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, 'PENDING', 0, ?, ?, ?)`
      )
      .run(transactionId, now, now, now);

    const updated = txDb
      .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
      .get(transactionId) as TransactionRow;

    return { alreadyProcessed: false, transaction: updated };
  });

  if (!result.alreadyProcessed) {
    const db = getDb();
    const cus = db
      .prepare('SELECT customer_code FROM customers WHERE id = ?')
      .get(result.transaction.customer_id) as { customer_code: string };

    notifyCustomerForTransaction({
      transactionId,
      customerId: result.transaction.customer_id,
      eventKey: 'paid',
      messageType: 'PAYMENT_VERIFIED',
      text:
        `Pembayaran untuk transaksi ${transactionId} (${result.transaction.product_name_snapshot}) sebesar Rp${result.transaction.payment_amount.toLocaleString('id-ID')} telah terverifikasi.\n` +
        `Pesanan sedang diteruskan ke supplier untuk diproses.`,
    });

    emitTransactionLogToGroups({
      eventKey: 'paid',
      transactionId,
      customerCode: cus.customer_code,
      productName: result.transaction.product_name_snapshot,
      amount: result.transaction.payment_amount,
      status: 'PAID_PROCESSING',
      note: `Pembayaran terverifikasi via ${source}`,
    });
  }

  return result;
}

export async function processSingleSupplierJob(
  transactionId: string,
  workerId: string,
  supplier: DigiflazzService = digiflazzService
): Promise<{ handled: boolean; status?: string }> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const staleCutoff = new Date(now.getTime() - 120_000).toISOString();

  // Atomically claim job so two workers cannot send duplicate Digiflazz orders
  const claimed = withTransaction((txDb) => {
    const claimRes = txDb
      .prepare(
        `UPDATE supplier_jobs
         SET locked_by = ?, locked_at = ?, updated_at = ?
         WHERE transaction_id = ?
           AND status IN ('PENDING', 'UNKNOWN')
           AND next_attempt_at <= ?
           AND (locked_at IS NULL OR locked_at < ?)`
      )
      .run(workerId, nowIso, nowIso, transactionId, nowIso, staleCutoff);

    if (claimRes.changes === 0) return null;

    const job = txDb
      .prepare('SELECT * FROM supplier_jobs WHERE transaction_id = ?')
      .get(transactionId) as {
      id: number;
      transaction_id: string;
      status: string;
      attempts: number;
    };

    const tx = txDb
      .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
      .get(transactionId) as TransactionRow;

    return { job, tx };
  }, db);

  if (!claimed) {
    return { handled: false };
  }

  const { job, tx } = claimed;

  // Guard: never purchase if payment is not verified PAID
  if (tx.payment_status !== 'PAID') {
    db.prepare('UPDATE supplier_jobs SET locked_by = NULL, locked_at = NULL WHERE id = ?').run(job.id);
    return { handled: false };
  }

  // Guard: if already attempted or supplier_reference exists, use INQUIRY instead of new purchase
  const isFirstAttempt = job.attempts === 0 && !tx.supplier_reference;
  const resp = isFirstAttempt
    ? await supplier.purchase({
        sku: tx.product_sku_snapshot,
        destination: tx.destination,
        refId: tx.transaction_id,
      })
    : await supplier.inquire({
        sku: tx.product_sku_snapshot,
        destination: tx.destination,
        refId: tx.transaction_id,
      });

  const nextAttempts = job.attempts + 1;
  const finishNow = new Date().toISOString();
  const cus = db.prepare('SELECT customer_code FROM customers WHERE id = ?').get(tx.customer_id) as {
    customer_code: string;
  };

  if (resp.mappedStatus === 'SUCCESS') {
    withTransaction((txDb) => {
      txDb
        .prepare(
          `UPDATE supplier_jobs
           SET status = 'COMPLETED', attempts = ?, last_attempt_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(nextAttempts, finishNow, finishNow, job.id);
    }, db);

    transitionTransactionStatus(
      tx.transaction_id,
      'SUCCESS',
      'DIGIFLAZZ',
      `Transaksi supplier sukses${resp.sn ? ` (SN: ${resp.sn})` : ''}`,
      {
        supplierStatus: 'SUCCESS',
        supplierReference: resp.refId,
        supplierSn: resp.sn ?? null,
        supplierMessage: resp.message ?? 'Sukses',
        completedAt: finishNow,
      }
    );

    notifyCustomerForTransaction({
      transactionId: tx.transaction_id,
      customerId: tx.customer_id,
      eventKey: 'success',
      messageType: 'TRANSACTION_SUCCESS',
      text:
        `Pesanan Anda BERHASIL diproses!\n` +
        `ID: ${tx.transaction_id}\n` +
        `Produk: ${tx.product_name_snapshot}\n` +
        `Tujuan: ${maskDestination(tx.destination)}\n` +
        (resp.sn ? `SN / Token: ${resp.sn}\n` : '') +
        `Terima kasih telah bertransaksi.`,
    });

    emitTransactionLogToGroups({
      eventKey: 'success',
      transactionId: tx.transaction_id,
      customerCode: cus.customer_code,
      productName: tx.product_name_snapshot,
      amount: tx.payment_amount,
      status: 'SUCCESS',
      note: `Sukses Digiflazz${resp.sn ? ` SN:${resp.sn}` : ''}`,
    });

    return { handled: true, status: 'SUCCESS' };
  }

  if (resp.mappedStatus === 'FAILED') {
    // Definitive supplier failure ONLY -> update to FAILED & trigger idempotent internal refund
    withTransaction((txDb) => {
      txDb
        .prepare(
          `UPDATE supplier_jobs
           SET status = 'FAILED_DEFINITIVE', attempts = ?, last_attempt_at = ?, last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(nextAttempts, finishNow, resp.message || 'Gagal definitif', finishNow, job.id);
    }, db);

    transitionTransactionStatus(
      tx.transaction_id,
      'FAILED',
      'DIGIFLAZZ',
      `Supplier gagal definitif: ${resp.message || resp.rc || 'Gagal'}`,
      {
        supplierStatus: 'FAILED',
        supplierReference: resp.refId,
        supplierMessage: resp.message ?? 'Gagal definitif',
      }
    );

    processAutomaticRefund(
      tx.transaction_id,
      'DIGIFLAZZ_DEFINITIVE_FAILURE',
      resp.message || 'Transaksi gagal definitif di supplier'
    );

    return { handled: true, status: 'FAILED' };
  }

  if (resp.mappedStatus === 'PENDING') {
    // PENDING is NOT FAILED! Keep monitoring via inquiry backoff; NEVER refund!
    const backoffSeconds = Math.min(300, config.scheduler.supplierPollIntervalSeconds * Math.min(6, nextAttempts));
    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

    withTransaction((txDb) => {
      txDb
        .prepare(
          `UPDATE supplier_jobs
           SET status = 'PENDING', attempts = ?, last_attempt_at = ?, next_attempt_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(nextAttempts, finishNow, nextAttemptAt, finishNow, job.id);
    }, db);

    if (tx.transaction_status !== 'SUPPLIER_PENDING') {
      transitionTransactionStatus(
        tx.transaction_id,
        'SUPPLIER_PENDING',
        'DIGIFLAZZ',
        `Pesanan masih PENDING di supplier (${resp.message || 'Menunggu hasil'})`,
        {
          supplierStatus: 'PENDING',
          supplierReference: resp.refId,
          supplierMessage: resp.message ?? 'Pending',
        }
      );

      emitTransactionLogToGroups({
        eventKey: 'supplier-pending',
        transactionId: tx.transaction_id,
        customerCode: cus.customer_code,
        productName: tx.product_name_snapshot,
        amount: tx.payment_amount,
        status: 'SUPPLIER_PENDING',
        note: 'Menunggu hasil supplier (inquiry terjadwal)',
      });
    }

    return { handled: true, status: 'PENDING' };
  }

  // UNKNOWN (timeout, ambiguous response, unconfigured) -> mark UNKNOWN, schedule inquiry; NEVER refund or re-buy!
  const backoffSeconds = Math.min(300, 30 * Math.min(8, nextAttempts));
  const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

  withTransaction((txDb) => {
    txDb
      .prepare(
        `UPDATE supplier_jobs
         SET status = 'UNKNOWN', attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ?, locked_by = NULL, locked_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(
        nextAttempts,
        finishNow,
        nextAttemptAt,
        resp.errorMessage || 'Status supplier belum diketahui',
        finishNow,
        job.id
      );
  }, db);

  if (tx.transaction_status !== 'UNKNOWN') {
    transitionTransactionStatus(
      tx.transaction_id,
      'UNKNOWN',
      'DIGIFLAZZ',
      `Status supplier UNKNOWN (${resp.errorMessage || 'Perlu inquiry lanjutan'})`,
      {
        supplierStatus: 'UNKNOWN',
        supplierReference: resp.refId || tx.supplier_reference,
        supplierMessage: resp.errorMessage ?? 'Status belum pasti',
      }
    );
  } else if (resp.errorMessage || resp.message) {
    db.prepare(
      `UPDATE transactions
       SET supplier_message = ?, supplier_reference = COALESCE(?, supplier_reference), updated_at = ?
       WHERE transaction_id = ?`
    ).run(
      (resp.errorMessage || resp.message || 'Status belum pasti').slice(0, 250),
      resp.refId || null,
      finishNow,
      tx.transaction_id
    );
  }

  logger.warn('Supplier job marked UNKNOWN for safe inquiry reconciliation', {
    service: 'transaction',
    transactionId: tx.transaction_id,
    details: { attempts: nextAttempts },
  });

  return { handled: true, status: 'UNKNOWN' };
}

export function listTransactions(params: {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  platform?: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: number;
}) {
  const db = getDb();
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.status && params.status !== 'ALL') {
    where.push('t.transaction_status = ?');
    args.push(params.status);
  }
  if (params.platform && params.platform !== 'ALL') {
    where.push('t.platform = ?');
    args.push(params.platform);
  }
  if (params.customerId) {
    where.push('t.customer_id = ?');
    args.push(params.customerId);
  }
  if (params.dateFrom) {
    where.push('t.created_at >= ?');
    args.push(params.dateFrom);
  }
  if (params.dateTo) {
    where.push('t.created_at <= ?');
    args.push(params.dateTo);
  }
  if (params.search) {
    where.push('(t.transaction_id LIKE ? OR c.customer_code LIKE ? OR t.gateway_reference LIKE ? OR t.supplier_reference LIKE ? OR t.destination LIKE ?)');
    const q = `%${params.search.trim()}%`;
    args.push(q, q, q, q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM transactions t
         JOIN customers c ON c.id = t.customer_id
         ${whereSql}`
      )
      .get(...args) as { cnt: number }
  ).cnt;

  const rawItems = db
    .prepare(
      `SELECT t.*, c.customer_code
       FROM transactions t
       JOIN customers c ON c.id = t.customer_id
       ${whereSql}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as Array<TransactionRow & { customer_code: string }>;

  const items = rawItems.map((row) => ({
    ...row,
    destination_masked: maskDestination(row.destination),
  }));

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

export function getTransactionDetail(transactionId: string) {
  const db = getDb();
  const tx = db
    .prepare(
      `SELECT t.*, c.customer_code
       FROM transactions t
       JOIN customers c ON c.id = t.customer_id
       WHERE t.transaction_id = ?`
    )
    .get(transactionId) as (TransactionRow & { customer_code: string }) | undefined;

  if (!tx) return null;

  const history = db
    .prepare('SELECT * FROM transaction_status_history WHERE transaction_id = ? ORDER BY id ASC')
    .all(transactionId);
  const paymentEvents = db
    .prepare('SELECT id, gateway_event_id, gateway_reference, verification_status, processed_at, created_at FROM payment_events WHERE transaction_id = ? ORDER BY id DESC')
    .all(transactionId);
  const supplierJob = db
    .prepare('SELECT * FROM supplier_jobs WHERE transaction_id = ?')
    .get(transactionId);
  const refund = db.prepare('SELECT * FROM refunds WHERE transaction_id = ?').get(transactionId);

  return {
    transaction: {
      ...tx,
      destination_masked: maskDestination(tx.destination),
    },
    history,
    paymentEvents,
    supplierJob,
    refund,
  };
}

export function getCustomerTransactions(customerId: number, limit = 10) {
  const db = getDb();
  return db
    .prepare(
      `SELECT transaction_id, product_name_snapshot, payment_amount, transaction_status, payment_status, supplier_status, destination, created_at
       FROM transactions
       WHERE customer_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(customerId, limit) as Array<{
    transaction_id: string;
    product_name_snapshot: string;
    payment_amount: number;
    transaction_status: TransactionStatus;
    payment_status: PaymentStatus;
    supplier_status: SupplierStatus;
    destination: string;
    created_at: string;
  }>;
}

export function getOverviewMetrics() {
  const db = getDb();
  const now = new Date();
  const todayPrefix = now.toISOString().slice(0, 10);
  const monthPrefix = now.toISOString().slice(0, 7);

  const summary = db
    .prepare(
      `SELECT
        SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN 1 ELSE 0 END) as today_count,
        SUM(CASE WHEN substr(created_at, 1, 7) = ? THEN 1 ELSE 0 END) as month_count,
        SUM(CASE WHEN transaction_status = 'SUCCESS' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN transaction_status IN ('FAILED', 'REFUNDED') THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING', 'UNKNOWN') THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN transaction_status = 'EXPIRED' THEN 1 ELSE 0 END) as expired_count,
        COALESCE(SUM(CASE WHEN transaction_status = 'SUCCESS' THEN payment_amount ELSE 0 END), 0) as total_revenue
       FROM transactions`
    )
    .get(todayPrefix, monthPrefix) as {
    today_count: number | null;
    month_count: number | null;
    success_count: number | null;
    failed_count: number | null;
    pending_count: number | null;
    expired_count: number | null;
    total_revenue: number;
  };

  const refundStats = db
    .prepare('SELECT COALESCE(SUM(amount), 0) as total_refunds, COUNT(*) as refund_count FROM refunds')
    .get() as { total_refunds: number; refund_count: number };

  const pendingSupplierJobs = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM supplier_jobs WHERE status IN ('PENDING', 'PROCESSING', 'UNKNOWN')")
      .get() as { cnt: number }
  ).cnt;

  const lastPriceSync = db
    .prepare('SELECT id, started_at, completed_at, status, success_count, failure_count FROM price_sync_logs ORDER BY id DESC LIMIT 1')
    .get();

  const lastBackup = db
    .prepare('SELECT id, file_name, file_size_bytes, status, created_at, completed_at FROM backup_logs ORDER BY id DESC LIMIT 1')
    .get();

  return {
    todayCount: summary.today_count ?? 0,
    monthCount: summary.month_count ?? 0,
    successCount: summary.success_count ?? 0,
    failedCount: summary.failed_count ?? 0,
    pendingCount: summary.pending_count ?? 0,
    expiredCount: summary.expired_count ?? 0,
    totalRevenue: summary.total_revenue ?? 0,
    totalRefunds: refundStats.total_refunds ?? 0,
    refundCount: refundStats.refund_count ?? 0,
    pendingSupplierJobs,
    lastPriceSync: lastPriceSync ?? null,
    lastBackup: lastBackup ?? null,
  };
}

export function previewOrderDryRun(input: {
  platform: CustomerPlatform;
  platformUserId: string;
  productSkuOrId: string | number;
  destination: string;
  couponCode?: string | null;
}): CreateOrderResult {
  if (isMaintenanceMode()) {
    return {
      ok: false,
      code: 'MAINTENANCE_ACTIVE',
      errorMessage: 'Sistem sedang dalam mode pemeliharaan. Pemesanan baru sementara dinonaktifkan.',
    };
  }

  const destination = input.destination.trim();
  if (!destination || destination.length < 4 || destination.length > 40) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      errorMessage: 'Nomor tujuan / ID pelanggan produk tidak valid',
    };
  }

  const product = getProductBySkuOrId(input.productSkuOrId);
  if (!product || product.status !== 'ACTIVE' || product.is_available !== 1) {
    return {
      ok: false,
      code: 'PRODUCT_UNAVAILABLE',
      errorMessage: 'Produk tidak ditemukan atau sedang nonaktif',
    };
  }

  const db = getDb();
  const existingCustomer = findCustomerByPlatform({
    platform: input.platform,
    platformUserId: input.platformUserId,
  });

  const globalMargin = getGlobalMarginRule();
  let categoryMargin: MarginRule | null = null;
  if (product.category_id) {
    const cat = db
      .prepare('SELECT margin_type, margin_value, max_margin FROM categories WHERE id = ?')
      .get(product.category_id) as
      | { margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
      | undefined;
    if (cat?.margin_type && cat.margin_value !== null) {
      categoryMargin = { type: cat.margin_type, value: cat.margin_value, maxMargin: cat.max_margin };
    }
  }
  const productMargin: MarginRule | null =
    product.margin_type && product.margin_value !== null
      ? { type: product.margin_type, value: product.margin_value, maxMargin: product.max_margin }
      : null;

  const marginCalc = resolveEffectiveMargin({
    supplierPrice: product.supplier_price,
    productMargin,
    categoryMargin,
    globalMargin,
  });

  let couponCodeSnapshot: string | null = null;
  let discountAmount = 0;
  if (input.couponCode && input.couponCode.trim()) {
    try {
      const preview = previewCouponReadOnly({
        code: input.couponCode.trim(),
        customerId: existingCustomer?.customer.id ?? null,
        sellingPrice: marginCalc.sellingPrice,
        productId: product.id,
        categoryId: product.category_id,
      });
      couponCodeSnapshot = preview.couponCode;
      discountAmount = preview.discountAmount;
    } catch (couponErr) {
      return {
        ok: false,
        code: 'COUPON_INVALID',
        errorMessage: couponErr instanceof Error ? couponErr.message : 'Kupon tidak valid',
      };
    }
  }

  const activeRows = db
    .prepare("SELECT payment_amount FROM transactions WHERE transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING')")
    .all() as Array<{ payment_amount: number }>;
  const uniqueCode = selectAvailableUniqueCode(
    Math.max(100, marginCalc.sellingPrice - discountAmount),
    new Set(activeRows.map((r) => r.payment_amount)),
    config.transaction.uniqueCodeMin,
    config.transaction.uniqueCodeMax
  );
  const paymentAmount = computeFinalPaymentAmount(
    marginCalc.sellingPrice,
    discountAmount,
    uniqueCode
  );

  const now = new Date();
  const expiredAt = new Date(now.getTime() + config.transaction.invoiceExpiryMinutes * 60 * 1000).toISOString();
  const previewTxId = `TRX-DEMO-${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
  const qrString = `00020101021226590014ID.CO.DEMO.PPOB0215${previewTxId}540${paymentAmount}5802ID5912PPOB BOT DEMO6007JAKARTA6304DEMO`;

  const previewTransaction: TransactionRow = {
    id: 0,
    transaction_id: previewTxId,
    idempotency_key: null,
    customer_id: existingCustomer?.customer.id ?? 0,
    platform: input.platform,
    product_id: product.id,
    product_sku_snapshot: product.sku,
    product_name_snapshot: product.name,
    supplier_price_snapshot: product.supplier_price,
    margin_snapshot: marginCalc.marginAmount,
    coupon_code_snapshot: couponCodeSnapshot,
    discount_snapshot: discountAmount,
    unique_code: uniqueCode,
    payment_amount: paymentAmount,
    payment_method: 'QRIS',
    payment_status: 'PENDING',
    supplier_status: 'NONE',
    transaction_status: 'PENDING_PAYMENT',
    gateway_reference: 'DEMO-PREVIEW',
    qris_payload_json: JSON.stringify({ qrString }),
    qr_message_ref_json: null,
    supplier_reference: null,
    supplier_sn: null,
    supplier_message: null,
    destination,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expired_at: expiredAt,
    paid_at: null,
    completed_at: null,
  };

  return {
    ok: true,
    transaction: previewTransaction,
    qris: { qrString },
  };
}

export const MIN_CUSTOMER_CANCEL_DELAY_MS = 30_000;

export async function cancelCustomerTransaction(
  input: {
    platform: CustomerPlatform;
    platformUserId: string;
    transactionId?: string;
  },
  gateway: PaymentGatewayPort = defaultPaymentGateway
): Promise<{
  ok: boolean;
  code?: 'NOT_FOUND' | 'TOO_EARLY' | 'NOT_CANCELLABLE' | 'ALREADY_PAID';
  remainingWaitSeconds?: number;
  errorMessage?: string;
  transaction?: TransactionRow;
}> {
  const resolved = findCustomerByPlatform({
    platform: input.platform,
    platformUserId: input.platformUserId,
  });

  if (!resolved) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      errorMessage: 'Belum ada pesanan aktif yang dapat dibatalkan saat ini.',
    };
  }

  const db = getDb();
  const tx = input.transactionId
    ? (db
        .prepare('SELECT * FROM transactions WHERE transaction_id = ? AND customer_id = ?')
        .get(input.transactionId.trim(), resolved.customer.id) as TransactionRow | undefined)
    : (db
        .prepare(
          `SELECT * FROM transactions
           WHERE customer_id = ? AND transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING')
           ORDER BY id DESC LIMIT 1`
        )
        .get(resolved.customer.id) as TransactionRow | undefined);

  if (!tx) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      errorMessage: input.transactionId
        ? `Pesanan ${input.transactionId} tidak ditemukan pada akun Anda.`
        : 'Tidak ada pesanan yang menunggu pembayaran untuk dibatalkan.',
    };
  }

  if (
    tx.payment_status === 'PAID' ||
    !['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(tx.transaction_status)
  ) {
    return {
      ok: false,
      code: 'NOT_CANCELLABLE',
      errorMessage: `Pesanan ${tx.transaction_id} tidak dapat dibatalkan karena status saat ini sudah ${tx.transaction_status}.`,
    };
  }

  const elapsedMs = Date.now() - new Date(tx.created_at).getTime();
  if (elapsedMs < MIN_CUSTOMER_CANCEL_DELAY_MS) {
    const remainingWaitSeconds = Math.max(1, Math.ceil((MIN_CUSTOMER_CANCEL_DELAY_MS - elapsedMs) / 1000));
    return {
      ok: false,
      code: 'TOO_EARLY',
      remainingWaitSeconds,
      errorMessage: `Pembatalan pesanan minimal dilakukan 30 detik setelah pesanan dibuat. Mohon tunggu ${remainingWaitSeconds} detik lagi ya Kak.`,
      transaction: tx,
    };
  }

  const gatewayRef = resolveGatewayReference(tx);
  if (gatewayRef) {
    persistGatewayReferenceIfMissing(tx.transaction_id, gatewayRef);
    const check = await gateway.checkPaymentStatus(gatewayRef, tx.transaction_id, tx.payment_amount);
    const effectiveGatewayRef = check.gatewayReference?.trim() || gatewayRef;
    if (check.mappedStatus === 'PAID') {
      handleVerifiedPaymentPaid(
        tx.transaction_id,
        'CUSTOMER_CANCEL_VERIFY',
        check.paidAt,
        effectiveGatewayRef
      );
      return {
        ok: false,
        code: 'ALREADY_PAID',
        errorMessage: `Pembayaran untuk ${tx.transaction_id} sudah diterima LUNAS sehingga pesanan sedang diproses.`,
      };
    }
    await gateway.cancelPayment(effectiveGatewayRef, tx.transaction_id).catch(() => undefined);
  }

  const now = new Date().toISOString();
  const cancelled = transitionTransactionStatus(
    tx.transaction_id,
    'CANCELLED',
    `${input.platform}_CUSTOMER_CANCEL`,
    'Pesanan dibatalkan oleh pelanggan',
    { paymentStatus: 'CANCELLED', completedAt: now }
  );

  setCustomerCooldown(tx.customer_id, 'CUSTOMER_CANCELLED', tx.transaction_id);

  const { deleteQrMessagesForTransaction } = await import('./payment.service');
  await deleteQrMessagesForTransaction(cancelled).catch(() => undefined);

  emitTransactionLogToGroups({
    eventKey: 'cancelled',
    transactionId: cancelled.transaction_id,
    customerCode: resolved.customer.customer_code,
    productName: cancelled.product_name_snapshot,
    amount: cancelled.payment_amount,
    status: 'CANCELLED',
    note: `Dibatalkan oleh pelanggan via ${input.platform}`,
  });

  return {
    ok: true,
    transaction: cancelled,
  };
}


