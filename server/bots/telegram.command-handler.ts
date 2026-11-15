import { Markup, type Telegraf, type Context } from 'telegraf';
import { getEffectivePermissions, type AdminRole } from '../domain/rbac';
import { config } from '../config/env';
import { maskDestination } from '../domain/masking';
import { listCategories, listProducts, getProductBySkuOrId } from '../services/product.service';
import {
  resolveOrCreateCustomer,
  findCustomerByPlatform,
  requestAccountLinkCode,
  verifyAndLinkAccount,
  unlinkPlatformIdentity,
  getCustomerRefundCreditTotal,
} from '../services/customer.service';
import {
  createOrder,
  previewOrderDryRun,
  cancelCustomerTransaction,
  getCustomerTransactions,
  getTransactionDetail,
  saveQrMessageReference,
} from '../services/transaction.service';
import {
  resolveAdminByPlatform,
  checkAdminPermission,
  getAdminBotTransactionReport,
  type ResolvedAdmin,
} from '../services/admin.service';
import { isMaintenanceMode, setMaintenanceMode } from '../services/settings.service';
import { centralScheduler } from '../workers/scheduler';
import { sendTelegramQrisInvoice, deleteTelegramMessageSafely } from './telegram.notification.service';
import {
  clearBotSession,
  consumeTelegramBotMessageIds,
  getBotSession,
  recordTelegramBotMessageId,
  setBotSession,
} from './bot-session';

export interface TelegramInlineButton {
  text: string;
  callbackData: string;
}

export interface TelegramReplyTransport {
  reply(text: string, buttons?: TelegramInlineButton[][]): Promise<void>;
  sendQris?(caption: string, qris?: { qrString?: string; qrUrl?: string }, buttons?: TelegramInlineButton[][]): Promise<number | null>;
  answerCbQuery?(): Promise<void>;
  deleteSourceMessage?(): Promise<void>;
}

export interface TelegramDispatchContext {
  userId: string;
  username?: string | null;
  text: string;
}

export interface TelegramCommandOptions {
  dryRun?: boolean;
  demoAdmin?: {
    role: AdminRole;
    platformUserId: string;
  } | null;
}

export const TG_MAIN_MENU_BUTTONS: TelegramInlineButton[][] = [
  [
    { text: 'Kategori Produk', callbackData: 'CAT_LIST' },
    { text: 'Daftar Produk', callbackData: 'PROD_PAGE_1' },
  ],
  [
    { text: 'Cek Status Terakhir', callbackData: 'MY_LATEST_STATUS' },
    { text: 'Riwayat & Refund', callbackData: 'MY_HISTORY' },
  ],
  [
    { text: 'Hubungkan WhatsApp', callbackData: 'LINK_ACCOUNT' },
    { text: 'Panduan Belanja', callbackData: 'HELP' },
  ],
];

