export type BotPlatformKey = 'WHATSAPP' | 'TELEGRAM';

export type BotConversationState =
  | { mode: 'IDLE'; updatedAt: number }
  | { mode: 'MAIN_MENU'; updatedAt: number }
  | { mode: 'CATEGORY_LIST'; categoryIds: number[]; updatedAt: number }
  | { mode: 'PRODUCT_LIST'; skus: string[]; page: number; categoryId?: number; updatedAt: number }
  | {
      mode: 'AWAITING_DESTINATION';
      sku: string;
      productName: string;
      sellingPrice: number;
      updatedAt: number;
    };

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 5000;
const sessions = new Map<string, BotConversationState>();

function makeKey(platform: BotPlatformKey, userId: string, dryRun?: boolean): string {
  return `${dryRun ? 'DEMO' : 'LIVE'}:${platform}:${userId}`;
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
  if (sessions.size > MAX_SESSIONS) {
    sessions.clear();
  }
  sessions.set(makeKey(platform, userId, dryRun), state);
}

export function clearBotSession(platform: BotPlatformKey, userId: string, dryRun?: boolean): void {
  sessions.delete(makeKey(platform, userId, dryRun));
}

const MAX_TRACKED_TG_CHATS = 5000;
const telegramBotMessageIds = new Map<string, number[]>();

export function recordTelegramBotMessageId(chatId: string | number, messageId: number): void {
  const key = String(chatId);
  if (telegramBotMessageIds.size > MAX_TRACKED_TG_CHATS) {
    telegramBotMessageIds.clear();
  }
  const existing = telegramBotMessageIds.get(key) || [];
  if (!existing.includes(messageId)) {
    existing.push(messageId);
  }
  telegramBotMessageIds.set(key, existing.slice(-5));
}

export function consumeTelegramBotMessageIds(chatId: string | number): number[] {
  const key = String(chatId);
  const ids = telegramBotMessageIds.get(key) || [];
  telegramBotMessageIds.delete(key);
  return ids;
}

