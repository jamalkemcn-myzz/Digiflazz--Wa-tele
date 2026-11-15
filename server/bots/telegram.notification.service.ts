import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Telegraf } from 'telegraf';
import QRCode from 'qrcode';
import { logger } from '../logging/logger';
import { appendRawFormatToQrisUrl, fetchQrisImageBuffer } from '../integrations/qris-image';

function detectImageMeta(buf: Buffer): { filename: string; mimeType: string } {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { filename: 'qris.png', mimeType: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { filename: 'qris.jpg', mimeType: 'image/jpeg' };
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { filename: 'qris.webp', mimeType: 'image/webp' };
  }
  if (buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') {
    return { filename: 'qris.gif', mimeType: 'image/gif' };
  }
  return { filename: 'qris.png', mimeType: 'image/png' };
}

function buildTelegramMultipartBody(params: {
  chatId: string | number;
  caption: string;
  imageBuffer: Buffer;
  filename: string;
  mimeType: string;
  inlineReplyMarkup?: unknown;
}): { boundary: string; body: Buffer } {
  const boundary = `----PPOBTelegramQRIS${crypto.randomBytes(16).toString('hex')}`;
  const chunks: Buffer[] = [];

  const pushTextField = (name: string, value: string) => {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8'
      )
    );
  };

  pushTextField('chat_id', String(params.chatId));
  if (params.caption) {
    pushTextField('caption', params.caption);
  }
  if (params.inlineReplyMarkup !== undefined) {
    pushTextField(
      'reply_markup',
      typeof params.inlineReplyMarkup === 'string'
        ? params.inlineReplyMarkup
        : JSON.stringify(params.inlineReplyMarkup)
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${params.filename}"\r\nContent-Type: ${params.mimeType}\r\n\r\n`,
      'utf8'
    )
  );
  chunks.push(params.imageBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  return { boundary, body: Buffer.concat(chunks) };
}

export async function sendTelegramPhotoDirectIpv4(params: {
  apiRoot?: string;
  token: string;
  chatId: string | number;
  caption: string;
  imageBuffer: Buffer;
  filename: string;
  mimeType: string;
  inlineReplyMarkup?: unknown;
  family?: 4 | 6;
}): Promise<number> {
  const baseRoot = (params.apiRoot || 'https://api.telegram.org').replace(/\/+$/, '');
  const endpointUrl = new URL(`${baseRoot}/bot${params.token}/sendPhoto`);
  const { boundary, body } = buildTelegramMultipartBody({
    chatId: params.chatId,
    caption: params.caption,
    imageBuffer: params.imageBuffer,
    filename: params.filename,
    mimeType: params.mimeType,
    inlineReplyMarkup: params.inlineReplyMarkup,
  });

  return new Promise<number>((resolve, reject) => {
    const isHttp = endpointUrl.protocol === 'http:';
    const requestFn = isHttp ? http.request : https.request;
    const req = requestFn(
      {
        protocol: endpointUrl.protocol,
        hostname: endpointUrl.hostname,
        port: endpointUrl.port || (isHttp ? 80 : 443),
        path: `${endpointUrl.pathname}${endpointUrl.search}`,
        method: 'POST',
        agent: false,
        family: params.family ?? 4,
        timeout: 30_000,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          Connection: 'close',
        },
      },
      (res) => {
        const resChunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => resChunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(resChunks).toString('utf8');
          try {
            const parsed = JSON.parse(raw) as {
              ok?: boolean;
              description?: string;
              result?: { message_id?: number };
            };
            if (!res.statusCode || res.statusCode >= 400 || !parsed.ok || !parsed.result?.message_id) {
              reject(new Error(parsed.description || `Telegram HTTP ${res.statusCode || 500}`));
              return;
            }
            resolve(parsed.result.message_id);
          } catch {
            reject(new Error(`Invalid Telegram sendPhoto response (HTTP ${res.statusCode || 500})`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Telegram sendPhoto IPv4 timeout'));
    });
    req.on('error', (err) => {
      err.message = err.message.replace(/\/(bot|user)(\d+):[^/]+\//g, '/$1$2:[REDACTED]/');
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function uploadPhotoResilient(
  bot: Telegraf,
  chatId: string | number,
  imageBuffer: Buffer,
  caption: string,
  replyMarkup?: Parameters<Telegraf['telegram']['sendMessage']>[2]
): Promise<number> {
  const { filename, mimeType } = detectImageMeta(imageBuffer);
  const safeCaption = caption.length > 1000 ? `${caption.slice(0, 997)}...` : caption;
  const inlineReplyMarkup =
    replyMarkup && typeof replyMarkup === 'object' && 'reply_markup' in replyMarkup
      ? (replyMarkup as { reply_markup?: unknown }).reply_markup
      : undefined;

  const token = bot.telegram.token;
  const apiRoot = bot.telegram.options?.apiRoot;

  try {
    const msg = await bot.telegram.sendPhoto(
      chatId,
      { source: imageBuffer, filename },
      { caption: safeCaption, ...replyMarkup }
    );
    return msg.message_id;
  } catch (firstErr) {
    if (!token) throw firstErr;

    logger.warn('Telegraf sendPhoto retry via direct IPv4 multipart upload', {
      service: 'telegram-notify',
      details: { error: firstErr instanceof Error ? firstErr.message : 'unknown' },
    });

    // Direct IPv4 Connection:close with exact Content-Length bypasses keepAlive/chunked socket hang up on Docker/Pterodactyl
    return await sendTelegramPhotoDirectIpv4({
      apiRoot,
      token,
      chatId,
      caption: safeCaption,
      imageBuffer,
      filename,
      mimeType,
      inlineReplyMarkup,
      family: 4,
    });
  }
}

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
      return await uploadPhotoResilient(bot, chatId, pngBuffer, caption, replyMarkup);
    }
    if (qris?.qrUrl) {
      const rawQrUrl = appendRawFormatToQrisUrl(qris.qrUrl);
      const imageBuffer = await fetchQrisImageBuffer(rawQrUrl);
      return await uploadPhotoResilient(bot, chatId, imageBuffer, caption, replyMarkup);
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
