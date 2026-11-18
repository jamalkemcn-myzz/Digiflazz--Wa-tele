import { Router, type Request, type Response } from 'express';
import { getDb } from '../../database/connection';
import { config, getSafeConfigSummary } from '../../config/env';
import { requireDashboardAuth, requirePermission } from '../middleware/auth';
import { adminRateLimiter } from '../middleware/rate-limit';
import {
  getOverviewMetrics,
  listTransactions,
  getTransactionDetail,
} from '../../services/transaction.service';
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategorySafely,
  listProducts,
  upsertProduct,
  updateProductStatus,
  deleteProductSafely,
  getGlobalMarginRule,
} from '../../services/product.service';
import { listCustomersDetailed } from '../../services/customer.service';
import {
  setGlobalMargin,
  setCategoryMargin,
  setProductMargin,
  listMarginHistory,
} from '../../services/margin.service';
import {
  listCoupons,
  listCouponUsages,
  createCoupon,
  updateCoupon,
  deleteCouponSafely,
} from '../../services/coupon.service';
import {
  listRefunds,
  listRefundLedger,
  applyManualRefundOrAdjustment,
  checkTransactionRefundEligibility,
} from '../../services/refund.service';
import {
  isMaintenanceMode,
  setMaintenanceMode,
  getProductAutoRefreshConfig,
  saveProductAutoRefreshConfig,
  formatProductAutoRefreshSummary,
} from '../../services/settings.service';
import { listAuditLogs } from '../../services/audit.service';
import { getNotificationQueueStats } from '../../services/notification.service';
import { runDatabaseBackup, listBackupFiles, listBackupLogs } from '../../services/backup.service';
import {
  listAdmins,
  createAdmin,
  updateAdminRole,
  addAdminIdentity,
  removeAdminIdentity,
  resetAdminsAndSyncOwner,
} from '../../services/admin.service';
import { reconcileSingleTransactionManual } from '../../services/reconciliation.service';
import { digiflazzService } from '../../integrations/digiflazz.service';
import { whatsappService } from '../../bots/whatsapp.service';
import { telegramService } from '../../bots/telegram.service';
import { centralScheduler } from '../../workers/scheduler';
import { recordAuditLog } from '../../services/audit.service';
import { runBotDemoInteraction } from '../../services/bot-demo.service';
import { runAutomaticMemoryCleanup } from '../../services/memory-cleanup.service';

export const adminRouter = Router();

adminRouter.use(adminRateLimiter);
adminRouter.use(requireDashboardAuth);

// A. OVERVIEW
adminRouter.get('/overview', requirePermission('overview:read'), (_req: Request, res: Response) => {
  const metrics = getOverviewMetrics();
  res.json({
    ok: true,
    data: {
      metrics,
      maintenanceMode: isMaintenanceMode(),
      services: {
        backend: { status: 'UP' },
        database: { status: 'CONNECTED' },
        whatsapp: whatsappService.getStatus(),
        telegram: telegramService.getStatus(),
        scheduler: centralScheduler.getStatus(),
        digiflazz: { configured: digiflazzService.isConfigured(), syncRunning: digiflazzService.isPriceSyncRunning() },
        notifications: getNotificationQueueStats(),
      },
      config: getSafeConfigSummary(),
    },
  });
});

// B. TRANSACTIONS
adminRouter.get('/transactions', requirePermission('transactions:read'), (req: Request, res: Response) => {
  const data = listTransactions({
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    platform: typeof req.query.platform === 'string' ? req.query.platform : undefined,
    dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
    dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
  });
  res.json({ ok: true, data });
});

adminRouter.get('/transactions/:transactionId', requirePermission('transactions:read'), (req: Request, res: Response) => {
  const detail = getTransactionDetail(String(req.params.transactionId));
  if (!detail) {
    res.status(404).json({ ok: false, error: 'Transaksi tidak ditemukan' });
    return;
  }
  const refundEligibility = checkTransactionRefundEligibility(String(req.params.transactionId));
  res.json({ ok: true, data: { ...detail, refundEligibility } });
});

