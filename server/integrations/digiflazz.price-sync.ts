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

export async function runDigiflazzPriceSync(
  client: DigiflazzPort = defaultDigiflazzClient,
  triggerSource: 'CRON' | 'MANUAL' = 'CRON'
): Promise<{
  ok: boolean;
  syncLogId: number;
  successCount: number;
  failureCount: number;
  errorMessage?: string;
}> {
  if (syncInProgress) {
    return {
      ok: false,
      syncLogId: 0,
      successCount: 0,
      failureCount: 0,
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
        errorMessage: result.errorMessage,
      };
    }

    let successCount = 0;
    let failureCount = 0;
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
      const findProduct = txDb.prepare('SELECT id, margin_type, margin_value, max_margin FROM products WHERE sku = ?');
      const insertProduct = txDb.prepare(
        `INSERT INTO products (sku, name, category_id, brand, type, supplier_price, selling_price, margin_type, margin_value, status, is_available, last_price_sync_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
      );
      const updateProduct = txDb.prepare(
        `UPDATE products
         SET name = ?, category_id = ?, brand = ?, type = ?, supplier_price = ?, selling_price = ?, is_available = ?, last_price_sync_at = ?, updated_at = ?
         WHERE id = ?`
      );

      for (const item of result.items) {
        try {
          if (!item.buyer_sku_code || !item.product_name || !Number.isFinite(item.price) || item.price < 0) {
            failureCount++;
            continue;
          }

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

          const existing = findProduct.get(item.buyer_sku_code) as
            | { id: number; margin_type: MarginType | null; margin_value: number | null; max_margin: number | null }
            | undefined;

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

          const isAvailable = Boolean(item.buyer_product_status && item.seller_product_status) ? 1 : 0;

          if (!existing) {
            insertProduct.run(
              item.buyer_sku_code,
              item.product_name.trim(),
              catRow.id,
              item.brand || null,
              item.type || null,
              Math.round(item.price),
              marginCalc.sellingPrice,
              isAvailable ? 'ACTIVE' : 'INACTIVE',
              isAvailable,
              now,
              now,
              now
            );
          } else {
            // Never overwrite product-specific or category margin config during sync!
            updateProduct.run(
              item.product_name.trim(),
              catRow.id,
              item.brand || null,
              item.type || null,
              Math.round(item.price),
              marginCalc.sellingPrice,
              isAvailable,
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
    }, db);

    db.prepare(
      `UPDATE price_sync_logs
       SET completed_at = ?, status = 'SUCCESS', success_count = ?, failure_count = ?, details_safe = ?
       WHERE id = ?`
    ).run(
      new Date().toISOString(),
      successCount,
      failureCount,
      JSON.stringify({ triggerSource, totalReceived: result.items.length }),
      syncLogId
    );

    logger.info('Digiflazz price sync completed', {
      service: 'digiflazz-price-sync',
      details: { triggerSource, successCount, failureCount },
    });

    return { ok: true, syncLogId, successCount, failureCount };
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

    return { ok: false, syncLogId, successCount: 0, failureCount: 0, errorMessage: msg };
  } finally {
    syncInProgress = false;
  }
}
