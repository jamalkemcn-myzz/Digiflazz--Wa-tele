export type BotPlatformKey = 'WHATSAPP' | 'TELEGRAM';

export type BotConversationState =
  | { mode: 'IDLE'; updatedAt: number }
  | { mode: 'MAIN_MENU'; updatedAt: number }
  | { mode: 'CATEGORY_LIST'; categoryIds: number[]; updatedAt: number }
  | {
      mode: 'BRAND_LIST';
      categoryId: number;
      categoryName: string;
      brands: string[];
      detectedDestination?: string;
      updatedAt: number;
    }
  | {
      mode: 'PRODUCT_LIST';
      skus: string[];
      page: number;
      categoryId?: number;
      brand?: string;
      detectedDestination?: string;
      updatedAt: number;
    }
  | {
      mode: 'AWAITING_SEARCH_QUERY';
      categoryId?: number;
      updatedAt: number;
    }
  | {
      mode: 'AWAITING_DESTINATION';
      sku: string;
      productName: string;
      sellingPrice: number;
      updatedAt: number;
    }
  | {
      mode: 'AWAITING_ORDER_CONFIRMATION';
      sku: string;
      productName: string;
      sellingPrice: number;
      discountAmount: number;
      estimatedTotal: number;
      destination: string;
      couponCode?: string | null;
      updatedAt: number;
    }
  | {
      mode: 'AWAITING_VOUCHER_CODE';
      updatedAt: number;
    };

const SESSION_TTL_MS = 10 * 60 * 1000;
const TG_MESSAGE_REF_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 1500;
const MAX_TRACKED_TG_CHATS = 1500;
const sessions = new Map<string, BotConversationState>();

function makeKey(platform: BotPlatformKey, userId: string, dryRun?: boolean): string {
  return `${dryRun ? 'DEMO' : 'LIVE'}:${platform}:${userId}`;
}

function trimMapToLimit<T extends { updatedAt: number }>(map: Map<string, T>, maxEntries: number, ttlMs: number, now: number): number {
  let evicted = 0;
  for (const [k, v] of map) {
    if (now - v.updatedAt > ttlMs) {
      map.delete(k);
      evicted++;
    }
  }
  if (map.size >= maxEntries) {
    const excess = map.size - maxEntries + 1;
    let removed = 0;
    for (const k of map.keys()) {
      map.delete(k);
      evicted++;
      removed++;
      if (removed >= excess) break;
    }
  }
  return evicted;
}

export function getBotSession(
  platform: BotPlatformKey,
  userId: string,
  dryRun?: boolean
): BotConversationState | null {
  const key = makeKey(platform, userId, dryRun);
  const entry = sessions.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    sessions.delete(key);
    return null;
  }
  return entry;
}

export function setBotSession(
  platform: BotPlatformKey,
  userId: string,
  state: BotConversationState,
  dryRun?: boolean
): void {
  if (sessions.size >= MAX_SESSIONS) {
    trimMapToLimit(sessions, MAX_SESSIONS, SESSION_TTL_MS, Date.now());
  }
  const key = makeKey(platform, userId, dryRun);
  sessions.delete(key);
  sessions.set(key, state);
}

export function clearBotSession(platform: BotPlatformKey, userId: string, dryRun?: boolean): void {
  sessions.delete(makeKey(platform, userId, dryRun));
}

const pendingVouchers = new Map<string, { code: string; updatedAt: number }>();

export function setPendingVoucher(
  platform: BotPlatformKey,
  userId: string,
  code: string,
  dryRun?: boolean
): void {
  if (pendingVouchers.size >= MAX_SESSIONS) {
    trimMapToLimit(pendingVouchers, MAX_SESSIONS, SESSION_TTL_MS, Date.now());
  }
  const key = makeKey(platform, userId, dryRun);
  pendingVouchers.delete(key);
  pendingVouchers.set(key, {
    code: code.trim().toUpperCase(),
    updatedAt: Date.now(),
  });
}

export function getPendingVoucher(
  platform: BotPlatformKey,
  userId: string,
  dryRun?: boolean
): string | null {
  const key = makeKey(platform, userId, dryRun);
  const entry = pendingVouchers.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    pendingVouchers.delete(key);
    return null;
  }
  return entry.code;
}

export function clearPendingVoucher(platform: BotPlatformKey, userId: string, dryRun?: boolean): void {
  pendingVouchers.delete(makeKey(platform, userId, dryRun));
}

const telegramBotMessageIds = new Map<string, { ids: number[]; updatedAt: number }>();

export function recordTelegramBotMessageId(chatId: string | number, messageId: number): void {
  const key = String(chatId);
  const now = Date.now();
  if (telegramBotMessageIds.size >= MAX_TRACKED_TG_CHATS) {
    trimMapToLimit(telegramBotMessageIds, MAX_TRACKED_TG_CHATS, TG_MESSAGE_REF_TTL_MS, now);
  }
  const existing = telegramBotMessageIds.get(key)?.ids || [];
  if (!existing.includes(messageId)) {
    existing.push(messageId);
  }
  telegramBotMessageIds.delete(key);
  telegramBotMessageIds.set(key, { ids: existing.slice(-5), updatedAt: now });
}

export function consumeTelegramBotMessageIds(chatId: string | number): number[] {
  const key = String(chatId);
  const entry = telegramBotMessageIds.get(key);
  telegramBotMessageIds.delete(key);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > TG_MESSAGE_REF_TTL_MS) {
    return [];
  }
  return entry.ids;
}

export function pruneBotSessionsMemory(now = Date.now()): {
  sessionsEvicted: number;
  vouchersEvicted: number;
  tgMessageRefsEvicted: number;
} {
  let sessionsEvicted = 0;
  for (const [k, v] of sessions) {
    if (now - v.updatedAt > SESSION_TTL_MS) {
      sessions.delete(k);
      sessionsEvicted++;
    }
  }
  let vouchersEvicted = 0;
  for (const [k, v] of pendingVouchers) {
    if (now - v.updatedAt > SESSION_TTL_MS) {
      pendingVouchers.delete(k);
      vouchersEvicted++;
    }
  }
  let tgMessageRefsEvicted = 0;
  for (const [k, v] of telegramBotMessageIds) {
    if (now - v.updatedAt > TG_MESSAGE_REF_TTL_MS) {
      telegramBotMessageIds.delete(k);
      tgMessageRefsEvicted++;
    }
  }
  return { sessionsEvicted, vouchersEvicted, tgMessageRefsEvicted };
}

export function getBotSessionMemoryStats() {
  return {
    sessions: sessions.size,
    pendingVouchers: pendingVouchers.size,
    telegramMessageRefs: telegramBotMessageIds.size,
  };
}

