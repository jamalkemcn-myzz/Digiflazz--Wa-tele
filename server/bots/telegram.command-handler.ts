import { Markup, type Telegraf, type Context } from 'telegraf';
import { getEffectivePermissions, type AdminRole } from '../domain/rbac';
import { config } from '../config/env';
import { maskDestination } from '../domain/masking';
import {
  listCategories,
  getCategoryById,
  listActiveBrandsInCategory,
  listProducts,
  getProductBySkuOrId,
} from '../services/product.service';
import {
  detectOperatorFromPhone,
  matchBrandForDetectedOperator,
  isTelecomCategoryName,
} from '../domain/operator-prefix';
import {
  resolveOrCreateCustomer,
  findCustomerByPlatform,
  requestAccountLinkCode,
  verifyAndLinkAccount,
  unlinkPlatformIdentity,
  getCustomerRefundCreditTotal,
  getCustomerProfileSummary,
  getTotalBotUsersCount,
} from '../services/customer.service';
import { previewVoucherRedeem } from '../services/coupon.service';
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
  clearPendingVoucher,
  consumeTelegramBotMessageIds,
  getBotSession,
  getPendingVoucher,
  recordTelegramBotMessageId,
  setBotSession,
  setPendingVoucher,
} from './bot-session';
import {
  formatContactAdminMessage,
  formatProfileMessage,
  formatStartMessage,
  formatVoucherPromptMessage,
  formatVoucherSuccessMessage,
  resolveDisplayName,
} from './bot-messages';

export interface TelegramInlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TelegramReplyTransport {
  reply(text: string, buttons?: TelegramInlineButton[][]): Promise<void>;
  sendQris?(caption: string, qris?: { qrString?: string; qrUrl?: string }, buttons?: TelegramInlineButton[][]): Promise<number | null>;
  answerCbQuery?(text?: string, showAlert?: boolean): Promise<void>;
  deleteSourceMessage?(): Promise<void>;
}

export interface TelegramDispatchContext {
  userId: string;
  username?: string | null;
  displayName?: string | null;
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
    { text: 'Profil & Saldo', callbackData: 'MY_PROFILE' },
    { text: 'Redeem Voucher', callbackData: 'REDEEM_VOUCHER' },
  ],
  [
    { text: 'Riwayat Transaksi', callbackData: 'MY_HISTORY' },
    { text: 'Hubungi Admin', callbackData: 'CONTACT_ADMIN' },
  ],
];

export function getTelegramAdminProfileUrl(cfg = config): string | null {
  const cleanUsername = (cfg.auth.ownerTelegramUsername || '').replace(/^@+/, '').trim();
  if (cleanUsername && /^[a-zA-Z0-9_]{3,64}$/.test(cleanUsername)) {
    return `https://t.me/${cleanUsername}`;
  }
  const cleanId = (cfg.auth.ownerTelegramId || '').trim();
  if (cleanId && /^\d{4,20}$/.test(cleanId)) {
    return `tg://user?id=${cleanId}`;
  }
  return null;
}

export function getTelegramMainMenuButtons(cfg = config): TelegramInlineButton[][] {
  const adminUrl = getTelegramAdminProfileUrl(cfg);
  return [
    [
      { text: 'Kategori Produk', callbackData: 'CAT_LIST' },
      { text: 'Daftar Produk', callbackData: 'PROD_PAGE_1' },
    ],
    [
      { text: 'Profil & Saldo', callbackData: 'MY_PROFILE' },
      { text: 'Redeem Voucher', callbackData: 'REDEEM_VOUCHER' },
    ],
    [
      { text: 'Riwayat Transaksi', callbackData: 'MY_HISTORY' },
      adminUrl
        ? { text: 'Hubungi Admin', url: adminUrl }
        : { text: 'Hubungi Admin', callbackData: 'CONTACT_ADMIN' },
    ],
  ];
}

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

const MAX_TG_RATE_ENTRIES = 1500;
const tgRateMap = new Map<number, { count: number; resetAt: number }>();

export function pruneTelegramRateLimits(now = Date.now()): number {
  let evicted = 0;
  for (const [userId, entry] of tgRateMap) {
    if (now > entry.resetAt) {
      tgRateMap.delete(userId);
      evicted++;
    }
  }
  return evicted;
}

