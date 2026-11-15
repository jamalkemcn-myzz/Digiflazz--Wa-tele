import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { getDb, withTransaction } from './connection';
import { config } from '../config/env';
import { logger } from '../logging/logger';

interface Migration {
  id: string;
  name: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    id: '001',
    name: 'initial_ppob_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_code TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'SUSPENDED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS customer_identities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
          platform TEXT NOT NULL CHECK(platform IN ('WHATSAPP', 'TELEGRAM', 'DASHBOARD')),
          platform_user_id TEXT NOT NULL,
          platform_username TEXT,
          linked_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(platform, platform_user_id),
          UNIQUE(customer_id, platform)
        );
        CREATE INDEX IF NOT EXISTS idx_customer_identities_customer ON customer_identities(customer_id);

        CREATE TABLE IF NOT EXISTS account_link_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code_hash TEXT NOT NULL UNIQUE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          source_platform TEXT NOT NULL CHECK(source_platform IN ('WHATSAPP', 'TELEGRAM')),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_account_link_codes_expires ON account_link_codes(expires_at);

        CREATE TABLE IF NOT EXISTS cooldowns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
          until_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          transaction_id TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('OWNER', 'ADMIN', 'OPERATOR')),
          permissions_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admin_identities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          platform TEXT NOT NULL CHECK(platform IN ('WHATSAPP', 'TELEGRAM', 'DASHBOARD')),
          platform_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(platform, platform_user_id)
        );

        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          slug TEXT NOT NULL UNIQUE,
          margin_type TEXT CHECK(margin_type IN ('FIXED', 'PERCENT')),
          margin_value REAL,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sku TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          brand TEXT,
          type TEXT,
          supplier_price INTEGER NOT NULL CHECK(supplier_price >= 0),
          selling_price INTEGER NOT NULL CHECK(selling_price >= 0),
          margin_type TEXT CHECK(margin_type IN ('FIXED', 'PERCENT')),
          margin_value REAL,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
          is_available INTEGER NOT NULL DEFAULT 1,
          last_price_sync_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
        CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, is_available);

        CREATE TABLE IF NOT EXISTS margin_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope_type TEXT NOT NULL CHECK(scope_type IN ('GLOBAL', 'CATEGORY', 'PRODUCT')),
          scope_id TEXT,
          old_margin_type TEXT,
          old_margin_value REAL,
          new_margin_type TEXT NOT NULL,
          new_margin_value REAL NOT NULL,
          actor_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS coupons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT,
          discount_type TEXT NOT NULL CHECK(discount_type IN ('FIXED', 'PERCENT')),
          discount_value REAL NOT NULL CHECK(discount_value >= 0),
          min_purchase INTEGER NOT NULL DEFAULT 0 CHECK(min_purchase >= 0),
          max_discount INTEGER,
          claim_limit INTEGER CHECK(claim_limit IS NULL OR claim_limit > 0),
          claimed_count INTEGER NOT NULL DEFAULT 0 CHECK(claimed_count >= 0),
          per_customer_limit INTEGER NOT NULL DEFAULT 1 CHECK(per_customer_limit > 0),
          scope_type TEXT NOT NULL DEFAULT 'ALL' CHECK(scope_type IN ('ALL', 'CATEGORY', 'PRODUCT')),
          scope_id INTEGER,
          starts_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'INACTIVE')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS coupon_usages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
          transaction_id TEXT NOT NULL,
          discount_amount INTEGER NOT NULL CHECK(discount_amount >= 0),
          created_at TEXT NOT NULL,
          UNIQUE(coupon_id, transaction_id)
        );
        CREATE INDEX IF NOT EXISTS idx_coupon_usages_customer ON coupon_usages(coupon_id, customer_id);

        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT UNIQUE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
          platform TEXT NOT NULL CHECK(platform IN ('WHATSAPP', 'TELEGRAM', 'DASHBOARD')),
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          product_sku_snapshot TEXT NOT NULL,
          product_name_snapshot TEXT NOT NULL,
          supplier_price_snapshot INTEGER NOT NULL,
          margin_snapshot INTEGER NOT NULL,
          coupon_code_snapshot TEXT,
          discount_snapshot INTEGER NOT NULL DEFAULT 0,
          unique_code INTEGER NOT NULL CHECK(unique_code BETWEEN 1 AND 99),
          payment_amount INTEGER NOT NULL CHECK(payment_amount > 0),
          payment_method TEXT NOT NULL DEFAULT 'QRIS',
          payment_status TEXT NOT NULL DEFAULT 'CREATED',
          supplier_status TEXT NOT NULL DEFAULT 'NONE',
          transaction_status TEXT NOT NULL DEFAULT 'CREATED',
          gateway_reference TEXT UNIQUE,
          qris_payload_json TEXT,
          qr_message_ref_json TEXT,
          supplier_reference TEXT UNIQUE,
          supplier_sn TEXT,
          supplier_message TEXT,
          destination TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expired_at TEXT,
          paid_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_customer ON transactions(customer_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(transaction_status);
        CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);

        -- Enforce Anti-Double-Order at the database level: max 1 active transaction per customer
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_tx_per_customer
          ON transactions(customer_id)
          WHERE transaction_status IN (
            'CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING',
            'PAID', 'PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING'
          );

        -- Enforce unique payment_amount among active pending QRIS invoices to avoid collision
        CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_payment_amount
          ON transactions(payment_amount)
          WHERE transaction_status IN ('CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING');

        CREATE TABLE IF NOT EXISTS transaction_status_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT NOT NULL REFERENCES transactions(transaction_id) ON DELETE CASCADE,
          old_status TEXT,
          new_status TEXT NOT NULL,
          source TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tx_history_txid ON transaction_status_history(transaction_id);

        CREATE TABLE IF NOT EXISTS payment_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gateway_event_id TEXT NOT NULL UNIQUE,
          gateway_reference TEXT,
          transaction_id TEXT,
          payload_safe TEXT NOT NULL,
          verification_status TEXT NOT NULL CHECK(verification_status IN ('VERIFIED', 'REJECTED', 'DUPLICATE')),
          processed_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payment_events_ref ON payment_events(gateway_reference);

        CREATE TABLE IF NOT EXISTS supplier_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(transaction_id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED_DEFINITIVE', 'UNKNOWN')),
          attempts INTEGER NOT NULL DEFAULT 0,
          locked_by TEXT,
          locked_at TEXT,
          next_attempt_at TEXT NOT NULL,
          last_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_supplier_jobs_poll ON supplier_jobs(status, next_attempt_at);

        CREATE TABLE IF NOT EXISTS refunds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
          amount INTEGER NOT NULL CHECK(amount > 0),
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PROCESSED' CHECK(status IN ('PENDING', 'PROCESSED')),
          approved_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          processed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS refund_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ledger_id TEXT NOT NULL UNIQUE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
          transaction_id TEXT REFERENCES transactions(transaction_id) ON DELETE RESTRICT,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('REFUND_CREDIT', 'MANUAL_ADJUSTMENT_CREDIT', 'MANUAL_ADJUSTMENT_DEBIT')),
          amount INTEGER NOT NULL,
          description TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_source TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_refund_ledger_customer ON refund_ledger(customer_id);

        -- Enforce append-only immutability on refund_ledger
        CREATE TRIGGER IF NOT EXISTS prevent_refund_ledger_update
        BEFORE UPDATE ON refund_ledger
        BEGIN
          SELECT RAISE(ABORT, 'refund_ledger is immutable and cannot be updated');
        END;

        CREATE TRIGGER IF NOT EXISTS prevent_refund_ledger_delete
        BEFORE DELETE ON refund_ledger
        BEGIN
          SELECT RAISE(ABORT, 'refund_ledger is immutable and cannot be deleted');
        END;

        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          setting_key TEXT NOT NULL UNIQUE,
          setting_value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_id TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT,
          details_safe TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

        -- Enforce append-only immutability on audit_logs
        CREATE TRIGGER IF NOT EXISTS prevent_audit_logs_update
        BEFORE UPDATE ON audit_logs
        BEGIN
          SELECT RAISE(ABORT, 'audit_logs is immutable and cannot be updated');
        END;

        CREATE TRIGGER IF NOT EXISTS prevent_audit_logs_delete
        BEFORE DELETE ON audit_logs
        BEGIN
          SELECT RAISE(ABORT, 'audit_logs is immutable and cannot be deleted');
        END;

        CREATE TABLE IF NOT EXISTS notification_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          dedupe_key TEXT NOT NULL UNIQUE,
          transaction_id TEXT,
          platform TEXT NOT NULL CHECK(platform IN ('WHATSAPP', 'TELEGRAM')),
          recipient_id TEXT NOT NULL,
          message_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SENT', 'FAILED')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notification_jobs_poll ON notification_jobs(status, next_attempt_at);

        CREATE TABLE IF NOT EXISTS price_sync_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('RUNNING', 'SUCCESS', 'FAILED')),
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          details_safe TEXT
        );

        CREATE TABLE IF NOT EXISTS backup_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name TEXT NOT NULL,
          file_size_bytes INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'FAILED')),
          created_at TEXT NOT NULL,
          completed_at TEXT,
          details_safe TEXT
        );

        CREATE TABLE IF NOT EXISTS service_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          level TEXT NOT NULL,
          service TEXT NOT NULL,
          transaction_id TEXT,
          message TEXT NOT NULL,
          details_safe TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_service_logs_created ON service_logs(created_at);
      `);
    },
  },
  {
    id: '002',
    name: 'seed_default_settings_and_owner',
    up: (db) => {
      const now = new Date().toISOString();

      const insertSetting = db.prepare(`
        INSERT OR IGNORE INTO settings (setting_key, setting_value, updated_at)
        VALUES (?, ?, ?)
      `);

      insertSetting.run('maintenance_mode', String(config.maintenanceModeDefault), now);
      insertSetting.run('global_margin_type', 'FIXED', now);
      insertSetting.run('global_margin_value', '1000', now);

      const adminCount = (db.prepare('SELECT COUNT(*) as cnt FROM admins').get() as { cnt: number }).cnt;
      if (adminCount === 0) {
        const res = db
          .prepare(
            `INSERT INTO admins (name, role, permissions_json, status, created_at, updated_at)
             VALUES (?, 'OWNER', '["*"]', 'ACTIVE', ?, ?)`
          )
          .run('Primary Owner', now, now);

        const adminId = Number(res.lastInsertRowid);
        if (config.auth.dashboardUser) {
          db.prepare(
            `INSERT OR IGNORE INTO admin_identities (admin_id, platform, platform_user_id, created_at)
             VALUES (?, 'DASHBOARD', ?, ?)`
          ).run(adminId, config.auth.dashboardUser, now);
        }
        if (config.auth.ownerWhatsappJid) {
          db.prepare(
            `INSERT OR IGNORE INTO admin_identities (admin_id, platform, platform_user_id, created_at)
             VALUES (?, 'WHATSAPP', ?, ?)`
          ).run(adminId, config.auth.ownerWhatsappJid, now);
        }
        if (config.auth.ownerTelegramId) {
          db.prepare(
            `INSERT OR IGNORE INTO admin_identities (admin_id, platform, platform_user_id, created_at)
             VALUES (?, 'TELEGRAM', ?, ?)`
          ).run(adminId, config.auth.ownerTelegramId, now);
        }
      }

      // Seed baseline PPOB categories (no fake products or fake transactions)
      const defaultCategories = [
        { name: 'Pulsa', slug: 'pulsa' },
        { name: 'Paket Data', slug: 'paket-data' },
        { name: 'Token PLN', slug: 'token-pln' },
        { name: 'E-Wallet', slug: 'e-wallet' },
      ];
      const insertCat = db.prepare(`
        INSERT OR IGNORE INTO categories (name, slug, margin_type, margin_value, status, created_at, updated_at)
        VALUES (?, ?, NULL, NULL, 'ACTIVE', ?, ?)
      `);
      for (const cat of defaultCategories) {
        insertCat.run(cat.name, cat.slug, now, now);
      }
    },
  },
  {
    id: '003',
    name: 'add_max_margin_cap',
    up: (db) => {
      const now = new Date().toISOString();
      const catCols = (db.prepare('PRAGMA table_info(categories)').all() as Array<{ name: string }>).map((c) => c.name);
      if (!catCols.includes('max_margin')) {
        db.exec('ALTER TABLE categories ADD COLUMN max_margin INTEGER');
      }

      const prodCols = (db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>).map((c) => c.name);
      if (!prodCols.includes('max_margin')) {
        db.exec('ALTER TABLE products ADD COLUMN max_margin INTEGER');
      }

      const histCols = (db.prepare('PRAGMA table_info(margin_history)').all() as Array<{ name: string }>).map((c) => c.name);
      if (!histCols.includes('old_max_margin')) {
        db.exec('ALTER TABLE margin_history ADD COLUMN old_max_margin INTEGER');
      }
      if (!histCols.includes('new_max_margin')) {
        db.exec('ALTER TABLE margin_history ADD COLUMN new_max_margin INTEGER');
      }

      db.prepare(
        `INSERT OR IGNORE INTO settings (setting_key, setting_value, updated_at)
         VALUES ('global_margin_max', '', ?)`
      ).run(now);
    },
  },
];

export function runMigrations(customDb?: Database.Database): void {
  const db = customDb || getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[];
  const appliedIds = new Set(appliedRows.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (appliedIds.has(migration.id)) continue;

    withTransaction((txDb) => {
      migration.up(txDb);
      txDb
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.id, migration.name, new Date().toISOString());
    }, db);

    logger.info(`Applied database migration ${migration.id}_${migration.name}`, {
      service: 'migration',
    });
  }
}

export function verifyDatabaseIntegrity(customDb?: Database.Database): boolean {
  const db = customDb || getDb();
  const requiredTables = [
    'customers',
    'customer_identities',
    'admins',
    'admin_identities',
    'transactions',
    'transaction_status_history',
    'payment_events',
    'supplier_jobs',
    'products',
    'categories',
    'coupons',
    'coupon_usages',
    'refund_ledger',
    'refunds',
    'settings',
    'audit_logs',
    'notification_jobs',
    'price_sync_logs',
    'backup_logs',
  ];

  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];
  const existing = new Set(rows.map((r) => r.name));

  for (const table of requiredTables) {
    if (!existing.has(table)) {
      throw new Error(`Database integrity check failed: missing table '${table}'`);
    }
  }
  return true;
}

export function generateLinkToken(): { rawCode: string; codeHash: string } {
  // 8-character uppercase alphanumeric code excluding ambiguous chars
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let rawCode = '';
  for (let i = 0; i < 8; i++) {
    rawCode += alphabet[bytes[i] % alphabet.length];
  }
  const codeHash = crypto.createHash('sha256').update(rawCode).digest('hex');
  return { rawCode, codeHash };
}
