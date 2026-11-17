import cron, { type ScheduledTask } from 'node-cron';
import { config } from '../config/env';
import { getDb } from '../database/connection';
import { logger } from '../logging/logger';
import { pollPendingPayments } from '../services/payment.reconciliation.service';
import { pollPendingSupplierJobs, runFullReconciliation } from '../services/reconciliation.service';
import { processPendingNotifications, emitServiceLogToGroups } from '../services/notification.service';
import { digiflazzService } from '../integrations/digiflazz.service';
import { runDatabaseBackup } from '../services/backup.service';
import { runAutomaticMemoryCleanup } from '../services/memory-cleanup.service';
import {
  formatProductAutoRefreshSummary,
  getProductAutoRefreshConfig,
  resolveProductRefreshCron,
  type ProductAutoRefreshConfig,
} from '../services/settings.service';

export interface SchedulerStatus {
  running: boolean;
  startedAt: string | null;
  lastPaymentPollAt: string | null;
  lastSupplierPollAt: string | null;
  lastReconciliationAt: string | null;
  lastNotificationRunAt: string | null;
  lastMemoryCleanupAt: string | null;
  lastProductSyncAt: string | null;
  productAutoRefreshSummary: string;
}

class CentralScheduler {
  private running = false;
  private startedAt: string | null = null;
  private intervals: NodeJS.Timeout[] = [];
  private cronTasks: ScheduledTask[] = [];
  private priceSyncInterval: NodeJS.Timeout | null = null;
  private priceSyncCronTask: ScheduledTask | null = null;
  private locks = {
    paymentPoll: false,
    supplierPoll: false,
    reconciliation: false,
    notification: false,
    cleanup: false,
    memoryCleanup: false,
    productSync: false,
  };

  private status: SchedulerStatus = {
    running: false,
    startedAt: null,
    lastPaymentPollAt: null,
    lastSupplierPollAt: null,
    lastReconciliationAt: null,
    lastNotificationRunAt: null,
    lastMemoryCleanupAt: null,
    lastProductSyncAt: null,
    productAutoRefreshSummary: `Cron: ${config.digiflazz.priceSyncCron} (${config.timezone})`,
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

    // 5. Temporary database record cleanup every 30 minutes (NEVER deletes transactions, audit_logs, or refund_ledger)
    const cleanupTimer = setInterval(() => {
      void this.runGuarded('cleanup', async () => {
        this.cleanupTemporaryRecords();
      });
    }, 30 * 60 * 1000);
    this.intervals.push(cleanupTimer);

    // 6. Automatic RAM, in-memory cache & SQLite memory cleanup every 5 minutes
    const memoryCleanupTimer = setInterval(() => {
      void this.runGuarded('memoryCleanup', async () => {
        const res = runAutomaticMemoryCleanup('AUTO');
        this.status.lastMemoryCleanupAt = res.ranAt;
      });
    }, 5 * 60 * 1000);
    this.intervals.push(memoryCleanupTimer);

    // 7. Dynamic Digiflazz Product Auto-Refresh (Interval / Daily Time / Cron / Disabled)
    this.rescheduleProductRefresh();

    // 8. SQLite Auto Backup Cron
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
      'Central scheduler aktif memantau pembayaran, supplier, rekonsiliasi, notifikasi, pembersihan RAM berkala, auto-refresh produk, dan backup.'
    );
  }

  private clearProductRefreshTimers(): void {
    if (this.priceSyncInterval) {
      clearInterval(this.priceSyncInterval);
      this.priceSyncInterval = null;
    }
    if (this.priceSyncCronTask) {
      this.priceSyncCronTask.stop();
      this.priceSyncCronTask = null;
    }
  }

  rescheduleProductRefresh(overrideConfig?: ProductAutoRefreshConfig): ProductAutoRefreshConfig {
    this.clearProductRefreshTimers();

    const cfg = overrideConfig ?? getProductAutoRefreshConfig();
    this.status.productAutoRefreshSummary = formatProductAutoRefreshSummary(cfg, config.timezone);

    if (!this.running || cfg.mode === 'DISABLED') {
      return cfg;
    }

    const executeSync = () => {
      void this.runGuarded('productSync', async () => {
        if (!digiflazzService.isConfigured()) return;
        const result = await digiflazzService.syncPrices('CRON');
        if (result.ok) {
          this.status.lastProductSyncAt = new Date().toISOString();
        }
      });
    };

    if (cfg.mode === 'INTERVAL') {
      const intervalMs = cfg.intervalMinutes * 60 * 1000;
      this.priceSyncInterval = setInterval(executeSync, intervalMs);
      logger.info('Product auto-refresh scheduled by interval', {
        service: 'scheduler',
        details: { mode: cfg.mode, intervalMinutes: cfg.intervalMinutes },
      });
      return cfg;
    }

    const cronExpr = resolveProductRefreshCron(cfg);
    if (cronExpr && cron.validate(cronExpr)) {
      this.priceSyncCronTask = cron.schedule(cronExpr, executeSync, { timezone: config.timezone });
      logger.info('Product auto-refresh scheduled by cron', {
        service: 'scheduler',
        details: { mode: cfg.mode, cronExpression: cronExpr, timezone: config.timezone },
      });
    }

    return cfg;
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

    this.clearProductRefreshTimers();

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
