import https from 'node:https';
import { Telegraf } from 'telegraf';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import { registerTelegramCommands } from './telegram.command-handler';
import { registerTelegramCallbacks } from './telegram.callback-handler';
import { deleteTelegramMessageSafely, sendTelegramText } from './telegram.notification.service';
import { registerNotificationSender, emitServiceLogToGroups } from '../services/notification.service';
import { registerQrMessageDeleter } from '../services/payment.service';

export type TelegramState = 'DISABLED' | 'STOPPED' | 'STARTING' | 'CONNECTED' | 'ERROR';

class TelegramService {
  private bot: Telegraf | null = null;
  private state: TelegramState = config.telegram.enabled ? 'STOPPED' : 'DISABLED';
  private lastError: string | null = null;
  private botUsername: string | null = null;
  private startedAt: string | null = null;

  getStatus() {
    return {
      enabled: config.telegram.enabled,
      tokenConfigured: Boolean(config.telegram.botToken),
      state: this.state,
      botUsername: this.botUsername,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    if (!config.telegram.enabled) {
      this.state = 'DISABLED';
      return;
    }
    if (!config.telegram.botToken) {
      this.state = 'ERROR';
      this.lastError = 'TELEGRAM_BOT_TOKEN belum diisi di .env';
      return;
    }
    if (this.bot) {
      logger.warn('Telegram bot already initialized; skipping duplicate start', { service: 'telegram' });
      return;
    }

    this.state = 'STARTING';
    try {
      const telegramAgent = new https.Agent({
        keepAlive: false,
        autoSelectFamily: true,
        timeout: 30_000,
      });
      const bot = new Telegraf(config.telegram.botToken, {
        telegram: {
          agent: telegramAgent,
          attachmentAgent: telegramAgent,
        },
      });

      bot.catch((err) => {
        const msg = err instanceof Error ? err.message : 'Telegram update error';
        this.lastError = msg;
        logger.error('Telegram middleware error', {
          service: 'telegram',
          details: { error: msg },
        });
      });

      registerTelegramCommands(bot);
      registerTelegramCallbacks(bot);

      const me = await bot.telegram.getMe();
      this.botUsername = me.username || null;

      // Launch polling cleanly without blocking startup
      void bot.launch().catch((err) => {
        this.state = 'ERROR';
        this.lastError = err instanceof Error ? err.message : 'Telegram polling error';
        logger.error('Telegram launch error', {
          service: 'telegram',
          details: { error: this.lastError },
        });
      });

      this.bot = bot;
      this.state = 'CONNECTED';
      this.lastError = null;
      this.startedAt = new Date().toISOString();

      registerNotificationSender('TELEGRAM', async ({ recipientId, payload }) => {
        if (!this.bot || this.state !== 'CONNECTED') return false;
        const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload);
        return sendTelegramText(this.bot, recipientId, text);
      });

      registerQrMessageDeleter('TELEGRAM', async ({ chatId, messageId }) => {
        if (!this.bot || this.state !== 'CONNECTED') return;
        const idNum = Number(messageId);
        if (Number.isFinite(idNum)) {
          await deleteTelegramMessageSafely(this.bot, chatId, idNum);
        }
      });

      logger.info('Telegram bot started', {
        service: 'telegram',
        details: { username: this.botUsername },
      });

      emitServiceLogToGroups(
        `tg-start-${Date.now()}`,
        'Telegram Connected',
        `Bot Telegram (@${this.botUsername || 'bot'}) berhasil aktif.`
      );
    } catch (err) {
      this.state = 'ERROR';
      this.lastError = err instanceof Error ? err.message : 'Gagal menjalankan bot Telegram';
      logger.error('Telegram start failed', {
        service: 'telegram',
        details: { error: this.lastError },
      });
    }
  }

  async reconnect(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    registerNotificationSender('TELEGRAM', null);
    registerQrMessageDeleter('TELEGRAM', null);
    if (this.bot) {
      try {
        this.bot.stop('SHUTDOWN');
      } catch {
        // Ignore if bot wasn't actively polling
      }
      this.bot = null;
    }
    if (config.telegram.enabled) {
      this.state = 'STOPPED';
    }
    logger.info('Telegram bot stopped cleanly', { service: 'telegram' });
  }
}

export const telegramService = new TelegramService();
