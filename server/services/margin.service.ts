import { getDb, withTransaction } from '../database/connection';
import { resolveEffectiveMargin, type MarginRule, type MarginType } from '../domain/pricing';
import { getGlobalMarginRule } from './product.service';
import { recordAuditLog } from './audit.service';

export function recalculateAllProductSellingPrices(): number {
  const db = getDb();
  const globalMargin = getGlobalMarginRule();
  const now = new Date().toISOString();

  return withTransaction((txDb) => {
    const categories = txDb
      .prepare('SELECT id, margin_type, margin_value, max_margin FROM categories')
      .all() as Array<{
      id: number;
      margin_type: MarginType | null;
      margin_value: number | null;
      max_margin: number | null;
    }>;
    const catMap = new Map(categories.map((c) => [c.id, c]));

    const products = txDb
      .prepare('SELECT id, category_id, supplier_price, margin_type, margin_value, max_margin FROM products')
      .all() as Array<{
      id: number;
      category_id: number | null;
      supplier_price: number;
      margin_type: MarginType | null;
      margin_value: number | null;
      max_margin: number | null;
    }>;

    const updateStmt = txDb.prepare('UPDATE products SET selling_price = ?, updated_at = ? WHERE id = ?');
    let updatedCount = 0;

    for (const p of products) {
      const cat = p.category_id ? catMap.get(p.category_id) : undefined;
      const productMargin: MarginRule | null =
        p.margin_type && p.margin_value !== null
          ? { type: p.margin_type, value: p.margin_value, maxMargin: p.max_margin }
          : null;
      const categoryMargin: MarginRule | null =
        cat?.margin_type && cat.margin_value !== null
          ? { type: cat.margin_type, value: cat.margin_value, maxMargin: cat.max_margin }
          : null;

      const resolved = resolveEffectiveMargin({
        supplierPrice: p.supplier_price,
        productMargin,
        categoryMargin,
        globalMargin,
      });

      updateStmt.run(resolved.sellingPrice, now, p.id);
      updatedCount++;
    }

    return updatedCount;
  }, db);
}

export function setGlobalMargin(
  marginType: MarginType,
  marginValue: number,
  actor: { id: string; role: string },
  maxMargin: number | null = null
) {
  if (!Number.isFinite(marginValue) || marginValue < 0) {
    throw new Error('Nilai margin tidak boleh negatif');
  }
  if (maxMargin !== null && (!Number.isFinite(maxMargin) || maxMargin < 0)) {
    throw new Error('Maksimal margin tidak boleh negatif');
  }

  const normalizedMax = marginType === 'PERCENT' && maxMargin !== null ? Math.round(maxMargin) : null;
  const old = getGlobalMarginRule();
  const now = new Date().toISOString();

  withTransaction((txDb) => {
    const upsert = txDb.prepare(
      `INSERT INTO settings (setting_key, setting_value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`
    );
    upsert.run('global_margin_type', marginType, now);
    upsert.run('global_margin_value', String(marginValue), now);
    upsert.run('global_margin_max', normalizedMax !== null ? String(normalizedMax) : '', now);

    txDb
      .prepare(
        `INSERT INTO margin_history (scope_type, scope_id, old_margin_type, old_margin_value, old_max_margin, new_margin_type, new_margin_value, new_max_margin, actor_id, created_at)
         VALUES ('GLOBAL', 'GLOBAL', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(old.type, old.value, old.maxMargin ?? null, marginType, marginValue, normalizedMax, actor.id, now);
  });

  const updatedProducts = recalculateAllProductSellingPrices();

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'GLOBAL_MARGIN_UPDATED',
    targetType: 'MARGIN',
    targetId: 'GLOBAL',
    details: { old, new: { type: marginType, value: marginValue, maxMargin: normalizedMax }, updatedProducts },
  });

  return { marginType, marginValue, maxMargin: normalizedMax, updatedProducts };
}

export function setCategoryMargin(
  categoryId: number,
  marginType: MarginType | null,
  marginValue: number | null,
  actor: { id: string; role: string },
  maxMargin: number | null = null
) {
  if (marginValue !== null && (!Number.isFinite(marginValue) || marginValue < 0)) {
    throw new Error('Nilai margin kategori tidak valid');
  }
  if (maxMargin !== null && (!Number.isFinite(maxMargin) || maxMargin < 0)) {
    throw new Error('Maksimal margin kategori tidak valid');
  }

  const normalizedMax = marginType === 'PERCENT' && maxMargin !== null ? Math.round(maxMargin) : null;
  const now = new Date().toISOString();
  withTransaction((txDb) => {
    const existing = txDb
      .prepare('SELECT id, margin_type, margin_value, max_margin FROM categories WHERE id = ?')
      .get(categoryId) as
      | { id: number; margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
      | undefined;
    if (!existing) throw new Error('Kategori tidak ditemukan');

    txDb
      .prepare('UPDATE categories SET margin_type = ?, margin_value = ?, max_margin = ?, updated_at = ? WHERE id = ?')
      .run(marginType, marginValue, normalizedMax, now, categoryId);

    txDb
      .prepare(
        `INSERT INTO margin_history (scope_type, scope_id, old_margin_type, old_margin_value, old_max_margin, new_margin_type, new_margin_value, new_max_margin, actor_id, created_at)
         VALUES ('CATEGORY', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(categoryId),
        existing.margin_type,
        existing.margin_value,
        existing.max_margin ?? null,
        marginType ?? 'GLOBAL_INHERIT',
        marginValue ?? 0,
        normalizedMax,
        actor.id,
        now
      );
  });

  const updatedProducts = recalculateAllProductSellingPrices();

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'CATEGORY_MARGIN_UPDATED',
    targetType: 'CATEGORY',
    targetId: String(categoryId),
    details: { marginType, marginValue, maxMargin: normalizedMax, updatedProducts },
  });

  return { categoryId, marginType, marginValue, maxMargin: normalizedMax, updatedProducts };
}

