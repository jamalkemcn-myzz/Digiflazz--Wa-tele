import crypto from 'node:crypto';
import { getDb, withTransaction } from '../database/connection';
import { generateLinkToken } from '../database/migrate';
import { config } from '../config/env';
import { extractWhatsappPhoneFromJid } from '../domain/masking';
import { recordAuditLog } from './audit.service';

export type CustomerPlatform = 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD';

export interface CustomerRow {
  id: number;
  customer_code: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: string;
  updated_at: string;
}

export interface CustomerIdentityRow {
  id: number;
  customer_id: number;
  platform: CustomerPlatform;
  platform_user_id: string;
  platform_username: string | null;
  linked_at: string;
  created_at: string;
}

function normalizePlatformUserId(platform: CustomerPlatform, rawId: string): string {
  const trimmed = rawId.trim();
  if (!trimmed) throw new Error('Identifier pelanggan kosong');
  if (platform === 'WHATSAPP') {
    return extractWhatsappPhoneFromJid(trimmed);
  }
  return trimmed;
}

export function resolveOrCreateCustomer(params: {
  platform: CustomerPlatform;
  platformUserId: string;
  platformUsername?: string | null;
}): { customer: CustomerRow; identity: CustomerIdentityRow; isNew: boolean } {
  const normalizedUserId = normalizePlatformUserId(params.platform, params.platformUserId);

  return withTransaction((txDb) => {
    const existingIdentity = txDb
      .prepare('SELECT * FROM customer_identities WHERE platform = ? AND platform_user_id = ?')
      .get(params.platform, normalizedUserId) as CustomerIdentityRow | undefined;

    const now = new Date().toISOString();

    if (existingIdentity) {
      if (params.platformUsername && params.platformUsername !== existingIdentity.platform_username) {
        txDb
          .prepare('UPDATE customer_identities SET platform_username = ? WHERE id = ?')
          .run(params.platformUsername, existingIdentity.id);
        existingIdentity.platform_username = params.platformUsername;
      }
      const customer = txDb
        .prepare('SELECT * FROM customers WHERE id = ?')
        .get(existingIdentity.customer_id) as CustomerRow;
      return { customer, identity: existingIdentity, isNew: false };
    }

    const customerCode = `CUS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const cusRes = txDb
      .prepare(
        `INSERT INTO customers (customer_code, status, created_at, updated_at)
         VALUES (?, 'ACTIVE', ?, ?)`
      )
      .run(customerCode, now, now);
    const customerId = Number(cusRes.lastInsertRowid);

    const idRes = txDb
      .prepare(
        `INSERT INTO customer_identities (customer_id, platform, platform_user_id, platform_username, linked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(customerId, params.platform, normalizedUserId, params.platformUsername ?? null, now, now);

    const customer = txDb.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as CustomerRow;
    const identity = txDb
      .prepare('SELECT * FROM customer_identities WHERE id = ?')
      .get(Number(idRes.lastInsertRowid)) as CustomerIdentityRow;

    return { customer, identity, isNew: true };
  });
}

export function findCustomerByPlatform(params: {
  platform: CustomerPlatform;
  platformUserId: string;
}): { customer: CustomerRow; identity: CustomerIdentityRow } | null {
  let normalizedUserId: string;
  try {
    normalizedUserId = normalizePlatformUserId(params.platform, params.platformUserId);
  } catch {
    return null;
  }
  const db = getDb();
  const identity = db
    .prepare('SELECT * FROM customer_identities WHERE platform = ? AND platform_user_id = ?')
    .get(params.platform, normalizedUserId) as CustomerIdentityRow | undefined;
  if (!identity) return null;
  const customer = db
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(identity.customer_id) as CustomerRow | undefined;
  if (!customer) return null;
  return { customer, identity };
}

export function getCustomerIdentities(customerId: number): CustomerIdentityRow[] {
  const db = getDb();
  return db
    .prepare('SELECT * FROM customer_identities WHERE customer_id = ? ORDER BY id ASC')
    .all(customerId) as CustomerIdentityRow[];
}

export function findCustomerByIdentifier(query: string): {
  customer: CustomerRow;
  identities: CustomerIdentityRow[];
} | null {
  const clean = query.trim();
  if (!clean) return null;
  const db = getDb();

  let customer: CustomerRow | undefined;
  if (/^CUS-/i.test(clean)) {
    customer = db
      .prepare('SELECT * FROM customers WHERE UPPER(customer_code) = UPPER(?)')
      .get(clean) as CustomerRow | undefined;
  }

  if (!customer && /^\d+$/.test(clean)) {
    const byIdentity = db
      .prepare('SELECT customer_id FROM customer_identities WHERE platform_user_id = ? LIMIT 1')
      .get(clean) as { customer_id: number } | undefined;
    if (byIdentity) {
      customer = db
        .prepare('SELECT * FROM customers WHERE id = ?')
        .get(byIdentity.customer_id) as CustomerRow | undefined;
    }
    if (!customer) {
      const waDigits = extractWhatsappPhoneFromJid(clean);
      if (waDigits && waDigits !== clean) {
        const byWa = db
          .prepare("SELECT customer_id FROM customer_identities WHERE platform = 'WHATSAPP' AND platform_user_id = ? LIMIT 1")
          .get(waDigits) as { customer_id: number } | undefined;
        if (byWa) {
          customer = db
            .prepare('SELECT * FROM customers WHERE id = ?')
            .get(byWa.customer_id) as CustomerRow | undefined;
        }
      }
    }
    if (!customer) {
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(clean)) as CustomerRow | undefined;
    }
  }

  if (!customer) {
    const normalizedWa = extractWhatsappPhoneFromJid(clean);
    const bareUsername = clean.replace(/^@/, '');
    const row = db
      .prepare(
        `SELECT customer_id FROM customer_identities
         WHERE platform_user_id = ?
            OR platform_user_id = ?
            OR LOWER(REPLACE(COALESCE(platform_username, ''), '@', '')) = LOWER(?)
         LIMIT 1`
      )
      .get(clean, normalizedWa, bareUsername) as { customer_id: number } | undefined;
    if (row) {
      customer = db
        .prepare('SELECT * FROM customers WHERE id = ?')
        .get(row.customer_id) as CustomerRow | undefined;
    }
  }

  if (!customer) return null;
  return {
    customer,
    identities: getCustomerIdentities(customer.id),
  };
}

