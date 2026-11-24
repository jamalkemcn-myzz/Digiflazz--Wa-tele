import type { WASocket } from '@whiskeysockets/baileys';
import { handleWhatsappCommand, type WhatsappReplyTransport } from './whatsapp.command-handler';

const DEDUP_TTL_MS = 10 * 60 * 1000;
const MAX_PROCESSED_MESSAGES = 2000;
const processedMessages = new Map<string, number>();

export function pruneProcessedWhatsappMessages(now = Date.now()): number {
  let evicted = 0;
  for (const [id, rememberedAt] of processedMessages) {
    if (now - rememberedAt > DEDUP_TTL_MS) {
      processedMessages.delete(id);
      evicted++;
    }
  }
  return evicted;
}

function rememberMessageId(id: string, now = Date.now()): boolean {
  const existing = processedMessages.get(id);
  if (existing !== undefined && now - existing <= DEDUP_TTL_MS) {
    return false;
  }
  if (processedMessages.size >= MAX_PROCESSED_MESSAGES) {
    pruneProcessedWhatsappMessages(now);
    if (processedMessages.size >= MAX_PROCESSED_MESSAGES) {
      const excess = processedMessages.size - MAX_PROCESSED_MESSAGES + 1;
      let removed = 0;
      for (const k of processedMessages.keys()) {
        processedMessages.delete(k);
        removed++;
        if (removed >= excess) break;
      }
    }
  }
  processedMessages.delete(id);
  processedMessages.set(id, now);
  return true;
}

function extractIncomingWhatsappText(message: Record<string, any> | undefined): string {
  if (!message) return '';
  if (typeof message.conversation === 'string' && message.conversation.trim()) {
    return message.conversation;
  }
  if (typeof message.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text.trim()) {
    return message.extendedTextMessage.text;
  }
  if (typeof message.buttonsResponseMessage?.selectedButtonId === 'string') {
    return message.buttonsResponseMessage.selectedButtonId;
  }
  if (typeof message.templateButtonReplyMessage?.selectedId === 'string') {
    return message.templateButtonReplyMessage.selectedId;
  }
  if (typeof message.listResponseMessage?.singleSelectReply?.selectedRowId === 'string') {
    return message.listResponseMessage.singleSelectReply.selectedRowId;
  }
  const nativeJson = message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (typeof nativeJson === 'string') {
    try {
      const parsed = JSON.parse(nativeJson) as { id?: string };
      if (typeof parsed.id === 'string' && parsed.id.trim()) return parsed.id;
    } catch {
      // Ignore malformed interactive JSON
    }
  }
  return '';
}

export async function handleWhatsappMessagesUpsert(sock: WASocket, rawUpsert: unknown): Promise<void> {
  const upsert = rawUpsert as {
    type?: string;
    messages?: Array<{
      key?: { id?: string; fromMe?: boolean; remoteJid?: string; remoteJidAlt?: string };
      pushName?: string;
      message?: Record<string, any>;
    }>;
  };

  if (upsert?.type !== 'notify' || !Array.isArray(upsert.messages)) return;

  for (const msg of upsert.messages) {
    const id = msg.key?.id;
    const rawRemoteJid = msg.key?.remoteJid;
    const remoteJidAlt = msg.key?.remoteJidAlt;
    if (!id || !rawRemoteJid || msg.key?.fromMe) continue;
    if (rawRemoteJid === 'status@broadcast' || rawRemoteJid.endsWith('@g.us')) continue;
    if (!rememberMessageId(id)) continue;

    const text = extractIncomingWhatsappText(msg.message);
    if (!text.trim()) continue;

    const customerJid =
      rawRemoteJid.endsWith('@lid') && remoteJidAlt && !remoteJidAlt.endsWith('@lid')
        ? remoteJidAlt
        : rawRemoteJid;

    const baileyTransport: WhatsappReplyTransport = {
      async sendMessage(_jid, content) {
        if ('image' in content) {
          return sock.sendMessage(rawRemoteJid, { image: content.image, caption: content.caption });
        }
        return sock.sendMessage(rawRemoteJid, { text: content.text });
      },
    };

    await handleWhatsappCommand(baileyTransport, customerJid, text, msg.pushName);
  }
}
