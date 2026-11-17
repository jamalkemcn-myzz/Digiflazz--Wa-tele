import cron from 'node-cron';
import { config } from '../config/env';
import { getDb, withTransaction } from '../database/connection';
import { recordAuditLog } from './audit.service';

export type ProductAutoRefreshMode = 'DISABLED' | 'INTERVAL' | 'DAILY_TIME' | 'CRON';

export interface ProductAutoRefreshConfig {
  mode: ProductAutoRefreshMode;
  intervalMinutes: number;
  dailyTime: string;
  cronExpression: string;
  updatedAt: string | null;
}

const PRODUCT_AUTO_REFRESH_KEY = 'product_auto_refresh_config';

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT setting_value FROM settings WHERE setting_key = ?').get(key) as
    | { setting_value: string }
    | undefined;
  return row ? row.setting_value : null;
}

export function isMaintenanceMode(): boolean {
  return getSetting('maintenance_mode') === 'true';
}

export function setMaintenanceMode(
  enabled: boolean,
  actor: { id: string; role: string },
  reason?: string
): boolean {
  const now = new Date().toISOString();
  withTransaction((txDb) => {
    txDb
      .prepare(
        `INSERT INTO settings (setting_key, setting_value, updated_at)
         VALUES ('maintenance_mode', ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`
      )
      .run(String(enabled), now);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: enabled ? 'MAINTENANCE_ENABLED' : 'MAINTENANCE_DISABLED',
    targetType: 'SYSTEM_SETTINGS',
    targetId: 'maintenance_mode',
    details: { enabled, reason: reason || null },
  });

  return enabled;
}

function getDefaultProductAutoRefreshConfig(): ProductAutoRefreshConfig {
  const envInterval = config.digiflazz.priceSyncIntervalMinutes;
  const envCron = config.digiflazz.priceSyncCron || '0 */6 * * *';
  return {
    mode: envInterval && envInterval >= 5 ? 'INTERVAL' : 'CRON',
    intervalMinutes: envInterval && envInterval >= 5 ? envInterval : 360,
    dailyTime: '02:00',
    cronExpression: envCron,
    updatedAt: null,
  };
}

export function getProductAutoRefreshConfig(): ProductAutoRefreshConfig {
  const defaults = getDefaultProductAutoRefreshConfig();
  const raw = getSetting(PRODUCT_AUTO_REFRESH_KEY);
  if (!raw) return defaults;

  try {
    const parsed = JSON.parse(raw) as Partial<ProductAutoRefreshConfig>;
    const mode: ProductAutoRefreshMode =
      parsed.mode === 'DISABLED' ||
      parsed.mode === 'INTERVAL' ||
      parsed.mode === 'DAILY_TIME' ||
      parsed.mode === 'CRON'
        ? parsed.mode
        : defaults.mode;

    const intervalMinutes =
      typeof parsed.intervalMinutes === 'number' &&
      Number.isInteger(parsed.intervalMinutes) &&
      parsed.intervalMinutes >= 5 &&
      parsed.intervalMinutes <= 1440
        ? parsed.intervalMinutes
        : defaults.intervalMinutes;

    const dailyTime =
      typeof parsed.dailyTime === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(parsed.dailyTime)
        ? parsed.dailyTime
        : defaults.dailyTime;

    const cronExpression =
      typeof parsed.cronExpression === 'string' && cron.validate(parsed.cronExpression.trim())
        ? parsed.cronExpression.trim()
        : defaults.cronExpression;

    return {
      mode,
      intervalMinutes,
      dailyTime,
      cronExpression,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return defaults;
  }
}

export function saveProductAutoRefreshConfig(
  input: {
    mode: string;
    intervalMinutes?: number | null;
    dailyTime?: string | null;
    cronExpression?: string | null;
  },
  actor: { id: string; role: string }
): ProductAutoRefreshConfig {
  const current = getProductAutoRefreshConfig();
  const mode = input.mode;
  if (mode !== 'DISABLED' && mode !== 'INTERVAL' && mode !== 'DAILY_TIME' && mode !== 'CRON') {
    throw new Error('Mode auto refresh produk tidak valid');
  }

  let intervalMinutes = current.intervalMinutes;
  if (mode === 'INTERVAL' || (input.intervalMinutes !== undefined && input.intervalMinutes !== null)) {
    const parsedInt = Number(input.intervalMinutes ?? current.intervalMinutes);
    if (!Number.isInteger(parsedInt) || parsedInt < 5 || parsedInt > 1440) {
      throw new Error('Interval auto refresh produk wajib bilangan bulat antara 5 hingga 1440 menit');
    }
    intervalMinutes = parsedInt;
  }

  let dailyTime = current.dailyTime;
  if (mode === 'DAILY_TIME' || (input.dailyTime !== undefined && input.dailyTime !== null && input.dailyTime !== '')) {
    const candidateTime = String(input.dailyTime ?? current.dailyTime).trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(candidateTime)) {
      throw new Error('Format waktu harian tidak valid (gunakan format JJ:MM, contoh 02:30)');
    }
    dailyTime = candidateTime;
  }

  let cronExpression = current.cronExpression;
  if (mode === 'CRON' || (input.cronExpression !== undefined && input.cronExpression !== null && input.cronExpression !== '')) {
    const candidateCron = String(input.cronExpression ?? current.cronExpression).trim();
    if (!candidateCron || !cron.validate(candidateCron)) {
      throw new Error('Ekspresi cron tidak valid (contoh: 0 */6 * * *)');
    }
    cronExpression = candidateCron;
  }

  const now = new Date().toISOString();
  const next: ProductAutoRefreshConfig = {
    mode,
    intervalMinutes,
    dailyTime,
    cronExpression,
    updatedAt: now,
  };

  withTransaction((txDb) => {
    txDb
      .prepare(
        `INSERT INTO settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`
      )
      .run(PRODUCT_AUTO_REFRESH_KEY, JSON.stringify(next), now);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'PRODUCT_AUTO_REFRESH_UPDATED',
    targetType: 'SYSTEM_SETTINGS',
    targetId: PRODUCT_AUTO_REFRESH_KEY,
    details: {
      mode: next.mode,
      intervalMinutes: next.intervalMinutes,
      dailyTime: next.dailyTime,
      cronExpression: next.cronExpression,
    },
  });

  return next;
}

export function resolveProductRefreshCron(cfg: ProductAutoRefreshConfig): string | null {
  if (cfg.mode === 'DAILY_TIME') {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cfg.dailyTime);
    if (!match) return null;
    return `${Number(match[2])} ${Number(match[1])} * * *`;
  }
  if (cfg.mode === 'CRON') {
    return cron.validate(cfg.cronExpression) ? cfg.cronExpression : null;
  }
  return null;
}

export function formatProductAutoRefreshSummary(
  cfg: ProductAutoRefreshConfig,
  timezone = config.timezone
): string {
  if (cfg.mode === 'DISABLED') {
    return 'Nonaktif (sinkronisasi manual saja)';
  }
  if (cfg.mode === 'INTERVAL') {
    if (cfg.intervalMinutes % 60 === 0) {
      const hours = cfg.intervalMinutes / 60;
      return `Setiap ${hours} jam (${cfg.intervalMinutes} menit)`;
    }
    return `Setiap ${cfg.intervalMinutes} menit`;
  }
  if (cfg.mode === 'DAILY_TIME') {
    return `Setiap hari pukul ${cfg.dailyTime} (${timezone})`;
  }
  return `Cron: ${cfg.cronExpression} (${timezone})`;
}
