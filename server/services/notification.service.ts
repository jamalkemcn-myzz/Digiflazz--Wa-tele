import { getDb } from '../database/connection';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import {
  maskBuyerForTestimony,
  maskDestination,
  maskSerialNumber,
  maskTransactionId,
} from '../domain/masking';

export type NotificationSender = (params: {
  recipientId: string;
  messageType: string;
  payload: Record<string, unknown>;
}) => Promise<boolean>;

const senders: {
  WHATSAPP: NotificationSender | null;
  TELEGRAM: NotificationSender | null;
} = {
  WHATSAPP: null,
  TELEGRAM: null,
};

let runtimeTelegramBotUsername: string | null = null;

export function setTelegramBotUsernameForLogs(username: string | null): void {
  const cleaned = (username || '').trim().replace(/^@+/, '');
  runtimeTelegramBotUsername = cleaned || null;
}

export function getEffectiveBotDisplayHandle(): string {
  const tgUsername = runtimeTelegramBotUsername || config.telegram.botUsername;
  if (tgUsername) return `@${tgUsername}`;
  return config.shopName;
}

export function formatGroupLogTimestamp(isoDate?: string): string {
  const date = isoDate ? new Date(isoDate) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: config.timezone || 'Asia/Jakarta',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(safeDate);
  } catch {
    return safeDate.toISOString();
  }
}

export function registerNotificationSender(
  platform: 'WHATSAPP' | 'TELEGRAM',
  sender: NotificationSender | null
): void {
  senders[platform] = sender;
}

