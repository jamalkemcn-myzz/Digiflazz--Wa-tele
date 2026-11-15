import { getDb, withTransaction } from '../database/connection';
import { logger, sanitizeForLog } from '../logging/logger';
import { defaultPaymentGateway, type PaymentGatewayPort } from '../integrations/myzzstore.gateway';
import {
  handleVerifiedPaymentPaid,
  persistGatewayReferenceIfMissing,
  resolveGatewayReference,
  setCustomerCooldown,
  transitionTransactionStatus,
  type TransactionRow,
} from './transaction.service';
import { emitTransactionLogToGroups, notifyCustomerForTransaction } from './notification.service';

export type QrMessageDeleter = (ref: {
  platform: 'WHATSAPP' | 'TELEGRAM';
  chatId: string;
  messageId: unknown;
}) => Promise<void>;

const qrDeleters: Partial<Record<'WHATSAPP' | 'TELEGRAM', QrMessageDeleter>> = {};

export function registerQrMessageDeleter(
  platform: 'WHATSAPP' | 'TELEGRAM',
  deleter: QrMessageDeleter | null
): void {
  if (deleter) {
    qrDeleters[platform] = deleter;
  } else {
    delete qrDeleters[platform];
  }
}

export async function deleteQrMessagesForTransaction(tx: TransactionRow): Promise<void> {
  if (!tx.qr_message_ref_json) return;
  try {
    const refs = JSON.parse(tx.qr_message_ref_json) as Array<{
      platform: 'WHATSAPP' | 'TELEGRAM';
      chatId: string;
      messageId: unknown;
    }>;
    for (const ref of refs) {
      const deleter = qrDeleters[ref.platform];
      if (deleter) {
        await deleter(ref).catch((err) => {
          logger.warn('Failed to delete expired QRIS message', {
            service: 'payment',
            transactionId: tx.transaction_id,
            details: { platform: ref.platform, error: err instanceof Error ? err.message : 'unknown' },
          });
        });
      }
    }
  } catch {
    // Ignore invalid JSON ref
  }
}

