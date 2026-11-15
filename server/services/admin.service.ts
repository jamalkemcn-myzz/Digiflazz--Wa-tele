import { getDb, withTransaction } from '../database/connection';
import { getEffectivePermissions, hasPermission, type AdminRole, type Permission } from '../domain/rbac';
import { extractWhatsappPhoneFromJid, maskDestination } from '../domain/masking';
import { recordAuditLog } from './audit.service';

export interface ResolvedAdmin {
  id: number;
  name: string;
  role: AdminRole;
  permissions: Permission[];
  platformUserId: string;
}

export function resolveAdminByPlatform(
  platform: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD',
  rawPlatformUserId: string
): ResolvedAdmin | null {
  const db = getDb();
  const normalizedId =
    platform === 'WHATSAPP'
      ? extractWhatsappPhoneFromJid(rawPlatformUserId)
      : rawPlatformUserId.trim();

  const row = db
    .prepare(
      `SELECT a.id, a.name, a.role, a.permissions_json, a.status, ai.platform_user_id
       FROM admin_identities ai
       JOIN admins a ON a.id = ai.admin_id
       WHERE ai.platform = ? AND ai.platform_user_id = ?`
    )
    .get(platform, normalizedId) as
    | {
        id: number;
        name: string;
        role: AdminRole;
        permissions_json: string;
        status: string;
        platform_user_id: string;
      }
    | undefined;

  if (!row || row.status !== 'ACTIVE') {
    return null;
  }

  let customPerms: string[] = [];
  try {
    customPerms = JSON.parse(row.permissions_json) as string[];
  } catch {
    customPerms = [];
  }

  return {
    id: row.id,
    name: row.name,
    role: row.role,
    permissions: getEffectivePermissions(row.role, customPerms),
    platformUserId: row.platform_user_id,
  };
}

export function checkAdminPermission(admin: ResolvedAdmin | null, permission: Permission): boolean {
  if (!admin) return false;
  return hasPermission(admin.role, admin.permissions, permission);
}

export function listAdmins() {
  const db = getDb();
  const admins = db.prepare('SELECT * FROM admins ORDER BY id ASC').all() as Array<{
    id: number;
    name: string;
    role: AdminRole;
    permissions_json: string;
    status: string;
    created_at: string;
    updated_at: string;
  }>;
  const identities = db.prepare('SELECT * FROM admin_identities').all() as Array<{
    id: number;
    admin_id: number;
    platform: string;
    platform_user_id: string;
  }>;

  return admins.map((a) => ({
    ...a,
    identities: identities.filter((i) => i.admin_id === a.id),
  }));
}