function checkTgRateLimit(userId: number, max = 25, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = tgRateMap.get(userId);
  if (!entry || now > entry.resetAt) {
    if (tgRateMap.size >= MAX_TG_RATE_ENTRIES) {
      pruneTelegramRateLimits(now);
      if (tgRateMap.size >= MAX_TG_RATE_ENTRIES) {
        const excess = tgRateMap.size - MAX_TG_RATE_ENTRIES + 1;
        let removed = 0;
        for (const k of tgRateMap.keys()) {
          tgRateMap.delete(k);
          removed++;
          if (removed >= excess) break;
        }
      }
    }
    tgRateMap.delete(userId);
    tgRateMap.set(userId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

export function toMarkupKeyboard(buttons?: TelegramInlineButton[][]) {
  if (!buttons || buttons.length === 0) return undefined;
  return Markup.inlineKeyboard(
    buttons.map((row) =>
      row.map((b) =>
        b.url
          ? Markup.button.url(b.text, b.url)
          : Markup.button.callback(b.text, b.callbackData || 'MAIN_MENU')
      )
    )
  );
}

export function buildBrandCallbackData(
  categoryId: number,
  brand: string,
  brandIndex: number,
  page = 1
): string {
  const direct = `CATBR_${categoryId}_${page}_${brand}`;
  return Buffer.byteLength(direct, 'utf8') <= 64 ? direct : `CATBI_${categoryId}_${brandIndex}_${page}`;
}

export async function clearTrackedTelegramMessages(bot: Telegraf, chatId: string | number): Promise<void> {
  const prevIds = consumeTelegramBotMessageIds(chatId);
  if (prevIds.length === 0) return;
  await Promise.allSettled(prevIds.map((msgId) => deleteTelegramMessageSafely(bot, chatId, msgId)));
}

export function toTelegramHtml(raw: string): string {
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/\*([^\n*]+)\*/g, '<b>$1</b>');
}

function createTelegrafTransport(bot: Telegraf, ctx: Context): TelegramReplyTransport {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  return {
    async reply(text: string, buttons?: TelegramInlineButton[][]) {
      const keyboard = toMarkupKeyboard(buttons);
      let sent;
      try {
        sent = await ctx.reply(toTelegramHtml(text), {
          parse_mode: 'HTML',
          ...(keyboard ?? {}),
        });
      } catch {
        sent = await ctx.reply(text, keyboard);
      }
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

function friendlyName(displayName?: string | null, username?: string | null): string {
  const clean = resolveDisplayName(displayName, username, '');
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
  dryRun?: boolean,
  displayName?: string | null,
  demoAdmin?: { role: AdminRole; platformUserId: string } | null
): Promise<void> {
  clearBotSession('TELEGRAM', userId, dryRun);
  const summary = getCustomerProfileSummary({
    platform: 'TELEGRAM',
    platformUserId: userId,
    platformUsername: username ?? null,
    displayName: displayName ?? null,
    dryRun,
  });
  const totalUsers = getTotalBotUsersCount();
  const isAdmin = dryRun ? Boolean(demoAdmin) : Boolean(resolveAdminByPlatform('TELEGRAM', userId));

  await transport.reply(
    formatStartMessage({
      displayName,
      username,
      shopName: config.shopName,
      userId: summary.userId,
      isAdmin,
      totalUsers,
    }),
    getTelegramMainMenuButtons()
  );
}

export async function sendTelegramProfile(
  transport: TelegramReplyTransport,
  params: { userId: string; displayName?: string | null; username?: string | null; dryRun?: boolean }
): Promise<void> {
  clearBotSession('TELEGRAM', params.userId, params.dryRun);
  const summary = getCustomerProfileSummary({
    platform: 'TELEGRAM',
    platformUserId: params.userId,
    platformUsername: params.username ?? null,
    displayName: params.displayName ?? null,
    dryRun: params.dryRun,
  });
  await transport.reply(formatProfileMessage(summary, config.timezone), [
    [
      { text: 'Daftar Produk', callbackData: 'PROD_PAGE_1' },
      { text: 'Riwayat Transaksi', callbackData: 'MY_HISTORY' },
    ],
    [{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }],
  ]);
}

export async function sendTelegramContactAdmin(transport: TelegramReplyTransport): Promise<void> {
  const adminUrl = getTelegramAdminProfileUrl();
  const rows: TelegramInlineButton[][] = [];
  if (adminUrl) {
    rows.push([{ text: 'Chat Admin Telegram', url: adminUrl }]);
  }
  rows.push([
    { text: 'Riwayat Transaksi', callbackData: 'MY_HISTORY' },
    { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
  ]);
  await transport.reply(formatContactAdminMessage(config), rows);
}

export async function handleTelegramVoucherCommand(
  transport: TelegramReplyTransport,
  params: { userId: string; username?: string | null; code?: string | null; dryRun?: boolean }
): Promise<void> {
  const activeVoucher = getPendingVoucher('TELEGRAM', params.userId, params.dryRun);
  const code = (params.code || '').trim();
  if (!code) {
    setBotSession(
      'TELEGRAM',
      params.userId,
      { mode: 'AWAITING_VOUCHER_CODE', updatedAt: Date.now() },
      params.dryRun
    );
    await transport.reply(formatVoucherPromptMessage('TELEGRAM', activeVoucher), [
      [{ text: 'Batal / Menu Utama', callbackData: 'MAIN_MENU' }],
    ]);
    return;
  }

  clearBotSession('TELEGRAM', params.userId, params.dryRun);
  const resolved = findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: params.userId });
  const check = previewVoucherRedeem({
    code,
    customerId: resolved?.customer.id ?? null,
  });

  if (!check.ok || !check.coupon) {
    await transport.reply(
      `Maaf Kak, ${check.errorMessage || 'kode voucher tidak valid.'}`,
      [
        [
          { text: 'Coba Lagi', callbackData: 'REDEEM_VOUCHER' },
          { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
        ],
      ]
    );
    return;
  }

  setPendingVoucher('TELEGRAM', params.userId, check.coupon.code, params.dryRun);
  await transport.reply(formatVoucherSuccessMessage(check.coupon, config.timezone), [
    [
      { text: 'Daftar Produk', callbackData: 'PROD_PAGE_1' },
      { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
    ],
  ]);
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
    { text: 'Cari Produk', callbackData: 'CARI_PRODUK' },
    { text: 'Semua Produk', callbackData: 'PROD_PAGE_1' },
  ]);
  buttons.push([{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]);
  await transport.reply('Pilih kategori produk yang ingin Kakak lihat:', buttons);
}

function buildBrandPickerButtons(
  categoryId: number,
  brands: Array<{ brand: string; productCount: number }>
): TelegramInlineButton[][] {
  const shown = brands.slice(0, 16);
  const buttons: TelegramInlineButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    buttons.push(
      shown.slice(i, i + 2).map((b, offset) => ({
        text: `${b.brand} (${b.productCount})`,
        callbackData: buildBrandCallbackData(categoryId, b.brand, i + offset, 1),
      }))
    );
  }
  buttons.push([
    { text: 'Cari Produk', callbackData: 'CARI_PRODUK' },
    { text: 'Kategori Lain', callbackData: 'CAT_LIST' },
  ]);
  buttons.push([{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]);
  return buttons;
}

export async function sendTelegramCategorySelection(
  transport: TelegramReplyTransport,
  params: { userId: string; categoryId: number; dryRun?: boolean }
): Promise<void> {
  const cat = getCategoryById(params.categoryId);
  const brands = listActiveBrandsInCategory(params.categoryId);

  if (brands.length <= 1) {
    await sendTelegramProductPage(transport, {
      page: 1,
      categoryId: params.categoryId,
      brand: brands[0]?.brand,
      userId: params.userId,
      dryRun: params.dryRun,
    });
    return;
  }

  const brandNames = brands.map((b) => b.brand);
  const existingSession = getBotSession('TELEGRAM', params.userId, params.dryRun);
  const preservedDestination =
    existingSession?.mode === 'BRAND_LIST' || existingSession?.mode === 'PRODUCT_LIST'
      ? existingSession.detectedDestination
      : undefined;

  setBotSession(
    'TELEGRAM',
    params.userId,
    {
      mode: 'BRAND_LIST',
      categoryId: params.categoryId,
      categoryName: cat?.name || 'Produk',
      brands: brandNames,
      detectedDestination: preservedDestination,
      updatedAt: Date.now(),
    },
    params.dryRun
  );

  const isTelecom = isTelecomCategoryName(cat?.name);
  const msg = isTelecom
    ? `Kategori: *${cat?.name || 'Produk'}*\n\n` +
      `Kirim *nomor HP tujuan* sekarang untuk deteksi operator otomatis (contoh: 081812345678), atau pilih operator/brand di bawah:`
    : `Kategori: *${cat?.name || 'Produk'}*\n\nPilih brand / layanan yang ingin Kakak lihat:`;

  await transport.reply(msg, buildBrandPickerButtons(params.categoryId, brands));
}

export async function promptTelegramSearch(
  transport: TelegramReplyTransport,
  params: { userId: string; categoryId?: number; dryRun?: boolean }
): Promise<void> {
  setBotSession(
    'TELEGRAM',
    params.userId,
    {
      mode: 'AWAITING_SEARCH_QUERY',
      categoryId: params.categoryId,
      updatedAt: Date.now(),
    },
    params.dryRun
  );
  await transport.reply(
    `Ketik kata kunci produk atau nominal yang ingin dicari (contoh: xl 10, telkomsel, ml 86, pln 50):`,
    [
      [
        { text: 'Kategori Produk', callbackData: 'CAT_LIST' },
        { text: 'Batal / Menu Utama', callbackData: 'MAIN_MENU' },
      ],
    ]
  );
}

export async function sendTelegramProductPage(
  transport: TelegramReplyTransport,
  params: {
    page: number;
    categoryId?: number;
    brand?: string;
    search?: string;
    detectedDestination?: string;
    detectedOperatorLabel?: string;
    userId?: string;
    dryRun?: boolean;
  }
): Promise<void> {
  const res = listProducts({
    page: params.page,
    limit: 6,
    categoryId: params.categoryId,
    brand: params.brand,
    search: params.search,
    onlyActive: true,
    sortBy: 'PRICE_ASC',
  });

  if (res.items.length === 0) {
    await transport.reply(
      params.search
        ? `Maaf Kak, produk dengan kata kunci "${params.search}" belum ditemukan.`
        : 'Maaf Kak, belum ada produk aktif di halaman ini saat ini.',
      [
        [
          { text: 'Cari Lagi', callbackData: 'CARI_PRODUK' },
          { text: 'Kategori Produk', callbackData: 'CAT_LIST' },
        ],
        [
          { text: 'Semua Produk', callbackData: 'PROD_PAGE_1' },
          { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
        ],
      ]
    );
    return;
  }

  if (params.userId) {
    setBotSession(
      'TELEGRAM',
      params.userId,
      {
        mode: 'PRODUCT_LIST',
        skus: res.items.map((p) => p.sku),
        page: params.page,
        categoryId: params.categoryId,
        brand: params.brand,
        detectedDestination: params.detectedDestination,
        updatedAt: Date.now(),
      },
      params.dryRun
    );
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

  const brandIndex =
    params.categoryId && params.brand
      ? listActiveBrandsInCategory(params.categoryId).findIndex(
          (b) => b.brand.toUpperCase() === params.brand!.toUpperCase()
        )
      : -1;

  const makePageCallback = (targetPage: number) => {
    if (params.categoryId && params.brand) {
      return buildBrandCallbackData(
        params.categoryId,
        params.brand,
        Math.max(0, brandIndex),
        targetPage
      );
    }
    if (params.categoryId) {
      return `CAT_${params.categoryId}_${targetPage}`;
    }
    return `PROD_PAGE_${targetPage}`;
  };

  const navRow: TelegramInlineButton[] = [];
  if (params.page > 1) {
    navRow.push({
      text: 'Sebelumnya',
      callbackData: makePageCallback(params.page - 1),
    });
  }
  if (params.page < res.pagination.totalPages) {
    navRow.push({
      text: 'Berikutnya',
      callbackData: makePageCallback(params.page + 1),
    });
  }
  if (navRow.length > 0) buttons.push(navRow);

  if (params.categoryId && params.brand) {
    buttons.push([
      { text: 'Ganti Operator / Brand', callbackData: `CAT_${params.categoryId}_1` },
      { text: 'Cari Produk', callbackData: 'CARI_PRODUK' },
    ]);
    buttons.push([
      { text: 'Kategori Lain', callbackData: 'CAT_LIST' },
      { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
    ]);
  } else {
    buttons.push([
      { text: 'Cari Produk', callbackData: 'CARI_PRODUK' },
      { text: 'Kategori Lain', callbackData: 'CAT_LIST' },
    ]);
    buttons.push([{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]);
  }

  let header: string;
  if (params.detectedDestination) {
    header =
      `Nomor *${params.detectedDestination}* terdeteksi operator *${params.brand || params.detectedOperatorLabel}* (Hal ${params.page}/${res.pagination.totalPages}):\n` +
      `${lines.join('\n')}\n\n` +
      `Tap produk di bawah untuk langsung lanjut konfirmasi pesanan ya Kak!`;
  } else if (params.brand) {
    header =
      `Daftar *${params.brand}* (Hal ${params.page}/${res.pagination.totalPages}):\n` +
      `${lines.join('\n')}\n\n` +
      `Tap tombol produk di bawah untuk langsung memesan ya Kak!`;
  } else {
    header =
      `Daftar Produk (Hal ${params.page}/${res.pagination.totalPages}):\n` +
      `${lines.join('\n')}\n\n` +
      `Tap tombol produk di bawah untuk langsung memesan ya Kak!`;
  }

  await transport.reply(header, buttons);
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

export async function promptTelegramOrderConfirmation(
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
  const resolvedCoupon =
    params.couponCode?.trim() || getPendingVoucher('TELEGRAM', params.userId, params.dryRun) || null;
  const preview = previewOrderDryRun({
    platform: 'TELEGRAM',
    platformUserId: params.userId,
    productSkuOrId: params.sku,
    destination: params.destination,
    couponCode: resolvedCoupon,
  });

  if (!preview.ok || !preview.transaction) {
    clearBotSession('TELEGRAM', params.userId, params.dryRun);
    await transport.reply(
      `Maaf Kak, ${preview.errorMessage || 'pesanan belum dapat diproses.'}`,
      TG_NAV_BACK_BUTTONS
    );
    return;
  }

  const p = preview.transaction;
  const sellingPrice = p.supplier_price_snapshot + p.margin_snapshot;

  setBotSession(
    'TELEGRAM',
    params.userId,
    {
      mode: 'AWAITING_ORDER_CONFIRMATION',
      sku: p.product_sku_snapshot,
      productName: p.product_name_snapshot,
      sellingPrice,
      discountAmount: p.discount_snapshot,
      estimatedTotal: p.payment_amount,
      destination: params.destination.trim(),
      couponCode: p.coupon_code_snapshot,
      updatedAt: Date.now(),
    },
    params.dryRun
  );

  await transport.reply(
    `Konfirmasi Pesanan Anda\n\n` +
      `Produk: ${p.product_name_snapshot}\n` +
      `Tujuan: ${params.destination.trim()}\n` +
      `Harga: Rp${sellingPrice.toLocaleString('id-ID')}\n` +
      (p.coupon_code_snapshot ? `Kupon: ${p.coupon_code_snapshot} (-Rp${p.discount_snapshot.toLocaleString('id-ID')})\n` : '') +
      `Estimasi Total (+ Kode Unik): Rp${p.payment_amount.toLocaleString('id-ID')}\n\n` +
      `Apakah Anda yakin ingin membuat invoice QRIS sekarang?`,
    [
      [
        { text: 'Ya, Buat QRIS', callbackData: 'CONFIRM_ORDER' },
        { text: 'Batal', callbackData: 'CANCEL_CONFIRM_ORDER' },
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
  const resolvedCoupon =
    params.couponCode?.trim() || getPendingVoucher('TELEGRAM', params.userId, params.dryRun) || null;
  if (resolvedCoupon) {
    clearPendingVoucher('TELEGRAM', params.userId, params.dryRun);
  }
  const result = params.dryRun
    ? previewOrderDryRun({
        platform: 'TELEGRAM',
        platformUserId: params.userId,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: resolvedCoupon,
      })
    : await createOrder({
        platform: 'TELEGRAM',
        platformUserId: params.userId,
        platformUsername: params.username ?? null,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: resolvedCoupon,
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
  const originalPaymentUrl =
    result.qris?.qrUrl && !result.qris.qrUrl.startsWith('data:') ? result.qris.qrUrl : undefined;
  const caption =
    `Terima kasih Kak! Pesanan siap dibayar:\n\n` +
    `INVOICE PEMBAYARAN QRIS\n` +
    `ID: ${tx.transaction_id}\n` +
    `Produk: ${tx.product_name_snapshot}\n` +
    `Tujuan: ${maskDestination(tx.destination)}\n` +
    (tx.discount_snapshot > 0 ? `Diskon: -Rp${tx.discount_snapshot.toLocaleString('id-ID')}\n` : '') +
    `Kode Unik: ${tx.unique_code}\n` +
    `Total Bayar: Rp${tx.payment_amount.toLocaleString('id-ID')}\n` +
    (originalPaymentUrl ? `Link Pembayaran: ${originalPaymentUrl}\n` : '') +
    `Kedaluwarsa: ${new Date(tx.expired_at!).toLocaleTimeString('id-ID')} (${config.transaction.invoiceExpiryMinutes} menit)\n\n` +
    `Scan QRIS atau klik Link Pembayaran di atas dengan nominal TEPAT Rp${tx.payment_amount.toLocaleString('id-ID')} ya Kak.\n` +
    `Ketik /batal atau tekan Batalkan Pesanan untuk membatalkan (minimal 30 detik setelah pesanan dibuat).` +
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
      if (session?.mode === 'AWAITING_ORDER_CONFIRMATION' && !args[0]) {
        clearBotSession('TELEGRAM', input.userId, dryRun);
        await transport.reply('Pembuatan pesanan dibatalkan sebelum QRIS dibuat.', TG_NAV_BACK_BUTTONS);
        return;
      }
      if (
        (session?.mode === 'AWAITING_DESTINATION' ||
          session?.mode === 'AWAITING_VOUCHER_CODE' ||
          session?.mode === 'BRAND_LIST' ||
          session?.mode === 'AWAITING_SEARCH_QUERY') &&
        !args[0]
      ) {
        await sendTelegramMainMenu(
          transport,
          input.userId,
          input.username,
          dryRun,
          input.displayName,
          options?.demoAdmin
        );
        return;
      }
      await handleTelegramOrderCancellation(transport, {
        userId: input.userId,
        transactionId: args[0]?.trim(),
        dryRun,
      });
      return;
    }

    if (session?.mode === 'AWAITING_ORDER_CONFIRMATION') {
      if (['ya', 'iya', 'ok', 'oke', 'lanjut', 'konfirmasi', 'y'].includes(cmd)) {
        await executeTelegramOrder(transport, {
          userId: input.userId,
          username: input.username,
          sku: session.sku,
          destination: session.destination,
          couponCode: session.couponCode || null,
          dryRun,
        });
        return;
      }
      if (['tidak', 'no', 'n', 'nggak', 'gak'].includes(cmd)) {
        clearBotSession('TELEGRAM', input.userId, dryRun);
        await transport.reply('Pembuatan pesanan dibatalkan sebelum QRIS dibuat.', TG_NAV_BACK_BUTTONS);
        return;
      }
      await transport.reply(
        `Pesanan ${session.productName} (${session.destination}) menunggu konfirmasi Anda.\nTekan tombol Ya, Buat QRIS atau Batal di bawah ini:`,
        [
          [
            { text: 'Ya, Buat QRIS', callbackData: 'CONFIRM_ORDER' },
            { text: 'Batal', callbackData: 'CANCEL_CONFIRM_ORDER' },
          ],
        ]
      );
      return;
    }

    if (session?.mode === 'AWAITING_DESTINATION') {
      const [dest, coupon] = parts;
      await promptTelegramOrderConfirmation(transport, {
        userId: input.userId,
        username: input.username,
        sku: session.sku,
        destination: dest,
        couponCode: coupon || null,
        dryRun,
      });
      return;
    }

    if (session?.mode === 'BRAND_LIST') {
      const detected = detectOperatorFromPhone(trimmed);
      if (detected) {
        const matchedBrand = matchBrandForDetectedOperator(session.brands, detected);
        if (matchedBrand) {
          await sendTelegramProductPage(transport, {
            page: 1,
            categoryId: session.categoryId,
            brand: matchedBrand,
            detectedDestination: detected.normalizedPhone,
            detectedOperatorLabel: detected.displayName,
            userId: input.userId,
            dryRun,
          });
          return;
        }
        const activeBrands = listActiveBrandsInCategory(session.categoryId);
        setBotSession(
          'TELEGRAM',
          input.userId,
          {
            ...session,
            detectedDestination: detected.normalizedPhone,
            updatedAt: Date.now(),
          },
          dryRun
        );
        await transport.reply(
          `Nomor *${detected.normalizedPhone}* terdeteksi operator *${detected.displayName}*, namun produk ${detected.displayName} aktif belum tersedia di kategori *${session.categoryName}*.\n` +
            `Silakan pilih operator/brand lain di bawah ini (nomor tetap tersimpan):`,
          buildBrandPickerButtons(session.categoryId, activeBrands)
        );
        return;
      }

      await sendTelegramProductPage(transport, {
        page: 1,
        categoryId: session.categoryId,
        search: trimmed,
        userId: input.userId,
        dryRun,
      });
      return;
    }

    if (session?.mode === 'AWAITING_SEARCH_QUERY') {
      await sendTelegramProductPage(transport, {
        page: 1,
        categoryId: session.categoryId,
        search: trimmed,
        userId: input.userId,
        dryRun,
      });
      return;
    }

    if (session?.mode === 'AWAITING_VOUCHER_CODE') {
      await handleTelegramVoucherCommand(transport, {
        userId: input.userId,
        username: input.username,
        code: parts[0],
        dryRun,
      });
      return;
    }

    if (cmd === 'profil' || cmd === 'profile') {
      await sendTelegramProfile(transport, {
        userId: input.userId,
        displayName: input.displayName,
        username: input.username,
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
      `${friendlyName(input.displayName, input.username)}! Maaf, saya belum memahami pesan "${trimmed}".\n` +
        `Kakak bisa langsung tekan tombol menu di bawah agar lebih mudah:`,
      getTelegramMainMenuButtons()
    );
    return;
  }

  if (cmd === 'batal' || cmd === 'cancel') {
    const activeSession = getBotSession('TELEGRAM', input.userId, dryRun);
    if (activeSession?.mode === 'AWAITING_ORDER_CONFIRMATION' && !args[0]) {
      clearBotSession('TELEGRAM', input.userId, dryRun);
      await transport.reply('Pembuatan pesanan dibatalkan sebelum QRIS dibuat.', TG_NAV_BACK_BUTTONS);
      return;
    }
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
          `1. Tekan tombol Daftar Produk atau Kategori Produk (lalu pilih operator / kirim nomor HP untuk deteksi otomatis).\n` +
          `2. Pilih produk yang diinginkan, kirim nomor tujuan & konfirmasi (Ya/Batal).\n` +
          `3. Bayar QRIS atau klik Link Pembayaran sesuai nominal tepat sebelum batas waktu.\n` +
          `4. Ketik /batal untuk membatalkan transaksi PENDING (minimal 30 detik setelah dibuat).\n\n` +
          `Atau ketik langsung: /order <SKU> <TUJUAN> [KUPON] bila sudah hafal SKU.`,
        getTelegramMainMenuButtons()
      );
      return;
    }
    await sendTelegramMainMenu(
      transport,
      input.userId,
      input.username,
      dryRun,
      input.displayName,
      options?.demoAdmin
    );
    return;
  }

  if (cmd === 'profil' || cmd === 'profile') {
    await sendTelegramProfile(transport, {
      userId: input.userId,
      displayName: input.displayName,
      username: input.username,
      dryRun,
    });
    return;
  }

  if (cmd === 'voucher' || cmd === 'redeem') {
    await handleTelegramVoucherCommand(transport, {
      userId: input.userId,
      username: input.username,
      code: args[0],
      dryRun,
    });
    return;
  }

  if (cmd === 'kontak' || cmd === 'hubungi_admin' || cmd === 'cs' || cmd === 'support') {
    await sendTelegramContactAdmin(transport);
    return;
  }

  if (cmd === 'kategori') {
    await sendTelegramCategoryList(transport);
    return;
  }

  if (cmd === 'cari_produk') {
    const q = args.join(' ').trim();
    if (q) {
      await sendTelegramProductPage(transport, { page: 1, search: q, userId: input.userId, dryRun });
    } else {
      await promptTelegramSearch(transport, { userId: input.userId, dryRun });
    }
    return;
  }

  if (cmd === 'pulsa') {
    const pulsaCat = listCategories(true).find((c) => /pulsa/i.test(c.name));
    if (pulsaCat) {
      const phoneArg = args[0]?.trim();
      if (phoneArg) {
        const detected = detectOperatorFromPhone(phoneArg);
        if (detected) {
          const brands = listActiveBrandsInCategory(pulsaCat.id).map((b) => b.brand);
          const matched = matchBrandForDetectedOperator(brands, detected);
          if (matched) {
            await sendTelegramProductPage(transport, {
              page: 1,
              categoryId: pulsaCat.id,
              brand: matched,
              detectedDestination: detected.normalizedPhone,
              detectedOperatorLabel: detected.displayName,
              userId: input.userId,
              dryRun,
            });
            return;
          }
        }
      }
      await sendTelegramCategorySelection(transport, {
        userId: input.userId,
        categoryId: pulsaCat.id,
        dryRun,
      });
      return;
    }
    await sendTelegramCategoryList(transport);
    return;
  }

  if (cmd === 'produk') {
    const search = args.join(' ').trim() || undefined;
    await sendTelegramProductPage(transport, { page: 1, search, userId: input.userId, dryRun });
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
    await promptTelegramOrderConfirmation(transport, {
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
      const canCancel = ['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(t.transaction_status);
      const buttons: TelegramInlineButton[][] = canCancel
        ? [[{ text: 'Batalkan Pesanan', callbackData: `CANCEL_TX_${t.transaction_id}` }], ...TG_NAV_BACK_BUTTONS]
        : TG_NAV_BACK_BUTTONS;
      await transport.reply(
        `Status Transaksi ${t.transaction_id}\n` +
          `Produk: ${t.product_name_snapshot}\n` +
          `Tujuan: ${t.destination_masked}\n` +
          `Nominal: Rp${t.payment_amount.toLocaleString('id-ID')}\n` +
          `Status: ${t.transaction_status}` +
          (t.supplier_sn ? `\nSN / Token: ${t.supplier_sn}` : ''),
        buttons
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
    const canCancel = ['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(latest.transaction_status);
    const buttons: TelegramInlineButton[][] = [];
    if (canCancel) {
      buttons.push([{ text: 'Batalkan Pesanan', callbackData: `CANCEL_TX_${latest.transaction_id}` }]);
    }
    buttons.push([
      { text: 'Riwayat Lengkap', callbackData: 'MY_HISTORY' },
      { text: 'Menu Utama', callbackData: 'MAIN_MENU' },
    ]);
    await transport.reply(
      `Transaksi Terakhir (${latest.transaction_id})\n` +
        `Produk: ${latest.product_name_snapshot}\n` +
        `Nominal: Rp${latest.payment_amount.toLocaleString('id-ID')}\n` +
        `Status: ${latest.transaction_status}`,
      buttons
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
    `${friendlyName(input.displayName, input.username)}! Maaf, perintah "${trimmed}" belum tersedia.\n` +
      `Silakan gunakan tombol menu di bawah ini:`,
    getTelegramMainMenuButtons()
  );
}

export function extractTelegramUserMeta(from?: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): { displayName: string | null; username: string | null } {
  if (!from) return { displayName: null, username: null };
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  const displayName = fullName || from.username || null;
  const username = from.username ? `@${from.username}` : fullName || null;
  return { displayName, username };
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
    const cleanupPromise = chatId ? clearTrackedTelegramMessages(bot, chatId) : Promise.resolve();
    const { displayName, username } = extractTelegramUserMeta(ctx.from);
    await dispatchTelegramCommand(createTelegrafTransport(bot, ctx), {
      userId: String(ctx.from.id),
      username,
      displayName,
      text,
    });
    await cleanupPromise;
  };

  bot.command(
    [
      'start',
      'menu',
      'bantuan',
      'help',
      'profil',
      'profile',
      'voucher',
      'redeem',
      'kontak',
      'hubungi_admin',
      'kategori',
      'produk',
      'pulsa',
      'cari_produk',
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
