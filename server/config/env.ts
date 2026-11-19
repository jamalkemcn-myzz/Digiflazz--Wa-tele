import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

dotenv.config({ quiet: true } as any);

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  shopName: string;
  timezone: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  appUrl: string;
  database: {
    path: string;
  };
  auth: {
    dashboardUser: string;
    dashboardPassword: string;
    sessionSecret: string;
    ownerWhatsappJid: string;
    ownerTelegramId: string;
    ownerTelegramUsername: string;
  };
  paymentGateway: {
    baseUrl: string;
    apiKey: string;
    secret: string;
    merchantId: string;
    callbackSecret: string;
    timeoutMs: number;
    createPath: string;
    statusPath: string;
    cancelPath: string;
  };
  digiflazz: {
    username: string;
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
    priceSyncCron: string;
    priceSyncIntervalMinutes: number | null;
  };
  whatsapp: {
    enabled: boolean;
    sessionDir: string;
    serviceLogGroup: string;
    transactionLogGroup: string;
    successLogGroup: string;
    testimonyGroup: string;
    reconnectMinDelayMs: number;
    reconnectMaxDelayMs: number;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    botUsername: string;
    mode: 'webhook' | 'polling';
    webhookUrl: string;
    webhookSecret: string;
    webhookPath: string;
    serviceLogChatId: string;
    transactionLogChatId: string;
    successLogChatId: string;
    testimonyChatId: string;
  };
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
    dir: string;
    retentionDays: number;
  };
  security: {
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
    trustProxy: boolean;
  };
  maintenanceModeDefault: boolean;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  throw new Error(`Invalid boolean environment value`);
}