export function createAdmin(
  input: {
    name: string;
    role: AdminRole;
    platform?: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD';
    platformUserId?: string;
  },
  actor: { id: string; role: string }
) {
  const name = input.name.trim();
  if (!name || name.length < 2) {
    throw new Error('Nama admin wajib diisi minimal 2 karakter');
  }
  const role: AdminRole =
    input.role === 'OWNER' || input.role === 'ADMIN' || input.role === 'OPERATOR'
      ? input.role
      : 'OPERATOR';

  const now = new Date().toISOString();
  const permsJson = role === 'OWNER' ? '["*"]' : '[]';

  let adminId = 0;
  withTransaction((txDb) => {
    const res = txDb
      .prepare(
        `INSERT INTO admins (name, role, permissions_json, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`
      )
      .run(name, role, permsJson, now, now);
    adminId = Number(res.lastInsertRowid);

    if (input.platform && input.platformUserId && input.platformUserId.trim()) {
      const normalized =
        input.platform === 'WHATSAPP'
          ? extractWhatsappPhoneFromJid(input.platformUserId)
          : input.platformUserId.trim();
      txDb
        .prepare(
          `INSERT INTO admin_identities (admin_id, platform, platform_user_id, created_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(adminId, input.platform, normalized, now);
    }
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'ADMIN_CREATED',
    targetType: 'ADMIN',
    targetId: String(adminId),
    details: { name, role },
  });

  return listAdmins().find((a) => a.id === adminId)!;
}

export function addAdminIdentity(
  adminId: number,
  platform: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD',
  rawPlatformUserId: string,
  actor: { id: string; role: string }
) {
  const trimmed = rawPlatformUserId.trim();
  if (!trimmed) {
    throw new Error('ID platform admin wajib diisi');
  }
  if (platform === 'TELEGRAM' && !/^\d+$/.test(trimmed)) {
    throw new Error('Identitas admin Telegram harus berupa User ID numerik (contoh: 123456789)');
  }

  const normalized =
    platform === 'WHATSAPP' ? extractWhatsappPhoneFromJid(trimmed) : trimmed;
  const now = new Date().toISOString();

  withTransaction((txDb) => {
    const adminExists = txDb.prepare('SELECT id FROM admins WHERE id = ?').get(adminId);
    if (!adminExists) {
      throw new Error('Admin tidak ditemukan');
    }
    txDb
      .prepare(
        `INSERT INTO admin_identities (admin_id, platform, platform_user_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(adminId, platform, normalized, now);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'ADMIN_IDENTITY_ADDED',
    targetType: 'ADMIN',
    targetId: String(adminId),
    details: { platform, platformUserId: normalized },
  });
}

export function removeAdminIdentity(
  adminId: number,
  identityId: number,
  actor: { id: string; role: string }
) {
  withTransaction((txDb) => {
    const identity = txDb
      .prepare('SELECT id, admin_id, platform, platform_user_id FROM admin_identities WHERE id = ? AND admin_id = ?')
      .get(identityId, adminId) as
      | { id: number; admin_id: number; platform: string; platform_user_id: string }
      | undefined;

    if (!identity) {
      throw new Error('Identitas admin tidak ditemukan');
    }

    if (identity.platform === 'DASHBOARD' && identity.platform_user_id === actor.id) {
      throw new Error('Tidak boleh menghapus identitas dashboard milik akun yang sedang login');
    }

    txDb.prepare('DELETE FROM admin_identities WHERE id = ?').run(identityId);

    recordAuditLog({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'ADMIN_IDENTITY_REMOVED',
      targetType: 'ADMIN',
      targetId: String(adminId),
      details: { identityId, platform: identity.platform, platformUserId: identity.platform_user_id },
    });
  });
}

export function updateAdminRole(
  adminId: number,
  role: AdminRole,
  status: 'ACTIVE' | 'DISABLED',
  actor: { id: string; role: string },
  name?: string
) {
  const validRole: AdminRole =
    role === 'OWNER' || role === 'ADMIN' || role === 'OPERATOR' ? role : 'OPERATOR';
  const validStatus: 'ACTIVE' | 'DISABLED' = status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
  const now = new Date().toISOString();

  withTransaction((txDb) => {
    const existing = txDb
      .prepare('SELECT id, name, role, status FROM admins WHERE id = ?')
      .get(adminId) as { id: number; name: string; role: AdminRole; status: string } | undefined;

    if (!existing) {
      throw new Error('Admin tidak ditemukan');
    }

    const activeOwners = (
      txDb
        .prepare("SELECT COUNT(*) as cnt FROM admins WHERE role = 'OWNER' AND status = 'ACTIVE' AND id != ?")
        .get(adminId) as { cnt: number }
    ).cnt;

    if (existing.role === 'OWNER' && activeOwners === 0 && (validRole !== 'OWNER' || validStatus !== 'ACTIVE')) {
      throw new Error('Minimal harus ada 1 akun OWNER aktif pada sistem');
    }

    const nextName = name && name.trim().length >= 2 ? name.trim() : existing.name;
    const permsJson = validRole === 'OWNER' ? '["*"]' : '[]';

    txDb
      .prepare('UPDATE admins SET name = ?, role = ?, permissions_json = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(nextName, validRole, permsJson, validStatus, now, adminId);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'ADMIN_ROLE_UPDATED',
    targetType: 'ADMIN',
    targetId: String(adminId),
    details: { role: validRole, status: validStatus, name: name?.trim() || undefined },
  });
}

export function resetAdminsAndSyncOwner(
  mode: 'SYNC_OWNER_FROM_ENV' | 'RESET_TO_PRIMARY_OWNER',
  actor: { id: string; role: string },
  envOverrides?: {
    dashboardUser?: string;
    ownerWhatsappJid?: string;
    ownerTelegramId?: string;
  }
) {
  const now = new Date().toISOString();
  const dashboardUser = (envOverrides?.dashboardUser ?? process.env.DASHBOARD_AUTH_USER ?? '').trim();
  const ownerWaRaw = (envOverrides?.ownerWhatsappJid ?? process.env.OWNER_WHATSAPP_JID ?? '').trim();
  const ownerTgRaw = (envOverrides?.ownerTelegramId ?? process.env.OWNER_TELEGRAM_ID ?? '').trim();

  let primaryOwnerId = 0;

  withTransaction((txDb) => {
    let owner = txDb
      .prepare("SELECT id FROM admins WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1")
      .get() as { id: number } | undefined;

    if (!owner) {
      owner = txDb
        .prepare('SELECT id FROM admins ORDER BY id ASC LIMIT 1')
        .get() as { id: number } | undefined;
    }

    if (!owner) {
      const inserted = txDb
        .prepare(
          `INSERT INTO admins (name, role, permissions_json, status, created_at, updated_at)
           VALUES ('Primary Owner', 'OWNER', '["*"]', 'ACTIVE', ?, ?)`
        )
        .run(now, now);
      primaryOwnerId = Number(inserted.lastInsertRowid);
    } else {
      primaryOwnerId = owner.id;
      txDb
        .prepare(
          `UPDATE admins
           SET role = 'OWNER', permissions_json = '["*"]', status = 'ACTIVE', updated_at = ?
           WHERE id = ?`
        )
        .run(now, primaryOwnerId);
    }

    if (mode === 'RESET_TO_PRIMARY_OWNER') {
      txDb.prepare('DELETE FROM admin_identities WHERE admin_id = ?').run(primaryOwnerId);
      txDb.prepare('DELETE FROM admins WHERE id != ?').run(primaryOwnerId);
    } else {
      // SYNC_OWNER_FROM_ENV: replace Primary Owner's managed env platform entries cleanly
      if (dashboardUser) {
        txDb
          .prepare("DELETE FROM admin_identities WHERE (admin_id = ? AND platform = 'DASHBOARD') OR (platform = 'DASHBOARD' AND platform_user_id = ?)")
          .run(primaryOwnerId, dashboardUser);
      }
      if (ownerWaRaw) {
        const waPhone = extractWhatsappPhoneFromJid(ownerWaRaw);
        txDb
          .prepare("DELETE FROM admin_identities WHERE (admin_id = ? AND platform = 'WHATSAPP') OR (platform = 'WHATSAPP' AND platform_user_id = ?)")
          .run(primaryOwnerId, waPhone);
      }
      if (ownerTgRaw) {
        txDb
          .prepare("DELETE FROM admin_identities WHERE (admin_id = ? AND platform = 'TELEGRAM') OR (platform = 'TELEGRAM' AND platform_user_id = ?)")
          .run(primaryOwnerId, ownerTgRaw);
      }
    }

    const insertId = txDb.prepare(
      `INSERT OR IGNORE INTO admin_identities (admin_id, platform, platform_user_id, created_at)
       VALUES (?, ?, ?, ?)`
    );

    if (dashboardUser) {
      insertId.run(primaryOwnerId, 'DASHBOARD', dashboardUser, now);
    }
    if (ownerWaRaw) {
      insertId.run(primaryOwnerId, 'WHATSAPP', extractWhatsappPhoneFromJid(ownerWaRaw), now);
    }
    if (ownerTgRaw && /^\d+$/.test(ownerTgRaw)) {
      insertId.run(primaryOwnerId, 'TELEGRAM', ownerTgRaw, now);
    }
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: mode === 'RESET_TO_PRIMARY_OWNER' ? 'ADMIN_RESET_TO_PRIMARY_OWNER' : 'ADMIN_OWNER_SYNCED_FROM_ENV',
    targetType: 'ADMIN',
    targetId: String(primaryOwnerId),
    details: {
      mode,
      hasDashboardUser: Boolean(dashboardUser),
      hasOwnerWhatsapp: Boolean(ownerWaRaw),
      hasOwnerTelegram: Boolean(ownerTgRaw && /^\d+$/.test(ownerTgRaw)),
    },
  });

  return listAdmins();
}

export function getAdminBotTransactionReport(params: {
  actorId: string;
  actorRole: string;
  page?: number;
  limit?: number;
  status?: string;
  date?: string;
  search?: string;
}) {
  const db = getDb();
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(10, Math.max(1, params.limit ?? 5));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.status) {
    where.push('t.transaction_status = ?');
    args.push(params.status.toUpperCase());
  }
  if (params.date) {
    where.push('substr(t.created_at, 1, 10) = ?');
    args.push(params.date);
  }
  if (params.search) {
    where.push('(t.transaction_id LIKE ? OR c.customer_code LIKE ?)');
    const q = `%${params.search}%`;
    args.push(q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const summary = db
    .prepare(
      `SELECT
        COUNT(*) as total_count,
        COALESCE(SUM(t.payment_amount), 0) as total_amount,
        SUM(CASE WHEN t.transaction_status = 'SUCCESS' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN t.transaction_status IN ('FAILED', 'REFUNDED') THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN t.transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING', 'UNKNOWN') THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN t.transaction_status = 'EXPIRED' THEN 1 ELSE 0 END) as expired_count
       FROM transactions t
       JOIN customers c ON c.id = t.customer_id
       ${whereSql}`
    )
    .get(...args) as {
    total_count: number;
    total_amount: number;
    success_count: number | null;
    failed_count: number | null;
    pending_count: number | null;
    expired_count: number | null;
  };

  const rows = db
    .prepare(
      `SELECT t.transaction_id, c.customer_code, t.product_name_snapshot, t.payment_amount, t.transaction_status, t.destination, t.created_at
       FROM transactions t
       JOIN customers c ON c.id = t.customer_id
       ${whereSql}
       ORDER BY t.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as Array<{
    transaction_id: string;
    customer_code: string;
    product_name_snapshot: string;
    payment_amount: number;
    transaction_status: string;
    destination: string;
    created_at: string;
  }>;

  recordAuditLog({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: 'ADMIN_BOT_HISTORY_VIEWED',
    targetType: 'TRANSACTIONS',
    details: { page, limit, status: params.status || null, date: params.date || null },
  });

  return {
    summary: {
      totalCount: summary.total_count ?? 0,
      totalAmount: summary.total_amount ?? 0,
      successCount: summary.success_count ?? 0,
      failedCount: summary.failed_count ?? 0,
      pendingCount: summary.pending_count ?? 0,
      expiredCount: summary.expired_count ?? 0,
    },
    items: rows.map((r) => ({
      ...r,
      destination_masked: maskDestination(r.destination),
    })),
    page,
    totalPages: Math.max(1, Math.ceil((summary.total_count ?? 0) / limit)),
  };
}
