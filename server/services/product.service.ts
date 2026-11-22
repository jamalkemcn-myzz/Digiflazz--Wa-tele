import { getDb, withTransaction } from '../database/connection';
import { resolveEffectiveMargin, type MarginRule, type MarginType } from '../domain/pricing';
import {
  filterProductsBySeriesAndDuration,
  summarizeDurations,
  summarizeSeries,
  type DurationBucket,
  type DurationSummary,
  type SeriesSummary,
} from '../domain/catalog-filter';
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
  description: string | null;
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

export function getCategoryById(id: number): CategoryRow | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined) ?? null;
}

export interface CategoryBrandSummary {
  brand: string;
  productCount: number;
  minPrice: number;
}

export function listActiveBrandsInCategory(categoryId: number): CategoryBrandSummary[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT
         COALESCE(NULLIF(TRIM(brand), ''), 'LAINNYA') as brand,
         COUNT(*) as productCount,
         MIN(selling_price) as minPrice
       FROM products
       WHERE category_id = ?
         AND status = 'ACTIVE'
         AND is_available = 1
       GROUP BY UPPER(COALESCE(NULLIF(TRIM(brand), ''), 'LAINNYA'))
       ORDER BY
         CASE WHEN COALESCE(NULLIF(TRIM(brand), ''), 'LAINNYA') = 'LAINNYA' THEN 1 ELSE 0 END ASC,
         brand ASC`
    )
    .all(categoryId) as CategoryBrandSummary[];
}

export function listActiveProductsForBrand(categoryId: number, brand?: string): ProductRow[] {
  const db = getDb();
  const where: string[] = ['p.category_id = ?', "p.status = 'ACTIVE'", 'p.is_available = 1'];
  const args: unknown[] = [categoryId];

  if (brand && brand.trim()) {
    const cleanBrand = brand.trim();
    if (cleanBrand.toUpperCase() === 'LAINNYA') {
      where.push("(p.brand IS NULL OR TRIM(p.brand) = '')");
    } else {
      where.push('UPPER(TRIM(p.brand)) = UPPER(TRIM(?))');
      args.push(cleanBrand);
    }
  }

  return db
    .prepare(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.selling_price ASC, p.name ASC`
    )
    .all(...args) as ProductRow[];
}

export interface BrandCatalogAnalysis {
  totalInBrand: number;
  filteredCount: number;
  seriesSummaries: SeriesSummary[];
  durationSummaries: DurationSummary[];
}

