export type AdminRole = 'OWNER' | 'ADMIN' | 'OPERATOR';

export interface AdminSession {
  id: number;
  username: string;
  name: string;
  role: AdminRole;
  permissions: string[];
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface OverviewData {
  metrics: {
    todayCount: number;
    monthCount: number;
    successCount: number;
    failedCount: number;
    pendingCount: number;
    expiredCount: number;
    totalRevenue: number;
    totalRefunds: number;
    refundCount: number;
    pendingSupplierJobs: number;
    lastPriceSync: {
      id: number;
      started_at: string;
      completed_at: string | null;
      status: string;
      success_count: number;
      failure_count: number;
    } | null;
    lastBackup: {
      id: number;
      file_name: string;
      file_size_bytes: number;
      status: string;
      created_at: string;
      completed_at: string | null;
    } | null;
  };
  maintenanceMode: boolean;
  services: {
    backend: { status: string };
    database: { status: string };
    whatsapp: {
      enabled: boolean;
      state: string;
      hasSavedSession: boolean;
      reconnectAttempts: number;
      lastError: string | null;
      connectedAt: string | null;
    };
    telegram: {
      enabled: boolean;
      tokenConfigured: boolean;
      state: string;
      mode?: string;
      webhookUrl?: string | null;
      webhookPath?: string;
      botUsername: string | null;
      lastError: string | null;
      startedAt: string | null;
    };
    scheduler: {
      running: boolean;
      startedAt: string | null;
      lastPaymentPollAt: string | null;
      lastSupplierPollAt: string | null;
      lastReconciliationAt: string | null;
      lastNotificationRunAt: string | null;
      lastMemoryCleanupAt?: string | null;
      lastProductSyncAt?: string | null;
      productAutoRefreshSummary?: string;
    };
    digiflazz: { configured: boolean; syncRunning: boolean };
    notifications: { pending: number | null; sent: number | null; failed: number | null };
  };
  config: SafeConfigSummary;
}

export interface SafeConfigSummary {
  nodeEnv: string;
  port: number;
  timezone: string;
  logLevel: string;
  transaction: {
    invoiceExpiryMinutes: number;
    cooldownSeconds: number;
    uniqueCodeMin: number;
    uniqueCodeMax: number;
  };
  accountLinking: {
    codeExpiryMinutes: number;
    maxAttempts: number;
  };
  scheduler: {
    paymentPollIntervalSeconds: number;
    supplierPollIntervalSeconds: number;
    reconciliationIntervalSeconds: number;
    notificationRetryIntervalSeconds: number;
  };
  backup: {
    enabled: boolean;
    cron: string;
    retentionDays: number;
  };
  digiflazz: {
    baseUrl: string;
    timeoutMs: number;
    priceSyncCron: string;
    priceSyncIntervalMinutes?: number | null;
    webhookPath?: string;
    webhookUrl?: string;
    webhookConfigured?: boolean;
  };
  paymentGateway: {
    baseUrl: string;
    timeoutMs: number;
  };
  readiness: {
    dashboardAuthConfigured: boolean;
    myzzstore: {
      configured: boolean;
      apiSpecConfigured: boolean;
      baseUrl: string;
      missingFields: string[];
    };
    digiflazz: {
      configured: boolean;
      baseUrl: string;
      missingFields: string[];
    };
    whatsapp: { enabled: boolean; sessionDir: string };
    telegram: { enabled: boolean; tokenConfigured: boolean };
  };
}

export interface TransactionItem {
  id: number;
  transaction_id: string;
  customer_id: number;
  customer_code: string;
  platform: string;
  product_sku_snapshot: string;
  product_name_snapshot: string;
  supplier_price_snapshot: number;
  margin_snapshot: number;
  coupon_code_snapshot: string | null;
  discount_snapshot: number;
  unique_code: number;
  payment_amount: number;
  payment_status: string;
  supplier_status: string;
  transaction_status: string;
  gateway_reference: string | null;
  supplier_reference: string | null;
  supplier_sn: string | null;
  supplier_message: string | null;
  destination_masked: string;
  created_at: string;
  updated_at: string;
  expired_at: string | null;
  paid_at: string | null;
  completed_at: string | null;
}

export interface CategoryItem {
  id: number;
  name: string;
  slug: string;
  margin_type: 'FIXED' | 'PERCENT' | null;
  margin_value: number | null;
  max_margin: number | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface ProductItem {
  id: number;
  sku: string;
  name: string;
  description?: string | null;
  category_id: number | null;
  category_name?: string | null;
  brand: string | null;
  supplier_price: number;
  selling_price: number;
  margin_type: 'FIXED' | 'PERCENT' | null;
  margin_value: number | null;
  max_margin: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  is_available: number;
  last_price_sync_at: string | null;
}

export type ProductAutoRefreshMode = 'DISABLED' | 'INTERVAL' | 'DAILY_TIME' | 'CRON';

export interface ProductAutoRefreshConfig {
  mode: ProductAutoRefreshMode;
  intervalMinutes: number;
  dailyTime: string;
  cronExpression: string;
  updatedAt: string | null;
}

export interface ProductAutoRefreshState {
  config: ProductAutoRefreshConfig;
  summary: string;
  timezone: string;
  digiflazzConfigured: boolean;
  syncRunning: boolean;
  lastProductSyncAt: string | null;
}

export interface CouponItem {
  id: number;
  code: string;
  name: string;
  description: string | null;
  discount_type: 'FIXED' | 'PERCENT';
  discount_value: number;
  min_purchase: number;
  max_discount: number | null;
  claim_limit: number | null;
  claimed_count: number;
  per_customer_limit: number;
  scope_type: 'ALL' | 'CATEGORY' | 'PRODUCT';
  starts_at: string;
  expires_at: string;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface RefundItem {
  id: number;
  transaction_id: string;
  customer_id: number;
  customer_code: string;
  product_name_snapshot: string;
  amount: number;
  reason: string;
  status: string;
  approved_by: string;
  processed_at: string;
}

export interface RefundLedgerItem {
  id: number;
  ledger_id: string;
  customer_id: number;
  customer_code: string;
  transaction_id: string | null;
  entry_type: string;
  amount: number;
  description: string;
  actor_id: string;
  actor_source: string;
  created_at: string;
}

export interface CustomerIdentityItem {
  id: number;
  customer_id: number;
  platform: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD';
  platform_user_id: string;
  platform_username: string | null;
  linked_at: string;
  created_at: string;
}

export interface CustomerUserItem {
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
  identities: CustomerIdentityItem[];
}

