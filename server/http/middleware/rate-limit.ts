import { isIP } from 'node:net';
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { config } from '../../config/env';

function normalizeIpCandidate(raw?: string): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/^"|"$/g, '');
  if (!value || value.toLowerCase() === 'unknown' || value.startsWith('_')) {
    return null;
  }

  // Handle bracketed IPv6 with optional port: [2001:db8::1]:443
  if (value.startsWith('[')) {
    const closeIdx = value.indexOf(']');
    if (closeIdx > 1) {
      value = value.slice(1, closeIdx);
    }
  } else if (value.includes('.') && value.includes(':')) {
    // Handle IPv4 with port: 203.0.113.10:12345
    const lastColon = value.lastIndexOf(':');
    const hostPart = value.slice(0, lastColon);
    if (isIP(hostPart) === 4) {
      value = hostPart;
    }
  }

  return isIP(value) ? value : null;
}

function parseForwardedHeader(header?: string): string | null {
  if (!header) return null;
  const firstHop = header.split(',')[0] ?? '';
  for (const param of firstHop.split(';')) {
    const eqIdx = param.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = param.slice(0, eqIdx).trim().toLowerCase();
    if (key === 'for') {
      const candidate = normalizeIpCandidate(param.slice(eqIdx + 1));
      if (candidate) return candidate;
    }
  }
  return null;
}

function parseXForwardedFor(header?: string | string[]): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const firstHop = raw.split(',')[0];
  return normalizeIpCandidate(firstHop);
}

export function resolveRateLimitClientKey(req: Request): string {
  const trustProxyEnabled = Boolean(req.app?.get('trust proxy')) || config.security.trustProxy;

  let clientIp: string | null = null;
  if (trustProxyEnabled) {
    clientIp =
      parseForwardedHeader(req.headers.forwarded) ??
      parseXForwardedFor(req.headers['x-forwarded-for']) ??
      normalizeIpCandidate(req.ip);
  } else {
    clientIp = normalizeIpCandidate(req.ip) ?? normalizeIpCandidate(req.socket?.remoteAddress);
  }

  if (clientIp) {
    return ipKeyGenerator(clientIp, 56);
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export const authRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitClientKey,
  message: {
    ok: false,
    error: 'Terlalu banyak percobaan login. Silakan coba lagi dalam beberapa menit.',
  },
});

export const adminRateLimiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitClientKey,
  message: {
    ok: false,
    error: 'Batas permintaan API tercapai. Mohon tunggu sebentar.',
  },
});

export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitClientKey,
  message: {
    ok: false,
    error: 'Too many webhook requests',
  },
});
