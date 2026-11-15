import { getDb, withTransaction } from '../database/connection';
import { resolveEffectiveMargin, type MarginRule, type MarginType } from '../domain/pricing';
import { getSetting } from './settings.service';
import { recordAuditLog } from './audit.service';

export interface CategoryRow {
  id: number;
  name: string;
  slug: string;
  margin_type: MarginType | null;
  margin_value: number | null;
  max_margin: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category_id: number | null;
  category_name?: string | null;
  brand: string | null;
  type: string | null;
  supplier_price: number;
  selling_price: number;
  margin_type: MarginType | null;
  margin_value: number | null;
  max_margin: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  is_available: number;
  last_price_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'category';
}

export function getGlobalMarginRule(): MarginRule {
  const type = getSetting('global_margin_type') === 'PERCENT' ? 'PERCENT' : 'FIXED';
  const rawVal = Number(getSetting('global_margin_value') ?? 1000);
  const rawMaxStr = getSetting('global_margin_max');
  const parsedMax =
    type === 'PERCENT' && rawMaxStr && rawMaxStr.trim() !== '' ? Number(rawMaxStr) : null;
  const maxMargin =
    parsedMax !== null && Number.isFinite(parsedMax) && parsedMax >= 0
      ? Math.round(parsedMax)
      : null;
  return {
    type,
    value: Number.isFinite(rawVal) && rawVal >= 0 ? rawVal : 1000,
    maxMargin,
  };
}

export function listCategories(onlyActive = false): CategoryRow[] {
  const db = getDb();
  const where = onlyActive ? "WHERE status = 'ACTIVE'" : '';
  return db.prepare(`SELECT * FROM categories ${where} ORDER BY name ASC`).all() as CategoryRow[];
}