function parseIntBounded(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseUrl(name: string, value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim() || fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Environment variable ${name} must use http or https protocol`);
    }
    return raw.replace(/\/+$/, '');
  } catch {
    throw new Error(`Environment variable ${name} is not a valid URL`);
  }
}

function normalizeTimezone(raw?: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return 'Asia/Jakarta';
  const aliasMap: Record<string, string> = {
    jakarta: 'Asia/Jakarta',
    wib: 'Asia/Jakarta',
    makassar: 'Asia/Makassar',
    wita: 'Asia/Makassar',
    jayapura: 'Asia/Jayapura',
    wit: 'Asia/Jayapura',
  };
  const candidate = aliasMap[trimmed.toLowerCase()] || trimmed;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'Asia/Jakarta';
  }
}

export function validateAndLoadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];

  const rawNodeEnv = (env.NODE_ENV || 'development').trim();
  const nodeEnv: AppConfig['nodeEnv'] =
    rawNodeEnv === 'production' || rawNodeEnv === 'test' ? rawNodeEnv : 'development';

  const rawLogLevel = (env.LOG_LEVEL || 'info').trim().toLowerCase();
  const logLevel: AppConfig['logLevel'] =
    rawLogLevel === 'debug' || rawLogLevel === 'warn' || rawLogLevel === 'error'
      ? rawLogLevel
      : 'info';

  let port = 3000;
  let appUrl = 'http://localhost:3000';
  let gatewayBaseUrl = 'https://gateway.myzzstore.my.id';
  let digiflazzBaseUrl = 'https://api.digiflazz.com/v1';
  let gatewayTimeoutMs = 30000;
  let digiflazzTimeoutMs = 30000;
  let priceSyncIntervalMinutes: number | null = null;
  let waMinDelay = 3000;
  let waMaxDelay = 60000;
  let invoiceExpiryMinutes = 5;
  let cooldownSeconds = 30;
  let uniqueCodeMin = 1;
  let uniqueCodeMax = 99;
  let linkExpiryMinutes = 5;
  let linkMaxAttempts = 5;
  let paymentPollSeconds = 15;
  let supplierPollSeconds = 30;
  let reconciliationSeconds = 60;
  let notificationRetrySeconds = 30;
  let backupRetentionDays = 14;
  let rateLimitWindowMs = 60000;
  let rateLimitMaxRequests = 60;
  let waEnabled = false;
  let tgEnabled = false;
  let backupEnabled = true;
  let trustProxy = false;
  let maintenanceModeDefault = false;

  try {
    port = parseIntBounded('PORT', env.PORT, 3000, 1, 65535);
    // In AI Studio's Cloud Run dev container, nginx occupies PORT=8080 and proxies to the dev server on port 3000.
    if (nodeEnv === 'development' && env.K_SERVICE && env.APP_DIR === '/app/applet' && port === 8080) {
      port = 3000;
    }
    appUrl = parseUrl('APP_URL', env.APP_URL, `http://localhost:${port}`);
    gatewayBaseUrl = parseUrl(
      'PAYMENT_GATEWAY_BASE_URL',
      env.PAYMENT_GATEWAY_BASE_URL,
      'https://gateway.myzzstore.my.id'
    );
    digiflazzBaseUrl = parseUrl(
      'DIGIFLAZZ_BASE_URL',
      env.DIGIFLAZZ_BASE_URL,
      'https://api.digiflazz.com/v1'
    );
    gatewayTimeoutMs = parseIntBounded('PAYMENT_GATEWAY_TIMEOUT', env.PAYMENT_GATEWAY_TIMEOUT, 30000, 1000, 120000);
    digiflazzTimeoutMs = parseIntBounded('DIGIFLAZZ_TIMEOUT', env.DIGIFLAZZ_TIMEOUT, 30000, 1000, 120000);
    if ((env.DIGIFLAZZ_PRICE_SYNC_INTERVAL_MINUTES || '').trim() !== '') {
      const parsedInterval = parseIntBounded(
        'DIGIFLAZZ_PRICE_SYNC_INTERVAL_MINUTES',
        env.DIGIFLAZZ_PRICE_SYNC_INTERVAL_MINUTES,
        0,
        0,
        1440
      );
      if (parsedInterval > 0 && parsedInterval < 5) {
        errors.push('DIGIFLAZZ_PRICE_SYNC_INTERVAL_MINUTES must be 0 or between 5 and 1440');
      }
      priceSyncIntervalMinutes = parsedInterval > 0 ? parsedInterval : null;
    }
    waMinDelay = parseIntBounded('WHATSAPP_RECONNECT_MIN_DELAY', env.WHATSAPP_RECONNECT_MIN_DELAY, 3000, 1000, 60000);
    waMaxDelay = parseIntBounded('WHATSAPP_RECONNECT_MAX_DELAY', env.WHATSAPP_RECONNECT_MAX_DELAY, 60000, 5000, 600000);
    if (waMaxDelay < waMinDelay) {
      errors.push('WHATSAPP_RECONNECT_MAX_DELAY must be >= WHATSAPP_RECONNECT_MIN_DELAY');
    }
    invoiceExpiryMinutes = parseIntBounded('INVOICE_EXPIRY_MINUTES', env.INVOICE_EXPIRY_MINUTES, 5, 1, 60);
    cooldownSeconds = parseIntBounded('TRANSACTION_COOLDOWN_SECONDS', env.TRANSACTION_COOLDOWN_SECONDS, 30, 0, 3600);
    uniqueCodeMin = parseIntBounded('UNIQUE_CODE_MIN', env.UNIQUE_CODE_MIN, 1, 1, 99);
    uniqueCodeMax = parseIntBounded('UNIQUE_CODE_MAX', env.UNIQUE_CODE_MAX, 99, 1, 99);
    if (uniqueCodeMax < uniqueCodeMin) {
      errors.push('UNIQUE_CODE_MAX must be >= UNIQUE_CODE_MIN');
    }
    linkExpiryMinutes = parseIntBounded('ACCOUNT_LINK_CODE_EXPIRY_MINUTES', env.ACCOUNT_LINK_CODE_EXPIRY_MINUTES, 5, 1, 60);
    linkMaxAttempts = parseIntBounded('ACCOUNT_LINK_MAX_ATTEMPTS', env.ACCOUNT_LINK_MAX_ATTEMPTS, 5, 1, 20);
    paymentPollSeconds = parseIntBounded('PAYMENT_POLL_INTERVAL_SECONDS', env.PAYMENT_POLL_INTERVAL_SECONDS, 15, 5, 3600);
    supplierPollSeconds = parseIntBounded('SUPPLIER_POLL_INTERVAL_SECONDS', env.SUPPLIER_POLL_INTERVAL_SECONDS, 30, 5, 3600);
    reconciliationSeconds = parseIntBounded('RECONCILIATION_INTERVAL_SECONDS', env.RECONCILIATION_INTERVAL_SECONDS, 60, 10, 3600);
    notificationRetrySeconds = parseIntBounded('NOTIFICATION_RETRY_INTERVAL_SECONDS', env.NOTIFICATION_RETRY_INTERVAL_SECONDS, 30, 5, 3600);
    backupRetentionDays = parseIntBounded('BACKUP_RETENTION_DAYS', env.BACKUP_RETENTION_DAYS, 14, 1, 365);
    rateLimitWindowMs = parseIntBounded('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000);
    rateLimitMaxRequests = parseIntBounded('RATE_LIMIT_MAX_REQUESTS', env.RATE_LIMIT_MAX_REQUESTS, 60, 5, 5000);
    waEnabled = parseBool(env.WHATSAPP_ENABLED, false);
    tgEnabled = parseBool(env.TELEGRAM_ENABLED, false);
    backupEnabled = parseBool(env.BACKUP_ENABLED, true);
    const defaultTrustProxy = Boolean(
      env.K_SERVICE ||
        (env.APP_URL &&
          !env.APP_URL.includes('localhost') &&
          !env.APP_URL.includes('127.0.0.1'))
    );
    trustProxy = parseBool(env.TRUST_PROXY, defaultTrustProxy);
    maintenanceModeDefault = parseBool(env.MAINTENANCE_MODE, false);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Configuration parse error');
  }

  const dashboardUser = (env.DASHBOARD_AUTH_USER || '').trim();
  const dashboardPassword = (env.DASHBOARD_AUTH_PASSWORD || '').trim();
  const rawSessionSecret = (env.SESSION_SECRET || '').trim();

  if (nodeEnv === 'production') {
    if (!dashboardUser || !dashboardPassword) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: 'config',
          message:
            'DASHBOARD_AUTH_USER or DASHBOARD_AUTH_PASSWORD is not set; admin dashboard endpoints will stay locked (HTTP 503) until configured.',
        })
      );
    }
    if (!rawSessionSecret || rawSessionSecret.length < 16) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: 'config',
          message:
            'SESSION_SECRET is missing or shorter than 16 chars; using a cryptographically strong server-derived fallback secret.',
        })
      );
    }
  }

  if (tgEnabled && !(env.TELEGRAM_BOT_TOKEN || '').trim()) {
    errors.push('TELEGRAM_ENABLED is true but TELEGRAM_BOT_TOKEN is empty');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n- ${errors.join('\n- ')}`);
  }

  // Use explicit SESSION_SECRET if strong (>= 16 chars); otherwise derive deterministically from
  // server auth credentials when available (so Cloud Run restarts/replicas keep valid sessions),
  // or fall back to an ephemeral CSPRNG secret (never hardcoded).
  const sessionSecret =
    rawSessionSecret.length >= 16
      ? rawSessionSecret
      : dashboardPassword
        ? crypto
            .createHmac('sha256', dashboardPassword)
            .update(`pulsasync-session:${dashboardUser}:${env.K_SERVICE || ''}:${rawSessionSecret}`)
            .digest('hex')
        : crypto.randomBytes(32).toString('hex');

  const dbPath = (env.DATABASE_PATH || 'data/database.sqlite').trim();
  const resolvedDbPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);

  const waSessionDir = (env.WHATSAPP_SESSION_DIR || 'data/whatsapp-session').trim();
  const resolvedWaSessionDir = path.isAbsolute(waSessionDir)
    ? waSessionDir
    : path.resolve(process.cwd(), waSessionDir);

  const backupDir = (env.BACKUP_DIR || 'backups').trim();
  const resolvedBackupDir = path.isAbsolute(backupDir)
    ? backupDir
    : path.resolve(process.cwd(), backupDir);

  return {
    nodeEnv,
    port,
    shopName: (env.SHOP_NAME || 'PulsaSync Store').trim() || 'PulsaSync Store',
    timezone: normalizeTimezone(env.APP_TIMEZONE),
    logLevel,
    appUrl,
    database: {
      path: resolvedDbPath,
    },
    auth: {
      dashboardUser,
      dashboardPassword,
      sessionSecret,
      ownerWhatsappJid: (env.OWNER_WHATSAPP_JID || '').trim(),
      ownerTelegramId: (env.OWNER_TELEGRAM_ID || '').trim(),
      ownerTelegramUsername: (env.OWNER_TELEGRAM_USERNAME || '').trim().replace(/^@+/, ''),
    },
    paymentGateway: {
      baseUrl: gatewayBaseUrl,
      apiKey: (env.PAYMENT_GATEWAY_API_KEY || '').trim(),
      secret: (env.PAYMENT_GATEWAY_SECRET || '').trim(),
      merchantId: (env.PAYMENT_GATEWAY_MERCHANT_ID || '').trim(),
      callbackSecret: (env.PAYMENT_GATEWAY_CALLBACK_SECRET || '').trim(),
      timeoutMs: gatewayTimeoutMs,
      createPath: (env.PAYMENT_GATEWAY_CREATE_PATH || '/create-qris').trim(),
      statusPath: (env.PAYMENT_GATEWAY_STATUS_PATH || '/check-payment').trim(),
      cancelPath: (env.PAYMENT_GATEWAY_CANCEL_PATH || '').trim(),
    },
    digiflazz: {
      username: (env.DIGIFLAZZ_USERNAME || '').trim(),
      apiKey: (env.DIGIFLAZZ_API_KEY || '').trim(),
      baseUrl: digiflazzBaseUrl,
      timeoutMs: digiflazzTimeoutMs,
      priceSyncCron: (env.DIGIFLAZZ_PRICE_SYNC_CRON || '0 */6 * * *').trim(),
      priceSyncIntervalMinutes,
    },
    whatsapp: {
      enabled: waEnabled,
      sessionDir: resolvedWaSessionDir,
      serviceLogGroup: (env.WHATSAPP_SERVICE_LOG_GROUP || '').trim(),
      transactionLogGroup: (env.WHATSAPP_TRANSACTION_LOG_GROUP || '').trim(),
      successLogGroup: (env.WHATSAPP_SUCCESS_LOG_GROUP || '').trim(),
      testimonyGroup: (env.WHATSAPP_TESTIMONY_GROUP || '').trim(),
      reconnectMinDelayMs: waMinDelay,
      reconnectMaxDelayMs: waMaxDelay,
    },
    telegram: {
      enabled: tgEnabled,
      botToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
      botUsername: (env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@+/, ''),
      mode: (env.TELEGRAM_MODE || 'webhook').trim().toLowerCase() === 'polling' ? 'polling' : 'webhook',
      webhookUrl: (env.TELEGRAM_WEBHOOK_URL || '').trim().replace(/\/+$/, ''),
      webhookSecret: (env.TELEGRAM_WEBHOOK_SECRET || '').trim(),
      webhookPath: '/api/telegram/webhook',
      serviceLogChatId: (env.TELEGRAM_SERVICE_LOG_CHAT_ID || '').trim(),
      transactionLogChatId: (env.TELEGRAM_TRANSACTION_LOG_CHAT_ID || '').trim(),
      successLogChatId: (env.TELEGRAM_SUCCESS_LOG_CHAT_ID || '').trim(),
      testimonyChatId: (env.TELEGRAM_TESTIMONY_CHAT_ID || '').trim(),
    },
    transaction: {
      invoiceExpiryMinutes,
      cooldownSeconds,
      uniqueCodeMin,
      uniqueCodeMax,
    },
    accountLinking: {
      codeExpiryMinutes: linkExpiryMinutes,
      maxAttempts: linkMaxAttempts,
    },
    scheduler: {
      paymentPollIntervalSeconds: paymentPollSeconds,
      supplierPollIntervalSeconds: supplierPollSeconds,
      reconciliationIntervalSeconds: reconciliationSeconds,
      notificationRetryIntervalSeconds: notificationRetrySeconds,
    },
    backup: {
      enabled: backupEnabled,
      cron: (env.BACKUP_CRON || '0 0 * * *').trim(),
      dir: resolvedBackupDir,
      retentionDays: backupRetentionDays,
    },
    security: {
      rateLimitWindowMs,
      rateLimitMaxRequests,
      trustProxy,
    },
    maintenanceModeDefault,
  };
}

export const config: AppConfig = validateAndLoadConfig();

export function refreshConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const next = validateAndLoadConfig(env);
  Object.assign(config, next);
  return config;
}

export interface IntegrationReadiness {
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
  whatsapp: {
    enabled: boolean;
    sessionDir: string;
  };
  telegram: {
    enabled: boolean;
    tokenConfigured: boolean;
  };
}

export function getIntegrationReadiness(cfg: AppConfig = config): IntegrationReadiness {
  const myzzMissing: string[] = [];
  if (!cfg.paymentGateway.apiKey) myzzMissing.push('PAYMENT_GATEWAY_API_KEY');
  if (!cfg.paymentGateway.createPath) myzzMissing.push('PAYMENT_GATEWAY_CREATE_PATH');
  if (!cfg.paymentGateway.statusPath) myzzMissing.push('PAYMENT_GATEWAY_STATUS_PATH');

  const digiMissing: string[] = [];
  if (!cfg.digiflazz.username) digiMissing.push('DIGIFLAZZ_USERNAME');
  if (!cfg.digiflazz.apiKey) digiMissing.push('DIGIFLAZZ_API_KEY');

  return {
    dashboardAuthConfigured: Boolean(cfg.auth.dashboardUser && cfg.auth.dashboardPassword),
    myzzstore: {
      configured: Boolean(cfg.paymentGateway.apiKey),
      apiSpecConfigured: Boolean(cfg.paymentGateway.createPath && cfg.paymentGateway.statusPath),
      baseUrl: cfg.paymentGateway.baseUrl,
      missingFields: myzzMissing,
    },
    digiflazz: {
      configured: Boolean(cfg.digiflazz.username && cfg.digiflazz.apiKey),
      baseUrl: cfg.digiflazz.baseUrl,
      missingFields: digiMissing,
    },
    whatsapp: {
      enabled: cfg.whatsapp.enabled,
      sessionDir: path.basename(cfg.whatsapp.sessionDir),
    },
    telegram: {
      enabled: cfg.telegram.enabled,
      tokenConfigured: Boolean(cfg.telegram.botToken),
    },
  };
}

export function getSafeConfigSummary(cfg: AppConfig = config) {
  return {
    nodeEnv: cfg.nodeEnv,
    port: cfg.port,
    shopName: cfg.shopName,
    timezone: cfg.timezone,
    logLevel: cfg.logLevel,
    transaction: cfg.transaction,
    accountLinking: cfg.accountLinking,
    scheduler: cfg.scheduler,
    backup: {
      enabled: cfg.backup.enabled,
      cron: cfg.backup.cron,
      retentionDays: cfg.backup.retentionDays,
    },
    security: {
      rateLimitWindowMs: cfg.security.rateLimitWindowMs,
      rateLimitMaxRequests: cfg.security.rateLimitMaxRequests,
      trustProxy: cfg.security.trustProxy,
    },
    digiflazz: {
      baseUrl: cfg.digiflazz.baseUrl,
      timeoutMs: cfg.digiflazz.timeoutMs,
      priceSyncCron: cfg.digiflazz.priceSyncCron,
      priceSyncIntervalMinutes: cfg.digiflazz.priceSyncIntervalMinutes,
    },
    paymentGateway: {
      baseUrl: cfg.paymentGateway.baseUrl,
      timeoutMs: cfg.paymentGateway.timeoutMs,
    },
    logChannels: {
      whatsapp: {
        serviceLog: Boolean(cfg.whatsapp.serviceLogGroup),
        transactionLog: Boolean(cfg.whatsapp.transactionLogGroup),
        successLog: Boolean(cfg.whatsapp.successLogGroup),
        testimony: Boolean(cfg.whatsapp.testimonyGroup),
      },
      telegram: {
        serviceLog: Boolean(cfg.telegram.serviceLogChatId),
        transactionLog: Boolean(cfg.telegram.transactionLogChatId),
        successLog: Boolean(cfg.telegram.successLogChatId),
        testimony: Boolean(cfg.telegram.testimonyChatId),
      },
    },
    readiness: getIntegrationReadiness(cfg),
  };
}

export interface DigiflazzEnvDiagnostic {
  configured: boolean;
  baseUrl: string;
  usernameMasked: string;
  usernameLength: number;
  apiKeyMode: 'DEVELOPMENT' | 'PRODUCTION' | 'EMPTY';
  apiKeyLength: number;
  envFileExists: boolean;
  overriddenByContainerEnv: boolean;
  warnings: string[];
}

export function maskDigiflazzUsername(username: string): string {
  const clean = username.trim();
  if (!clean) return '(kosong)';
  if (clean.length <= 2) return `${clean[0]}***`;
  if (clean.length <= 5) return `${clean[0]}***${clean[clean.length - 1]}`;
  return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
}

function inspectRawEnvLine(rawContent: string, key: string): {
  present: boolean;
  hasUnquotedHash: boolean;
  hasWhitespacePadding: boolean;
} {
  const lines = rawContent.split(/\r?\n/);
  let present = false;
  let hasUnquotedHash = false;
  let hasWhitespacePadding = false;

  const lineRegex = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`);
  for (const line of lines) {
    const match = line.match(lineRegex);
    if (!match) continue;
    present = true;
    const rhs = match[1] ?? '';
    const trimmed = rhs.trim();
    if (!trimmed) continue;
    const isQuoted =
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('`') && trimmed.endsWith('`'));
    if (!isQuoted && trimmed.includes('#')) {
      hasUnquotedHash = true;
    }
    if (rhs !== rhs.trim() && !isQuoted) {
      hasWhitespacePadding = true;
    }
  }

  return { present, hasUnquotedHash, hasWhitespacePadding };
}