export function analyzeBrandCatalog(
  categoryId: number,
  brand?: string,
  series?: string
): BrandCatalogAnalysis {
  const allInBrand = listActiveProductsForBrand(categoryId, brand);
  const seriesSummaries = summarizeSeries(allInBrand);
  const scoped =
    series && series.trim() && series.trim().toUpperCase() !== 'ALL'
      ? filterProductsBySeriesAndDuration(allInBrand, { series })
      : allInBrand;
  const durationSummaries = summarizeDurations(scoped);
  return {
    totalInBrand: allInBrand.length,
    filteredCount: scoped.length,
    seriesSummaries,
    durationSummaries,
  };
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
  brand?: string;
  series?: string;
  durationBucket?: DurationBucket | 'ALL';
  search?: string;
  onlyActive?: boolean;
  sortBy?: 'NAME_ASC' | 'PRICE_ASC';
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
  if (params.brand && params.brand.trim()) {
    const cleanBrand = params.brand.trim();
    if (cleanBrand.toUpperCase() === 'LAINNYA') {
      where.push("(p.brand IS NULL OR TRIM(p.brand) = '')");
    } else {
      where.push('UPPER(TRIM(p.brand)) = UPPER(TRIM(?))');
      args.push(cleanBrand);
    }
  }
  if (params.search) {
    where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.brand LIKE ? OR p.type LIKE ?)');
    const q = `%${params.search}%`;
    args.push(q, q, q, q);
  }

  const orderBySql =
    params.sortBy === 'PRICE_ASC'
      ? 'ORDER BY p.selling_price ASC, p.name ASC'
      : 'ORDER BY p.name ASC';

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const hasDomainFilter =
    Boolean(params.series && params.series.trim() && params.series.trim().toUpperCase() !== 'ALL') ||
    Boolean(params.durationBucket && params.durationBucket !== 'ALL');

  if (hasDomainFilter) {
    const allRows = db
      .prepare(
        `SELECT p.*, c.name as category_name
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         ${whereSql}
         ${orderBySql}`
      )
      .all(...args) as ProductRow[];
    const filtered = filterProductsBySeriesAndDuration(allRows, {
      series: params.series,
      durationBucket: params.durationBucket,
    });
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);
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

  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM products p ${whereSql}`).get(...args) as { cnt: number }
  ).cnt;

  const items = db
    .prepare(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereSql}
       ${orderBySql} LIMIT ? OFFSET ?`
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
    description?: string | null;
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

  const hasDescriptionField = input.description !== undefined;
  const normalizedDescription = hasDescriptionField
    ? (input.description || '').trim() || null
    : undefined;
  if (normalizedDescription && normalizedDescription.length > 500) {
    throw new Error('Deskripsi produk maksimal 500 karakter');
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
    const existing = txDb
      .prepare('SELECT id, description FROM products WHERE sku = ?')
      .get(sku) as { id: number; description: string | null } | undefined;
    if (existing) {
      const nextDescription = hasDescriptionField ? (normalizedDescription ?? null) : existing.description;
      txDb
        .prepare(
          `UPDATE products
           SET name = ?, description = ?, category_id = ?, brand = ?, type = ?, supplier_price = ?, selling_price = ?, margin_type = ?, margin_value = ?, max_margin = ?, status = ?, is_available = 1, updated_at = ?
           WHERE id = ?`
        )
        .run(
          name,
          nextDescription,
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
        `INSERT INTO products (sku, name, description, category_id, brand, type, supplier_price, selling_price, margin_type, margin_value, max_margin, status, is_available, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        sku,
        name,
        normalizedDescription ?? null,
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

export function updateProductDescription(
  skuOrId: string | number,
  description: string | null,
  actor: { id: string; role: string }
): ProductRow {
  const existing = getProductBySkuOrId(skuOrId);
  if (!existing) throw new Error(`Produk "${skuOrId}" tidak ditemukan`);
  const clean = (description || '').trim();
  const nextDesc = clean === '-' || !clean ? null : clean;
  if (nextDesc && nextDesc.length > 500) {
    throw new Error('Deskripsi produk maksimal 500 karakter');
  }
  const now = new Date().toISOString();
  const updated = withTransaction((txDb) => {
    txDb
      .prepare('UPDATE products SET description = ?, updated_at = ? WHERE id = ?')
      .run(nextDesc, now, existing.id);
    return txDb
      .prepare(
        `SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`
      )
      .get(existing.id) as ProductRow;
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'PRODUCT_DESCRIPTION_UPDATED',
    targetType: 'PRODUCT',
    targetId: updated.sku,
    details: { cleared: !nextDesc, length: nextDesc?.length || 0 },
  });

  return updated;
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
    if (status === 'ACTIVE') {
      txDb.prepare('UPDATE products SET status = ?, is_available = 1, updated_at = ? WHERE id = ?').run(status, now, id);
    } else {
      txDb.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    }
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

export function deleteProductSafely(
  id: number,
  actor: { id: string; role: string }
): { deleted: boolean; sku: string; message: string } {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
  if (!existing) throw new Error('Produk tidak ditemukan');

  const txCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM transactions WHERE product_id = ?').get(id) as { cnt: number }
  ).cnt;

  if (txCount > 0) {
    throw new Error(
      `Produk ${existing.sku} memiliki ${txCount} transaksi terkait dan tidak dapat dihapus permanen. Gunakan tombol Nonaktifkan.`
    );
  }

  withTransaction((txDb) => {
    txDb.prepare('DELETE FROM products WHERE id = ?').run(id);
  });

  recordAuditLog({
    actorId: actor.id,
    actorRole: actor.role,
    action: 'PRODUCT_DELETED',
    targetType: 'PRODUCT',
    targetId: existing.sku,
    details: { name: existing.name },
  });

  return { deleted: true, sku: existing.sku, message: `Produk ${existing.name} (${existing.sku}) berhasil dihapus.` };
}
