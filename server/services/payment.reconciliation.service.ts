import { getDb } from '../database/connection';
import { logger } from '../logging/logger';
import { defaultPaymentGateway, type PaymentGatewayPort } from '../integrations/myzzstore.gateway';
import {
  handleVerifiedPaymentPaid,
  resolveGatewayReference,
  transitionTransactionStatus,
  type TransactionRow,
} from './transaction.service';
import { checkTransactionPaymentStatus, finalizeExpiredInvoice } from './payment.service';

export async function pollPendingPayments(
  gateway: PaymentGatewayPort = defaultPaymentGateway
): Promise<{ checked: number; paid: number; expired: number; unknown: number }> {
  if (!gateway.isConfigured()) {
    return { checked: 0, paid: 0, expired: 0, unknown: 0 };
  }

  const db = getDb();
  const pending = db
    .prepare(
      `SELECT * FROM transactions
       WHERE transaction_status IN ('PENDING_PAYMENT', 'PAYMENT_PROCESSING')
       ORDER BY id ASC LIMIT 30`
    )
    .all() as TransactionRow[];

  let paid = 0;
  let expired = 0;
  let unknown = 0;

  for (const tx of pending) {
    const isPastExpiry = tx.expired_at ? Date.now() >= new Date(tx.expired_at).getTime() : false;

    if (isPastExpiry) {
      const outcome = await finalizeExpiredInvoice(tx, 'PAYMENT_POLLER', gateway);
      if (outcome === 'PAID') paid++;
      else if (outcome === 'EXPIRED') expired++;
      else unknown++;
      continue;
    }

    const verified = await checkTransactionPaymentStatus(tx, gateway);
    if (!verified) continue;
    const { check, effectiveGatewayRef } = verified;

    if (check.mappedStatus === 'PAID') {
      handleVerifiedPaymentPaid(tx.transaction_id, 'PAYMENT_POLLER', check.paidAt, effectiveGatewayRef);
      paid++;
    } else if (check.mappedStatus === 'EXPIRED') {
      await finalizeExpiredInvoice(tx, 'PAYMENT_POLLER', gateway);
      expired++;
    } else if (check.mappedStatus === 'CANCELLED' || check.mappedStatus === 'FAILED') {
      transitionTransactionStatus(
        tx.transaction_id,
        check.mappedStatus,
        'PAYMENT_POLLER',
        `Gateway status polling mengembalikan ${check.mappedStatus}`,
        { paymentStatus: check.mappedStatus, completedAt: new Date().toISOString() }
      );
    } else if (check.mappedStatus === 'UNKNOWN') {
      unknown++;
    }
  }

  if (pending.length > 0) {
    logger.debug('Payment poll cycle finished', {
      service: 'payment-reconciliation',
      details: { checked: pending.length, paid, expired, unknown },
    });
  }

  return { checked: pending.length, paid, expired, unknown };
}

export async function reconcileUnknownAndMissedCallbacks(
  gateway: PaymentGatewayPort = defaultPaymentGateway
): Promise<{ reconciled: number; recoveredPaid: number }> {
  if (!gateway.isConfigured()) {
    return { reconciled: 0, recoveredPaid: 0 };
  }

  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT * FROM transactions
       WHERE (transaction_status = 'UNKNOWN' AND payment_status IN ('CREATED', 'PENDING', 'PROCESSING', 'UNKNOWN'))
          OR (transaction_status = 'EXPIRED' AND payment_status != 'PAID' AND gateway_reference IS NOT NULL AND updated_at >= datetime('now', '-2 hours'))
       ORDER BY id ASC LIMIT 25`
    )
    .all() as TransactionRow[];

  let recoveredPaid = 0;
  for (const tx of candidates) {
    if (!resolveGatewayReference(tx)) {
      if (
        tx.transaction_status === 'UNKNOWN' &&
        tx.payment_status !== 'PAID' &&
        tx.supplier_status === 'NONE' &&
        !tx.qris_payload_json
      ) {
        const expiryMs = tx.expired_at
          ? new Date(tx.expired_at).getTime()
          : new Date(tx.created_at).getTime() + 5 * 60_000;
        if (Number.isFinite(expiryMs) && Date.now() >= expiryMs) {
          transitionTransactionStatus(
            tx.transaction_id,
            'FAILED',
            'PAYMENT_RECONCILIATION',
            'Pembuatan invoice QRIS gagal sebelum menerima Gateway Ref dan telah melewati batas waktu; tidak ada pembayaran masuk',
            { paymentStatus: 'FAILED', completedAt: new Date().toISOString() }
          );
        }
      }
      continue;
    }

    const verified = await checkTransactionPaymentStatus(tx, gateway);
    if (!verified) continue;
    const { check, effectiveGatewayRef } = verified;
    if (check.mappedStatus === 'PAID') {
      handleVerifiedPaymentPaid(tx.transaction_id, 'PAYMENT_RECONCILIATION', check.paidAt, effectiveGatewayRef);
      recoveredPaid++;
    } else if (check.mappedStatus === 'PENDING' && tx.transaction_status === 'UNKNOWN') {
      const isPastExpiry = tx.expired_at ? Date.now() >= new Date(tx.expired_at).getTime() : false;
      if (isPastExpiry) {
        await finalizeExpiredInvoice(tx, 'PAYMENT_RECONCILIATION', gateway);
      } else {
        transitionTransactionStatus(
          tx.transaction_id,
          'PENDING_PAYMENT',
          'PAYMENT_RECONCILIATION',
          'Rekonsiliasi menemukan invoice masih PENDING di gateway',
          { paymentStatus: 'PENDING' }
        );
      }
    } else if (check.mappedStatus === 'EXPIRED' && tx.transaction_status === 'UNKNOWN') {
      await finalizeExpiredInvoice(tx, 'PAYMENT_RECONCILIATION', gateway);
    } else if (
      (check.mappedStatus === 'FAILED' || check.mappedStatus === 'CANCELLED') &&
      tx.transaction_status === 'UNKNOWN'
    ) {
      transitionTransactionStatus(
        tx.transaction_id,
        'FAILED',
        'PAYMENT_RECONCILIATION',
        `Rekonsiliasi menemukan gateway berstatus ${check.mappedStatus}`,
        { paymentStatus: check.mappedStatus, completedAt: new Date().toISOString() }
      );
    }
  }

  return { reconciled: candidates.length, recoveredPaid };
}
