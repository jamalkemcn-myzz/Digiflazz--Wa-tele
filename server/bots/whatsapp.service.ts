import type { proto } from '@whiskeysockets/baileys';
import { toWhatsappJid } from '../domain/masking';
import { WhatsappConnectionManager } from './whatsapp.connection';
import { handleWhatsappMessagesUpsert } from './whatsapp.message-handler';
import { registerNotificationSender } from '../services/notification.service';
import { registerQrMessageDeleter } from '../services/payment.service';
import { clearWhatsappSessionDir } from './whatsapp.session';

class WhatsappService {
  private readonly manager = new WhatsappConnectionManager();

  constructor() {
    this.manager.setMessageHandler(handleWhatsappMessagesUpsert);
  }

  async start(): Promise<void> {
    registerNotificationSender('WHATSAPP', async ({ recipientId, payload }) => {
      const sock = this.manager.getSocket();
      if (!sock || this.manager.getStatus().state !== 'CONNECTED') return false;
      const targetJid = toWhatsappJid(recipientId);
      const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload);
      await sock.sendMessage(targetJid, { text });
      return true;
    });

    registerQrMessageDeleter('WHATSAPP', async ({ chatId, messageId }) => {
      const sock = this.manager.getSocket();
      if (!sock || this.manager.getStatus().state !== 'CONNECTED') return;
      if (messageId && typeof messageId === 'object') {
        await sock.sendMessage(chatId, { delete: messageId as proto.IMessageKey });
      }
    });

    await this.manager.connect();
  }

  getStatus() {
    return this.manager.getStatus();
  }

  requestPairingCode(phoneNumber: string): Promise<string> {
    return this.manager.requestPairingCode(phoneNumber);
  }

  async reconnect(resetSession = false): Promise<void> {
    await this.manager.stop();
    if (resetSession) {
      clearWhatsappSessionDir();
    }
    await this.manager.connect(true);
  }

  async stop(): Promise<void> {
    registerNotificationSender('WHATSAPP', null);
    registerQrMessageDeleter('WHATSAPP', null);
    await this.manager.stop();
  }
}

export const whatsappService = new WhatsappService();