export function requestAccountLinkCode(params: {
  platform: 'WHATSAPP' | 'TELEGRAM';
  platformUserId: string;
  platformUsername?: string | null;
}): { ok: boolean; code?: string; expiresAt?: string; errorMessage?: string } {
  const { customer } = resolveOrCreateCustomer(params);
  const targetPlatform = params.platform === 'WHATSAPP' ? 'TELEGRAM' : 'WHATSAPP';
  const existingIdentities = getCustomerIdentities(customer.id);

  if (existingIdentities.some((i) => i.platform === targetPlatform)) {
    return {
      ok: false,
      errorMessage: `Akun Anda sudah terhubung dengan ${targetPlatform}. Gunakan perintah unlink terlebih dahulu jika ingin mengganti.`,
    };
  }

  const { rawCode, codeHash } = generateLinkToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.accountLinking.codeExpiryMinutes * 60 * 1000
  ).toISOString();

  withTransaction((txDb) => {
    // Invalidate any previous unused codes for this customer
    txDb
      .prepare('UPDATE account_link_codes SET used_at = ? WHERE customer_id = ? AND used_at IS NULL')
      .run(now.toISOString(), customer.id);

    txDb
      .prepare(
        `INSERT INTO account_link_codes (code_hash, customer_id, source_platform, attempts, max_attempts, expires_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        codeHash,
        customer.id,
        params.platform,
        config.accountLinking.maxAttempts,
        expiresAt,
        now.toISOString()
      );
  });

  recordAuditLog({
    actorId: customer.customer_code,
    actorRole: 'CUSTOMER',
    action: 'ACCOUNT_LINK_CODE_REQUESTED',
    targetType: 'CUSTOMER',
    targetId: customer.customer_code,
    details: { sourcePlatform: params.platform },
  });

  return { ok: true, code: rawCode, expiresAt };
}

export function verifyAndLinkAccount(params: {
  targetPlatform: 'WHATSAPP' | 'TELEGRAM';
  targetPlatformUserId: string;
  targetPlatformUsername?: string | null;
  rawCode: string;
}): { ok: boolean; customerCode?: string; errorMessage?: string } {
  const cleanedCode = params.rawCode.trim().toUpperCase();
  if (!cleanedCode || cleanedCode.length < 6) {
    return { ok: false, errorMessage: 'Format kode penghubung tidak valid' };
  }

  const normalizedTargetId = normalizePlatformUserId(params.targetPlatform, params.targetPlatformUserId);
  const codeHash = crypto.createHash('sha256').update(cleanedCode).digest('hex');

  return withTransaction((txDb) => {
    const codeRow = txDb
      .prepare('SELECT * FROM account_link_codes WHERE code_hash = ?')
      .get(codeHash) as
      | {
          id: number;
          customer_id: number;
          source_platform: 'WHATSAPP' | 'TELEGRAM';
          attempts: number;
          max_attempts: number;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;

    const now = new Date().toISOString();

    if (!codeRow) {
      return { ok: false, errorMessage: 'Kode penghubung tidak ditemukan atau tidak valid' };
    }
    if (codeRow.used_at) {
      return { ok: false, errorMessage: 'Kode penghubung sudah pernah digunakan' };
    }
    if (codeRow.attempts >= codeRow.max_attempts) {
      return { ok: false, errorMessage: 'Batas percobaan kode penghubung telah habis' };
    }
    if (new Date(codeRow.expires_at).getTime() < Date.now()) {
      return { ok: false, errorMessage: 'Kode penghubung sudah kedaluwarsa' };
    }
    if (codeRow.source_platform === params.targetPlatform) {
      txDb.prepare('UPDATE account_link_codes SET attempts = attempts + 1 WHERE id = ?').run(codeRow.id);
      return {
        ok: false,
        errorMessage: 'Kode harus dimasukkan melalui platform yang berbeda (WhatsApp <-> Telegram)',
      };
    }

    // Check if source customer already has targetPlatform identity
    const sourceAlreadyLinked = txDb
      .prepare('SELECT id FROM customer_identities WHERE customer_id = ? AND platform = ?')
      .get(codeRow.customer_id, params.targetPlatform);
    if (sourceAlreadyLinked) {
      txDb.prepare('UPDATE account_link_codes SET attempts = attempts + 1 WHERE id = ?').run(codeRow.id);
      return { ok: false, errorMessage: 'Akun sumber sudah memiliki identitas platform ini' };
    }

    // Check if target platform user ID already exists on another customer
    const existingTargetIdentity = txDb
      .prepare('SELECT id, customer_id FROM customer_identities WHERE platform = ? AND platform_user_id = ?')
      .get(params.targetPlatform, normalizedTargetId) as { id: number; customer_id: number } | undefined;

    if (existingTargetIdentity) {
      // Only allow re-linking if that separate placeholder customer has NO transactions, NO coupon usages, and NO refund ledger entries
      const txCount = (
        txDb
          .prepare('SELECT COUNT(*) as cnt FROM transactions WHERE customer_id = ?')
          .get(existingTargetIdentity.customer_id) as { cnt: number }
      ).cnt;
      const refundCount = (
        txDb
          .prepare('SELECT COUNT(*) as cnt FROM refund_ledger WHERE customer_id = ?')
          .get(existingTargetIdentity.customer_id) as { cnt: number }
      ).cnt;

      if (txCount > 0 || refundCount > 0) {
        return {
          ok: false,
          errorMessage:
            'Identitas platform ini sudah memiliki riwayat transaksi terpisah dan tidak dapat digabungkan otomatis',
        };
      }

      txDb
        .prepare('UPDATE customer_identities SET customer_id = ?, linked_at = ? WHERE id = ?')
        .run(codeRow.customer_id, now, existingTargetIdentity.id);
    } else {
      txDb
        .prepare(
          `INSERT INTO customer_identities (customer_id, platform, platform_user_id, platform_username, linked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          codeRow.customer_id,
          params.targetPlatform,
          normalizedTargetId,
          params.targetPlatformUsername ?? null,
          now,
          now
        );
    }

    txDb.prepare('UPDATE account_link_codes SET used_at = ? WHERE id = ?').run(now, codeRow.id);

    const customer = txDb
      .prepare('SELECT customer_code FROM customers WHERE id = ?')
      .get(codeRow.customer_id) as { customer_code: string };

    txDb
      .prepare(
        `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, details_safe, created_at)
         VALUES (?, 'CUSTOMER', 'ACCOUNT_LINKED', 'CUSTOMER', ?, ?, ?)`
      )
      .run(
        customer.customer_code,
        customer.customer_code,
        JSON.stringify({ linkedPlatform: params.targetPlatform }),
        now
      );

    return { ok: true, customerCode: customer.customer_code };
  });
}

