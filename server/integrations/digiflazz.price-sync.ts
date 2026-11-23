import { getDb, withTransaction } from '../database/connection';
import { resolveEffectiveMargin, type MarginRule, type MarginType } from '../domain/pricing';
import { logger } from '../logging/logger';
import { defaultDigiflazzClient, type DigiflazzPort } from './digiflazz.client';

let syncInProgress = false;

export function isPriceSyncRunning(): boolean {
  return syncInProgress;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'lainnya';
}

function normalizeSupplierDescription(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return null;
  return clean.length > 1000 ? `${clean.slice(0, 997).trimEnd()}...` : clean;
}

export async function runDigiflazzPriceSync(
  client: DigiflazzPort = defaultDigiflazzClient,
  triggerSource: 'CRON' | 'MANUAL' = 'CRON'
): Promise<{
  ok: boolean;
  syncLogId: number;
  successCount: number;
  failureCount: number;
  deletedCount: number;
  errorMessage?: string;
}> {
  if (syncInProgress) {
    return {
      ok: false,
      syncLogId: 0,
      successCount: 0,
      failureCount: 0,
      deletedCount: 0,
      errorMessage: 'Sinkronisasi harga Digiflazz sedang berjalan',
    };
  }

  syncInProgress = true;
  const db = getDb();
  const startedAt = new Date().toISOString();

  const logRes = db
    .prepare(
      `INSERT INTO price_sync_logs (started_at, status, success_count, failure_count, details_safe)
       VALUES (?, 'RUNNING', 0, 0, ?)`
    )
    .run(startedAt, JSON.stringify({ triggerSource }));
  const syncLogId = Number(logRes.lastInsertRowid);

  try {
    const result = await client.fetchPriceList();
    if (!result.ok) {
      db.prepare(
        `UPDATE price_sync_logs
         SET completed_at = ?, status = 'FAILED', details_safe = ?
         WHERE id = ?`
      ).run(
        new Date().toISOString(),
        JSON.stringify({ triggerSource, error: result.errorMessage }),
        syncLogId
      );
      return {
        ok: false,
        syncLogId,
        successCount: 0,
        failureCount: 0,
        deletedCount: 0,
        errorMessage: result.errorMessage,
      };
    }

    let successCount = 0;
    let failureCount = 0;
    let deletedCount = 0;
    const now = new Date().toISOString();

    withTransaction((txDb) => {
      const globalTypeRow = txDb
        .prepare("SELECT setting_value FROM settings WHERE setting_key = 'global_margin_type'")
        .get() as { setting_value: string } | undefined;
      const globalValRow = txDb
        .prepare("SELECT setting_value FROM settings WHERE setting_key = 'global_margin_value'")
        .get() as { setting_value: string } | undefined;
      const globalMaxRow = txDb
        .prepare("SELECT setting_value FROM settings WHERE setting_key = 'global_margin_max'")
        .get() as { setting_value: string } | undefined;

      const globalType = (globalTypeRow?.setting_value === 'PERCENT' ? 'PERCENT' : 'FIXED') as MarginType;
      const rawMax = globalMaxRow?.setting_value?.trim();
      const parsedGlobalMax = globalType === 'PERCENT' && rawMax ? Number(rawMax) : null;
      const globalMargin: MarginRule = {
        type: globalType,
        value: Number(globalValRow?.setting_value ?? 1000) || 1000,
        maxMargin: parsedGlobalMax !== null && Number.isFinite(parsedGlobalMax) && parsedGlobalMax >= 0 ? Math.round(parsedGlobalMax) : null,
      };

      const findCategory = txDb.prepare('SELECT id, margin_type, margin_value, max_margin FROM categories WHERE slug = ? OR name = ?');
      const insertCategory = txDb.prepare(
        `INSERT INTO categories (name, slug, margin_type, margin_value, status, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'ACTIVE', ?, ?)`
      );
      const findProduct = txDb.prepare(
        'SELECT id, description, supplier_description, margin_type, margin_value, max_margin FROM products WHERE sku = ?'
      );
      const insertProduct = txDb.prepare(
        `INSERT INTO products (sku, name, description, supplier_description, category_id, brand, type, supplier_price, selling_price, margin_type, margin_value, status, is_available, last_price_sync_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
      );
      const updateProduct = txDb.prepare(
        `UPDATE products
         SET name = ?, description = ?, supplier_description = ?, category_id = ?, brand = ?, type = ?, supplier_price = ?, selling_price = ?, is_available = ?, last_price_sync_at = ?, updated_at = ?
         WHERE id = ?`
      );

      const availableSkus = new Set<string>();

      for (const item of result.items) {
        try {
          if (!item.buyer_sku_code || !item.product_name || !Number.isFinite(item.price) || item.price < 0) {
            failureCount++;
            continue;
          }

          const sku = item.buyer_sku_code.trim().toUpperCase();
          const isAvailable = Boolean(item.buyer_product_status && item.seller_product_status);

          // Skip unavailable products from sync insertion; existing unavailable items will be removed below
          if (!isAvailable) {
            continue;
          }

          availableSkus.add(sku);

          const categoryName = (item.category || 'Umum').trim();
          const categorySlug = slugify(categoryName);
          let catRow = findCategory.get(categorySlug, categoryName) as
            | { id: number; margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
            | undefined;

          if (!catRow) {
            const catInsert = insertCategory.run(categoryName, categorySlug, now, now);
            catRow = {
              id: Number(catInsert.lastInsertRowid),
              margin_type: null,
              margin_value: null,
              max_margin: null,
            };
          }

          const existing = findProduct.get(sku) as
            | {
                id: number;
                description: string | null;
                supplier_description: string | null;
                margin_type: MarginType | null;
                margin_value: number | null;
                max_margin: number | null;
              }
            | undefined;

          const digiDesc = normalizeSupplierDescription(item.desc);

          const productMargin: MarginRule | null =
            existing?.margin_type && existing.margin_value !== null
              ? { type: existing.margin_type, value: existing.margin_value, maxMargin: existing.max_margin }
              : null;
          const categoryMargin: MarginRule | null =
            catRow.margin_type && catRow.margin_value !== null
              ? { type: catRow.margin_type, value: catRow.margin_value, maxMargin: catRow.max_margin }
              : null;

          const marginCalc = resolveEffectiveMargin({
            supplierPrice: Math.round(item.price),
            productMargin,
            categoryMargin,
            globalMargin,
          });

          if (!existing) {
            insertProduct.run(
              sku,
              item.product_name.trim(),
              digiDesc,
              digiDesc,
              catRow.id,
              item.brand || null,
              item.type || null,
              Math.round(item.price),
              marginCalc.sellingPrice,
              'ACTIVE',
              1,
              now,
              now,
              now
            );
          } else {
            // Auto-fill/update description from Digiflazz when empty or still synced from supplier; keep manual admin overrides intact
            const existingDescTrimmed = (existing.description || '').trim();
            const existingSupplierTrimmed = (existing.supplier_description || '').trim();
            const isManualOverride =
              Boolean(existingDescTrimmed) && existingDescTrimmed !== existingSupplierTrimmed;
            const nextDescription = isManualOverride ? existing.description : digiDesc;

            // Never overwrite product-specific or category margin config during sync!
            updateProduct.run(
              item.product_name.trim(),
              nextDescription,
              digiDesc,
              catRow.id,
              item.brand || null,
              item.type || null,
              Math.round(item.price),
              marginCalc.sellingPrice,
              1,
              now,
              now,
              existing.id
            );
          }

          successCount++;
        } catch {
          failureCount++;
        }
      }

      // Delete (or deactivate if referenced by existing transactions) any product missing or unavailable in Digiflazz sync
      if (result.items.length > 0) {
        const allProducts = txDb.prepare('SELECT id, sku FROM products').all() as Array<{ id: number; sku: string }>;
        const countTxStmt = txDb.prepare('SELECT COUNT(*) as cnt FROM transactions WHERE product_id = ?');
        const deleteProductStmt = txDb.prepare('DELETE FROM products WHERE id = ?');
        const deactivateProductStmt = txDb.prepare(
          `UPDATE products SET status = 'INACTIVE', is_available = 0, last_price_sync_at = ?, updated_at = ? WHERE id = ?`
        );

        for (const prod of allProducts) {
          if (!availableSkus.has(prod.sku.trim().toUpperCase())) {
            const txCount = (countTxStmt.get(prod.id) as { cnt: number }).cnt;
            if (txCount === 0) {
              deleteProductStmt.run(prod.id);
              deletedCount++;
            } else {
              deactivateProductStmt.run(now, now, prod.id);
            }
          }
        }
      }
    }, db);

    db.prepare(
      `UPDATE price_sync_logs
       SET completed_at = ?, status = 'SUCCESS', success_count = ?, failure_count = ?, details_safe = ?
       WHERE id = ?`
    ).run(
      new Date().toISOString(),
      successCount,
      failureCount,
      JSON.stringify({ triggerSource, totalReceived: result.items.length, deletedCount }),
      syncLogId
    );

    logger.info('Digiflazz price sync completed', {
      service: 'digiflazz-price-sync',
      details: { triggerSource, successCount, failureCount, deletedCount },
    });

    return { ok: true, syncLogId, successCount, failureCount, deletedCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected price sync error';
    db.prepare(
      `UPDATE price_sync_logs
       SET completed_at = ?, status = 'FAILED', details_safe = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), JSON.stringify({ triggerSource, error: msg }), syncLogId);

    logger.error('Digiflazz price sync exception', {
      service: 'digiflazz-price-sync',
      details: { error: msg },
    });

    return { ok: false, syncLogId, successCount: 0, failureCount: 0, deletedCount: 0, errorMessage: msg };
  } finally {
    syncInProgress = false;
  }
}
