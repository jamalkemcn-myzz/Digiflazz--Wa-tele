import crypto from 'node:crypto';
import { getDb, withTransaction } from '../database/connection';
import {
  canTransitionTransaction,
  isEligibleForInternalRefund,
  type PaymentStatus,
  type SupplierStatus,
  type TransactionStatus,
} from '../domain/state-machine';
import { recordAuditLog } from './audit.service';
import { emitTransactionLogToGroups, notifyCustomerForTransaction } from './notification.service';
import { getCustomerRefundCreditTotal } from './customer.service';

export interface RefundProcessResult {
  ok: boolean;
  alreadyRefunded?: boolean;
  refundId?: number;
  amount?: number;
  reason?: string;
}

export function checkTransactionRefundEligibility(transactionId: string) {
  const db = getDb();
  const tx = db
    .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
    .get(transactionId) as
    | {
        transaction_id: string;
        customer_id: number;
        payment_status: PaymentStatus;
        supplier_status: SupplierStatus;
        transaction_status: TransactionStatus;
        payment_amount: number;
      }
    | undefined;

  if (!tx) {
    return { found: false, eligible: false, reason: 'Transaksi tidak ditemukan' };
  }

  const existingRefund = db
    .prepare('SELECT id FROM refunds WHERE transaction_id = ?')
    .get(transactionId);

  const check = isEligibleForInternalRefund({
    paymentStatus: tx.payment_status,
    supplierStatus: tx.supplier_status,
    transactionStatus: tx.transaction_status,
    alreadyRefunded: Boolean(existingRefund),
  });

  return {
    found: true,
    eligible: check.eligible,
    reason: check.reason,
    amount: tx.payment_amount,
    alreadyRefunded: Boolean(existingRefund),
  };
}

