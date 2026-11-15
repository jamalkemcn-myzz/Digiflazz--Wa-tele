import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config/env';
import { getDb } from '../database/connection';
import { logger } from '../logging/logger';
import { pollPendingPayments } from '../services/payment.reconciliation.service';
import { pollPendingSupplierJobs, runFullReconciliation } from '../services/reconciliation.service';
import { processPendingNotifications, emitServiceLogToGroups } from '../services/notification.service';
import { digiflazzService } from '../integrations/digiflazz.service';
import { runDatabaseBackup } from '../services/backup.service';

export interface SchedulerStatus {
  running: boolean;
  startedAt: string | null;
  lastPaymentPollAt: string | null;
  lastSupplierPollAt: string | null;
  lastReconciliationAt: string | null;
  lastNotificationRunAt: string | null;
}

class CentralScheduler {
  private running = false;
  private startedAt: string | null = null;
  private intervals: NodeJS.Timeout[] = [];
  private cronTasks: ScheduledTask[] = [];
  private locks = {
    paymentPoll: false,
    supplierPoll: false,
    reconciliation: false,
    notification: false,
    cleanup: false,
  };

  private status: SchedulerStatus = {
    running: false,
    startedAt: null,
    lastPaymentPollAt: null,
    lastSupplierPollAt: null,
    lastReconciliationAt: null,
    lastNotificationRunAt: null,
  };

  start(): void {
    if (this.running) {
      logger.warn('Scheduler already running; skipping duplicate start', { service: 'scheduler' });
      return;
    }

    this.running = true;
    this.startedAt = new Date().toISOString();
    this.status.running = true;
    this.status.startedAt = this.startedAt;

    // 1. Payment polling + 5-min expiration verification
    const paymentTimer = setInterval(() => {
      void this.runGuarded('paymentPoll', async () => {
        await pollPendingPayments();
        this.status.lastPaymentPollAt = new Date().toISOString();
      });
    }, config.scheduler.paymentPollIntervalSeconds * 1000);
    this.intervals.push(paymentTimer);

    // 2. Supplier transaction & inquiry polling
    const supplierTimer = setInterval(() => {
      void this.runGuarded('supplierPoll', async () => {
        await pollPendingSupplierJobs('central-scheduler');
        this.status.lastSupplierPollAt = new Date().toISOString();
      });
    }, config.scheduler.supplierPollIntervalSeconds * 1000);
    this.intervals.push(supplierTimer);

    // 3. Full reconciliation
    const reconcileTimer = setInterval(() => {
      void this.runGuarded('reconciliation', async () => {
        await runFullReconciliation();
        this.status.lastReconciliationAt = new Date().toISOString();
      });
    }, config.scheduler.reconciliationIntervalSeconds * 1000);
    this.intervals.push(reconcileTimer);

    // 4. Notification queue processor & retry
    const notifyTimer = setInterval(() => {
      void this.runGuarded('notification', async () => {
        await processPendingNotifications();
        this.status.lastNotificationRunAt = new Date().toISOString();
      });
    }, config.scheduler.notificationRetryIntervalSeconds * 1000);
    this.intervals.push(notifyTimer);

    // 5. Temporary data cleanup every 30 minutes (NEVER deletes transactions, audit_logs, or refund_ledger)
    const cleanupTimer = setInterval(() => {
      void this.runGuarded('cleanup', async () => {
        this.cleanupTemporaryRecords();
      });
    }, 30 * 60 * 1000);
    this.intervals.push(cleanupTimer);

    // 6. Digiflazz Price Sync Cron
    if (cron.validate(config.digiflazz.priceSyncCron)) {
      const priceTask = cron.schedule(
        config.digiflazz.priceSyncCron,
        () => {
          if (digiflazzService.isConfigured()) {
            void digiflazzService.syncPrices('CRON');
          }
        },
        { timezone: config.timezone }
      );
      this.cronTasks.push(priceTask);
    }

    // 7. SQLite Auto Backup Cron
    if (config.backup.enabled && cron.validate(config.backup.cron)) {
      const backupTask = cron.schedule(
        config.backup.cron,
        () => {
          void runDatabaseBackup('CRON');
        },
        { timezone: config.timezone }
      );
      this.cronTasks.push(backupTask);
    }

    logger.info('Central scheduler started', { service: 'scheduler' });
    emitServiceLogToGroups(
      `scheduler-start-${Date.now()}`,
      'Scheduler Started',
      'Central scheduler aktif memantau pembayaran, supplier, rekonsiliasi, notifikasi, sinkronisasi harga, dan backup.'
    );
  }

  private async runGuarded(key: keyof typeof this.locks, task: () => Promise<void>): Promise<void> {
    if (!this.running || this.locks[key]) return;
    this.locks[key] = true;
    try {
      await task();
    } catch (err) {
      logger.error(`Scheduler task '${key}' error`, {
        service: 'scheduler',
        details: { error: err instanceof Error ? err.message : 'unknown' },
      });
    } finally {
      this.locks[key] = false;
    }
  }

  private cleanupTemporaryRecords(): void {
    const db = getDb();
    const linkCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cooldownCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const svcLogCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const deletedLinks = db
      .prepare('DELETE FROM account_link_codes WHERE expires_at < ? OR used_at IS NOT NULL AND created_at < ?')
      .run(linkCutoff, linkCutoff).changes;
    const deletedCooldowns = db
      .prepare('DELETE FROM cooldowns WHERE until_at < ?')
      .run(cooldownCutoff).changes;
    const deletedServiceLogs = db
      .prepare('DELETE FROM service_logs WHERE created_at < ?')
      .run(svcLogCutoff).changes;

    if (deletedLinks > 0 || deletedCooldowns > 0 || deletedServiceLogs > 0) {
      logger.info('Temporary data retention cleanup executed', {
        service: 'cleanup',
        details: { deletedLinks, deletedCooldowns, deletedServiceLogs },
      });
    }
  }

  getStatus(): SchedulerStatus {
    return { ...this.status };
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.status.running = false;

    for (const timer of this.intervals) {
      clearInterval(timer);
    }
    this.intervals = [];

    for (const task of this.cronTasks) {
      task.stop();
    }
    this.cronTasks = [];

    logger.info('Central scheduler stopped cleanly', { service: 'scheduler' });
  }
}

export const centralScheduler = new CentralScheduler();
