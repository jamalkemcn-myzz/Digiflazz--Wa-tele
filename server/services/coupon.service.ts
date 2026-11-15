import { getDb, withTransaction } from '../database/connection';
import {
  evaluateCoupon,
  type CouponDiscountType,
  type CouponRecord,
  type CouponScopeType,
} from '../domain/coupon';
import { recordAuditLog } from './audit.service';

interface CouponDbRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  discount_type: CouponDiscountType;
  discount_value: number;
  min_purchase: number;
  max_discount: number | null;
  claim_limit: number | null;
  claimed_count: number;
  per_customer_limit: number;
  scope_type: CouponScopeType;
  scope_id: number | null;
  starts_at: string;
  expires_at: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

function toDomainCoupon(row: CouponDbRow): CouponRecord {
  return {
    id: row.id,
    code: row.code,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    minPurchase: row.min_purchase,
    maxDiscount: row.max_discount,
    claimLimit: row.claim_limit,
    claimedCount: row.claimed_count,
    perCustomerLimit: row.per_customer_limit,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

export function listCoupons() {
  const db = getDb();
  return db.prepare('SELECT * FROM coupons ORDER BY id DESC').all() as CouponDbRow[];
}

export function listCouponUsages(couponId?: number, limit = 50) {
  const db = getDb();
  if (couponId) {
    return db
      .prepare(
        `SELECT cu.*, c.code, cus.customer_code
         FROM coupon_usages cu
         JOIN coupons c ON c.id = cu.coupon_id
         JOIN customers cus ON cus.id = cu.customer_id
         WHERE cu.coupon_id = ?
         ORDER BY cu.id DESC LIMIT ?`
      )
      .all(couponId, limit);
  }
  return db
    .prepare(
      `SELECT cu.*, c.code, cus.customer_code
       FROM coupon_usages cu
       JOIN coupons c ON c.id = cu.coupon_id
       JOIN customers cus ON cus.id = cu.customer_id
       ORDER BY cu.id DESC LIMIT ?`
    )
    .all(limit);
}

export function createCoupon(
  input: {
    code: string;
    name: string;
    description?: string | null;
    discountType: CouponDiscountType;
    discountValue: number;
    minPurchase?: number;
    maxDiscount?: number | null;
    claimLimit?: number | null;
    perCustomerLimit?: number;
    scopeType?: CouponScopeType;
    scopeId?: number | null;
    startsAt: string;
    expiresAt: string;
  },
  actor: { id: string; role: string }
): CouponDbRow {
  const code = input.code.trim().toUpperCase();
  if (!code || !/^[A-Z0-9_-]{3,32}$/.test(code)) {
    throw new Error('Kode kupon harus 3–32 karakter alfanumerik');
  }
  if (!input.name.trim()) throw new Error('Nama kupon wajib diisi');
  if (!Number.isFinite(input.discountValue) || input.discountValue <= 0) {
    throw new Error('Nilai diskon harus lebih dari 0');
  }
  if (input.discountType === 'PERCENT' && input.discountValue > 100) {
    throw new Error('Diskon persentase maksimal 100%');
  }
  if (new Date(input.expiresAt) <= new Date(input.startsAt)) {
    throw new Error('Waktu berakhir kupon harus lebih besar dari waktu mulai');
  }

  const now = new Date().toISOString();
  const created = withTransaction((txDb) => {
    const res = txDb
      .prepare(
        `INSERT INTO coupons (
          code, name, description, discount_type, discount_value, min_purchase, max_discount,
          claim_limit, claimed_count, per_customer_limit, scope_type, scope_id, starts_at, expires_at,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
      )
      .run(
        code,
        input.name.trim(),
        input.description?.trim() || null,
        input.discountType,
        input.discountValue,
        Math.max(0, Math.round(input.minPurchase ?? 0)),
        input.maxDiscount ?? null,
        input.claimLimit ?? null,
        Math.max(1, Math.round(input.perCustomerLimit ?? 1)),
        input.scopeType ?? 'ALL',
        input.scopeId ?? null,
        input.startsAt,
        input.expiresAt,
        now,
        now
      );
    return txDb.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(res.lastInsertRowid)) as CouponDbRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'COUPON_CREATED',
    targetType: 'COUPON',
    targetId: created.code,
    details: { discountType: created.discount_type, discountValue: created.discount_value },
  });

  return created;
}

export function updateCoupon(
  id: number,
  input: {
    name?: string;
    description?: string | null;
    discountType?: CouponDiscountType;
    discountValue?: number;
    minPurchase?: number;
    maxDiscount?: number | null;
    claimLimit?: number | null;
    perCustomerLimit?: number;
    startsAt?: string;
    expiresAt?: string;
    status?: 'ACTIVE' | 'INACTIVE';
  },
  actor: { id: string; role: string }
): CouponDbRow {
  const now = new Date().toISOString();
  const updated = withTransaction((txDb) => {
    const existing = txDb.prepare('SELECT * FROM coupons WHERE id = ?').get(id) as CouponDbRow | undefined;
    if (!existing) throw new Error('Kupon tidak ditemukan');

    const startsAt = input.startsAt ?? existing.starts_at;
    const expiresAt = input.expiresAt ?? existing.expires_at;
    if (new Date(expiresAt) <= new Date(startsAt)) {
      throw new Error('Waktu berakhir kupon harus setelah waktu mulai');
    }

    txDb
      .prepare(
        `UPDATE coupons
         SET name = ?, description = ?, discount_type = ?, discount_value = ?, min_purchase = ?,
             max_discount = ?, claim_limit = ?, per_customer_limit = ?, starts_at = ?, expires_at = ?,
             status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name !== undefined ? input.name.trim() : existing.name,
        input.description !== undefined ? input.description : existing.description,
        input.discountType ?? existing.discount_type,
        input.discountValue ?? existing.discount_value,
        input.minPurchase ?? existing.min_purchase,
        input.maxDiscount !== undefined ? input.maxDiscount : existing.max_discount,
        input.claimLimit !== undefined ? input.claimLimit : existing.claim_limit,
        input.perCustomerLimit ?? existing.per_customer_limit,
        startsAt,
        expiresAt,
        input.status ?? existing.status,
        now,
        id
      );
    return txDb.prepare('SELECT * FROM coupons WHERE id = ?').get(id) as CouponDbRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'COUPON_UPDATED',
    targetType: 'COUPON',
    targetId: updated.code,
    details: { status: updated.status },
  });

  return updated;
}

export function deleteCouponSafely(id: number, actor: { id: string; role: string }): void {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM coupons WHERE id = ?').get(id) as CouponDbRow | undefined;
  if (!existing) throw new Error('Kupon tidak ditemukan');

  const usages = (
    db.prepare('SELECT COUNT(*) as cnt FROM coupon_usages WHERE coupon_id = ?').get(id) as { cnt: number }
  ).cnt;

  if (usages > 0) {
    throw new Error('Kupon sudah memiliki riwayat penggunaan. Nonaktifkan kupon alih-alih menghapusnya.');
  }

  withTransaction((txDb) => {
    txDb.prepare('DELETE FROM coupons WHERE id = ?').run(id);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'COUPON_DELETED',
    targetType: 'COUPON',
    targetId: existing.code,
  });
}

/**
 * Validates and atomically reserves a coupon inside an existing database transaction.
 * Prevents race conditions when multiple customers claim the last remaining slot simultaneously.
 */
export function validateAndClaimCouponInTx(
  txDb: import('better-sqlite3').Database,
  params: {
    code: string;
    customerId: number;
    transactionId: string;
    sellingPrice: number;
    productId: number;
    categoryId: number | null;
  }
): { couponId: number; couponCode: string; discountAmount: number } {
  const row = txDb
    .prepare('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)')
    .get(params.code.trim()) as CouponDbRow | undefined;

  if (!row) {
    throw new Error('Kode kupon tidak ditemukan');
  }

  const usageCount = (
    txDb
      .prepare('SELECT COUNT(*) as cnt FROM coupon_usages WHERE coupon_id = ? AND customer_id = ?')
      .get(row.id, params.customerId) as { cnt: number }
  ).cnt;

  const evalResult = evaluateCoupon({
    coupon: toDomainCoupon(row),
    sellingPrice: params.sellingPrice,
    productId: params.productId,
    categoryId: params.categoryId,
    customerUsageCount: usageCount,
  });

  if (!evalResult.valid) {
    throw new Error(evalResult.reason || 'Kupon tidak memenuhi syarat');
  }

  // Atomic conditional increment guarding claim_limit against concurrent claims
  const updateRes = txDb
    .prepare(
      `UPDATE coupons
       SET claimed_count = claimed_count + 1, updated_at = ?
       WHERE id = ? AND (claim_limit IS NULL OR claimed_count < claim_limit)`
    )
    .run(new Date().toISOString(), row.id);

  if (updateRes.changes === 0) {
    throw new Error('Kuota klaim kupon sudah habis');
  }

  txDb
    .prepare(
      `INSERT INTO coupon_usages (coupon_id, customer_id, transaction_id, discount_amount, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(row.id, params.customerId, params.transactionId, evalResult.discountAmount, new Date().toISOString());

  return {
    couponId: row.id,
    couponCode: row.code,
    discountAmount: evalResult.discountAmount,
  };
}

export function previewCouponReadOnly(params: {
  code: string;
  customerId?: number | null;
  sellingPrice: number;
  productId: number;
  categoryId: number | null;
}): { couponCode: string; discountAmount: number } {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)')
    .get(params.code.trim()) as CouponDbRow | undefined;

  if (!row) {
    throw new Error('Kode kupon tidak ditemukan');
  }

  const usageCount = params.customerId
    ? (
        db
          .prepare('SELECT COUNT(*) as cnt FROM coupon_usages WHERE coupon_id = ? AND customer_id = ?')
          .get(row.id, params.customerId) as { cnt: number }
      ).cnt
    : 0;

  const evalResult = evaluateCoupon({
    coupon: toDomainCoupon(row),
    sellingPrice: params.sellingPrice,
    productId: params.productId,
    categoryId: params.categoryId,
    customerUsageCount: usageCount,
  });

  if (!evalResult.valid) {
    throw new Error(evalResult.reason || 'Kupon tidak memenuhi syarat');
  }

  return {
    couponCode: row.code,
    discountAmount: evalResult.discountAmount,
  };
}

