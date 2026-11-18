import crypto from 'node:crypto';
import https from 'node:https';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import { registerTelegramCommands } from './telegram.command-handler';
import { registerTelegramCallbacks } from './telegram.callback-handler';
import { deleteTelegramMessageSafely, sendTelegramText } from './telegram.notification.service';
import {
  registerNotificationSender,
  emitServiceLogToGroups,
  setTelegramBotUsernameForLogs,
} from '../services/notification.service';
import { registerQrMessageDeleter } from '../services/payment.service';

export type TelegramState = 'DISABLED' | 'STOPPED' | 'STARTING' | 'CONNECTED' | 'ERROR';
export type TelegramMode = 'WEBHOOK' | 'POLLING' | 'NONE';

function buildWebhookSecretToken(botToken: string, configuredSecret: string): string {
  const cleanedConfigured = configuredSecret.replace(/[^A-Za-z0-9_-]/g, '');
  if (cleanedConfigured.length >= 8) {
    return cleanedConfigured.slice(0, 128);
  }
  return crypto.createHmac('sha256', botToken).update('telegram-webhook-secret').digest('hex').slice(0, 48);
}

function safeCompareSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class TelegramService {
  private bot: Telegraf | null = null;
  private state: TelegramState = config.telegram.enabled ? 'STOPPED' : 'DISABLED';
  private activeMode: TelegramMode = 'NONE';
  private webhookUrl: string | null = null;
  private webhookSecretToken: string | null = null;
  private lastError: string | null = null;
  private botUsername: string | null = null;
  private startedAt: string | null = null;

  getStatus() {
    return {
      enabled: config.telegram.enabled,
      tokenConfigured: Boolean(config.telegram.botToken),
      state: this.state,
      mode: this.activeMode,
      webhookUrl: this.webhookUrl,
      webhookPath: config.telegram.webhookPath,
      botUsername: this.botUsername,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  private resolveTargetWebhookUrl(): string | null {
    if (config.telegram.webhookUrl && config.telegram.webhookUrl.startsWith('https://')) {
      return config.telegram.webhookUrl;
    }
    if (config.appUrl.startsWith('https://')) {
      return `${config.appUrl.replace(/\/+$/, '')}${config.telegram.webhookPath}`;
    }
    return null;
  }

  async handleWebhookUpdate(
    update: unknown,
    secretHeader?: string
  ): Promise<{ ok: boolean; statusCode: number; error?: string }> {
    if (!config.telegram.enabled || !this.bot || this.state !== 'CONNECTED') {
      return { ok: false, statusCode: 503, error: 'Telegram bot is not connected' };
    }
    if (this.webhookSecretToken) {
      const candidate = (secretHeader || '').trim();
      if (!candidate || !safeCompareSecret(candidate, this.webhookSecretToken)) {
        return { ok: false, statusCode: 401, error: 'Invalid Telegram webhook secret token' };
      }
    }
    if (!update || typeof update !== 'object' || !('update_id' in update)) {
      return { ok: false, statusCode: 400, error: 'Invalid Telegram update payload' };
    }

    try {
      await this.bot.handleUpdate(update as Update);
      return { ok: true, statusCode: 200 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Telegram webhook update error';
      this.lastError = msg;
      logger.error('Telegram webhook handleUpdate error', {
        service: 'telegram',
        details: { error: msg },
      });
      return { ok: true, statusCode: 200 };
    }
  }

  async start(): Promise<void> {
    if (!config.telegram.enabled) {
      this.state = 'DISABLED';
      this.activeMode = 'NONE';
      return;
    }
    if (!config.telegram.botToken) {
      this.state = 'ERROR';
      this.activeMode = 'NONE';
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
        keepAlive: true,
        family: 4,
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
      setTelegramBotUsernameForLogs(this.botUsername);

      const targetWebhookUrl = this.resolveTargetWebhookUrl();
      if (config.telegram.mode === 'webhook' && targetWebhookUrl) {
        const secretToken = buildWebhookSecretToken(config.telegram.botToken, config.telegram.webhookSecret);
        await bot.telegram.setWebhook(targetWebhookUrl, {
          secret_token: secretToken,
          drop_pending_updates: false,
        });
        this.activeMode = 'WEBHOOK';
        this.webhookUrl = targetWebhookUrl;
        this.webhookSecretToken = secretToken;
      } else {
        if (config.telegram.mode === 'webhook' && !targetWebhookUrl) {
          logger.warn(
            'TELEGRAM_MODE=webhook memerlukan APP_URL atau TELEGRAM_WEBHOOK_URL berawalan https://; sementara memakai fallback polling agar bot tetap aktif',
            { service: 'telegram' }
          );
        }
        await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
        void bot.launch().catch((err) => {
          this.state = 'ERROR';
          this.lastError = err instanceof Error ? err.message : 'Telegram polling error';
          logger.error('Telegram launch error', {
            service: 'telegram',
            details: { error: this.lastError },
          });
        });
        this.activeMode = 'POLLING';
        this.webhookUrl = null;
        this.webhookSecretToken = null;
      }

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

      logger.info(`Telegram bot started in ${this.activeMode} mode`, {
        service: 'telegram',
        details: {
          username: this.botUsername,
          mode: this.activeMode,
          webhookUrl: this.webhookUrl,
        },
      });

      emitServiceLogToGroups(
        `tg-start-${Date.now()}`,
        'Telegram Connected',
        `Bot Telegram (@${this.botUsername || 'bot'}) berhasil aktif (${this.activeMode}).`
      );
    } catch (err) {
      this.state = 'ERROR';
      this.activeMode = 'NONE';
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
    setTelegramBotUsernameForLogs(null);
    if (this.bot) {
      if (this.activeMode === 'POLLING') {
        try {
          this.bot.stop('SHUTDOWN');
        } catch {
          // Ignore if bot wasn't actively polling
        }
      }
      this.bot = null;
    }
    this.activeMode = 'NONE';
    if (config.telegram.enabled) {
      this.state = 'STOPPED';
    }
    logger.info('Telegram bot stopped cleanly', { service: 'telegram' });
  }
}

export const telegramService = new TelegramService();
