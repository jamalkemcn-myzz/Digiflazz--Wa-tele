import { getDb } from '../database/connection';
import { sanitizeForLog } from '../logging/logger';

export interface AuditEntryInput {
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

export function recordAuditLog(entry: AuditEntryInput): void {
  const db = getDb();
  const safeDetails = entry.details ? JSON.stringify(sanitizeForLog(entry.details)) : null;
  db.prepare(
    `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, details_safe, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.actorId,
    entry.actorRole,
    entry.action,
    entry.targetType,
    entry.targetId ?? null,
    safeDetails,
    new Date().toISOString()
  );
}

export function listAuditLogs(params: {
  page?: number;
  limit?: number;
  action?: string;
  search?: string;
}) {
  const db = getDb();
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.action) {
    where.push('action = ?');
    args.push(params.action);
  }
  if (params.search) {
    where.push('(actor_id LIKE ? OR action LIKE ? OR target_id LIKE ? OR details_safe LIKE ?)');
    const q = `%${params.search}%`;
    args.push(q, q, q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM audit_logs ${whereSql}`).get(...args) as { cnt: number }
  ).cnt;

  const items = db
    .prepare(
      `SELECT id, actor_id, actor_role, action, target_type, target_id, details_safe, created_at
       FROM audit_logs ${whereSql}
       ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}
