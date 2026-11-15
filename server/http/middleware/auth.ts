import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config/env';
import { getDb } from '../../database/connection';
import { getEffectivePermissions, hasPermission, type AdminRole, type Permission } from '../../domain/rbac';
import { recordAuditLog } from '../../services/audit.service';

export interface AuthenticatedAdmin {
  id: number;
  username: string;
  name: string;
  role: AdminRole;
  permissions: Permission[];
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
      rawBody?: string;
    }
  }
}

const SESSION_COOKIE_NAME = 'ppob_admin_session';

function safeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAuthConfigured(): boolean {
  return Boolean(config.auth.dashboardUser && config.auth.dashboardPassword);
}

function parseBasicAuthHeader(header?: string): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    return {
      username: decoded.slice(0, sep),
      password: decoded.slice(sep + 1),
    };
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      result[k] = decodeURIComponent(v);
    }
  }
  return result;
}

export function signSessionToken(username: string): string {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp }), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.auth.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): { username: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', config.auth.sessionSecret)
    .update(payload)
    .digest('base64url');

  if (!safeEqualString(sig, expectedSig)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: string;
      exp?: number;
    };
    if (!parsed.u || !parsed.exp || Date.now() > parsed.exp) return null;
    return { username: parsed.u };
  } catch {
    return null;
  }
}

function resolveDashboardAdmin(username: string): AuthenticatedAdmin | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT a.id, a.name, a.role, a.permissions_json, a.status
       FROM admin_identities ai
       JOIN admins a ON a.id = ai.admin_id
       WHERE ai.platform = 'DASHBOARD' AND ai.platform_user_id = ?`
    )
    .get(username) as
    | { id: number; name: string; role: AdminRole; permissions_json: string; status: string }
    | undefined;

  if (row) {
    if (row.status !== 'ACTIVE') return null;
    let custom: string[] = [];
    try {
      custom = JSON.parse(row.permissions_json) as string[];
    } catch {
      custom = [];
    }
    return {
      id: row.id,
      username,
      name: row.name,
      role: row.role,
      permissions: getEffectivePermissions(row.role, custom),
    };
  }

  // If primary env user isn't in admin_identities yet, bind to Primary Owner row if it matches env user
  if (safeEqualString(username, config.auth.dashboardUser)) {
    const owner = db
      .prepare("SELECT id, name, role, permissions_json, status FROM admins WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1")
      .get() as
      | { id: number; name: string; role: AdminRole; permissions_json: string; status: string }
      | undefined;

    if (owner && owner.status === 'ACTIVE') {
      db.prepare(
        `INSERT OR IGNORE INTO admin_identities (admin_id, platform, platform_user_id, created_at)
         VALUES (?, 'DASHBOARD', ?, ?)`
      ).run(owner.id, username, new Date().toISOString());

      return {
        id: owner.id,
        username,
        name: owner.name,
        role: owner.role,
        permissions: getEffectivePermissions(owner.role, ['*']),
      };
    }
  }

  return null;
}

export function verifyBasicCredentials(username: string, password: string): AuthenticatedAdmin | null {
  if (!isAuthConfigured()) return null;
  const userMatch = safeEqualString(username, config.auth.dashboardUser);
  const passMatch = safeEqualString(password, config.auth.dashboardPassword);
  if (!userMatch || !passMatch) return null;
  return resolveDashboardAdmin(username);
}

function parseBearerToken(header?: string): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function tryAuthenticateDashboardRequest(req: Request): AuthenticatedAdmin | null {
  if (!isAuthConfigured()) return null;

  const basic = parseBasicAuthHeader(req.headers.authorization);
  if (basic) {
    return verifyBasicCredentials(basic.username, basic.password);
  }

  const bearer = parseBearerToken(req.headers.authorization);
  const cookies = parseCookies(req.headers.cookie);
  const token = bearer || cookies[SESSION_COOKIE_NAME];
  if (token) {
    const verified = verifySessionToken(token);
    if (verified && safeEqualString(verified.username, config.auth.dashboardUser)) {
      return resolveDashboardAdmin(verified.username);
    }
  }

  return null;
}

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthConfigured()) {
    res.status(503).json({
      ok: false,
      error: 'Dashboard authentication credentials (DASHBOARD_AUTH_USER / DASHBOARD_AUTH_PASSWORD) are not configured on the server.',
    });
    return;
  }

  // 1. Check HTTP Basic Auth header first
  const basic = parseBasicAuthHeader(req.headers.authorization);
  if (basic) {
    const admin = verifyBasicCredentials(basic.username, basic.password);
    if (!admin) {
      recordAuditLog({
        actorId: basic.username || 'unknown',
        actorRole: 'ANONYMOUS',
        action: 'DASHBOARD_LOGIN_FAILED',
        targetType: 'AUTH',
        details: { method: 'BASIC_HEADER', ip: req.ip },
      });
      res.setHeader('WWW-Authenticate', 'Basic realm="PPOB Admin Console"');
      res.status(401).json({ ok: false, error: 'Kredensial Basic Auth tidak valid' });
      return;
    }
    req.admin = admin;
    next();
    return;
  }

  // 2. Check signed session token via Bearer header (in-memory) or HttpOnly cookie
  const bearer = parseBearerToken(req.headers.authorization);
  const cookies = parseCookies(req.headers.cookie);
  const token = bearer || cookies[SESSION_COOKIE_NAME];
  if (token) {
    const verified = verifySessionToken(token);
    if (verified && safeEqualString(verified.username, config.auth.dashboardUser)) {
      const admin = resolveDashboardAdmin(verified.username);
      if (admin) {
        req.admin = admin;
        next();
        return;
      }
    }
  }

  res.status(401).json({ ok: false, error: 'Autentikasi diperlukan' });
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.admin) {
      res.status(401).json({ ok: false, error: 'Autentikasi diperlukan' });
      return;
    }
    if (!hasPermission(req.admin.role, req.admin.permissions, permission)) {
      recordAuditLog({
        actorId: req.admin.username,
        actorRole: req.admin.role,
        action: 'PERMISSION_DENIED',
        targetType: 'API',
        targetId: req.originalUrl,
        details: { requiredPermission: permission },
      });
      res.status(403).json({ ok: false, error: `Akses ditolak: membutuhkan izin ${permission}` });
      return;
    }
    next();
  };
}

export { SESSION_COOKIE_NAME, parseBasicAuthHeader };
