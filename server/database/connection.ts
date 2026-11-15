import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env';
import { logger } from '../logging/logger';

let dbInstance: Database.Database | null = null;
let currentDbPath: string | null = null;

export function getDb(customPath?: string): Database.Database {
  const targetPath = customPath || config.database.path;
  if (dbInstance && targetPath === currentDbPath) {
    return dbInstance;
  }

  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }

  currentDbPath = targetPath;
  if (targetPath !== ':memory:') {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(targetPath);
  db.pragma('foreign_keys = ON');
  if (targetPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('busy_timeout = 5000');

  dbInstance = db;
  logger.info('SQLite database opened', {
    service: 'database',
    details: { mode: targetPath === ':memory:' ? 'memory' : 'persistent-wal' },
  });
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignore checkpoint error on close
    }
    dbInstance.close();
    dbInstance = null;
    logger.info('SQLite database closed', { service: 'database' });
  }
}

export function withTransaction<T>(fn: (db: Database.Database) => T, customDb?: Database.Database): T {
  const db = customDb || getDb();
  const maxRetries = 4;
  let attempt = 0;

  while (true) {
    try {
      const tx = db.transaction(() => fn(db));
      return tx();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'SQLITE_BUSY' && attempt < maxRetries) {
        attempt++;
        const waitUntil = Date.now() + 50 * attempt;
        while (Date.now() < waitUntil) {
          // Short bounded synchronous yield for SQLITE_BUSY
        }
        continue;
      }
      throw err;
    }
  }
}