export async function processGatewayCallback(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  parsedBody: unknown,
  gateway: PaymentGatewayPort = defaultPaymentGateway
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const verified = gateway.verifyCallback(headers, rawBody, parsedBody);
  const db = getDb();
  const now = new Date().toISOString();

  if (!verified.valid) {
    logger.warn('Rejected invalid MyZZStore callback', {
      service: 'payment-callback',
      transactionId: verified.transactionId,
      details: { reason: verified.reason },
    });

    db.prepare(
      `INSERT OR IGNORE INTO payment_events (gateway_event_id, gateway_reference, transaction_id, payload_safe, verification_status, created_at)
       VALUES (?, ?, ?, ?, 'REJECTED', ?)`
    ).run(
      `REJ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      verified.gatewayReference ?? null,
      verified.transactionId ?? null,
      JSON.stringify(sanitizeForLog(verified.safePayload)),
      now
    );

    return {
      statusCode: 401,
      body: { ok: false, error: verified.reason || 'Invalid callback signature' },
    };
  }

  const eventId = verified.eventId || `${verified.gatewayReference}:${verified.mappedStatus}`;

  // Locate transaction by transactionId or gatewayReference (supporting gateways sending trx_id in order_id or vice versa)
  const idA = verified.transactionId?.trim() || '';
  const idB = verified.gatewayReference?.trim() || '';
  const tx = db
    .prepare(
      `SELECT * FROM transactions
       WHERE transaction_id IN (?, ?)
          OR (gateway_reference IS NOT NULL AND gateway_reference IN (?, ?))
       ORDER BY id DESC LIMIT 1`
    )
    .get(idA, idB, idA, idB) as TransactionRow | undefined;

  if (!tx) {
    return { statusCode: 404, body: { ok: false, error: 'Transaction not found' } };
  }

  const effectiveGatewayRef = verified.gatewayReference?.trim() || resolveGatewayReference(tx) || undefined;
  if (effectiveGatewayRef) {
    persistGatewayReferenceIfMissing(tx.transaction_id, effectiveGatewayRef);
  }

  if (verified.amount !== undefined && verified.amount !== tx.payment_amount) {
    logger.warn('Callback amount mismatch', {
      service: 'payment-callback',
      transactionId: tx.transaction_id,
      details: { expected: tx.payment_amount, received: verified.amount },
    });
    return { statusCode: 400, body: { ok: false, error: 'Payment amount mismatch' } };
  }

  // Record idempotent payment event
  const inserted = withTransaction((txDb) => {
    const existing = txDb
      .prepare('SELECT id FROM payment_events WHERE gateway_event_id = ?')
      .get(eventId);
    if (existing) {
      return false;
    }
    txDb
      .prepare(
        `INSERT INTO payment_events (gateway_event_id, gateway_reference, transaction_id, payload_safe, verification_status, processed_at, created_at)
         VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?)`
      )
      .run(
        eventId,
        verified.gatewayReference ?? tx.gateway_reference,
        tx.transaction_id,
        JSON.stringify(sanitizeForLog(verified.safePayload)),
        now,
        now
      );
    return true;
  }, db);

  if (!inserted) {
    return {
      statusCode: 200,
      body: { ok: true, duplicate: true, transactionId: tx.transaction_id },
    };
  }

  if (verified.mappedStatus === 'PAID') {
    handleVerifiedPaymentPaid(
      tx.transaction_id,
      'MYZZSTORE_CALLBACK',
      verified.paidAt,
      effectiveGatewayRef
    );
  } else if (verified.mappedStatus === 'EXPIRED') {
    await finalizeExpiredInvoice(tx, 'MYZZSTORE_CALLBACK', gateway);
  } else if (verified.mappedStatus === 'CANCELLED' || verified.mappedStatus === 'FAILED') {
    if (['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(tx.transaction_status)) {
      const target = verified.mappedStatus === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
      transitionTransactionStatus(
        tx.transaction_id,
        target,
        'MYZZSTORE_CALLBACK',
        `Gateway menyatakan status ${verified.mappedStatus}`,
        { paymentStatus: verified.mappedStatus, completedAt: now }
      );
      setCustomerCooldown(tx.customer_id, `PAYMENT_${target}`, tx.transaction_id);
      await deleteQrMessagesForTransaction(tx);
    }
  }

  return {
    statusCode: 200,
    body: { ok: true, transactionId: tx.transaction_id, status: verified.mappedStatus },
  };
}

export async function checkTransactionPaymentStatus(
  tx: TransactionRow,
  gateway: PaymentGatewayPort = defaultPaymentGateway
) {
  const gatewayRef = resolveGatewayReference(tx);
  if (!gatewayRef) {
    return null;
  }
  persistGatewayReferenceIfMissing(tx.transaction_id, gatewayRef);
  const check = await gateway.checkPaymentStatus(gatewayRef, tx.transaction_id, tx.payment_amount);
  const effectiveGatewayRef = check.gatewayReference?.trim() || gatewayRef;
  persistGatewayReferenceIfMissing(tx.transaction_id, effectiveGatewayRef);
  return { check, effectiveGatewayRef };
}

export async function finalizeExpiredInvoice(
  tx: TransactionRow,
  source: string,
  gateway: PaymentGatewayPort = defaultPaymentGateway
): Promise<'EXPIRED' | 'PAID' | 'UNKNOWN'> {
  if (!['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'UNKNOWN'].includes(tx.transaction_status)) {
    return 'PAID';
  }

  // Always verify status with MyZZStore using Gateway trx_id before marking EXPIRED!
  const verified = await checkTransactionPaymentStatus(tx, gateway);
  if (verified) {
    const { check, effectiveGatewayRef } = verified;
    if (check.mappedStatus === 'PAID') {
      handleVerifiedPaymentPaid(tx.transaction_id, `${source}_VERIFY`, check.paidAt, effectiveGatewayRef);
      return 'PAID';
    }
    if (check.mappedStatus === 'UNKNOWN') {
      if (tx.transaction_status !== 'UNKNOWN') {
        transitionTransactionStatus(
          tx.transaction_id,
          'UNKNOWN',
          source,
          'Status gateway tidak dapat dipastikan saat pengecekan kedaluwarsa; menunggu rekonsiliasi',
          { paymentStatus: 'UNKNOWN' }
        );
      }
      return 'UNKNOWN';
    }
    // Cancel on gateway if supported
    await gateway.cancelPayment(effectiveGatewayRef, tx.transaction_id);
  }

  const now = new Date().toISOString();
  transitionTransactionStatus(
    tx.transaction_id,
    'EXPIRED',
    source,
    'Invoice QRIS melewati batas waktu 5 menit dan dipastikan belum dibayar',
    { paymentStatus: 'EXPIRED', completedAt: now }
  );

  setCustomerCooldown(tx.customer_id, 'INVOICE_EXPIRED', tx.transaction_id);
  await deleteQrMessagesForTransaction(tx);

  const db = getDb();
  const cus = db.prepare('SELECT customer_code FROM customers WHERE id = ?').get(tx.customer_id) as {
    customer_code: string;
  };

  notifyCustomerForTransaction({
    transactionId: tx.transaction_id,
    customerId: tx.customer_id,
    eventKey: 'expired',
    messageType: 'INVOICE_EXPIRED',
    text:
      `Invoice ${tx.transaction_id} (${tx.product_name_snapshot}) telah KEDALUWARSA karena melewati batas waktu pembayaran.\n` +
      `Silakan tunggu 30 detik sebelum membuat pesanan baru.`,
  });

  emitTransactionLogToGroups({
    eventKey: 'expired',
    transactionId: tx.transaction_id,
    customerCode: cus.customer_code,
    productName: tx.product_name_snapshot,
    amount: tx.payment_amount,
    status: 'EXPIRED',
    note: 'Invoice kedaluwarsa (terverifikasi belum dibayar)',
  });

  return 'EXPIRED';
}
