import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config, getIntegrationReadiness } from '../config/env';
import { getDb } from '../database/connection';
import { logger } from '../logging/logger';
import {
  isAuthConfigured,
  parseBasicAuthHeader,
  requireDashboardAuth,
  SESSION_COOKIE_NAME,
  signSessionToken,
  tryAuthenticateDashboardRequest,
  verifyBasicCredentials,
} from './middleware/auth';
import { authRateLimiter, webhookRateLimiter } from './middleware/rate-limit';
import { handleMyZZStoreCallback } from './controllers/payment.callback.controller';
import { adminRouter } from './routes/admin.routes';
import { whatsappService } from '../bots/whatsapp.service';
import { telegramService } from '../bots/telegram.service';
import { centralScheduler } from '../workers/scheduler';
import { recordAuditLog } from '../services/audit.service';

export function createExpressApp() {
  const app = express();

  if (config.security.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(
    cors({
      origin: config.nodeEnv === 'production' ? config.appUrl : true,
      credentials: true,
    })
  );

  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf.toString('utf8');
      },
    })
  );

  // Public Safe Health Check (no secrets or sensitive internal stack details)
  app.get('/api/health', (_req: Request, res: Response) => {
    let dbHealthy = false;
    let pendingTransactions = 0;
    let pendingSupplierJobs = 0;
    let lastPriceSync: unknown = null;
    let lastBackup: unknown = null;

    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      dbHealthy = true;
      pendingTransactions = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM transactions WHERE transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING', 'UNKNOWN')"
          )
          .get() as { cnt: number }
      ).cnt;
      pendingSupplierJobs = (
        db
          .prepare("SELECT COUNT(*) as cnt FROM supplier_jobs WHERE status IN ('PENDING', 'PROCESSING', 'UNKNOWN')")
          .get() as { cnt: number }
      ).cnt;
      lastPriceSync = db
        .prepare('SELECT status, completed_at FROM price_sync_logs ORDER BY id DESC LIMIT 1')
        .get() ?? null;
      lastBackup = db
        .prepare('SELECT status, completed_at FROM backup_logs ORDER BY id DESC LIMIT 1')
        .get() ?? null;
    } catch {
      dbHealthy = false;
    }

    const readiness = getIntegrationReadiness();
    res.status(dbHealthy ? 200 : 503).json({
      ok: dbHealthy,
      status: dbHealthy ? 'healthy' : 'degraded',
      services: {
        backend: 'UP',
        sqlite: dbHealthy ? 'UP' : 'DOWN',
        whatsapp: whatsappService.getStatus().state,
        telegram: telegramService.getStatus().state,
        scheduler: centralScheduler.getStatus().running ? 'RUNNING' : 'STOPPED',
        paymentGatewayConfigured: readiness.myzzstore.configured && readiness.myzzstore.apiSpecConfigured,
        digiflazzConfigured: readiness.digiflazz.configured,
      },
      metrics: {
        pendingTransactions,
        pendingSupplierJobs,
        lastPriceSync,
        lastBackup,
      },
    });
  });

  // Auth status & Basic Auth login/logout
  app.get('/api/auth/status', (req: Request, res: Response) => {
    const admin = tryAuthenticateDashboardRequest(req);
    res.json({
      ok: true,
      authConfigured: isAuthConfigured(),
      authenticated: Boolean(admin),
      admin,
    });
  });

  app.post('/api/auth/login', authRateLimiter, (req: Request, res: Response) => {
    if (!isAuthConfigured()) {
      res.status(503).json({
        ok: false,
        error: 'Konfigurasi DASHBOARD_AUTH_USER dan DASHBOARD_AUTH_PASSWORD belum diisi pada server (.env).',
      });
      return;
    }

    const basic = parseBasicAuthHeader(req.headers.authorization);
    if (!basic) {
      res.status(401).json({ ok: false, error: 'Header Basic Authentication wajib dikirim' });
      return;
    }

    const admin = verifyBasicCredentials(basic.username, basic.password);
    if (!admin) {
      recordAuditLog({
        actorId: basic.username || 'unknown',
        actorRole: 'ANONYMOUS',
        action: 'DASHBOARD_LOGIN_FAILED',
        targetType: 'AUTH',
        details: { ip: req.ip },
      });
      res.status(401).json({ ok: false, error: 'Username atau password salah' });
      return;
    }

    const isHttps =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      config.appUrl.startsWith('https://');
    const cookieOpts = isHttps
      ? {
          httpOnly: true,
          sameSite: 'none' as const,
          secure: true,
          partitioned: true,
          maxAge: 12 * 60 * 60 * 1000,
          path: '/',
        }
      : {
          httpOnly: true,
          sameSite: 'lax' as const,
          secure: false,
          maxAge: 12 * 60 * 60 * 1000,
          path: '/',
        };

    const token = signSessionToken(admin.username);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOpts);

    recordAuditLog({
      actorId: admin.username,
      actorRole: admin.role,
      action: 'DASHBOARD_LOGIN_SUCCESS',
      targetType: 'AUTH',
      details: { ip: req.ip },
    });

    res.json({ ok: true, admin, sessionToken: token });
  });

  app.get('/api/auth/me', requireDashboardAuth, (req: Request, res: Response) => {
    res.json({ ok: true, admin: req.admin });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const isHttps =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      config.appUrl.startsWith('https://');
    res.clearCookie(SESSION_COOKIE_NAME, {
      path: '/',
      ...(isHttps ? { sameSite: 'none' as const, secure: true, partitioned: true } : {}),
    });
    res.status(200).json({ ok: true });
  });

  // Payment Gateway Callback Endpoint
  app.post('/api/webhooks/myzzstore', webhookRateLimiter, handleMyZZStoreCallback);

  // Admin REST API
  app.use('/api/admin', adminRouter);

  // Centralized API Error Handler (never leaks stack traces or secrets)
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Terjadi kesalahan internal';
    logger.error('HTTP API error', {
      service: 'express',
      details: { message },
    });
    const isValidation =
      message.includes('wajib') ||
      message.includes('tidak ditemukan') ||
      message.includes('tidak valid') ||
      message.includes('masih memiliki') ||
      message.includes('dilarang') ||
      message.includes('tidak boleh');
    res.status(isValidation ? 400 : 500).json({
      ok: false,
      error: message,
    });
  });

  return app;
}