export function unlinkPlatformIdentity(params: {
  platform: 'WHATSAPP' | 'TELEGRAM';
  platformUserId: string;
}): { ok: boolean; errorMessage?: string } {
  const normalizedId = normalizePlatformUserId(params.platform, params.platformUserId);

  return withTransaction((txDb) => {
    const identity = txDb
      .prepare('SELECT * FROM customer_identities WHERE platform = ? AND platform_user_id = ?')
      .get(params.platform, normalizedId) as CustomerIdentityRow | undefined;

    if (!identity) {
      return { ok: false, errorMessage: 'Identitas tidak ditemukan' };
    }

    const totalIdentities = (
      txDb
        .prepare('SELECT COUNT(*) as cnt FROM customer_identities WHERE customer_id = ?')
        .get(identity.customer_id) as { cnt: number }
    ).cnt;

    if (totalIdentities <= 1) {
      return {
        ok: false,
        errorMessage: 'Tidak dapat memutuskan satu-satunya identitas yang terhubung pada akun ini',
      };
    }

    txDb.prepare('DELETE FROM customer_identities WHERE id = ?').run(identity.id);

    const customer = txDb
      .prepare('SELECT customer_code FROM customers WHERE id = ?')
      .get(identity.customer_id) as { customer_code: string };

    txDb
      .prepare(
        `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, details_safe, created_at)
         VALUES (?, 'CUSTOMER', 'ACCOUNT_UNLINKED', 'CUSTOMER', ?, ?, ?)`
      )
      .run(
        customer.customer_code,
        customer.customer_code,
        JSON.stringify({ unlinkedPlatform: params.platform }),
        new Date().toISOString()
      );

    return { ok: true };
  });
}

