import type { Telegraf } from 'telegraf';
import QRCode from 'qrcode';
import { logger } from '../logging/logger';
import { fetchQrisImageBuffer } from '../integrations/qris-image';

export async function sendTelegramText(bot: Telegraf, chatId: string, text: string): Promise<boolean> {
  try {
    await bot.telegram.sendMessage(chatId, text);
    return true;
  } catch (err) {
    logger.warn('Telegram sendMessage failed', {
      service: 'telegram-notify',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
    return false;
  }
}

export async function sendTelegramQrisInvoice(
  bot: Telegraf,
  chatId: string | number,
  caption: string,
  qris?: { qrString?: string; qrUrl?: string },
  replyMarkup?: Parameters<Telegraf['telegram']['sendMessage']>[2]
): Promise<number | null> {
  try {
    if (qris?.qrString) {
      const pngBuffer = await QRCode.toBuffer(qris.qrString, { width: 360, margin: 2 });
      const msg = await bot.telegram.sendPhoto(chatId, { source: pngBuffer, filename: 'qris.png' }, { caption, ...replyMarkup });
      return msg.message_id;
    }
    if (qris?.qrUrl) {
      const imageBuffer = await fetchQrisImageBuffer(qris.qrUrl);
      const msg = await bot.telegram.sendPhoto(chatId, { source: imageBuffer, filename: 'qris.png' }, { caption, ...replyMarkup });
      return msg.message_id;
    }
    const msg = await bot.telegram.sendMessage(chatId, caption, replyMarkup);
    return msg.message_id;
  } catch (err) {
    logger.warn('Telegram sendTelegramQrisInvoice fallback to text', {
      service: 'telegram-notify',
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
    const msg = await bot.telegram.sendMessage(chatId, caption, replyMarkup);
    return msg.message_id;
  }
}

export async function deleteTelegramMessageSafely(
  bot: Telegraf,
  chatId: string | number,
  messageId: number
): Promise<void> {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch {
    // Message may already be deleted or past Telegram delete window
  }
}
