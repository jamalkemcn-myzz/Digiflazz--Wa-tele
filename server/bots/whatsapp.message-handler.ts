import type { WASocket } from '@whiskeysockets/baileys';
import { handleWhatsappCommand, type WhatsappReplyTransport } from './whatsapp.command-handler';

const processedMessages = new Set<string>();

function rememberMessageId(id: string): boolean {
  if (processedMessages.has(id)) return false;
  if (processedMessages.size > 5000) {
    processedMessages.clear();
  }
  processedMessages.add(id);
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
      key?: { id?: string; fromMe?: boolean; remoteJid?: string };
      pushName?: string;
      message?: Record<string, any>;
    }>;
  };

  if (upsert?.type !== 'notify' || !Array.isArray(upsert.messages)) return;

  const baileyTransport: WhatsappReplyTransport = {
    async sendMessage(jid, content) {
      if ('image' in content) {
        return sock.sendMessage(jid, { image: content.image, caption: content.caption });
      }
      return sock.sendMessage(jid, { text: content.text });
    },
  };

  for (const msg of upsert.messages) {
    const id = msg.key?.id;
    const remoteJid = msg.key?.remoteJid;
    if (!id || !remoteJid || msg.key?.fromMe) continue;
    if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) continue;
    if (!rememberMessageId(id)) continue;

    const text = extractIncomingWhatsappText(msg.message);
    if (!text.trim()) continue;

    await handleWhatsappCommand(baileyTransport, remoteJid, text, msg.pushName);
  }
}