export function getCustomerRefundCreditTotal(customerId: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
         CASE
           WHEN entry_type IN ('REFUND_CREDIT', 'MANUAL_ADJUSTMENT_CREDIT') THEN amount
           WHEN entry_type = 'MANUAL_ADJUSTMENT_DEBIT' THEN -amount
           ELSE 0
         END
       ), 0) as balance
       FROM refund_ledger
       WHERE customer_id = ?`
    )
    .get(customerId) as { balance: number };
  return row.balance;
}

export function listCustomersDetailed(params: { page?: number; limit?: number; search?: string }) {
  const db = getDb();
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = (page - 1) * limit;
  const search = (params.search || '').trim();

  const where: string[] = [];
  const args: unknown[] = [];

  if (search) {
    const q = `%${search}%`;
    where.push(
      `(c.customer_code LIKE ? OR EXISTS (
         SELECT 1 FROM customer_identities ci
         WHERE ci.customer_id = c.id
           AND (ci.platform_user_id LIKE ? OR COALESCE(ci.platform_username, '') LIKE ?)
       ))`
    );
    args.push(q, q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM customers c ${whereSql}`).get(...args) as { cnt: number }
  ).cnt;

  const customers = db
    .prepare(
      `SELECT
         c.id,
         c.customer_code,
         c.status,
         c.created_at,
         c.updated_at,
         (SELECT COUNT(*) FROM transactions t WHERE t.customer_id = c.id) as total_transactions,
         (SELECT COUNT(*) FROM transactions t WHERE t.customer_id = c.id AND t.transaction_status = 'SUCCESS') as success_transactions,
         (SELECT COALESCE(SUM(t.payment_amount), 0) FROM transactions t WHERE t.customer_id = c.id AND t.transaction_status = 'SUCCESS') as total_spent,
         (SELECT MAX(t.created_at) FROM transactions t WHERE t.customer_id = c.id) as last_transaction_at,
         (SELECT COALESCE(SUM(
            CASE
              WHEN rl.entry_type IN ('REFUND_CREDIT', 'MANUAL_ADJUSTMENT_CREDIT') THEN rl.amount
              WHEN rl.entry_type = 'MANUAL_ADJUSTMENT_DEBIT' THEN -rl.amount
              ELSE 0
            END
          ), 0) FROM refund_ledger rl WHERE rl.customer_id = c.id) as refund_balance
       FROM customers c
       ${whereSql}
       ORDER BY c.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as Array<{
    id: number;
    customer_code: string;
    status: 'ACTIVE' | 'SUSPENDED';
    created_at: string;
    updated_at: string;
    total_transactions: number;
    success_transactions: number;
    total_spent: number;
    last_transaction_at: string | null;
    refund_balance: number;
  }>;

  const identityStmt = db.prepare(
    `SELECT id, customer_id, platform, platform_user_id, platform_username, linked_at, created_at
     FROM customer_identities
     WHERE customer_id = ?
     ORDER BY id ASC`
  );

  const items = customers.map((cus) => ({
    ...cus,
    identities: identityStmt.all(cus.id) as CustomerIdentityRow[],
  }));

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

export function getTotalBotUsersCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM customers').get() as { cnt: number };
  return row.cnt;
}

export function calculateCustomerTier(totalSpent: number): 'Bronze' | 'Silver' | 'Gold' | 'Platinum' {
  if (totalSpent >= 5_000_000) return 'Platinum';
  if (totalSpent >= 1_000_000) return 'Gold';
  if (totalSpent >= 250_000) return 'Silver';
  return 'Bronze';
}

export interface CustomerProfileSummary {
  customerId: number | null;
  userId: string;
  username: string;
  joinedAt: string;
  balance: number;
  loyaltyPoints: number;
  tier: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  totalSpent: number;
  successCount: number;
}

export function getCustomerProfileSummary(params: {
  platform: 'WHATSAPP' | 'TELEGRAM';
  platformUserId: string;
  platformUsername?: string | null;
  displayName?: string | null;
  dryRun?: boolean;
}): CustomerProfileSummary {
  const resolved = params.dryRun
    ? findCustomerByPlatform({
        platform: params.platform,
        platformUserId: params.platformUserId,
      })
    : resolveOrCreateCustomer({
        platform: params.platform,
        platformUserId: params.platformUserId,
        platformUsername: params.platformUsername ?? params.displayName ?? null,
      });

  const cleanUsername = (params.platformUsername || '').trim();
  const cleanDisplay = (params.displayName || '').trim();
  const fallbackId =
    params.platform === 'WHATSAPP'
      ? extractWhatsappPhoneFromJid(params.platformUserId)
      : params.platformUserId.trim();

  if (!resolved) {
    return {
      customerId: null,
      userId: fallbackId || '-',
      username: cleanUsername || cleanDisplay || fallbackId || '-',
      joinedAt: new Date().toISOString(),
      balance: 0,
      loyaltyPoints: 0,
      tier: 'Bronze',
      totalSpent: 0,
      successCount: 0,
    };
  }

  const db = getDb();
  const stats = db
    .prepare(
      `SELECT
         COUNT(*) as success_count,
         COALESCE(SUM(payment_amount), 0) as total_spent
       FROM transactions
       WHERE customer_id = ? AND transaction_status = 'SUCCESS'`
    )
    .get(resolved.customer.id) as { success_count: number; total_spent: number };

  const balance = getCustomerRefundCreditTotal(resolved.customer.id);
  const totalSpent = Number(stats?.total_spent || 0);
  const successCount = Number(stats?.success_count || 0);
  const loyaltyPoints = Math.floor(totalSpent / 1000);
  const tier = calculateCustomerTier(totalSpent);

  const storedUsername = (resolved.identity.platform_username || '').trim();
  const resolvedUsername = cleanUsername || storedUsername || cleanDisplay || resolved.identity.platform_user_id;

  return {
    customerId: resolved.customer.id,
    userId: resolved.customer.customer_code,
    username: resolvedUsername,
    joinedAt: resolved.customer.created_at,
    balance,
    loyaltyPoints,
    tier,
    totalSpent,
    successCount,
  };
}

