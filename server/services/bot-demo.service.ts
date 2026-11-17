import QRCode from 'qrcode';
import type { AdminRole } from '../domain/rbac';
import {
  handleWhatsappCommand,
  type WhatsappReplyTransport,
} from '../bots/whatsapp.command-handler';
import {
  dispatchTelegramCommand,
  type TelegramInlineButton,
  type TelegramReplyTransport,
} from '../bots/telegram.command-handler';
import { dispatchTelegramCallback } from '../bots/telegram.callback-handler';

export type BotDemoPlatform = 'WHATSAPP' | 'TELEGRAM';
export type BotDemoSenderRole = 'CUSTOMER' | 'ADMIN';
export type BotDemoInputType = 'TEXT' | 'CALLBACK';

export interface BotDemoButton {
  text: string;
  callbackData?: string;
  replyText?: string;
}

export interface BotDemoReply {
  text: string;
  imageDataUrl?: string;
  buttons?: BotDemoButton[][];
}

export interface BotDemoInput {
  platform: BotDemoPlatform;
  senderRole: BotDemoSenderRole;
  inputType: BotDemoInputType;
  text?: string;
  callbackData?: string;
  senderId?: string;
  actor: {
    id: string;
    role: AdminRole;
  };
}

export interface BotDemoResponse {
  platform: BotDemoPlatform;
  senderRole: BotDemoSenderRole;
  dryRun: true;
  replies: BotDemoReply[];
}

export async function runBotDemoInteraction(input: BotDemoInput): Promise<BotDemoResponse> {
  const replies: BotDemoReply[] = [];
  const demoAdmin =
    input.senderRole === 'ADMIN'
      ? { role: input.actor.role, platformUserId: input.actor.id }
      : null;

  if (input.platform === 'WHATSAPP') {
    const text = (input.text || '').trim();
    if (!text) {
      throw new Error('Pesan perintah WhatsApp tidak boleh kosong');
    }
    const jid = (input.senderId || '6281234567890').trim() || '6281234567890';
    const transport: WhatsappReplyTransport = {
      async sendMessage(_targetJid, content) {
        const buttons: BotDemoButton[][] | undefined =
          content.quickReplies && content.quickReplies.length > 0
            ? content.quickReplies.map((row) =>
                row.map((b) => ({ text: b.text, replyText: b.replyText }))
              )
            : undefined;

        if ('image' in content) {
          let imageDataUrl: string | undefined;
          if (Buffer.isBuffer(content.image)) {
            imageDataUrl = `data:image/png;base64,${content.image.toString('base64')}`;
          } else if (
            content.image &&
            typeof content.image === 'object' &&
            'url' in content.image &&
            typeof content.image.url === 'string'
          ) {
            imageDataUrl = content.image.url;
          }
          replies.push({
            text: content.caption ?? '',
            imageDataUrl,
            buttons,
          });
          return undefined;
        }
        replies.push({
          text: content.text,
          buttons,
        });
        return undefined;
      },
    };

    await handleWhatsappCommand(transport, jid, text, 'Kak Demo', {
      dryRun: true,
      demoAdmin,
    });

    return {
      platform: 'WHATSAPP',
      senderRole: input.senderRole,
      dryRun: true,
      replies,
    };
  }

  // TELEGRAM
  const userId = (input.senderId || '100001').trim() || '100001';
  const transport: TelegramReplyTransport = {
    async reply(text: string, buttons?: TelegramInlineButton[][]) {
      replies.push({
        text,
        buttons:
          buttons && buttons.length > 0
            ? buttons.map((row) =>
                row.map((b) => ({ text: b.text, callbackData: b.callbackData }))
              )
            : undefined,
      });
    },
    async sendQris(caption, qris, buttons) {
      let imageDataUrl: string | undefined;
      if (qris?.qrString) {
        imageDataUrl = await QRCode.toDataURL(qris.qrString, { width: 320, margin: 2 });
      } else if (qris?.qrUrl) {
        try {
          const { fetchQrisImageBuffer } = await import('../integrations/qris-image');
          const buf = await fetchQrisImageBuffer(qris.qrUrl);
          imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
        } catch {
          imageDataUrl = qris.qrUrl;
        }
      }
      replies.push({
        text: caption,
        imageDataUrl,
        buttons:
          buttons && buttons.length > 0
            ? buttons.map((row) =>
                row.map((b) => ({ text: b.text, callbackData: b.callbackData }))
              )
            : undefined,
      });
      return null;
    },
    async answerCbQuery() {
      // No-op in dashboard simulator
    },
  };

  if (input.inputType === 'CALLBACK') {
    const callbackData = (input.callbackData || '').trim();
    if (!callbackData) {
      throw new Error('Callback data Telegram tidak boleh kosong');
    }
    await dispatchTelegramCallback(
      transport,
      { data: callbackData, userId, username: 'Kak Demo', displayName: 'Kak Demo' },
      { dryRun: true, demoAdmin }
    );
  } else {
    const text = (input.text || '').trim();
    if (!text) {
      throw new Error('Pesan perintah Telegram tidak boleh kosong');
    }
    await dispatchTelegramCommand(
      transport,
      { userId, username: 'Kak Demo', displayName: 'Kak Demo', text },
      { dryRun: true, demoAdmin }
    );
  }

  return {
    platform: 'TELEGRAM',
    senderRole: input.senderRole,
    dryRun: true,
    replies,
  };
}
