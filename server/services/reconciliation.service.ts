import { getDb, withTransaction } from '../database/connection';
import { logger } from '../logging/logger';
import { defaultPaymentGateway, type PaymentGatewayPort } from '../integrations/myzzstore.gateway';
import { digiflazzService, type DigiflazzService } from '../integrations/digiflazz.service';
import { pollPendingPayments, reconcileUnknownAndMissedCallbacks } from './payment.reconciliation.service';
import {
  processSingleSupplierJob,
  resolveGatewayReference,
  transitionTransactionStatus,
  type TransactionRow,
} from './transaction.service';

export async function pollPendingSupplierJobs(
  workerId = 'scheduler',
  supplier: DigiflazzService = digiflazzService
): Promise<{ processed: number }> {
  const db = getDb();
  const now = new Date().toISOString();

  const jobs = db
    .prepare(
      `SELECT transaction_id FROM supplier_jobs
       WHERE status IN ('PENDING', 'UNKNOWN') AND next_attempt_at <= ?
       ORDER BY id ASC LIMIT 20`
    )
    .all(now) as Array<{ transaction_id: string }>;

  let processed = 0;
  for (const j of jobs) {
    const res = await processSingleSupplierJob(j.transaction_id, workerId, supplier);
    if (res.handled) processed++;
  }
  return { processed };
}

export async function runFullReconciliation(
  gateway: PaymentGatewayPort = defaultPaymentGateway,
  supplier: DigiflazzService = digiflazzService
) {
  const payRec = await reconcileUnknownAndMissedCallbacks(gateway);
  const supRec = await pollPendingSupplierJobs('reconciliation-worker', supplier);
  return { payRec, supRec };
}

/**
 * Startup Auto-Resume Recovery (Bagian 5 Section 4):
 * Runs after DB migrations & integrity verification, before scheduler starts accepting new work.
 */
