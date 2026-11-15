import { getDb, withTransaction } from '../database/connection';
import { recordAuditLog } from './audit.service';

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