export function enqueueNotification(params: {
  dedupeKey: string;
  transactionId?: string | null;
  platform: 'WHATSAPP' | 'TELEGRAM';
  recipientId: string;
  messageType: string;
  payload: Record<string, unknown>;
}): void {
  if (!params.recipientId) return;
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO notification_jobs
       (dedupe_key, transaction_id, platform, recipient_id, message_type, payload_json, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`
    ).run(
      params.dedupeKey,
      params.transactionId ?? null,
      params.platform,
      params.recipientId,
      params.messageType,
      JSON.stringify(params.payload),
      now,
      now
    );
  } catch (err) {
    logger.warn('Failed to enqueue notification job', {
      service: 'notification',
      transactionId: params.transactionId ?? undefined,
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
  }
}

// 1. Log event layanan admin
export function emitServiceLogToGroups(eventKey: string, title: string, safeSummary: string): void {
  const timestamp = formatGroupLogTimestamp();
  const text = `[SERVICE LOG]\nWaktu: ${timestamp}\nEvent: ${title}\nDetail: ${safeSummary}`;

  if (config.whatsapp.enabled && config.whatsapp.serviceLogGroup) {
    enqueueNotification({
      dedupeKey: `svc-wa-${eventKey}`,
      platform: 'WHATSAPP',
      recipientId: config.whatsapp.serviceLogGroup,
      messageType: 'SERVICE_LOG',
      payload: { text },
    });
  }

  if (config.telegram.enabled && config.telegram.serviceLogChatId) {
    enqueueNotification({
      dedupeKey: `svc-tg-${eventKey}`,
      platform: 'TELEGRAM',
      recipientId: config.telegram.serviceLogChatId,
      messageType: 'SERVICE_LOG',
      payload: { text },
    });
  }
}

// 2. Log all transaksi admin
export function emitTransactionLogToGroups(params: {
  eventKey: string;
  transactionId: string;
  customerCode: string;
  productName: string;
  destination?: string;
  platform?: string;
  amount: number;
  status: string;
  note: string;
}): void {
  const timestamp = formatGroupLogTimestamp();
  const text =
    `[ALL TRANSAKSI ADMIN]\n` +
    `Waktu: ${timestamp}\n` +
    `ID: ${params.transactionId}\n` +
    `Pelanggan: ${params.customerCode}${params.platform ? ` (${params.platform})` : ''}\n` +
    `Produk: ${params.productName}\n` +
    (params.destination ? `Tujuan: ${params.destination}\n` : '') +
    `Nominal: Rp ${params.amount.toLocaleString('id-ID')}\n` +
    `Status: ${params.status}\n` +
    `Keterangan: ${params.note}`;

  if (config.whatsapp.enabled && config.whatsapp.transactionLogGroup) {
    enqueueNotification({
      dedupeKey: `txlog-wa-${params.transactionId}-${params.eventKey}`,
      transactionId: params.transactionId,
      platform: 'WHATSAPP',
      recipientId: config.whatsapp.transactionLogGroup,
      messageType: 'TRANSACTION_LOG',
      payload: { text },
    });
  }

  if (config.telegram.enabled && config.telegram.transactionLogChatId) {
    enqueueNotification({
      dedupeKey: `txlog-tg-${params.transactionId}-${params.eventKey}`,
      transactionId: params.transactionId,
      platform: 'TELEGRAM',
      recipientId: config.telegram.transactionLogChatId,
      messageType: 'TRANSACTION_LOG',
      payload: { text },
    });
  }
}

export interface SuccessGroupLogParams {
  transactionId: string;
  platform: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD';
  customerCode: string;
  platformUserId?: string | null;
  platformUsername?: string | null;
  categoryName?: string | null;
  brand?: string | null;
  productSku: string;
  productName: string;
  destination: string;
  sn?: string | null;
  supplierPrice: number;
  margin: number;
  discount: number;
  uniqueCode: number;
  paymentAmount: number;
  supplierReference?: string | null;
  gatewayReference?: string | null;
  completedAt?: string;
}

// 3. Log transaksi sukses admin (FULL TANPA SENSOR, khusus grup admin)
export function emitSuccessAdminLogToGroups(params: SuccessGroupLogParams): void {
  const timestamp = formatGroupLogTimestamp(params.completedAt);
  const serviceLabel =
    params.categoryName && params.brand && params.categoryName.toLowerCase() !== params.brand.toLowerCase()
      ? `${params.categoryName} • ${params.brand}`
      : params.categoryName || params.brand || 'Produk PPOB';
  const buyerIdentityParts = [params.customerCode];
  if (params.platformUsername) {
    buyerIdentityParts.push(`@${params.platformUsername.replace(/^@+/, '')}`);
  }
  if (params.platformUserId) {
    buyerIdentityParts.push(`ID:${params.platformUserId}`);
  }

  const text =
    `✅ [LOG TRANSAKSI SUKSES ADMIN]\n` +
    `Waktu: ${timestamp}\n` +
    `Order ID: ${params.transactionId}\n` +
    `Platform: ${params.platform}\n` +
    `Pembeli: ${buyerIdentityParts.join(' | ')}\n` +
    `Layanan: ${serviceLabel}\n` +
    `Produk: ${params.productName} (${params.productSku})\n` +
    `Tujuan: ${params.destination}\n` +
    `SN / Token: ${params.sn || '-'}\n` +
    `Modal Supplier: Rp ${params.supplierPrice.toLocaleString('id-ID')}\n` +
    `Diskon: Rp ${params.discount.toLocaleString('id-ID')} | Kode Unik: ${params.uniqueCode}\n` +
    `Total Bayar: Rp ${params.paymentAmount.toLocaleString('id-ID')}\n` +
    `Margin: Rp ${params.margin.toLocaleString('id-ID')}\n` +
    `Ref Supplier: ${params.supplierReference || '-'}\n` +
    `Ref Gateway: ${params.gatewayReference || '-'}`;

  if (config.whatsapp.enabled && config.whatsapp.successLogGroup) {
    enqueueNotification({
      dedupeKey: `txok-wa-${params.transactionId}`,
      transactionId: params.transactionId,
      platform: 'WHATSAPP',
      recipientId: config.whatsapp.successLogGroup,
      messageType: 'SUCCESS_ADMIN_LOG',
      payload: { text },
    });
  }

  if (config.telegram.enabled && config.telegram.successLogChatId) {
    enqueueNotification({
      dedupeKey: `txok-tg-${params.transactionId}`,
      transactionId: params.transactionId,
      platform: 'TELEGRAM',
      recipientId: config.telegram.successLogChatId,
      messageType: 'SUCCESS_ADMIN_LOG',
      payload: { text },
    });
  }
}

export function formatTestimonyMessage(params: SuccessGroupLogParams): string {
  const timestamp = formatGroupLogTimestamp(params.completedAt);
  const serviceLabel =
    params.categoryName && params.brand && params.categoryName.toLowerCase() !== params.brand.toLowerCase()
      ? `${params.categoryName} • ${params.brand}`
      : params.categoryName || params.brand || 'Layanan PPOB';
  const maskedDestination = maskDestination(params.destination);
  const maskedOrder = maskTransactionId(params.transactionId);
  const { buyerLabel, maskedId } = maskBuyerForTestimony({
    customerCode: params.customerCode,
    platformUsername: params.platformUsername,
    platformUserId: params.platformUserId,
  });
  const maskedSn = params.sn ? maskSerialNumber(params.sn) : null;
  const botHandle = getEffectiveBotDisplayHandle();

  const lines = [
    '✨ ORDER BERHASIL',
    '╭───────────────',
    '│ DETAIL TRANSAKSI',
    '├───────────────',
    `┣ Layanan : ${serviceLabel}`,
    `┣ Produk  : ${params.productName}`,
    `┣ Tujuan  : ${maskedDestination}`,
    ...(maskedSn ? [`┣ SN      : ${maskedSn}`] : []),
    `┣ Total   : Rp ${params.paymentAmount.toLocaleString('id-ID')}`,
    `┣ Pembeli : ${buyerLabel}`,
    `┣ ID      : ${maskedId}`,
    `┣ Order   : ${maskedOrder}`,
    `╰ Waktu   : ${timestamp}`,
    '',
    `🙏 Terima kasih sudah order di ${config.shopName}`,
    '',
    '💎 Keunggulan',
    '• Auto proses',
    '• Proses cepat',
    '• Harga bersahabat',
    '',
    `🤖 Bot: ${botHandle}`,
  ];

  return lines.join('\n');
}

// 4. Grup / channel testimoni member (DISENSOR, HANYA transaksi sukses)
export function emitTestimonyToGroups(params: SuccessGroupLogParams): void {
  const text = formatTestimonyMessage(params);

  if (config.whatsapp.enabled && config.whatsapp.testimonyGroup) {
    enqueueNotification({
      dedupeKey: `testi-wa-${params.transactionId}`,
      transactionId: params.transactionId,
      platform: 'WHATSAPP',
      recipientId: config.whatsapp.testimonyGroup,
      messageType: 'TESTIMONY_LOG',
      payload: { text },
    });
  }

  if (config.telegram.enabled && config.telegram.testimonyChatId) {
    enqueueNotification({
      dedupeKey: `testi-tg-${params.transactionId}`,
      transactionId: params.transactionId,
      platform: 'TELEGRAM',
      recipientId: config.telegram.testimonyChatId,
      messageType: 'TESTIMONY_LOG',
      payload: { text },
    });
  }
}


export function notifyCustomerForTransaction(params: {
  transactionId: string;
  customerId: number;
  eventKey: string;
  messageType: string;
  text: string;
}): void {
  const db = getDb();
  const identities = db
    .prepare('SELECT platform, platform_user_id FROM customer_identities WHERE customer_id = ?')
    .all(params.customerId) as Array<{ platform: 'WHATSAPP' | 'TELEGRAM' | 'DASHBOARD'; platform_user_id: string }>;

  for (const id of identities) {
    if (id.platform === 'WHATSAPP' || id.platform === 'TELEGRAM') {
      enqueueNotification({
        dedupeKey: `cus-${id.platform}-${params.transactionId}-${params.eventKey}`,
        transactionId: params.transactionId,
        platform: id.platform,
        recipientId: id.platform_user_id,
        messageType: params.messageType,
        payload: { text: params.text },
      });
    }
  }
}

export async function processPendingNotifications(): Promise<{ sent: number; failed: number }> {
  const db = getDb();
  const now = new Date().toISOString();
  const maxAttempts = 5;

  const jobs = db
    .prepare(
      `SELECT * FROM notification_jobs
       WHERE status = 'PENDING' AND next_attempt_at <= ? AND attempts < ?
       ORDER BY id ASC LIMIT 20`
    )
    .all(now, maxAttempts) as Array<{
    id: number;
    transaction_id: string | null;
    platform: 'WHATSAPP' | 'TELEGRAM';
    recipient_id: string;
    message_type: string;
    payload_json: string;
    attempts: number;
  }>;

  let sent = 0;
  let failed = 0;

  for (const job of jobs) {
    const sender = senders[job.platform];
    if (!sender) {
      // Bot not connected yet; defer safely without burning all attempts rapidly
      const nextRetry = new Date(Date.now() + 30000).toISOString();
      db.prepare('UPDATE notification_jobs SET next_attempt_at = ? WHERE id = ?').run(nextRetry, job.id);
      continue;
    }

    try {
      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      const ok = await sender({
        recipientId: job.recipient_id,
        messageType: job.message_type,
        payload,
      });

      if (ok) {
        db.prepare("UPDATE notification_jobs SET status = 'SENT', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(
          new Date().toISOString(),
          job.id
        );
        sent++;
      } else {
        throw new Error('Sender returned false');
      }
    } catch (err) {
      const nextAttempt = job.attempts + 1;
      const isFinal = nextAttempt >= maxAttempts;
      const backoffMs = Math.min(300000, 15000 * Math.pow(2, nextAttempt - 1));
      db.prepare(
        `UPDATE notification_jobs
         SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?`
      ).run(
        isFinal ? 'FAILED' : 'PENDING',
        nextAttempt,
        new Date(Date.now() + backoffMs).toISOString(),
        err instanceof Error ? err.message.slice(0, 200) : 'Send failed',
        job.id
      );
      failed++;
    }
  }

  return { sent, failed };
}

export function getNotificationQueueStats() {
  const db = getDb();
  return db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed
       FROM notification_jobs`
    )
    .get() as { pending: number | null; sent: number | null; failed: number | null };
}
