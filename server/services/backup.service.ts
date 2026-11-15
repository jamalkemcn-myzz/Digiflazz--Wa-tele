import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../database/connection';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import { recordAuditLog } from './audit.service';
import { emitServiceLogToGroups } from './notification.service';

let backupRunning = false;

export function ensureBackupDir(): string {
  if (!fs.existsSync(config.backup.dir)) {
    fs.mkdirSync(config.backup.dir, { recursive: true });
  }
  return config.backup.dir;
}

export async function runDatabaseBackup(
  trigger: 'CRON' | 'MANUAL' | 'CLI',
  actor?: { id: string; role: string }
): Promise<{
  ok: boolean;
  fileName?: string;
  filePath?: string;
  sizeBytes?: number;
  errorMessage?: string;
}> {
  if (backupRunning) {
    return { ok: false, errorMessage: 'Backup sedang berjalan' };
  }

  backupRunning = true;
  const db = getDb();
  const createdAt = new Date().toISOString();

  try {
    const dir = ensureBackupDir();
    const stamp = createdAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const fileName = `database-${stamp}.sqlite`;
    const destPath = path.join(dir, fileName);

    // SQLite online backup API ensures consistent snapshot even during active WAL writes
    await db.backup(destPath);

    const stat = fs.statSync(destPath);
    const completedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO backup_logs (file_name, file_size_bytes, status, created_at, completed_at, details_safe)
       VALUES (?, ?, 'SUCCESS', ?, ?, ?)`
    ).run(fileName, stat.size, createdAt, completedAt, JSON.stringify({ trigger }));

    // Retention cleanup (never delete the latest backup)
    const deletedCount = pruneOldBackups(dir, fileName);

    if (actor) {
      recordAuditLog({
        actorId: actor.id,
        actorRole: actor.role,
        action: 'MANUAL_DATABASE_BACKUP',
        targetType: 'BACKUP',
        targetId: fileName,
        details: { sizeBytes: stat.size, prunedOldCount: deletedCount },
      });
    }

    emitServiceLogToGroups(
      `backup-${stamp}`,
      'Database Backup',
      `Backup SQLite berhasil (${fileName}, ${(stat.size / 1024).toFixed(1)} KB)`
    );

    logger.info('SQLite database backup completed', {
      service: 'backup',
      details: { fileName, sizeBytes: stat.size, trigger },
    });

    return { ok: true, fileName, filePath: destPath, sizeBytes: stat.size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Backup gagal';
    db.prepare(
      `INSERT INTO backup_logs (file_name, file_size_bytes, status, created_at, completed_at, details_safe)
       VALUES (?, 0, 'FAILED', ?, ?, ?)`
    ).run('failed', createdAt, new Date().toISOString(), JSON.stringify({ trigger, error: msg }));

    logger.error('SQLite database backup failed', {
      service: 'backup',
      details: { error: msg },
    });

    return { ok: false, errorMessage: msg };
  } finally {
    backupRunning = false;
  }
}

function pruneOldBackups(dir: string, protectFileName: string): number {
  const retentionMs = config.backup.retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  let removed = 0;

  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('database-') && f.endsWith('.sqlite'))
      .map((f) => {
        const full = path.join(dir, f);
        return { name: f, full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Always retain at least the newest valid backup
    for (let i = 1; i < files.length; i++) {
      const f = files[i];
      if (f.name !== protectFileName && f.mtimeMs < cutoff) {
        fs.unlinkSync(f.full);
        removed++;
      }
    }
  } catch {
    // Non-fatal retention cleanup failure
  }
  return removed;
}

export function listBackupLogs(limit = 30) {
  const db = getDb();
  return db.prepare('SELECT * FROM backup_logs ORDER BY id DESC LIMIT ?').all(limit);
}

export function listBackupFiles() {
  const dir = ensureBackupDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return {
        fileName: f,
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