adminRouter.post(
  '/transactions/:transactionId/reconcile',
  requirePermission('transactions:reconcile'),
  async (req: Request, res: Response, next) => {
    try {
      const txId = String(req.params.transactionId);
      const updated = await reconcileSingleTransactionManual(txId);
      recordAuditLog({
        actorId: req.admin!.username,
        actorRole: req.admin!.role,
        action: 'TRANSACTION_MANUAL_RECONCILE',
        targetType: 'TRANSACTION',
        targetId: txId,
      });
      res.json({ ok: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

// C. PRODUCTS & D. CATEGORIES
adminRouter.get('/products', requirePermission('products:read'), (req: Request, res: Response) => {
  const data = listProducts({
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 30,
    categoryId: req.query.categoryId ? Number(req.query.categoryId) : undefined,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
  });
  res.json({ ok: true, data });
});

adminRouter.post('/products', requirePermission('products:write'), (req: Request, res: Response, next) => {
  try {
    const product = upsertProduct(req.body, { id: req.admin!.username, role: req.admin!.role });
    res.status(201).json({ ok: true, data: product });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/products/:id/status', requirePermission('products:write'), (req: Request, res: Response, next) => {
  try {
    const status = req.body.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const updated = updateProductStatus(Number(req.params.id), status, {
      id: req.admin!.username,
      role: req.admin!.role,
    });
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/products/:id', requirePermission('products:write'), (req: Request, res: Response, next) => {
  try {
    const result = deleteProductSafely(Number(req.params.id), {
      id: req.admin!.username,
      role: req.admin!.role,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/products/sync-digiflazz', requirePermission('products:write'), async (req: Request, res: Response) => {
  const result = await digiflazzService.syncPrices('MANUAL');
  recordAuditLog({
    actorId: req.admin!.username,
    actorRole: req.admin!.role,
    action: 'DIGIFLAZZ_MANUAL_SYNC',
    targetType: 'PRODUCTS',
    details: { ok: result.ok, successCount: result.successCount, failureCount: result.failureCount },
  });
  res.status(result.ok ? 200 : 400).json({ ok: result.ok, data: result, error: result.errorMessage });
});

adminRouter.get('/products/sync-logs', requirePermission('products:read'), (_req: Request, res: Response) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM price_sync_logs ORDER BY id DESC LIMIT 20').all();
  res.json({ ok: true, data: logs });
});

adminRouter.get('/products/auto-refresh', requirePermission('products:read'), (_req: Request, res: Response) => {
  const autoCfg = getProductAutoRefreshConfig();
  const sched = centralScheduler.getStatus();
  res.json({
    ok: true,
    data: {
      config: autoCfg,
      summary: formatProductAutoRefreshSummary(autoCfg, config.timezone),
      timezone: config.timezone,
      digiflazzConfigured: digiflazzService.isConfigured(),
      syncRunning: digiflazzService.isPriceSyncRunning(),
      lastProductSyncAt: sched.lastProductSyncAt,
    },
  });
});

adminRouter.put('/products/auto-refresh', requirePermission('products:write'), (req: Request, res: Response, next) => {
  try {
    const saved = saveProductAutoRefreshConfig(
      {
        mode: String(req.body?.mode || ''),
        intervalMinutes:
          req.body?.intervalMinutes !== undefined && req.body?.intervalMinutes !== null && req.body?.intervalMinutes !== ''
            ? Number(req.body.intervalMinutes)
            : undefined,
        dailyTime: typeof req.body?.dailyTime === 'string' ? req.body.dailyTime : undefined,
        cronExpression: typeof req.body?.cronExpression === 'string' ? req.body.cronExpression : undefined,
      },
      { id: req.admin!.username, role: req.admin!.role }
    );
    centralScheduler.rescheduleProductRefresh(saved);
    res.json({
      ok: true,
      data: {
        config: saved,
        summary: formatProductAutoRefreshSummary(saved, config.timezone),
        timezone: config.timezone,
        digiflazzConfigured: digiflazzService.isConfigured(),
        syncRunning: digiflazzService.isPriceSyncRunning(),
        lastProductSyncAt: centralScheduler.getStatus().lastProductSyncAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/categories', requirePermission('products:read'), (_req: Request, res: Response) => {
  res.json({ ok: true, data: listCategories(false) });
});

adminRouter.post('/categories', requirePermission('categories:write'), (req: Request, res: Response, next) => {
  try {
    const created = createCategory(req.body, { id: req.admin!.username, role: req.admin!.role });
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/categories/:id', requirePermission('categories:write'), (req: Request, res: Response, next) => {
  try {
    const updated = updateCategory(Number(req.params.id), req.body, {
      id: req.admin!.username,
      role: req.admin!.role,
    });
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/categories/:id', requirePermission('categories:write'), (req: Request, res: Response, next) => {
  try {
    const result = deleteCategorySafely(Number(req.params.id), {
      id: req.admin!.username,
      role: req.admin!.role,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// E. COUPONS
adminRouter.get('/coupons', requirePermission('coupons:read'), (_req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      coupons: listCoupons(),
      usages: listCouponUsages(undefined, 50),
    },
  });
});

adminRouter.post('/coupons', requirePermission('coupons:write'), (req: Request, res: Response, next) => {
  try {
    const created = createCoupon(req.body, { id: req.admin!.username, role: req.admin!.role });
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/coupons/:id', requirePermission('coupons:write'), (req: Request, res: Response, next) => {
  try {
    const updated = updateCoupon(Number(req.params.id), req.body, {
      id: req.admin!.username,
      role: req.admin!.role,
    });
    res.json({ ok: true, data: updated });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/coupons/:id', requirePermission('coupons:write'), (req: Request, res: Response, next) => {
  try {
    deleteCouponSafely(Number(req.params.id), { id: req.admin!.username, role: req.admin!.role });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// F. MARGIN SETTINGS
adminRouter.get('/margins', requirePermission('products:read'), (_req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      globalMargin: getGlobalMarginRule(),
      history: listMarginHistory(50),
    },
  });
});

adminRouter.put('/margins/global', requirePermission('margins:write'), (req: Request, res: Response, next) => {
  try {
    const marginType = req.body.marginType === 'PERCENT' ? 'PERCENT' : 'FIXED';
    const marginValue = Number(req.body.marginValue);
    const maxMargin =
      req.body.maxMargin !== null && req.body.maxMargin !== undefined && req.body.maxMargin !== ''
        ? Number(req.body.maxMargin)
        : null;
    const result = setGlobalMargin(
      marginType,
      marginValue,
      {
        id: req.admin!.username,
        role: req.admin!.role,
      },
      maxMargin
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/margins/category/:id', requirePermission('margins:write'), (req: Request, res: Response, next) => {
  try {
    const marginType = req.body.marginType ?? null;
    const marginValue = req.body.marginValue !== null && req.body.marginValue !== undefined ? Number(req.body.marginValue) : null;
    const maxMargin =
      req.body.maxMargin !== null && req.body.maxMargin !== undefined && req.body.maxMargin !== ''
        ? Number(req.body.maxMargin)
        : null;
    const result = setCategoryMargin(
      Number(req.params.id),
      marginType,
      marginValue,
      {
        id: req.admin!.username,
        role: req.admin!.role,
      },
      maxMargin
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

adminRouter.put('/margins/product/:id', requirePermission('margins:write'), (req: Request, res: Response, next) => {
  try {
    const marginType = req.body.marginType ?? null;
    const marginValue = req.body.marginValue !== null && req.body.marginValue !== undefined ? Number(req.body.marginValue) : null;
    const maxMargin =
      req.body.maxMargin !== null && req.body.maxMargin !== undefined && req.body.maxMargin !== ''
        ? Number(req.body.maxMargin)
        : null;
    const result = setProductMargin(
      Number(req.params.id),
      marginType,
      marginValue,
      {
        id: req.admin!.username,
        role: req.admin!.role,
      },
      maxMargin
    );
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// G. REFUNDS (Internal only - zero deposit/top-up endpoints)
adminRouter.get('/refunds', requirePermission('refunds:read'), (req: Request, res: Response) => {
  const page = Number(req.query.page) || 1;
  res.json({
    ok: true,
    data: {
      refunds: listRefunds(page, 25),
      ledger: listRefundLedger(page, 30),
    },
  });
});

adminRouter.get('/customers', requirePermission('refunds:read'), (_req: Request, res: Response) => {
  const db = getDb();
  const customers = db
    .prepare('SELECT id, customer_code, status, created_at FROM customers ORDER BY id DESC LIMIT 100')
    .all();
  res.json({ ok: true, data: customers });
});

adminRouter.get('/users', requirePermission('overview:read'), (req: Request, res: Response) => {
  const data = listCustomersDetailed({
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 25,
    search: typeof req.query.search === 'string' ? req.query.search : undefined,
  });
  res.json({ ok: true, data });
});

adminRouter.post('/refunds/adjust', requirePermission('refunds:adjust'), (req: Request, res: Response, next) => {
  try {
    const result = applyManualRefundOrAdjustment(
      {
        customerId: Number(req.body.customerId),
        transactionId: req.body.transactionId || null,
        entryType: req.body.entryType === 'MANUAL_ADJUSTMENT_DEBIT' ? 'MANUAL_ADJUSTMENT_DEBIT' : 'MANUAL_ADJUSTMENT_CREDIT',
        amount: Number(req.body.amount),
        reason: String(req.body.reason || ''),
      },
      { id: req.admin!.username, role: req.admin!.role }
    );
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// H. BOT MANAGEMENT
adminRouter.get('/bots/status', requirePermission('bots:read'), (_req: Request, res: Response) => {
  res.json({
    ok: true,
    data: {
      whatsapp: whatsappService.getStatus(),
      telegram: telegramService.getStatus(),
      notifications: getNotificationQueueStats(),
      logChannels: getSafeConfigSummary().logChannels,
    },
  });
});

adminRouter.post('/bots/whatsapp/pairing-code', requirePermission('bots:pairing'), async (req: Request, res: Response, next) => {
  try {
    const phoneNumber = String(req.body.phoneNumber || '');
    const code = await whatsappService.requestPairingCode(phoneNumber);
    recordAuditLog({
      actorId: req.admin!.username,
      actorRole: req.admin!.role,
      action: 'WHATSAPP_PAIRING_CODE_GENERATED',
      targetType: 'BOT_WHATSAPP',
      details: { targetLength: phoneNumber.length },
    });
    res.json({ ok: true, data: { pairingCode: code } });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/bots/whatsapp/reconnect', requirePermission('bots:manage'), async (req: Request, res: Response, next) => {
  try {
    const resetSession = Boolean(req.body?.resetSession);
    await whatsappService.reconnect(resetSession);
    recordAuditLog({
      actorId: req.admin!.username,
      actorRole: req.admin!.role,
      action: 'WHATSAPP_RECONNECT_TRIGGERED',
      targetType: 'BOT_WHATSAPP',
      details: { resetSession },
    });
    res.json({ ok: true, data: whatsappService.getStatus() });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/bots/telegram/reconnect', requirePermission('bots:manage'), async (req: Request, res: Response, next) => {
  try {
    await telegramService.reconnect();
    recordAuditLog({
      actorId: req.admin!.username,
      actorRole: req.admin!.role,
      action: 'TELEGRAM_RECONNECT_TRIGGERED',
      targetType: 'BOT_TELEGRAM',
    });
    res.json({ ok: true, data: telegramService.getStatus() });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/bots/demo', requirePermission('bots:read'), async (req: Request, res: Response, next) => {
  try {
    const platform = req.body?.platform === 'TELEGRAM' ? 'TELEGRAM' : 'WHATSAPP';
    const senderRole = req.body?.senderRole === 'ADMIN' ? 'ADMIN' : 'CUSTOMER';
    const inputType = req.body?.inputType === 'CALLBACK' ? 'CALLBACK' : 'TEXT';
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
    const callbackData = typeof req.body?.callbackData === 'string' ? req.body.callbackData : undefined;
    const senderId = typeof req.body?.senderId === 'string' ? req.body.senderId : undefined;

    const result = await runBotDemoInteraction({
      platform,
      senderRole,
      inputType,
      text,
      callbackData,
      senderId,
      actor: {
        id: req.admin!.username,
        role: req.admin!.role,
      },
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// I. LOGS
adminRouter.get('/logs', requirePermission('logs:read'), (req: Request, res: Response) => {
  const type = typeof req.query.type === 'string' ? req.query.type : 'service';
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const offset = (page - 1) * limit;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const level = typeof req.query.level === 'string' ? req.query.level.trim() : '';

  if (type === 'audit') {
    res.json({ ok: true, data: listAuditLogs({ page, limit, search: search || undefined }) });
    return;
  }

  const db = getDb();
  if (type === 'transactions') {
    const where: string[] = [];
    const args: unknown[] = [];
    if (search) {
      where.push('(transaction_id LIKE ? OR new_status LIKE ? OR description LIKE ?)');
      const q = `%${search}%`;
      args.push(q, q, q);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      db.prepare(`SELECT COUNT(*) as cnt FROM transaction_status_history ${whereSql}`).get(...args) as { cnt: number }
    ).cnt;
    const items = db
      .prepare(`SELECT * FROM transaction_status_history ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    res.json({
      ok: true,
      data: { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } },
    });
    return;
  }

  // Default: service_logs
  const where: string[] = [];
  const args: unknown[] = [];
  if (level && level !== 'ALL') {
    where.push('level = ?');
    args.push(level.toLowerCase());
  }
  if (search) {
    where.push('(service LIKE ? OR message LIKE ? OR transaction_id LIKE ?)');
    const q = `%${search}%`;
    args.push(q, q, q);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM service_logs ${whereSql}`).get(...args) as { cnt: number }
  ).cnt;
  const items = db
    .prepare(`SELECT * FROM service_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);

  res.json({
    ok: true,
    data: { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } },
  });
});

// J. SETTINGS, MAINTENANCE, BACKUPS, ADMINS
adminRouter.get('/settings', requirePermission('settings:read'), (_req: Request, res: Response) => {
  const productAutoRefresh = getProductAutoRefreshConfig();
  res.json({
    ok: true,
    data: {
      maintenanceMode: isMaintenanceMode(),
      config: getSafeConfigSummary(),
      productAutoRefresh: {
        config: productAutoRefresh,
        summary: formatProductAutoRefreshSummary(productAutoRefresh, config.timezone),
      },
      backupFiles: listBackupFiles(),
      backupLogs: listBackupLogs(20),
      admins: listAdmins(),
    },
  });
});

adminRouter.put('/settings/maintenance', requirePermission('maintenance:toggle'), (req: Request, res: Response) => {
  const enabled = Boolean(req.body.enabled);
  const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
  const result = setMaintenanceMode(enabled, { id: req.admin!.username, role: req.admin!.role }, reason);
  res.json({ ok: true, data: { maintenanceMode: result } });
});

adminRouter.post('/backups/run', requirePermission('backups:manage'), async (req: Request, res: Response) => {
  const result = await runDatabaseBackup('MANUAL', { id: req.admin!.username, role: req.admin!.role });
  res.status(result.ok ? 200 : 500).json({ ok: result.ok, data: result, error: result.errorMessage });
});

adminRouter.post('/system/memory-cleanup', requirePermission('backups:manage'), (req: Request, res: Response) => {
  const result = runAutomaticMemoryCleanup('MANUAL');
  recordAuditLog({
    actorId: req.admin!.username,
    actorRole: req.admin!.role,
    action: 'MANUAL_MEMORY_CLEANUP',
    targetType: 'SYSTEM',
    details: {
      evictedEntries: result.evicted.total,
      rssBeforeMb: result.before.rssMb,
      rssAfterMb: result.after.rssMb,
    },
  });
  res.json({ ok: true, data: result });
});

adminRouter.post('/admins', requirePermission('admins:manage'), (req: Request, res: Response, next) => {
  try {
    const created = createAdmin(
      {
        name: String(req.body.name || ''),
        role: req.body.role,
        platform: req.body.platform || undefined,
        platformUserId: typeof req.body.platformUserId === 'string' ? req.body.platformUserId : undefined,
      },
      { id: req.admin!.username, role: req.admin!.role }
    );
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/admins/reset', requirePermission('admins:manage'), (req: Request, res: Response, next) => {
  try {
    const mode =
      req.body?.mode === 'RESET_TO_PRIMARY_OWNER'
        ? 'RESET_TO_PRIMARY_OWNER'
        : 'SYNC_OWNER_FROM_ENV';
    const admins = resetAdminsAndSyncOwner(mode, {
      id: req.admin!.username,
      role: req.admin!.role,
    });
    res.json({ ok: true, data: admins });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/admins/:id/identities', requirePermission('admins:manage'), (req: Request, res: Response, next) => {
  try {
    addAdminIdentity(
      Number(req.params.id),
      req.body.platform,
      String(req.body.platformUserId || ''),
      { id: req.admin!.username, role: req.admin!.role }
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete(
  '/admins/:id/identities/:identityId',
  requirePermission('admins:manage'),
  (req: Request, res: Response, next) => {
    try {
      removeAdminIdentity(Number(req.params.id), Number(req.params.identityId), {
        id: req.admin!.username,
        role: req.admin!.role,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

adminRouter.patch('/admins/:id/role', requirePermission('admins:manage'), (req: Request, res: Response, next) => {
  try {
    updateAdminRole(
      Number(req.params.id),
      req.body.role,
      req.body.status || 'ACTIVE',
      { id: req.admin!.username, role: req.admin!.role },
      typeof req.body.name === 'string' ? req.body.name : undefined
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