export function processAutomaticRefund(
  transactionId: string,
  source: string,
  reason = 'Kegagalan definitif dari supplier setelah pembayaran terverifikasi'
): RefundProcessResult {
  const result = withTransaction((txDb) => {
    const tx = txDb
      .prepare(
        `SELECT t.*, c.customer_code
         FROM transactions t
         JOIN customers c ON c.id = t.customer_id
         WHERE t.transaction_id = ?`
      )
      .get(transactionId) as
      | {
          transaction_id: string;
          customer_id: number;
          customer_code: string;
          product_name_snapshot: string;
          payment_amount: number;
          payment_status: PaymentStatus;
          supplier_status: SupplierStatus;
          transaction_status: TransactionStatus;
        }
      | undefined;

    if (!tx) {
      return { ok: false, reason: 'Transaksi tidak ditemukan' };
    }

    const existingRefund = txDb
      .prepare('SELECT id, amount FROM refunds WHERE transaction_id = ?')
      .get(transactionId) as { id: number; amount: number } | undefined;

    const eligibility = isEligibleForInternalRefund({
      paymentStatus: tx.payment_status,
      supplierStatus: tx.supplier_status,
      transactionStatus: tx.transaction_status,
      alreadyRefunded: Boolean(existingRefund),
    });

    if (!eligibility.eligible) {
      return {
        ok: false,
        alreadyRefunded: Boolean(existingRefund),
        refundId: existingRefund?.id,
        amount: existingRefund?.amount,
        reason: eligibility.reason,
      };
    }

    if (!canTransitionTransaction(tx.transaction_status, 'REFUNDED')) {
      return { ok: false, reason: `Transisi ke REFUNDED tidak diizinkan dari ${tx.transaction_status}` };
    }

    const now = new Date().toISOString();
    const refundAmount = tx.payment_amount;
    const ledgerId = `LDG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const refundInsert = txDb
      .prepare(
        `INSERT INTO refunds (transaction_id, customer_id, amount, reason, status, approved_by, created_at, processed_at)
         VALUES (?, ?, ?, ?, 'PROCESSED', ?, ?, ?)`
      )
      .run(transactionId, tx.customer_id, refundAmount, reason, source, now, now);

    txDb
      .prepare(
        `INSERT INTO refund_ledger (ledger_id, customer_id, transaction_id, entry_type, amount, description, actor_id, actor_source, created_at)
         VALUES (?, ?, ?, 'REFUND_CREDIT', ?, ?, ?, ?, ?)`
      )
      .run(
        ledgerId,
        tx.customer_id,
        transactionId,
        refundAmount,
        reason,
        source,
        'SYSTEM_AUTO_REFUND',
        now
      );

    txDb
      .prepare(
        `UPDATE transactions SET transaction_status = 'REFUNDED', completed_at = ?, updated_at = ? WHERE transaction_id = ?`
      )
      .run(now, now, transactionId);

    txDb
      .prepare(
        `INSERT INTO transaction_status_history (transaction_id, old_status, new_status, source, description, created_at)
         VALUES (?, ?, 'REFUNDED', ?, ?, ?)`
      )
      .run(transactionId, tx.transaction_status, source, `Refund internal Rp${refundAmount.toLocaleString('id-ID')}: ${reason}`, now);

    return {
      ok: true,
      refundId: Number(refundInsert.lastInsertRowid),
      amount: refundAmount,
      tx,
    };
  });

  if (result.ok && 'tx' in result && result.tx) {
    const tx = result.tx;
    recordAuditLog({
      actorId: source,
      actorRole: 'SYSTEM',
      action: 'INTERNAL_REFUND_PROCESSED',
      targetType: 'TRANSACTION',
      targetId: transactionId,
      details: { amount: result.amount, reason },
    });

    notifyCustomerForTransaction({
      transactionId,
      customerId: tx.customer_id,
      eventKey: 'refunded',
      messageType: 'REFUND_PROCESSED',
      text:
        `Transaksi ${transactionId} (${tx.product_name_snapshot}) gagal diproses oleh supplier secara definitif.\n` +
        `Kredit refund internal sebesar Rp${(result.amount ?? 0).toLocaleString('id-ID')} telah dicatat pada akun Anda (${tx.customer_code}).\n` +
        `Alasan: ${reason}`,
    });

    emitTransactionLogToGroups({
      eventKey: 'refunded',
      transactionId,
      customerCode: tx.customer_code,
      productName: tx.product_name_snapshot,
      amount: result.amount ?? 0,
      status: 'REFUNDED',
      note: `Refund internal dicatat (${reason})`,
    });
  }

  return {
    ok: result.ok,
    alreadyRefunded: result.alreadyRefunded,
    refundId: result.refundId,
    amount: result.amount,
    reason: result.reason,
  };
}

export function applyManualRefundOrAdjustment(
  input: {
    customerId: number;
    transactionId?: string | null;
    entryType: 'MANUAL_ADJUSTMENT_CREDIT' | 'MANUAL_ADJUSTMENT_DEBIT';
    amount: number;
    reason: string;
  },
  actor: { id: string; role: string }
): { ledgerId: string; balanceBefore: number; balanceAfter: number } {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new Error('Alasan penyesuaian wajib diisi minimal 5 karakter');
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error('Nominal penyesuaian harus lebih dari 0');
  }
  const amount = Math.round(input.amount);

  if (input.transactionId) {
    const db = getDb();
    const tx = db
      .prepare('SELECT payment_status, supplier_status, transaction_status FROM transactions WHERE transaction_id = ?')
      .get(input.transactionId) as
      | { payment_status: PaymentStatus; supplier_status: SupplierStatus; transaction_status: TransactionStatus }
      | undefined;
    if (!tx) throw new Error('Transaction ID referensi tidak ditemukan');
    if (
      input.entryType === 'MANUAL_ADJUSTMENT_CREDIT' &&
      (tx.supplier_status === 'PENDING' ||
        tx.supplier_status === 'PROCESSING' ||
        tx.supplier_status === 'UNKNOWN' ||
        tx.transaction_status === 'UNKNOWN')
    ) {
      throw new Error(
        'Penyesuaian kredit refund dilarang ketika transaksi supplier masih PENDING, PROCESSING, atau UNKNOWN'
      );
    }
  }

  const balanceBefore = getCustomerRefundCreditTotal(input.customerId);
  if (input.entryType === 'MANUAL_ADJUSTMENT_DEBIT' && balanceBefore - amount < 0) {
    throw new Error('Saldo kredit refund pelanggan tidak boleh menjadi negatif');
  }

  const ledgerId = `LDG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();

  withTransaction((txDb) => {
    const cus = txDb.prepare('SELECT id FROM customers WHERE id = ?').get(input.customerId);
    if (!cus) throw new Error('Pelanggan tidak ditemukan');

    txDb
      .prepare(
        `INSERT INTO refund_ledger (ledger_id, customer_id, transaction_id, entry_type, amount, description, actor_id, actor_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ledgerId,
        input.customerId,
        input.transactionId ?? null,
        input.entryType,
        amount,
        reason,
        actor.id,
        `ADMIN_${actor.role}`,
        now
      );
  });

  const balanceAfter = getCustomerRefundCreditTotal(input.customerId);

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'REFUND_LEDGER_ADJUSTED',
    targetType: 'REFUND_LEDGER',
    targetId: ledgerId,
    details: {
      customerId: input.customerId,
      transactionId: input.transactionId ?? null,
      entryType: input.entryType,
      amount,
      balanceBefore,
      balanceAfter,
      reason,
    },
  });

  return { ledgerId, balanceBefore, balanceAfter };
}

export function listRefunds(page = 1, limit = 25) {
  const db = getDb();
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset = (safePage - 1) * safeLimit;

  const total = (db.prepare('SELECT COUNT(*) as cnt FROM refunds').get() as { cnt: number }).cnt;
  const items = db
    .prepare(
      `SELECT r.*, c.customer_code, t.product_name_snapshot, t.supplier_status, t.payment_status
       FROM refunds r
       JOIN customers c ON c.id = r.customer_id
       JOIN transactions t ON t.transaction_id = r.transaction_id
       ORDER BY r.id DESC LIMIT ? OFFSET ?`
    )
    .all(safeLimit, offset);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}

export function listRefundLedger(page = 1, limit = 30) {
  const db = getDb();
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset = (safePage - 1) * safeLimit;

  const total = (db.prepare('SELECT COUNT(*) as cnt FROM refund_ledger').get() as { cnt: number }).cnt;
  const items = db
    .prepare(
      `SELECT rl.*, c.customer_code
       FROM refund_ledger rl
       JOIN customers c ON c.id = rl.customer_id
       ORDER BY rl.id DESC LIMIT ? OFFSET ?`
    )
    .all(safeLimit, offset);

  return {
    items,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    },
  };
}
