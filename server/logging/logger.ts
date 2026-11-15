import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  'password',
  'api_key',
  'apikey',
  'secret',
  'token',
  'bot_token',
  'bottoken',
  'pairing_code',
  'pairingcode',
  'authorization',
  'cookie',
  'session',
  'callback_secret',
  'callbacksecret',
  'private_key',
  'sign',
]);

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: String(sanitizeForLog(value.message, depth + 1)),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalized = k.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (SENSITIVE_KEYS.has(normalized) || normalized.includes('secret') || normalized.includes('password') || normalized.includes('token')) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeForLog(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB simple rotation

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size >= MAX_LOG_BYTES) {
        const rotated = path.join(LOG_DIR, `app-${Date.now()}.log`);
        fs.renameSync(LOG_FILE, rotated);
      }
    }
  } catch {
    // Best-effort log rotation
  }
}

export interface LogContext {
  service: string;
  transactionId?: string;
  details?: Record<string, unknown>;
}

type DbLogSink = (entry: {
  level: LogLevel;
  service: string;
  transactionId?: string;
  message: string;
  detailsSafe?: string;
  createdAt: string;
}) => void;

let dbSink: DbLogSink | null = null;

export function registerDbLogSink(sink: DbLogSink | null) {
  dbSink = sink;
}

function writeLog(level: LogLevel, message: string, context: LogContext) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[config.logLevel]) return;

  const timestamp = new Date().toISOString();
  const safeDetails = context.details
    ? (sanitizeForLog(context.details) as Record<string, unknown>)
    : undefined;
  const safeMessage = String(sanitizeForLog(message));

  const payload = {
    timestamp,
    level,
    service: context.service,
    ...(context.transactionId ? { transactionId: context.transactionId } : {}),
    message: safeMessage,
    ...(safeDetails ? { details: safeDetails } : {}),
  };

  const line = JSON.stringify(payload);
  if (config.nodeEnv !== 'test') {
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Avoid crashing if file system log append fails
  }

  if (dbSink) {
    try {
      dbSink({
        level,
        service: context.service,
        transactionId: context.transactionId,
        message: safeMessage,
        detailsSafe: safeDetails ? JSON.stringify(safeDetails) : undefined,
        createdAt: timestamp,
      });
    } catch {
      // Never recurse or crash from DB sink failure
    }
  }
}

export const logger = {
  debug: (message: string, context: LogContext) => writeLog('debug', message, context),
  info: (message: string, context: LogContext) => writeLog('info', message, context),
  warn: (message: string, context: LogContext) => writeLog('warn', message, context),
  error: (message: string, context: LogContext) => writeLog('error', message, context),
};