export function getDigiflazzEnvDiagnostic(options?: {
  cfg?: AppConfig;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): DigiflazzEnvDiagnostic {
  const cfg = options?.cfg ?? config;
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();

  const username = cfg.digiflazz.username;
  const apiKey = cfg.digiflazz.apiKey;
  const warnings: string[] = [];

  const envPath = path.resolve(cwd, '.env');
  const envFileExists = fs.existsSync(envPath);
  let overriddenByContainerEnv = false;

  if (envFileExists) {
    try {
      const rawContent = fs.readFileSync(envPath, 'utf8');
      const parsedDotenv = dotenv.parse(rawContent);

      const userLine = inspectRawEnvLine(rawContent, 'DIGIFLAZZ_USERNAME');
      const keyLine = inspectRawEnvLine(rawContent, 'DIGIFLAZZ_API_KEY');

      if (keyLine.hasUnquotedHash) {
        warnings.push(
          'Baris DIGIFLAZZ_API_KEY di .env mengandung tanda "#" tanpa tanda kutip — parser dotenv memotong nilai setelah "#". Bungkus dengan tanda kutip ganda ("...").'
        );
      }
      if (userLine.hasUnquotedHash) {
        warnings.push(
          'Baris DIGIFLAZZ_USERNAME di .env mengandung tanda "#" tanpa tanda kutip. Bungkus dengan tanda kutip ganda ("...").'
        );
      }
      if (userLine.hasWhitespacePadding || keyLine.hasWhitespacePadding) {
        warnings.push('Terdapat spasi berlebih pada baris DIGIFLAZZ_USERNAME atau DIGIFLAZZ_API_KEY di .env.');
      }

      if (
        (parsedDotenv.DIGIFLAZZ_USERNAME !== undefined &&
          (env.DIGIFLAZZ_USERNAME ?? '') !== parsedDotenv.DIGIFLAZZ_USERNAME) ||
        (parsedDotenv.DIGIFLAZZ_API_KEY !== undefined &&
          (env.DIGIFLAZZ_API_KEY ?? '') !== parsedDotenv.DIGIFLAZZ_API_KEY)
      ) {
        overriddenByContainerEnv = true;
        warnings.push(
          'Nilai DIGIFLAZZ di .env berbeda dengan environment aktif proses — kemungkinan tertimpa oleh CUSTOM_ENVIRONMENT_VARIABLES / Startup panel Pterodactyl atau server belum di-Restart.'
        );
      }
    } catch {
      warnings.push('File .env ditemukan tetapi gagal dibaca saat pemeriksaan diagnostik.');
    }
  } else {
    warnings.push('File .env tidak ditemukan di direktori kerja server (kredensial hanya berasal dari environment container jika diisi).');
  }

  if (!username) {
    warnings.push('DIGIFLAZZ_USERNAME kosong.');
  } else {
    if (username.includes('@')) {
      warnings.push('DIGIFLAZZ_USERNAME berisi "@". Digiflazz mewajibkan Username API dari menu Atur Koneksi → API, bukan email login.');
    }
    if (/\s/.test(username)) {
      warnings.push('DIGIFLAZZ_USERNAME mengandung spasi — pastikan tidak ada spasi saat copy-paste.');
    }
  }

  const apiKeyMode: DigiflazzEnvDiagnostic['apiKeyMode'] = !apiKey
    ? 'EMPTY'
    : apiKey.toLowerCase().startsWith('dev-')
      ? 'DEVELOPMENT'
      : 'PRODUCTION';

  if (!apiKey) {
    warnings.push('DIGIFLAZZ_API_KEY kosong.');
  } else {
    if (/\s/.test(apiKey)) {
      warnings.push('DIGIFLAZZ_API_KEY mengandung spasi — pastikan tidak ada spasi di dalam API key.');
    }
    if (/[\u200B-\u200D\uFEFF\u00A0]/.test(apiKey) || /[\u200B-\u200D\uFEFF\u00A0]/.test(username)) {
      warnings.push('Terdeteksi karakter Unicode tak terlihat (zero-width/non-breaking space) pada kredensial Digiflazz.');
    }
    if (apiKeyMode === 'DEVELOPMENT') {
      warnings.push(
        'API Key terdeteksi mode DEVELOPMENT (awalan dev-). Jika IP server terdaftar di IP Production pada Digiflazz, gunakan Production Key (atau pindahkan IP server ke IP Development).'
      );
    }
  }

  return {
    configured: Boolean(username && apiKey),
    baseUrl: cfg.digiflazz.baseUrl,
    usernameMasked: maskDigiflazzUsername(username),
    usernameLength: username.length,
    apiKeyMode,
    apiKeyLength: apiKey.length,
    envFileExists,
    overriddenByContainerEnv,
    warnings,
  };
}