export function setProductMargin(
  productId: number,
  marginType: MarginType | null,
  marginValue: number | null,
  actor: { id: string; role: string },
  maxMargin: number | null = null
) {
  if (marginValue !== null && (!Number.isFinite(marginValue) || marginValue < 0)) {
    throw new Error('Nilai margin produk tidak valid');
  }
  if (maxMargin !== null && (!Number.isFinite(maxMargin) || maxMargin < 0)) {
    throw new Error('Maksimal margin produk tidak valid');
  }

  const normalizedMax = marginType === 'PERCENT' && maxMargin !== null ? Math.round(maxMargin) : null;
  const now = new Date().toISOString();
  withTransaction((txDb) => {
    const existing = txDb
      .prepare('SELECT id, sku, margin_type, margin_value, max_margin FROM products WHERE id = ?')
      .get(productId) as
      | { id: number; sku: string; margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
      | undefined;
    if (!existing) throw new Error('Produk tidak ditemukan');

    txDb
      .prepare('UPDATE products SET margin_type = ?, margin_value = ?, max_margin = ?, updated_at = ? WHERE id = ?')
      .run(marginType, marginValue, normalizedMax, now, productId);

    txDb
      .prepare(
        `INSERT INTO margin_history (scope_type, scope_id, old_margin_type, old_margin_value, old_max_margin, new_margin_type, new_margin_value, new_max_margin, actor_id, created_at)
         VALUES ('PRODUCT', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        existing.sku,
        existing.margin_type,
        existing.margin_value,
        existing.max_margin ?? null,
        marginType ?? 'INHERIT',
        marginValue ?? 0,
        normalizedMax,
        actor.id,
        now
      );
  });

  const updatedProducts = recalculateAllProductSellingPrices();

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'PRODUCT_MARGIN_UPDATED',
    targetType: 'PRODUCT',
    targetId: String(productId),
    details: { marginType, marginValue, maxMargin: normalizedMax, updatedProducts },
  });

  return { productId, marginType, marginValue, maxMargin: normalizedMax, updatedProducts };
}

export function listMarginHistory(limit = 50) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM margin_history ORDER BY id DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, limit)));
}