export function createCategory(
  input: { name: string; marginType?: MarginType | null; marginValue?: number | null; maxMargin?: number | null },
  actor: { id: string; role: string }
): CategoryRow {
  const name = input.name.trim();
  if (!name) throw new Error('Nama kategori wajib diisi');
  const slug = slugify(name);
  const now = new Date().toISOString();
  const maxMargin =
    input.marginType === 'PERCENT' && input.maxMargin !== null && input.maxMargin !== undefined
      ? Math.round(input.maxMargin)
      : null;

  const created = withTransaction((txDb) => {
    const res = txDb
      .prepare(
        `INSERT INTO categories (name, slug, margin_type, margin_value, max_margin, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
      )
      .run(name, slug, input.marginType ?? null, input.marginValue ?? null, maxMargin, now, now);
    return txDb.prepare('SELECT * FROM categories WHERE id = ?').get(Number(res.lastInsertRowid)) as CategoryRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'CATEGORY_CREATED',
    targetType: 'CATEGORY',
    targetId: String(created.id),
    details: { name: created.name },
  });

  return created;
}

export function updateCategory(
  id: number,
  input: {
    name?: string;
    status?: 'ACTIVE' | 'INACTIVE';
    marginType?: MarginType | null;
    marginValue?: number | null;
    maxMargin?: number | null;
  },
  actor: { id: string; role: string }
): CategoryRow {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined;
  if (!existing) throw new Error('Kategori tidak ditemukan');

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  if (!name) throw new Error('Nama kategori tidak boleh kosong');
  const status = input.status ?? existing.status;
  const marginType = input.marginType !== undefined ? input.marginType : existing.margin_type;
  const marginValue = input.marginValue !== undefined ? input.marginValue : existing.margin_value;
  const maxMargin =
    marginType === 'PERCENT'
      ? input.maxMargin !== undefined
        ? input.maxMargin !== null
          ? Math.round(input.maxMargin)
          : null
        : existing.max_margin
      : null;
  const now = new Date().toISOString();

  const updated = withTransaction((txDb) => {
    txDb
      .prepare(
        `UPDATE categories SET name = ?, slug = ?, status = ?, margin_type = ?, margin_value = ?, max_margin = ?, updated_at = ? WHERE id = ?`
      )
      .run(name, slugify(name), status, marginType, marginValue, maxMargin, now, id);
    return txDb.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'CATEGORY_UPDATED',
    targetType: 'CATEGORY',
    targetId: String(id),
    details: { name, status, marginType, marginValue, maxMargin },
  });

  return updated;
}

export function deleteCategorySafely(id: number, actor: { id: string; role: string }): { deleted: boolean; message: string } {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined;
  if (!existing) throw new Error('Kategori tidak ditemukan');

  const linkedProducts = (
    db.prepare('SELECT COUNT(*) as cnt FROM products WHERE category_id = ?').get(id) as { cnt: number }
  ).cnt;

  if (linkedProducts > 0) {
    throw new Error(
      `Kategori masih memiliki ${linkedProducts} produk terkait. Nonaktifkan kategori atau pindahkan produk terlebih dahulu.`
    );
  }

  withTransaction((txDb) => {
    txDb.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'CATEGORY_DELETED',
    targetType: 'CATEGORY',
    targetId: String(id),
    details: { name: existing.name },
  });

  return { deleted: true, message: 'Kategori berhasil dihapus' };
}

export function listProducts(params: {
  page?: number;
  limit?: number;
  categoryId?: number;
  search?: string;
  onlyActive?: boolean;
}) {
  const db = getDb();
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 30));
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.onlyActive) {
    where.push("p.status = 'ACTIVE' AND p.is_available = 1");
  }
  if (params.categoryId) {
    where.push('p.category_id = ?');
    args.push(params.categoryId);
  }
  if (params.search) {
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.brand LIKE ?)');
    const q = `%${params.search}%`;
    args.push(q, q, q);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM products p ${whereSql}`).get(...args) as { cnt: number }
  ).cnt;

  const items = db
    .prepare(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereSql}
       ORDER BY p.name ASC LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as ProductRow[];

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

export function getProductBySkuOrId(skuOrId: string | number): ProductRow | null {
  const db = getDb();
  if (typeof skuOrId === 'number' || /^\d+$/.test(String(skuOrId))) {
    const byId = db
      .prepare(
        `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`
      )
      .get(Number(skuOrId)) as ProductRow | undefined;
    if (byId) return byId;
  }
  const bySku = db
    .prepare(
      `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE UPPER(p.sku) = UPPER(?)`
    )
    .get(String(skuOrId).trim()) as ProductRow | undefined;
  return bySku ?? null;
}

export function upsertProduct(
  input: {
    sku: string;
    name: string;
    categoryId: number | null;
    brand?: string | null;
    type?: string | null;
    supplierPrice: number;
    marginType?: MarginType | null;
    marginValue?: number | null;
    maxMargin?: number | null;
    status?: 'ACTIVE' | 'INACTIVE';
  },
  actor: { id: string; role: string }
): ProductRow {
  const sku = input.sku.trim().toUpperCase();
  const name = input.name.trim();
  if (!sku || !name) throw new Error('SKU dan nama produk wajib diisi');
  if (!Number.isFinite(input.supplierPrice) || input.supplierPrice < 0) {
    throw new Error('Harga supplier tidak valid');
  }
  if (input.maxMargin !== null && input.maxMargin !== undefined && (!Number.isFinite(input.maxMargin) || input.maxMargin < 0)) {
    throw new Error('Batas maksimal margin produk tidak valid');
  }

  const db = getDb();
  const globalMargin = getGlobalMarginRule();
  let categoryMargin: MarginRule | null = null;
  if (input.categoryId) {
    const cat = db.prepare('SELECT margin_type, margin_value, max_margin FROM categories WHERE id = ?').get(input.categoryId) as
      | { margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
      | undefined;
    if (cat?.margin_type && cat.margin_value !== null) {
      categoryMargin = { type: cat.margin_type, value: cat.margin_value, maxMargin: cat.max_margin };
    }
  }

  const normalizedMaxMargin =
    input.marginType === 'PERCENT' && input.maxMargin !== null && input.maxMargin !== undefined
      ? Math.round(input.maxMargin)
      : null;

  const productMargin: MarginRule | null =
    input.marginType && input.marginValue !== null && input.marginValue !== undefined
      ? { type: input.marginType, value: input.marginValue, maxMargin: normalizedMaxMargin }
      : null;

  const resolved = resolveEffectiveMargin({
    supplierPrice: Math.round(input.supplierPrice),
    productMargin,
    categoryMargin,
    globalMargin,
  });

  const now = new Date().toISOString();
  const product = withTransaction((txDb) => {
    const existing = txDb.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number } | undefined;
    if (existing) {
      txDb
        .prepare(
          `UPDATE products
           SET name = ?, category_id = ?, brand = ?, type = ?, supplier_price = ?, selling_price = ?, margin_type = ?, margin_value = ?, max_margin = ?, status = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          name,
          input.categoryId,
          input.brand ?? null,
          input.type ?? null,
          Math.round(input.supplierPrice),
          resolved.sellingPrice,
          input.marginType ?? null,
          input.marginValue ?? null,
          normalizedMaxMargin,
          input.status ?? 'ACTIVE',
          now,
          existing.id
        );
      return txDb.prepare('SELECT * FROM products WHERE id = ?').get(existing.id) as ProductRow;
    }

    const res = txDb
      .prepare(
        `INSERT INTO products (sku, name, category_id, brand, type, supplier_price, selling_price, margin_type, margin_value, max_margin, status, is_available, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        sku,
        name,
        input.categoryId,
        input.brand ?? null,
        input.type ?? null,
        Math.round(input.supplierPrice),
        resolved.sellingPrice,
        input.marginType ?? null,
        input.marginValue ?? null,
        normalizedMaxMargin,
        input.status ?? 'ACTIVE',
        now,
        now
      );
    return txDb.prepare('SELECT * FROM products WHERE id = ?').get(Number(res.lastInsertRowid)) as ProductRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'PRODUCT_SAVED',
    targetType: 'PRODUCT',
    targetId: product.sku,
    details: {
      sellingPrice: product.selling_price,
      status: product.status,
      maxMargin: normalizedMaxMargin,
    },
  });

  return product;
}

export function updateProductStatus(
  id: number,
  status: 'ACTIVE' | 'INACTIVE',
  actor: { id: string; role: string }
): ProductRow {
  const now = new Date().toISOString();
  const updated = withTransaction((txDb) => {
    const existing = txDb.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
    if (!existing) throw new Error('Produk tidak ditemukan');
    txDb.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    return txDb.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'PRODUCT_STATUS_CHANGED',
    targetType: 'PRODUCT',
    targetId: updated.sku,
    details: { status },
  });

  return updated;
}