export async function recoverTransactionsOnStartup(
  gateway: PaymentGatewayPort = defaultPaymentGateway,
  supplier: DigiflazzService = digiflazzService
) {
  const db = getDb();
  const now = new Date().toISOString();

  // 1. Release stale worker locks left behind by crash/restart
  withTransaction((txDb) => {
    txDb
      .prepare("UPDATE supplier_jobs SET locked_by = NULL, locked_at = NULL WHERE locked_by IS NOT NULL")
      .run();

    // 2. Ensure every PAID or PAID_PROCESSING transaction has a supplier_jobs record
    const paidWithoutJob = txDb
      .prepare(
        `SELECT t.transaction_id
         FROM transactions t
         LEFT JOIN supplier_jobs sj ON sj.transaction_id = t.transaction_id
         WHERE t.payment_status = 'PAID'
           AND t.transaction_status IN ('PAID', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING')
           AND sj.id IS NULL`
      )
      .all() as Array<{ transaction_id: string }>;

    for (const row of paidWithoutJob) {
      txDb
        .prepare(
          `INSERT OR IGNORE INTO supplier_jobs (transaction_id, status, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, 'PENDING', 0, ?, ?, ?)`
        )
        .run(row.transaction_id, now, now, now);
    }
  }, db);

  const pendingCounts = db
    .prepare(
      `SELECT
        SUM(CASE WHEN transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING') THEN 1 ELSE 0 END) as pending_invoices,
        SUM(CASE WHEN transaction_status IN ('PAID', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING') THEN 1 ELSE 0 END) as pending_supplier,
        SUM(CASE WHEN transaction_status = 'UNKNOWN' THEN 1 ELSE 0 END) as unknown_tx
       FROM transactions`
    )
    .get() as { pending_invoices: number | null; pending_supplier: number | null; unknown_tx: number | null };

  logger.info('Startup transaction auto-resume scan complete', {
    service: 'recovery',
    details: {
      pendingInvoices: pendingCounts.pending_invoices ?? 0,
      pendingSupplier: pendingCounts.pending_supplier ?? 0,
      unknownTransactions: pendingCounts.unknown_tx ?? 0,
    },
  });

  // 3. Immediately run one safe check cycle for pending payments & reconciliation
  await pollPendingPayments(gateway).catch((err) => {
    logger.warn('Startup payment poll warning', {
      service: 'recovery',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
  });

  await runFullReconciliation(gateway, supplier).catch((err) => {
    logger.warn('Startup reconciliation warning', {
      service: 'recovery',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
  });

  return pendingCounts;
}

export async function reconcileSingleTransactionManual(
  transactionId: string,
  gateway: PaymentGatewayPort = defaultPaymentGateway,
  supplier: DigiflazzService = digiflazzService
) {
  const db = getDb();
  const tx = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) as
    | TransactionRow
    | undefined;
  if (!tx) throw new Error('Transaksi tidak ditemukan');

  if (tx.payment_status !== 'PAID') {
    const gatewayRef = resolveGatewayReference(tx);
    if (!gatewayRef) {
      if (
        tx.supplier_status === 'NONE' &&
        !tx.qris_payload_json &&
        ['CREATED', 'UNKNOWN'].includes(tx.transaction_status)
      ) {
        transitionTransactionStatus(
          tx.transaction_id,
          'FAILED',
          'MANUAL_RECONCILE',
          'Rekonsiliasi manual: pembuatan invoice QRIS gagal sebelum menerima Gateway Ref sehingga tidak ada invoice aktif / pembayaran yang diproses',
          { paymentStatus: 'FAILED', completedAt: new Date().toISOString() }
        );
      }
    } else if (gateway.isConfigured()) {
      const { checkTransactionPaymentStatus, finalizeExpiredInvoice } = await import('./payment.service');
      const verified = await checkTransactionPaymentStatus(tx, gateway);
      if (verified) {
        const { check, effectiveGatewayRef } = verified;
        if (check.mappedStatus === 'PAID') {
          const { handleVerifiedPaymentPaid } = await import('./transaction.service');
          handleVerifiedPaymentPaid(
            tx.transaction_id,
            'MANUAL_RECONCILE',
            check.paidAt,
            effectiveGatewayRef
          );
        } else if (check.mappedStatus === 'EXPIRED') {
          await finalizeExpiredInvoice(tx, 'MANUAL_RECONCILE', gateway);
        } else if (check.mappedStatus === 'FAILED' || check.mappedStatus === 'CANCELLED') {
          if (['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'UNKNOWN'].includes(tx.transaction_status)) {
            transitionTransactionStatus(
              tx.transaction_id,
              'FAILED',
              'MANUAL_RECONCILE',
              `Rekonsiliasi manual menemukan gateway berstatus ${check.mappedStatus}`,
              { paymentStatus: check.mappedStatus, completedAt: new Date().toISOString() }
            );
          }
        } else if (check.mappedStatus === 'PENDING') {
          const isPastExpiry = tx.expired_at ? Date.now() >= new Date(tx.expired_at).getTime() : false;
          if (isPastExpiry) {
            await finalizeExpiredInvoice(tx, 'MANUAL_RECONCILE', gateway);
          } else if (tx.transaction_status === 'UNKNOWN') {
            transitionTransactionStatus(
              tx.transaction_id,
              'PENDING_PAYMENT',
              'MANUAL_RECONCILE',
              'Rekonsiliasi manual menemukan invoice masih PENDING di gateway',
              { paymentStatus: 'PENDING' }
            );
          }
        }
      }
    }
  }

  const refreshed = db
    .prepare('SELECT * FROM transactions WHERE transaction_id = ?')
    .get(transactionId) as TransactionRow;

  if (refreshed.payment_status === 'PAID' && !['SUCCESS', 'REFUNDED'].includes(refreshed.transaction_status)) {
    // Make sure job is due now so manual inquiry runs immediately
    db.prepare(
      `UPDATE supplier_jobs SET next_attempt_at = ?, locked_by = NULL, locked_at = NULL WHERE transaction_id = ?`
    ).run(new Date().toISOString(), transactionId);
    await processSingleSupplierJob(transactionId, 'manual-reconcile', supplier);
  }

  return db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId);
}
