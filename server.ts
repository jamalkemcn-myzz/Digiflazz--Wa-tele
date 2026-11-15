import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { config } from './server/config/env';
import { logger, registerDbLogSink } from './server/logging/logger';
import { getDb, closeDb } from './server/database/connection';
import { runMigrations, verifyDatabaseIntegrity } from './server/database/migrate';
import { recoverTransactionsOnStartup } from './server/services/reconciliation.service';
import { centralScheduler } from './server/workers/scheduler';
import { whatsappService } from './server/bots/whatsapp.service';
import { telegramService } from './server/bots/telegram.service';
import { createExpressApp } from './server/http/app';

let httpServer: http.Server | null = null;
let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}; starting graceful shutdown`, { service: 'main' });

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timeout exceeded; forcing exit', { service: 'main' });
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  try {
    centralScheduler.stop();
    await whatsappService.stop().catch(() => undefined);
    await telegramService.stop().catch(() => undefined);

    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }

    registerDbLogSink(null);
    closeDb();
    logger.info('Graceful shutdown completed', { service: 'main' });
  } catch (err) {
    logger.error('Error during graceful shutdown', {
      service: 'main',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => void gracefulShutdown('SIGINT', 0));
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM', 0));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    service: 'process',
    details: { reason: reason instanceof Error ? reason.message : String(reason) },
  });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception; shutting down safely for Pterodactyl auto-restart', {
    service: 'process',
    details: { error: err.message },
  });
  void gracefulShutdown('uncaughtException', 1);
});

async function bootstrap() {
  // 1. Database initialization & migration
  const db = getDb();
  runMigrations(db);
  verifyDatabaseIntegrity(db);

  // 2. Register persistent service_logs DB sink
  registerDbLogSink((entry) => {
    db.prepare(
      `INSERT INTO service_logs (level, service, transaction_id, message, details_safe, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      entry.level,
      entry.service,
      entry.transactionId ?? null,
      entry.message,
      entry.detailsSafe ?? null,
      entry.createdAt
    );
  });

  // 3. Startup Auto-Resume Recovery (must complete before scheduler/bots accept new work)
  await recoverTransactionsOnStartup();

  // 4. Start Central Scheduler
  centralScheduler.start();

  // 5. Build Express App & attach Vite (dev) or dist/ (prod)
  const app = createExpressApp();

  if (config.nodeEnv !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  // 6. Start HTTP Server on configured port (3000)
  await new Promise<void>((resolve) => {
    httpServer = app.listen(config.port, '0.0.0.0', () => {
      logger.info(`PPOB Bot Ecosystem HTTP server listening on port ${config.port}`, {
        service: 'http',
      });
      resolve();
    });
  });

  // 7. Start WhatsApp & Telegram Bots independently (one failing does not crash backend)
  await whatsappService.start().catch((err) => {
    logger.error('WhatsApp startup failed independently', {
      service: 'whatsapp',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
  });

  await telegramService.start().catch((err) => {
    logger.error('Telegram startup failed independently', {
      service: 'telegram',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
  });
}

void bootstrap().catch((err) => {
  logger.error('Fatal startup failure', {
    service: 'main',
    details: { error: err instanceof Error ? err.message : String(err) },
  });
  process.exit(1);
});