export const TG_NAV_BACK_BUTTONS: TelegramInlineButton[][] = [
  [
    { text: 'Lihat Produk', callbackData: 'PROD_PAGE_1' },
    { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
  ],
];

export const TG_ADMIN_MENU_BUTTONS: TelegramInlineButton[][] = [
  [
    { text: 'Transaksi Terbaru', callbackData: 'ADMIN_TX_1' },
    { text: 'Hari Ini', callbackData: 'ADMIN_TODAY' },
  ],
  [
    { text: 'Status Layanan', callbackData: 'ADMIN_STATUS' },
    { text: 'Menu Pelanggan', callbackData: 'MAIN_MENU' },
  ],
];

const tgRateMap = new Map<number, { count: number; resetAt: number }>();

function checkTgRateLimit(userId: number, max = 25, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = tgRateMap.get(userId);
  if (!entry || now > entry.resetAt) {
    if (tgRateMap.size > 5000) tgRateMap.clear();
    tgRateMap.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

export function toMarkupKeyboard(buttons?: TelegramInlineButton[][]) {
  if (!buttons || buttons.length === 0) return undefined;
  return Markup.inlineKeyboard(buttons.map((row) => row.map((b) => Markup.button.callback(b.text, b.callbackData))));
}

export async function clearTrackedTelegramMessages(bot: Telegraf, chatId: string | number): Promise<void> {
  const prevIds = consumeTelegramBotMessageIds(chatId);
  for (const msgId of prevIds) {
    await deleteTelegramMessageSafely(bot, chatId, msgId);
  }
}

function createTelegrafTransport(bot: Telegraf, ctx: Context): TelegramReplyTransport {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  return {
    async reply(text: string, buttons?: TelegramInlineButton[][]) {
      const sent = await ctx.reply(text, toMarkupKeyboard(buttons));
      if (chatId && sent?.message_id) {
        recordTelegramBotMessageId(chatId, sent.message_id);
      }
    },
    async sendQris(caption: string, qris?: { qrString?: string; qrUrl?: string }, buttons?: TelegramInlineButton[][]) {
      if (!chatId) return null;
      const msgId = await sendTelegramQrisInvoice(bot, chatId, caption, qris, toMarkupKeyboard(buttons));
      if (msgId) {
        recordTelegramBotMessageId(chatId, msgId);
      }
      return msgId;
    },
  };
}

function friendlyName(username?: string | null): string {
  const clean = (username || '').trim();
  return clean ? `Halo Kak ${clean}` : 'Halo Kak';
}

function formatProductButtonLabel(name: string, sellingPrice: number): string {
  const priceText = `Rp${sellingPrice.toLocaleString('id-ID')}`;
  const maxNameLen = 38;
  const cleanName = name.trim();
  const shortName =
    cleanName.length > maxNameLen ? `${cleanName.slice(0, maxNameLen - 1).trimEnd()}…` : cleanName;
  return `${shortName} · ${priceText}`;
}

export async function sendTelegramMainMenu(
  transport: TelegramReplyTransport,
  userId: string,
  username?: string | null,
  dryRun?: boolean
): Promise<void> {
  clearBotSession('TELEGRAM', userId, dryRun);
  await transport.reply(
    `${friendlyName(username)}! Selamat datang di PPOB Bot Ecosystem — Layanan Pelanggan.\n` +
      `Silakan pilih menu lewat tombol praktis di bawah tanpa perlu mengetik perintah manual:`,
    TG_MAIN_MENU_BUTTONS
  );
}

export async function sendTelegramCategoryList(transport: TelegramReplyTransport): Promise<void> {
  const cats = listCategories(true);
  if (cats.length === 0) {
    await transport.reply(
      'Maaf Kak, belum ada kategori produk aktif saat ini. Silakan coba lagi nanti ya.',
      [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
    );
    return;
  }
  const shown = cats.slice(0, 12);
  const buttons: TelegramInlineButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    buttons.push(shown.slice(i, i + 2).map((c) => ({ text: c.name, callbackData: `CAT_${c.id}_1` })));
  }
  buttons.push([
    { text: 'Semua Produk', callbackData: 'PROD_PAGE_1' },
    { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
  ]);
  await transport.reply('Pilih kategori produk yang ingin Kakak lihat:', buttons);
}

export async function sendTelegramProductPage(
  transport: TelegramReplyTransport,
  params: { page: number; categoryId?: number; search?: string }
): Promise<void> {
  const res = listProducts({
    page: params.page,
    limit: 6,
    categoryId: params.categoryId,
    search: params.search,
    onlyActive: true,
  });

  if (res.items.length === 0) {
    await transport.reply(
      params.search
        ? `Maaf Kak, produk dengan kata kunci "${params.search}" belum ditemukan.`
        : 'Maaf Kak, belum ada produk aktif di halaman ini saat ini.',
      [
        [
          { text: 'Kategori Produk', callbackData: 'CAT_LIST' },
          { text: 'Semua Produk', callbackData: 'PROD_PAGE_1' },
        ],
        [{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }],
      ]
    );
    return;
  }

  const lines = res.items.map(
    (p, idx) => `${idx + 1}. ${p.name} — Rp${p.selling_price.toLocaleString('id-ID')}`
  );

  const buttons: TelegramInlineButton[][] = res.items.map((p) => {
    const skuCallback = `BUY_SKU_${p.sku}`;
    const callbackData = Buffer.byteLength(skuCallback, 'utf8') <= 64 ? skuCallback : `BUY_ID_${p.id}`;
    return [
      {
        text: formatProductButtonLabel(p.name, p.selling_price),
        callbackData,
      },
    ];
  });

  const navRow: TelegramInlineButton[] = [];
  if (params.page > 1) {
    navRow.push({
      text: 'Sebelumnya',
      callbackData: params.categoryId
        ? `CAT_${params.categoryId}_${params.page - 1}`
        : `PROD_PAGE_${params.page - 1}`,
    });
  }
  if (params.page < res.pagination.totalPages) {
    navRow.push({
      text: 'Berikutnya',
      callbackData: params.categoryId
        ? `CAT_${params.categoryId}_${params.page + 1}`
        : `PROD_PAGE_${params.page + 1}`,
    });
  }
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([
    { text: 'Kategori Lain', callbackData: 'CAT_LIST' },
    { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
  ]);

  await transport.reply(
    `Daftar Produk (Hal ${params.page}/${res.pagination.totalPages}):\n${lines.join('\n')}\n\n` +
      `Tap tombol produk di bawah untuk langsung memesan ya Kak!`,
    buttons
  );
}

export async function promptTelegramProductDestination(
  transport: TelegramReplyTransport,
  userId: string,
  skuOrId: string,
  dryRun?: boolean
): Promise<void> {
  const product = getProductBySkuOrId(skuOrId);
  if (!product || product.status !== 'ACTIVE' || product.is_available !== 1) {
    await transport.reply(
      `Maaf Kak, produk ${skuOrId} sedang tidak tersedia atau nonaktif.`,
      TG_NAV_BACK_BUTTONS
    );
    return;
  }

  setBotSession(
    'TELEGRAM',
    userId,
    {
      mode: 'AWAITING_DESTINATION',
      sku: product.sku,
      productName: product.name,
      sellingPrice: product.selling_price,
      updatedAt: Date.now(),
    },
    dryRun
  );

  await transport.reply(
    `Siap Kak! Anda memilih:\n` +
      `${product.name}\n` +
      `Harga: Rp${product.selling_price.toLocaleString('id-ID')}\n\n` +
      `Silakan kirimkan nomor tujuan / ID pelanggan Anda sekarang (contoh: 081234567890, atau tambahkan kode kupon setelah spasi).`,
    [
      [
        { text: 'Pilih Produk Lain', callbackData: 'PROD_PAGE_1' },
        { text: 'Batal / Menu Utama', callbackData: 'CANCEL_ORDER' },
      ],
    ]
  );
}

export async function executeTelegramOrder(
  transport: TelegramReplyTransport,
  params: {
    userId: string;
    username?: string | null;
    sku: string;
    destination: string;
    couponCode?: string | null;
    dryRun?: boolean;
  }
): Promise<void> {
  clearBotSession('TELEGRAM', params.userId, params.dryRun);
  const result = params.dryRun
    ? previewOrderDryRun({
        platform: 'TELEGRAM',
        platformUserId: params.userId,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: params.couponCode || null,
      })
    : await createOrder({
        platform: 'TELEGRAM',
        platformUserId: params.userId,
        platformUsername: params.username ?? null,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: params.couponCode || null,
      });

  if (!result.ok || !result.transaction) {
    if (result.activeInvoice) {
      const a = result.activeInvoice;
      await transport.reply(
        `Halo Kak, ${result.errorMessage}\n\nID: ${a.transaction_id}\nProduk: ${a.product_name_snapshot}\nNominal: Rp${a.payment_amount.toLocaleString('id-ID')}`,
        [
          [
            { text: 'Cek Status Invoice', callbackData: `STATUS_${a.transaction_id}` },
            { text: 'Batalkan Pesanan', callbackData: `CANCEL_TX_${a.transaction_id}` },
          ],
          [{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }],
        ]
      );
      return;
    }
    await transport.reply(
      `Maaf Kak, ${result.errorMessage || 'pesanan belum dapat diproses.'}`,
      TG_NAV_BACK_BUTTONS
    );
    return;
  }

  const tx = result.transaction;
  const caption =
    `Terima kasih Kak! Pesanan siap dibayar:\n\n` +
    `INVOICE PEMBAYARAN QRIS\n` +
    `ID: ${tx.transaction_id}\n` +
    `Produk: ${tx.product_name_snapshot}\n` +
    `Tujuan: ${maskDestination(tx.destination)}\n` +
    (tx.discount_snapshot > 0 ? `Diskon: -Rp${tx.discount_snapshot.toLocaleString('id-ID')}\n` : '') +
    `Kode Unik: ${tx.unique_code}\n` +
    `Total Bayar: Rp${tx.payment_amount.toLocaleString('id-ID')}\n` +
    `Kedaluwarsa: ${new Date(tx.expired_at!).toLocaleTimeString('id-ID')} (${config.transaction.invoiceExpiryMinutes} menit)\n\n` +
    `Scan QRIS dengan nominal TEPAT Rp${tx.payment_amount.toLocaleString('id-ID')} ya Kak.\n` +
    `(Pembatalan tersedia minimal 30 detik setelah pesanan dibuat)` +
    (params.dryRun ? `\n\n[Mode Demo: pratinjau invoice & QRIS, transaksi tidak disimpan ke database]` : '');

  const qrisButtons: TelegramInlineButton[][] = [
    [
      { text: 'Cek Status Pembayaran', callbackData: `STATUS_${tx.transaction_id}` },
      { text: 'Batalkan Pesanan', callbackData: `CANCEL_TX_${tx.transaction_id}` },
    ],
    [{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }],
  ];

  if (transport.sendQris) {
    const msgId = await transport.sendQris(caption, result.qris, qrisButtons);
    if (!params.dryRun && msgId) {
      saveQrMessageReference(tx.transaction_id, {
        platform: 'TELEGRAM',
        chatId: params.userId,
        messageId: msgId,
      });
    }
  } else {
    await transport.reply(caption, qrisButtons);
  }
}

export async function handleTelegramOrderCancellation(
  transport: TelegramReplyTransport,
  params: { userId: string; transactionId?: string; dryRun?: boolean }
): Promise<void> {
  if (params.dryRun) {
    await transport.reply(
      params.transactionId?.startsWith('TRX-DEMO-')
        ? `Pembatalan pesanan minimal dilakukan 30 detik setelah pesanan dibuat. (Mode Demo: transaksi ${params.transactionId} tidak tersimpan di database)`
        : '[Mode Demo] Simulasi pembatalan pesanan (minimal 30 detik setelah pesanan dibuat).',
      TG_NAV_BACK_BUTTONS
    );
    return;
  }

  const res = await cancelCustomerTransaction({
    platform: 'TELEGRAM',
    platformUserId: params.userId,
    transactionId: params.transactionId,
  });

  if (!res.ok) {
    const buttons: TelegramInlineButton[][] = res.transaction
      ? [
          [
            { text: 'Cek Status Pembayaran', callbackData: `STATUS_${res.transaction.transaction_id}` },
            { text: 'Coba Batalkan Lagi', callbackData: `CANCEL_TX_${res.transaction.transaction_id}` },
          ],
          [{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }],
        ]
      : TG_NAV_BACK_BUTTONS;
    await transport.reply(res.errorMessage || 'Maaf Kak, pesanan belum dapat dibatalkan.', buttons);
    return;
  }

  await transport.reply(
    `Pesanan ${res.transaction!.transaction_id} (${res.transaction!.product_name_snapshot}) telah DIBATALKAN.\n` +
      `Harap tunggu ${config.transaction.cooldownSeconds} detik sebelum membuat pesanan baru ya Kak.`,
    TG_NAV_BACK_BUTTONS
  );
}

export async function dispatchTelegramCommand(
  transport: TelegramReplyTransport,
  input: TelegramDispatchContext,
  options?: TelegramCommandOptions
): Promise<void> {
  const dryRun = Boolean(options?.dryRun);
  const trimmed = input.text.trim();
  if (!trimmed) return;

  const parts = trimmed.split(/\s+/);
  const rawHead = parts[0].toLowerCase();
  const isSlash = rawHead.startsWith('/');
  const cmd = rawHead.replace(/^\//, '').split('@')[0];
  const args = parts.slice(1);

  if (!isSlash) {
    const session = getBotSession('TELEGRAM', input.userId, dryRun);
    if (cmd === 'batal' || cmd === 'cancel') {
      if (session?.mode === 'AWAITING_DESTINATION' && !args[0]) {
        await sendTelegramMainMenu(transport, input.userId, input.username, dryRun);
        return;
      }
      await handleTelegramOrderCancellation(transport, {
        userId: input.userId,
        transactionId: args[0]?.trim(),
        dryRun,
      });
      return;
    }

    if (session?.mode === 'AWAITING_DESTINATION') {
      const [dest, coupon] = parts;
      await executeTelegramOrder(transport, {
        userId: input.userId,
        username: input.username,
        sku: session.sku,
        destination: dest,
        couponCode: coupon || null,
        dryRun,
      });
      return;
    }

    const sampleProduct = getProductBySkuOrId(trimmed);
    if (sampleProduct) {
      await promptTelegramProductDestination(transport, input.userId, sampleProduct.sku, dryRun);
      return;
    }

    await transport.reply(
      `${friendlyName(input.username)}! Maaf, saya belum memahami pesan "${trimmed}".\n` +
        `Kakak bisa langsung tekan tombol menu di bawah agar lebih mudah:`,
      TG_MAIN_MENU_BUTTONS
    );
    return;
  }

  if (cmd === 'batal' || cmd === 'cancel') {
    await handleTelegramOrderCancellation(transport, {
      userId: input.userId,
      transactionId: args[0]?.trim(),
      dryRun,
    });
    return;
  }

  if (cmd === 'start' || cmd === 'menu' || cmd === 'bantuan' || cmd === 'help') {
    if (cmd === 'bantuan' || cmd === 'help') {
      clearBotSession('TELEGRAM', input.userId, dryRun);
      await transport.reply(
        `Panduan Belanja Praktis:\n` +
          `1. Tekan tombol Daftar Produk atau Kategori Produk.\n` +
          `2. Pilih produk yang diinginkan, lalu kirim nomor tujuan.\n` +
          `3. Bayar QRIS sesuai nominal tepat sebelum batas waktu.\n` +
          `4. Pesanan yang belum dibayar dapat dibatalkan setelah minimal 30 detik.\n\n` +
          `Atau ketik langsung: /order <SKU> <TUJUAN> [KUPON] bila sudah hafal SKU.`,
        TG_MAIN_MENU_BUTTONS
      );
      return;
    }
    await sendTelegramMainMenu(transport, input.userId, input.username, dryRun);
    return;
  }

  if (cmd === 'kategori') {
    await sendTelegramCategoryList(transport);
    return;
  }

  if (cmd === 'produk') {
    const search = args.join(' ').trim() || undefined;
    await sendTelegramProductPage(transport, { page: 1, search });
    return;
  }

  if (cmd === 'order') {
    if (args.length < 2) {
      await transport.reply(
        'Supaya lebih mudah, Kakak bisa tap tombol Daftar Produk lalu pilih produk tanpa mengetik format manual.\n' +
          'Atau ketik: /order <SKU> <TUJUAN> [KUPON]',
        TG_NAV_BACK_BUTTONS
      );
      return;
    }
    const [sku, destination, couponCode] = args;
    await executeTelegramOrder(transport, {
      userId: input.userId,
      username: input.username,
      sku,
      destination,
      couponCode,
      dryRun,
    });
    return;
  }

  if (cmd === 'status') {
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: input.userId })
      : resolveOrCreateCustomer({
          platform: 'TELEGRAM',
          platformUserId: input.userId,
          platformUsername: input.username ?? null,
        });

    const txId = args[0]?.trim();
    if (txId) {
      const detail = resolved ? getTransactionDetail(txId) : null;
      if (!detail || !resolved || detail.transaction.customer_id !== resolved.customer.id) {
        await transport.reply('Maaf Kak, transaksi tersebut tidak ditemukan pada akun Anda.', TG_NAV_BACK_BUTTONS);
        return;
      }
      const t = detail.transaction;
      await transport.reply(
        `Status Transaksi ${t.transaction_id}\n` +
          `Produk: ${t.product_name_snapshot}\n` +
          `Tujuan: ${t.destination_masked}\n` +
          `Nominal: Rp${t.payment_amount.toLocaleString('id-ID')}\n` +
          `Status: ${t.transaction_status}` +
          (t.supplier_sn ? `\nSN / Token: ${t.supplier_sn}` : ''),
        TG_NAV_BACK_BUTTONS
      );
      return;
    }

    const recent = resolved ? getCustomerTransactions(resolved.customer.id, 1) : [];
    if (recent.length === 0) {
      await transport.reply(
        'Kakak belum memiliki riwayat transaksi saat ini. Yuk lihat daftar produk kami!',
        TG_NAV_BACK_BUTTONS
      );
      return;
    }
    const latest = recent[0];
    await transport.reply(
      `Transaksi Terakhir (${latest.transaction_id})\n` +
        `Produk: ${latest.product_name_snapshot}\n` +
        `Nominal: Rp${latest.payment_amount.toLocaleString('id-ID')}\n` +
        `Status: ${latest.transaction_status}`,
      [
        [
          { text: 'Riwayat Lengkap', callbackData: 'MY_HISTORY' },
          { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
        ],
      ]
    );
    return;
  }

  if (cmd === 'riwayat') {
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: input.userId })
      : resolveOrCreateCustomer({
          platform: 'TELEGRAM',
          platformUserId: input.userId,
          platformUsername: input.username ?? null,
        });
    if (!resolved) {
      await transport.reply(
        `Riwayat Transaksi\nKredit Refund Internal: Rp0\n\nBelum ada riwayat transaksi ya Kak.`,
        TG_NAV_BACK_BUTTONS
      );
      return;
    }
    const { customer } = resolved;
    const txs = getCustomerTransactions(customer.id, 5);
    const refundTotal = getCustomerRefundCreditTotal(customer.id);
    const lines = txs.map(
      (t) => `• ${t.transaction_id} — ${t.product_name_snapshot} (Rp${t.payment_amount.toLocaleString('id-ID')}) [${t.transaction_status}]`
    );

    await transport.reply(
      `Riwayat Transaksi (${customer.customer_code})\n` +
        `Kredit Refund Internal: Rp${refundTotal.toLocaleString('id-ID')}\n\n` +
        (lines.length > 0 ? lines.join('\n') : 'Belum ada riwayat transaksi ya Kak.'),
      TG_NAV_BACK_BUTTONS
    );
    return;
  }

  if (cmd === 'hubungkan') {
    const code = args[0]?.trim();
    if (dryRun) {
      await transport.reply(
        code
          ? `[Mode Demo] Simulasi verifikasi kode hubung "${code}" — tidak menautkan akun nyata.`
          : `Kode Penghubung Akun (Simulasi Demo, berlaku ${config.accountLinking.codeExpiryMinutes} menit):\n\n` +
              `hubungkan DEMO-123456\n\n` +
              `Kirim perintah di atas ke Bot WhatsApp kami.\n[Mode Demo: token tidak dibuat di database]`,
        [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
      );
      return;
    }
    if (!code) {
      const res = requestAccountLinkCode({
        platform: 'TELEGRAM',
        platformUserId: input.userId,
        platformUsername: input.username ?? null,
      });
      if (!res.ok) {
        await transport.reply(
          res.errorMessage || 'Maaf Kak, gagal membuat kode penghubung.',
          [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
        );
        return;
      }
      await transport.reply(
        `Kode Penghubung Akun (berlaku ${config.accountLinking.codeExpiryMinutes} menit):\n\n` +
          `hubungkan ${res.code}\n\n` +
          `Kirim perintah di atas ke Bot WhatsApp kami. Jangan bagikan kode ini kepada siapa pun ya Kak.`,
        [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
      );
      return;
    }

    const verify = verifyAndLinkAccount({
      targetPlatform: 'TELEGRAM',
      targetPlatformUserId: input.userId,
      targetPlatformUsername: input.username ?? null,
      rawCode: code,
    });

    await transport.reply(
      verify.ok
        ? `Yeay! Akun Telegram Kakak berhasil dihubungkan ke akun ${verify.customerCode}.`
        : verify.errorMessage || 'Maaf Kak, gagal menghubungkan akun.',
      [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
    );
    return;
  }

  if (cmd === 'unlink') {
    if (dryRun) {
      await transport.reply(
        '[Mode Demo] Simulasi unlink Telegram — identitas nyata tidak diubah.',
        [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
      );
      return;
    }
    const res = unlinkPlatformIdentity({
      platform: 'TELEGRAM',
      platformUserId: input.userId,
    });
    await transport.reply(
      res.ok ? 'Identitas Telegram berhasil di-unlink.' : res.errorMessage || 'Maaf, gagal unlink.',
      [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
    );
    return;
  }

  // Admin Commands — Verified strictly by Telegram numeric ctx.from.id + backend RBAC (or demoAdmin in Demo mode)
  const resolveAdmin = (): ResolvedAdmin | null =>
    dryRun
      ? options?.demoAdmin
        ? {
            id: 0,
            name: 'Demo Admin',
            role: options.demoAdmin.role,
            permissions: getEffectivePermissions(options.demoAdmin.role, []),
            platformUserId: options.demoAdmin.platformUserId,
          }
        : null
      : resolveAdminByPlatform('TELEGRAM', input.userId);

  if (cmd === 'admin') {
    const admin = resolveAdmin();
    if (!admin) {
      await transport.reply(
        'Maaf, akses ditolak karena akun Anda tidak terdaftar sebagai admin.',
        [[{ text: 'Buka Menu Pelanggan', callbackData: 'MAIN_MENU' }]]
      );
      return;
    }
    await transport.reply(
      `Panel Admin Telegram (${admin.role})\n` +
        `Halo Admin, pilih menu cepat di bawah atau ketik perintah:\n\n` +
        `/transaksi [halaman] — Ringkasan & riwayat transaksi\n` +
        `/riwayat_hari_ini — Riwayat transaksi hari ini\n` +
        `/cari <TRX_ID> — Cari detail transaksi\n` +
        `/status_bot — Status layanan & scheduler\n` +
        `/maintenance on|off — Ubah maintenance mode`,
      TG_ADMIN_MENU_BUTTONS
    );
    return;
  }

  if (cmd === 'transaksi') {
    const admin = resolveAdmin();
    if (!admin || !checkAdminPermission(admin, 'transactions:read')) {
      await transport.reply('Maaf, akses ditolak.', [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]);
      return;
    }
    const page = Number(args[0]) || 1;
    const report = getAdminBotTransactionReport({
      actorId: admin.platformUserId,
      actorRole: admin.role,
      page,
      limit: 5,
    });
    const lines = report.items.map(
      (i) => `• ${i.transaction_id} | ${i.product_name_snapshot} | Rp${i.payment_amount.toLocaleString('id-ID')} | ${i.transaction_status}`
    );
    await transport.reply(
      `Ringkasan Transaksi (Hal ${report.page}/${report.totalPages})\n` +
        `Total: ${report.summary.totalCount} | Sukses: ${report.summary.successCount} | Pending: ${report.summary.pendingCount} | Gagal: ${report.summary.failedCount} | Expired: ${report.summary.expiredCount}\n` +
        `Omzet: Rp${report.summary.totalAmount.toLocaleString('id-ID')}\n\n` +
        (lines.length > 0 ? lines.join('\n') : 'Belum ada transaksi.'),
      TG_ADMIN_MENU_BUTTONS
    );
    return;
  }

  if (cmd === 'riwayat_hari_ini') {
    const admin = resolveAdmin();
    if (!admin || !checkAdminPermission(admin, 'transactions:read')) {
      await transport.reply('Maaf, akses ditolak.');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const report = getAdminBotTransactionReport({
      actorId: admin.platformUserId,
      actorRole: admin.role,
      date: today,
      page: 1,
      limit: 8,
    });
    const lines = report.items.map(
      (i) => `• ${i.transaction_id} | Rp${i.payment_amount.toLocaleString('id-ID')} | ${i.transaction_status}`
    );
    await transport.reply(
      `Transaksi Hari Ini (${today})\n` +
        `Total: ${report.summary.totalCount} | Sukses: ${report.summary.successCount} | Pending: ${report.summary.pendingCount}\n\n` +
        (lines.length > 0 ? lines.join('\n') : 'Belum ada transaksi hari ini.'),
      TG_ADMIN_MENU_BUTTONS
    );
    return;
  }

  if (cmd === 'cari') {
    const admin = resolveAdmin();
    if (!admin || !checkAdminPermission(admin, 'transactions:read')) {
      await transport.reply('Maaf, akses ditolak.');
      return;
    }
    const txId = args[0]?.trim();
    if (!txId) {
      await transport.reply('Silakan sertakan ID transaksi: /cari <TRANSACTION_ID>');
      return;
    }
    const detail = getTransactionDetail(txId);
    if (!detail) {
      await transport.reply(`Transaksi ${txId} tidak ditemukan.`, TG_ADMIN_MENU_BUTTONS);
      return;
    }
    const t = detail.transaction;
    await transport.reply(
      `Detail ${t.transaction_id}\n` +
        `Pelanggan: ${t.customer_code}\n` +
        `Produk: ${t.product_name_snapshot} (${t.product_sku_snapshot})\n` +
        `Tujuan: ${t.destination_masked}\n` +
        `Nominal: Rp${t.payment_amount.toLocaleString('id-ID')}\n` +
        `Status: ${t.transaction_status}\n` +
        `Pembayaran: ${t.payment_status} | Supplier: ${t.supplier_status}\n` +
        `Ref Gateway: ${t.gateway_reference || '-'}\n` +
        `Ref Supplier: ${t.supplier_reference || '-'}`,
      TG_ADMIN_MENU_BUTTONS
    );
    return;
  }

  if (cmd === 'status_bot') {
    const admin = resolveAdmin();
    if (!admin || !checkAdminPermission(admin, 'bots:read')) {
      await transport.reply('Maaf, akses ditolak.');
      return;
    }
    const sched = centralScheduler.getStatus();
    await transport.reply(
      `Status Layanan PPOB\n` +
        `Maintenance Mode: ${isMaintenanceMode() ? 'AKTIF' : 'NONAKTIF'}\n` +
        `Scheduler: ${sched.running ? 'RUNNING' : 'STOPPED'}\n` +
        `Last Payment Poll: ${sched.lastPaymentPollAt || '-'}\n` +
        `Last Supplier Poll: ${sched.lastSupplierPollAt || '-'}`,
      TG_ADMIN_MENU_BUTTONS
    );
    return;
  }

  if (cmd === 'maintenance') {
    const admin = resolveAdmin();
    if (!admin || !checkAdminPermission(admin, 'maintenance:toggle')) {
      await transport.reply('Maaf, akses ditolak.');
      return;
    }
    const val = args[0]?.toLowerCase();
    if (val !== 'on' && val !== 'off') {
      await transport.reply('Gunakan: /maintenance on atau /maintenance off', TG_ADMIN_MENU_BUTTONS);
      return;
    }
    const next = val === 'on';
    if (dryRun) {
      await transport.reply(
        `[Mode Demo] Maintenance mode akan diubah menjadi: ${next ? 'AKTIF' : 'NONAKTIF'} (tidak mengubah status server aktif).`,
        TG_ADMIN_MENU_BUTTONS
      );
      return;
    }
    setMaintenanceMode(next, { id: `TG:${admin.platformUserId}`, role: admin.role }, 'Perintah Telegram Admin');
    await transport.reply(`Maintenance mode berhasil diubah: ${next ? 'AKTIF' : 'NONAKTIF'}.`, TG_ADMIN_MENU_BUTTONS);
    return;
  }

  await transport.reply(
    `${friendlyName(input.username)}! Maaf, perintah "${trimmed}" belum tersedia.\n` +
      `Silakan gunakan tombol menu di bawah ini:`,
    TG_MAIN_MENU_BUTTONS
  );
}

export function registerTelegramCommands(bot: Telegraf): void {
  bot.use(async (ctx, next) => {
    if (ctx.from && !checkTgRateLimit(ctx.from.id)) {
      await ctx.reply('Mohon tunggu beberapa saat ya Kak, permintaan terlalu cepat.');
      return;
    }
    return next();
  });

  const handleWithCtx = async (ctx: Context) => {
    if (!ctx.from) return;
    const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') || '';
    if (!text.trim()) return;
    const chatId = ctx.chat?.id ?? ctx.from.id;
    if (chatId) {
      await clearTrackedTelegramMessages(bot, chatId);
    }
    await dispatchTelegramCommand(createTelegrafTransport(bot, ctx), {
      userId: String(ctx.from.id),
      username: ctx.from.username || ctx.from.first_name || null,
      text,
    });
  };

  bot.command(
    [
      'start',
      'menu',
      'bantuan',
      'help',
      'kategori',
      'produk',
      'order',
      'batal',
      'cancel',
      'status',
      'riwayat',
      'hubungkan',
      'unlink',
      'admin',
      'transaksi',
      'riwayat_hari_ini',
      'cari',
      'status_bot',
      'maintenance',
    ],
    handleWithCtx
  );

  // Fallback for unrecognized commands/text
  bot.on('text', handleWithCtx);
}
