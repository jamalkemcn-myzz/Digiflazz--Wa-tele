import { getEffectivePermissions, type AdminRole } from '../domain/rbac';
import QRCode from 'qrcode';
import { config } from '../config/env';
import { logger } from '../logging/logger';
import { maskDestination } from '../domain/masking';
import {
  listCategories,
  getCategoryById,
  listActiveBrandsInCategory,
  analyzeBrandCatalog,
  listProducts,
  getProductBySkuOrId,
} from '../services/product.service';
import {
  detectOperatorFromPhone,
  matchBrandForDetectedOperator,
  isTelecomCategoryName,
} from '../domain/operator-prefix';
import {
  DURATION_BUCKET_META,
  durationBucketFromCode,
  shouldShowDurationPicker,
  shouldShowSeriesPicker,
  type DurationBucket,
} from '../domain/catalog-filter';
import {
  resolveOrCreateCustomer,
  findCustomerByPlatform,
  requestAccountLinkCode,
  verifyAndLinkAccount,
  unlinkPlatformIdentity,
  getCustomerRefundCreditTotal,
  getCustomerProfileSummary,
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
import { fetchQrisImageBuffer } from '../integrations/qris-image';
import {
  resolveAdminByPlatform,
  checkAdminPermission,
  getAdminBotTransactionReport,
  type ResolvedAdmin,
} from '../services/admin.service';
import { getConfirmationDescription, isMaintenanceMode, setMaintenanceMode } from '../services/settings.service';
import { centralScheduler } from '../workers/scheduler';
import {
  acquireOrderExecutionLock,
  clearBotSession,
  clearPendingVoucher,
  getBotSession,
  getPendingVoucher,
  releaseOrderExecutionLock,
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

export interface WhatsappQuickButton {
  text: string;
  replyText: string;
}

export type WhatsappReplyContent =
  | { text: string; quickReplies?: WhatsappQuickButton[][] }
  | { image: Buffer | { url: string }; caption?: string; quickReplies?: WhatsappQuickButton[][] };

export interface WhatsappReplyTransport {
  sendMessage(
    jid: string,
    content: WhatsappReplyContent
  ): Promise<{ key?: unknown } | undefined>;
}

export interface WhatsappCommandOptions {
  dryRun?: boolean;
  enforceCooldown?: boolean;
  now?: number;
  demoAdmin?: {
    role: AdminRole;
    platformUserId: string;
  } | null;
}

const MAIN_MENU_BUTTONS: WhatsappQuickButton[][] = [
  [
    { text: '📂 Kategori Produk', replyText: '!kategori' },
    { text: '🛒 Daftar Produk', replyText: '!produk' },
  ],
  [
    { text: '👤 Profil & Saldo', replyText: '!profil' },
    { text: '🎟️ Redeem Voucher', replyText: '!voucher' },
  ],
  [
    { text: '📜 Riwayat Transaksi', replyText: '!riwayat' },
    { text: '👨‍💼 Hubungi Admin', replyText: '!kontak' },
  ],
];

const NAV_BACK_BUTTONS: WhatsappQuickButton[][] = [
  [
    { text: '🛒 Daftar Produk', replyText: '!produk' },
    { text: '🏠 Menu Utama', replyText: '!menu' },
  ],
];

const WA_COOLDOWN_MS = 3000;
const MAX_WA_COOLDOWN_ENTRIES = 1500;
const waCooldownMap = new Map<string, number>();

export function clearWhatsappCooldown(jid?: string): void {
  if (jid) {
    waCooldownMap.delete(jid);
  } else {
    waCooldownMap.clear();
  }
}

export function pruneWhatsappCooldowns(now = Date.now()): number {
  let evicted = 0;
  for (const [jid, lastAt] of waCooldownMap) {
    if (now - lastAt >= WA_COOLDOWN_MS) {
      waCooldownMap.delete(jid);
      evicted++;
    }
  }
  return evicted;
}

function checkWhatsappCooldown(jid: string, now = Date.now()): boolean {
  const lastAt = waCooldownMap.get(jid);
  if (lastAt !== undefined && now - lastAt < WA_COOLDOWN_MS) {
    return false;
  }
  if (waCooldownMap.size >= MAX_WA_COOLDOWN_ENTRIES) {
    pruneWhatsappCooldowns(now);
    if (waCooldownMap.size >= MAX_WA_COOLDOWN_ENTRIES) {
      const excess = waCooldownMap.size - MAX_WA_COOLDOWN_ENTRIES + 1;
      let removed = 0;
      for (const k of waCooldownMap.keys()) {
        waCooldownMap.delete(k);
        removed++;
        if (removed >= excess) break;
      }
    }
  }
  waCooldownMap.delete(jid);
  waCooldownMap.set(jid, now);
  return true;
}

const WA_ADMIN_COMMANDS = new Set(['admin', 'transaksi', 'cari', 'statusbot', 'maintenance']);
const WA_RESERVED_COMMANDS = new Set([
  'start',
  'menu',
  'hai',
  'halo',
  'hi',
  'bantuan',
  'help',
  'kategori',
  'produk',
  'produk_hal',
  'produk_kat',
  'produk_brand',
  'produk_filter',
  'seri',
  'durasi',
  'kembali_seri',
  'kembali_durasi',
  'cari_scope',
  'pulsa',
  'cari_produk',
  'pilih',
  'order',
  'profil',
  'profile',
  'voucher',
  'redeem',
  'kontak',
  'hubungi_admin',
  'cs',
  'support',
  'status',
  'riwayat',
  'hubungkan',
  'unlink',
  'batal',
  'cancel',
  'tujuan',
  'admin',
  'transaksi',
  'cari',
  'statusbot',
  'maintenance',
]);

function greetingPrefix(pushName?: string): string {
  const clean = resolveDisplayName(pushName, null, '');
  return clean ? `Halo Kak *${clean}*` : 'Halo Kak';
}

function formatWaProductButtonLabel(name: string, sellingPrice: number, num: number): string {
  const maxNameLen = 36;
  const clean = name.trim();
  const shortName = clean.length > maxNameLen ? `${clean.slice(0, maxNameLen - 1).trimEnd()}…` : clean;
  return `${num}. ${shortName} · Rp${sellingPrice.toLocaleString('id-ID')}`;
}

function formatWhatsappProductHighlightBlock(desc: string): string {
  const lines = desc
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return '┃';
      if (!/[*_]|https?:\/\//i.test(trimmed)) {
        return `┃ *_${trimmed}_*`;
      }
      const safeBold = trimmed.replace(/\*/g, '');
      if (!/https?:\/\//i.test(safeBold) && safeBold) {
        return `┃ *${safeBold}*`;
      }
      return `┃ ${trimmed}`;
    });
  return (
    `📌 *PERHATIAN — KETERANGAN PRODUK:*\n` +
    `┏━━━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines.join('\n')}\n` +
    `┗━━━━━━━━━━━━━━━━━━━━━━`
  );
}

async function sendMainMenu(
  sock: WhatsappReplyTransport,
  jid: string,
  pushName?: string,
  dryRun?: boolean,
  demoAdmin?: { role: AdminRole; platformUserId: string } | null
) {
  setBotSession('WHATSAPP', jid, { mode: 'MAIN_MENU', updatedAt: Date.now() }, dryRun);
  const summary = getCustomerProfileSummary({
    platform: 'WHATSAPP',
    platformUserId: jid,
    platformUsername: pushName || null,
    displayName: pushName || null,
    dryRun,
  });
  const isAdmin = dryRun ? Boolean(demoAdmin) : Boolean(resolveAdminByPlatform('WHATSAPP', jid));

  const hasButtons = Boolean(dryRun);
  await sock.sendMessage(jid, {
    text:
      `${formatStartMessage({
        displayName: pushName,
        shopName: config.shopName,
        userId: summary.userId,
        isAdmin,
        supportsButtons: hasButtons,
      })}\n\n` +
      `*Menu Utama:*\n` +
      `*1.* 📂 Kategori Produk (kategori)\n` +
      `*2.* 🛒 Daftar Produk (produk)\n` +
      `*3.* 👤 Profil & Saldo (profil)\n` +
      `*4.* 🎟️ Redeem Voucher (voucher)\n` +
      `*5.* 📜 Riwayat Transaksi (riwayat)\n` +
      `*6.* 👨‍💼 Hubungi Admin (kontak)\n\n` +
      (hasButtons
        ? `_Ketik angka/perintah di atas atau tap tombol di bawah._`
        : `_Balas *angka* (misal: *1*) atau ketik *nama menu* (misal: *kategori*)._`),
    quickReplies: MAIN_MENU_BUTTONS,
  });
}

async function sendWhatsappProfile(
  sock: WhatsappReplyTransport,
  jid: string,
  pushName?: string,
  dryRun?: boolean
) {
  clearBotSession('WHATSAPP', jid, dryRun);
  const summary = getCustomerProfileSummary({
    platform: 'WHATSAPP',
    platformUserId: jid,
    platformUsername: pushName || null,
    displayName: pushName || null,
    dryRun,
  });
  await sock.sendMessage(jid, {
    text: formatProfileMessage(summary, config.timezone),
    quickReplies: [
      [
        { text: '🛒 Daftar Produk', replyText: '!produk' },
        { text: '📜 Riwayat Transaksi', replyText: '!riwayat' },
      ],
      [{ text: '🏠 Menu Utama', replyText: '!menu' }],
    ],
  });
}

async function sendWhatsappContactAdmin(sock: WhatsappReplyTransport, jid: string, dryRun?: boolean) {
  clearBotSession('WHATSAPP', jid, dryRun);
  await sock.sendMessage(jid, {
    text: formatContactAdminMessage(config),
    quickReplies: [
      [
        { text: '📜 Riwayat Transaksi', replyText: '!riwayat' },
        { text: '🏠 Menu Utama', replyText: '!menu' },
      ],
    ],
  });
}

async function handleWhatsappVoucherCommand(
  sock: WhatsappReplyTransport,
  jid: string,
  code?: string | null,
  dryRun?: boolean
) {
  const activeVoucher = getPendingVoucher('WHATSAPP', jid, dryRun);
  const cleanCode = (code || '').trim();
  if (!cleanCode) {
    setBotSession('WHATSAPP', jid, { mode: 'AWAITING_VOUCHER_CODE', updatedAt: Date.now() }, dryRun);
    await sock.sendMessage(jid, {
      text: formatVoucherPromptMessage('WHATSAPP', activeVoucher),
      quickReplies: [[{ text: '❌ Batal / Menu Utama', replyText: '!menu' }]],
    });
    return;
  }

  clearBotSession('WHATSAPP', jid, dryRun);
  const resolved = findCustomerByPlatform({ platform: 'WHATSAPP', platformUserId: jid });
  const check = previewVoucherRedeem({
    code: cleanCode,
    customerId: resolved?.customer.id ?? null,
  });

  if (!check.ok || !check.coupon) {
    await sock.sendMessage(jid, {
      text: `Maaf Kak, ${check.errorMessage || 'kode voucher tidak valid.'}`,
      quickReplies: [
        [
          { text: '🔄 Coba Lagi', replyText: '!voucher' },
          { text: '🏠 Menu Utama', replyText: '!menu' },
        ],
      ],
    });
    return;
  }

  setPendingVoucher('WHATSAPP', jid, check.coupon.code, dryRun);
  await sock.sendMessage(jid, {
    text: formatVoucherSuccessMessage(check.coupon, config.timezone),
    quickReplies: [
      [
        { text: '🛒 Daftar Produk', replyText: '!produk' },
        { text: '🏠 Menu Utama', replyText: '!menu' },
      ],
    ],
  });
}

async function sendCategoryList(sock: WhatsappReplyTransport, jid: string, dryRun?: boolean) {
  const cats = listCategories(true);
  if (cats.length === 0) {
    await sock.sendMessage(jid, {
      text: 'Maaf Kak, belum ada kategori produk yang aktif saat ini. Silakan coba lagi nanti ya.',
      quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
    });
    return;
  }

  const shown = cats.slice(0, 12);
  setBotSession(
    'WHATSAPP',
    jid,
    { mode: 'CATEGORY_LIST', categoryIds: shown.map((c) => c.id), updatedAt: Date.now() },
    dryRun
  );

  const lines = shown.map((c, idx) => `${idx + 1}. ${c.name}`).join('\n');
  const buttonRows: WhatsappQuickButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    const row = shown.slice(i, i + 2).map((c, offset) => ({
      text: `🏷️ ${i + offset + 1}. ${c.name}`,
      replyText: `!produk_kat ${c.id} 1`,
    }));
    buttonRows.push(row);
  }
  buttonRows.push([
    { text: '🔍 Cari Produk', replyText: '!cari_produk' },
    { text: '📦 Semua Produk', replyText: '!produk' },
  ]);
  buttonRows.push([{ text: '🏠 Menu Utama', replyText: '!menu' }]);

  await sock.sendMessage(jid, {
    text:
      `*Kategori Produk Aktif*\n` +
      `${lines}\n\n` +
      (dryRun
        ? `Pilih tombol kategori atau balas dengan *angka* kategori (misal: *1*) ya Kak.`
        : `Balas *angka* kategori (misal: *1*), ketik *produk* untuk semua produk, atau *0* untuk Menu Utama.`),
    quickReplies: buttonRows,
  });
}

function buildWhatsappBrandButtons(
  categoryId: number,
  brands: Array<{ brand: string; productCount: number }>
): WhatsappQuickButton[][] {
  const shown = brands.slice(0, 14);
  const buttonRows: WhatsappQuickButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    buttonRows.push(
      shown.slice(i, i + 2).map((b, offset) => ({
        text: `📶 ${i + offset + 1}. ${b.brand} (${b.productCount})`,
        replyText: `!produk_brand ${categoryId} 1 ${b.brand}`,
      }))
    );
  }
  buttonRows.push([
    { text: '🔍 Cari Produk', replyText: '!cari_produk' },
    { text: '📂 Kategori Lain', replyText: '!kategori' },
  ]);
  buttonRows.push([{ text: '🏠 Menu Utama', replyText: '!menu' }]);
  return buttonRows;
}

function buildWhatsappSeriesButtons(
  categoryId: number,
  brand: string,
  seriesSummaries: Array<{ series: string; productCount: number }>
): WhatsappQuickButton[][] {
  const shown = seriesSummaries.slice(0, 14);
  const buttonRows: WhatsappQuickButton[][] = [];
  for (let i = 0; i < shown.length; i += 2) {
    buttonRows.push(
      shown.slice(i, i + 2).map((s, offset) => ({
        text: `📦 ${i + offset + 1}. ${s.series}`,
        replyText: `!seri ${i + offset}`,
      }))
    );
  }
  buttonRows.push([{ text: `📋 Semua Produk ${brand}`, replyText: '!seri ALL' }]);
  buttonRows.push([
    { text: '🔍 Cari Produk', replyText: '!cari_scope' },
    { text: '🔄 Ganti Operator / Brand', replyText: `!produk_kat ${categoryId} 1` },
  ]);
  buttonRows.push([
    { text: '📂 Kategori Lain', replyText: '!kategori' },
    { text: '🏠 Menu Utama', replyText: '!menu' },
  ]);
  return buttonRows;
}

function buildWhatsappDurationButtons(
  categoryId: number,
  durationSummaries: Array<{
    code: string;
    emoji: string;
    label: string;
    productCount: number;
  }>,
  totalFiltered: number,
  hasSeriesStep: boolean
): WhatsappQuickButton[][] {
  const buttonRows: WhatsappQuickButton[][] = durationSummaries.map((d, idx) => [
    {
      text: `${d.emoji} ${idx + 1}. ${d.label} · ${d.productCount} paket`,
      replyText: `!durasi ${d.code}`,
    },
  ]);
  buttonRows.push([{ text: `📋 Semua Durasi (${totalFiltered})`, replyText: '!durasi ALL' }]);
  const navRow: WhatsappQuickButton[] = [];
  if (hasSeriesStep) {
    navRow.push({ text: '🔙 Pilih Seri', replyText: '!kembali_seri' });
  }
  navRow.push({ text: '🔄 Ganti Operator', replyText: `!produk_kat ${categoryId} 1` });
  buttonRows.push(navRow);
  buttonRows.push([
    { text: '🔍 Cari Produk', replyText: '!cari_scope' },
    { text: '🏠 Menu Utama', replyText: '!menu' },
  ]);
  return buttonRows;
}

async function enterWhatsappSeriesCatalog(
  sock: WhatsappReplyTransport,
  jid: string,
  params: {
    categoryId: number;
    categoryName?: string;
    brand?: string;
    series?: string;
    hasSeriesStep?: boolean;
    detectedDestination?: string;
    detectedOperatorLabel?: string;
  },
  dryRun?: boolean
) {
  const catName = params.categoryName || getCategoryById(params.categoryId)?.name || 'Produk';
  const analysis = analyzeBrandCatalog(params.categoryId, params.brand, params.series);
  const hasSeriesStep = params.hasSeriesStep ?? shouldShowSeriesPicker(analysis.seriesSummaries);

  if (shouldShowDurationPicker(analysis.durationSummaries, analysis.filteredCount) && params.brand) {
    setBotSession(
      'WHATSAPP',
      jid,
      {
        mode: 'DURATION_LIST',
        categoryId: params.categoryId,
        categoryName: catName,
        brand: params.brand,
        series: params.series,
        hasSeriesStep,
        durationBuckets: analysis.durationSummaries.map((d) => d.bucket),
        detectedDestination: params.detectedDestination,
        detectedOperatorLabel: params.detectedOperatorLabel,
        updatedAt: Date.now(),
      },
      dryRun
    );

    const scopeLabel = params.series ? `*${params.brand} · ${params.series}*` : `*${params.brand}*`;
    const destHint = params.detectedDestination
      ? `Nomor *${params.detectedDestination}* terdeteksi *${params.detectedOperatorLabel || params.brand}*\n`
      : '';
    const lines = analysis.durationSummaries
      .map(
        (d, idx) =>
          `${idx + 1}. ${d.emoji} *${d.label}* (${d.productCount} paket, mulai Rp${d.minPrice.toLocaleString('id-ID')})`
      )
      .join('\n');

    await sock.sendMessage(jid, {
      text:
        `${destHint}${scopeLabel} (${catName})\n\n` +
        `Pilih durasi masa aktif paket agar lebih mudah dicari:\n${lines}\n\n` +
        `Balas *angka* (misal: *1*) untuk memilih durasi, *semua* untuk semua durasi, *kembali*, atau ketik *kata kunci* untuk mencari:`,
      quickReplies: buildWhatsappDurationButtons(
        params.categoryId,
        analysis.durationSummaries,
        analysis.filteredCount,
        hasSeriesStep
      ),
    });
    return;
  }

  await sendProductPage(
    sock,
    jid,
    {
      page: 1,
      categoryId: params.categoryId,
      categoryName: catName,
      brand: params.brand,
      series: params.series,
      hasSeriesStep,
      hasDurationStep: false,
      detectedDestination: params.detectedDestination,
      detectedOperatorLabel: params.detectedOperatorLabel,
    },
    dryRun
  );
}

async function enterWhatsappBrandCatalog(
  sock: WhatsappReplyTransport,
  jid: string,
  params: {
    categoryId: number;
    categoryName?: string;
    brand?: string;
    detectedDestination?: string;
    detectedOperatorLabel?: string;
  },
  dryRun?: boolean
) {
  const catName = params.categoryName || getCategoryById(params.categoryId)?.name || 'Produk';
  const analysis = analyzeBrandCatalog(params.categoryId, params.brand);

  if (shouldShowSeriesPicker(analysis.seriesSummaries) && params.brand) {
    const shown = analysis.seriesSummaries.slice(0, 14);
    setBotSession(
      'WHATSAPP',
      jid,
      {
        mode: 'SERIES_LIST',
        categoryId: params.categoryId,
        categoryName: catName,
        brand: params.brand,
        seriesList: shown.map((s) => s.series),
        detectedDestination: params.detectedDestination,
        detectedOperatorLabel: params.detectedOperatorLabel,
        updatedAt: Date.now(),
      },
      dryRun
    );

    const destHint = params.detectedDestination
      ? `Nomor *${params.detectedDestination}* terdeteksi *${params.detectedOperatorLabel || params.brand}*\n`
      : '';
    const lines = shown
      .map(
        (s, idx) =>
          `${idx + 1}. *${s.series}* (mulai Rp${s.minPrice.toLocaleString('id-ID')})`
      )
      .join('\n');

    await sock.sendMessage(jid, {
      text:
        `${destHint}*${params.brand}* (${catName})\n\n` +
        `Pilih seri / jenis paket yang ingin dicari:\n${lines}\n\n` +
        `Balas *angka* (misal: *1*) untuk memilih seri, *semua* untuk semua produk ${params.brand}, *kembali*, atau ketik *kata kunci* untuk mencari:`,
      quickReplies: buildWhatsappSeriesButtons(
        params.categoryId,
        params.brand,
        shown
      ),
    });
    return;
  }

  await enterWhatsappSeriesCatalog(
    sock,
    jid,
    {
      categoryId: params.categoryId,
      categoryName: catName,
      brand: params.brand,
      hasSeriesStep: false,
      detectedDestination: params.detectedDestination,
      detectedOperatorLabel: params.detectedOperatorLabel,
    },
    dryRun
  );
}

async function sendCategoryBrandOrProducts(
  sock: WhatsappReplyTransport,
  jid: string,
  categoryId: number,
  dryRun?: boolean
) {
  const cat = getCategoryById(categoryId);
  const brands = listActiveBrandsInCategory(categoryId);

  if (brands.length <= 1) {
    const existingSession = getBotSession('WHATSAPP', jid, dryRun);
    const preservedDestination =
      existingSession && 'detectedDestination' in existingSession
        ? existingSession.detectedDestination
        : undefined;
    await enterWhatsappBrandCatalog(
      sock,
      jid,
      {
        categoryId,
        categoryName: cat?.name || 'Produk',
        brand: brands[0]?.brand,
        detectedDestination: preservedDestination,
      },
      dryRun
    );
    return;
  }

  const shown = brands.slice(0, 14);
  const existingSession = getBotSession('WHATSAPP', jid, dryRun);
  const preservedDestination =
    existingSession && 'detectedDestination' in existingSession
      ? existingSession.detectedDestination
      : undefined;

  setBotSession(
    'WHATSAPP',
    jid,
    {
      mode: 'BRAND_LIST',
      categoryId,
      categoryName: cat?.name || 'Produk',
      brands: shown.map((b) => b.brand),
      detectedDestination: preservedDestination,
      updatedAt: Date.now(),
    },
    dryRun
  );

  const lines = shown
    .map((b, idx) => `${idx + 1}. *${b.brand}* (${b.productCount} produk, mulai Rp${b.minPrice.toLocaleString('id-ID')})`)
    .join('\n');

  const isTelecom = isTelecomCategoryName(cat?.name);
  const promptHint = isTelecom
    ? `Kirim *nomor HP* untuk deteksi operator otomatis (contoh: *081812345678*), atau balas *angka* untuk memilih operator:`
    : `Balas *angka* (misal: *1*) untuk melihat daftar produk brand tersebut:`;

  await sock.sendMessage(jid, {
    text:
      `*Kategori: ${cat?.name || 'Produk'}*\n\n` +
      `${lines}\n\n` +
      `${promptHint}\n` +
      `_Ketik *kategori* untuk ganti kategori atau *0* untuk Menu Utama._`,
    quickReplies: buildWhatsappBrandButtons(categoryId, shown),
  });
}

async function promptWhatsappSearch(
  sock: WhatsappReplyTransport,
  jid: string,
  params?: {
    categoryId?: number;
    brand?: string;
    series?: string;
    durationBucket?: DurationBucket | 'ALL';
    detectedDestination?: string;
    detectedOperatorLabel?: string;
  },
  dryRun?: boolean
) {
  setBotSession(
    'WHATSAPP',
    jid,
    {
      mode: 'AWAITING_SEARCH_QUERY',
      categoryId: params?.categoryId,
      brand: params?.brand,
      series: params?.series,
      durationBucket: params?.durationBucket,
      detectedDestination: params?.detectedDestination,
      detectedOperatorLabel: params?.detectedOperatorLabel,
      updatedAt: Date.now(),
    },
    dryRun
  );
  const scopeParts = [params?.brand, params?.series].filter(Boolean);
  const scopeDesc = scopeParts.length > 0 ? ` di *${scopeParts.join(' · ')}*` : '';
  await sock.sendMessage(jid, {
    text:
      `Silakan ketik kata kunci produk${scopeDesc} yang dicari (contoh: *happy 12*, *30 hari*, *xl 10*, *pln 50*).`,
    quickReplies: [
      [
        { text: '📂 Kategori Produk', replyText: '!kategori' },
        { text: '❌ Batal / Menu Utama', replyText: '!menu' },
      ],
    ],
  });
}

async function sendProductPage(
  sock: WhatsappReplyTransport,
  jid: string,
  params: {
    page: number;
    categoryId?: number;
    categoryName?: string;
    brand?: string;
    series?: string;
    durationBucket?: DurationBucket | 'ALL';
    search?: string;
    hasSeriesStep?: boolean;
    hasDurationStep?: boolean;
    detectedDestination?: string;
    detectedOperatorLabel?: string;
  },
  dryRun?: boolean
) {
  const res = listProducts({
    page: params.page,
    limit: 6,
    categoryId: params.categoryId,
    brand: params.brand,
    series: params.series,
    durationBucket: params.durationBucket,
    search: params.search,
    onlyActive: true,
    sortBy: 'PRICE_ASC',
  });

  if (res.items.length === 0) {
    const emptyQuickReplies: WhatsappQuickButton[][] = [];
    if (params.categoryId && params.brand) {
      const row: WhatsappQuickButton[] = [];
      if (params.hasDurationStep || (params.durationBucket && params.durationBucket !== 'ALL')) {
        row.push({ text: '⏱️ Ganti Durasi', replyText: '!kembali_durasi' });
      }
      if (params.hasSeriesStep || params.series) {
        row.push({ text: '🔙 Pilih Seri', replyText: '!kembali_seri' });
      }
      if (row.length > 0) emptyQuickReplies.push(row);
    }
    emptyQuickReplies.push([
      { text: '🔍 Cari Produk', replyText: params.brand ? '!cari_scope' : '!cari_produk' },
      { text: '📂 Lihat Kategori', replyText: '!kategori' },
    ]);
    emptyQuickReplies.push([
      { text: '📦 Semua Produk', replyText: '!produk' },
      { text: '🏠 Menu Utama', replyText: '!menu' },
    ]);

    await sock.sendMessage(jid, {
      text: params.search
        ? `Maaf Kak, produk untuk kata kunci "${params.search}" belum ditemukan. Coba cari kata kunci lain atau lihat kategori.`
        : 'Maaf Kak, belum ada produk aktif di filter ini saat ini.',
      quickReplies: emptyQuickReplies,
    });
    return;
  }

  let hasSeriesStep = params.hasSeriesStep;
  let hasDurationStep = params.hasDurationStep;
  if (params.categoryId && params.brand && (hasSeriesStep === undefined || hasDurationStep === undefined)) {
    const analysis = analyzeBrandCatalog(params.categoryId, params.brand, params.series);
    if (hasSeriesStep === undefined) {
      hasSeriesStep = shouldShowSeriesPicker(analysis.seriesSummaries);
    }
    if (hasDurationStep === undefined) {
      hasDurationStep = shouldShowDurationPicker(analysis.durationSummaries, analysis.filteredCount);
    }
  }

  setBotSession(
    'WHATSAPP',
    jid,
    {
      mode: 'PRODUCT_LIST',
      skus: res.items.map((p) => p.sku),
      page: params.page,
      categoryId: params.categoryId,
      categoryName: params.categoryName,
      brand: params.brand,
      series: params.series,
      durationBucket: params.durationBucket,
      search: params.search,
      hasSeriesStep,
      hasDurationStep,
      detectedDestination: params.detectedDestination,
      detectedOperatorLabel: params.detectedOperatorLabel,
      updatedAt: Date.now(),
    },
    dryRun
  );

  const lines = res.items.map(
    (p, idx) => `${idx + 1}. *${p.name}*\n    Rp${p.selling_price.toLocaleString('id-ID')}`
  );

  const buttonRows: WhatsappQuickButton[][] = res.items.map((p, idx) => [
    {
      text: `🛍️ ${formatWaProductButtonLabel(p.name, p.selling_price, idx + 1)}`,
      replyText: `!pilih ${p.sku}`,
    },
  ]);

  const hasExtraFilter = Boolean(
    params.series || (params.durationBucket && params.durationBucket !== 'ALL') || params.search
  );

  const makePageCmd = (targetPage: number) => {
    if (hasExtraFilter) {
      return `!produk_filter ${targetPage}`;
    }
    if (params.categoryId && params.brand) {
      return `!produk_brand ${params.categoryId} ${targetPage} ${params.brand}`;
    }
    if (params.categoryId) {
      return `!produk_kat ${params.categoryId} ${targetPage}`;
    }
    return `!produk_hal ${targetPage}`;
  };

  const navRow: WhatsappQuickButton[] = [];
  if (params.page > 1) {
    navRow.push({
      text: '⬅️ Sebelumnya',
      replyText: makePageCmd(params.page - 1),
    });
  }
  if (params.page < res.pagination.totalPages) {
    navRow.push({
      text: '➡️ Berikutnya',
      replyText: makePageCmd(params.page + 1),
    });
  }
  if (navRow.length > 0) buttonRows.push(navRow);

  if (params.categoryId && params.brand) {
    const filterBackRow: WhatsappQuickButton[] = [];
    if (hasDurationStep) {
      filterBackRow.push({ text: '⏱️ Ganti Durasi', replyText: '!kembali_durasi' });
    }
    if (hasSeriesStep) {
      filterBackRow.push({ text: '📂 Ganti Seri', replyText: '!kembali_seri' });
    }
    if (filterBackRow.length > 0) buttonRows.push(filterBackRow);

    buttonRows.push([
      { text: '🔄 Ganti Operator / Brand', replyText: `!produk_kat ${params.categoryId} 1` },
      { text: '🔍 Cari Produk', replyText: '!cari_scope' },
    ]);
    buttonRows.push([
      { text: '📂 Kategori Lain', replyText: '!kategori' },
      { text: '🏠 Menu Utama', replyText: '!menu' },
    ]);
  } else {
    buttonRows.push([
      { text: '🔍 Cari Produk', replyText: '!cari_produk' },
      { text: '📂 Kategori Lain', replyText: '!kategori' },
    ]);
    buttonRows.push([{ text: '🏠 Menu Utama', replyText: '!menu' }]);
  }

  const filterLabels: string[] = [];
  if (params.series) filterLabels.push(params.series);
  if (params.durationBucket && params.durationBucket !== 'ALL') {
    filterLabels.push(DURATION_BUCKET_META[params.durationBucket].shortLabel);
  }
  if (params.search) filterLabels.push(`"${params.search}"`);
  const filterSuffix = filterLabels.length > 0 ? ` · ${filterLabels.join(' · ')}` : '';

  const navHints: string[] = [];
  if (params.page < res.pagination.totalPages) navHints.push('*next* (hal berikutnya)');
  if (params.page > 1) navHints.push('*prev* (sebelumnya)');
  if (hasDurationStep || hasSeriesStep || params.categoryId) navHints.push('*kembali*');
  navHints.push('*0* (Menu Utama)');
  const realNavFooter = !dryRun ? `\n_Navigasi: ${navHints.join(' · ')}_` : '';

  let headerText: string;
  if (params.detectedDestination) {
    headerText =
      `*Nomor ${params.detectedDestination} Terdeteksi: ${params.brand || params.detectedOperatorLabel}*${filterSuffix} (Hal ${params.page}/${res.pagination.totalPages})\n` +
      `${lines.join('\n')}\n\n` +
      (dryRun
        ? `Tap produk di bawah atau balas *angka* (misal: *1*) untuk langsung konfirmasi pesanan ya Kak!`
        : `Balas *angka* (misal: *1*) untuk langsung konfirmasi pesanan ya Kak!`) +
      realNavFooter;
  } else if (params.brand) {
    headerText =
      `*Daftar ${params.brand}*${filterSuffix} (Hal ${params.page}/${res.pagination.totalPages})\n` +
      `${lines.join('\n')}\n\n` +
      (dryRun
        ? `Tap tombol produk di bawah atau balas *angka* (misal: *1*) untuk memesan ya Kak!`
        : `Balas *angka* (misal: *1*) untuk memilih produk ya Kak!`) +
      realNavFooter;
  } else {
    headerText =
      `*Daftar Produk${filterSuffix} (Hal ${params.page}/${res.pagination.totalPages})*\n` +
      `${lines.join('\n')}\n\n` +
      (dryRun
        ? `Tap tombol produk di bawah atau balas *angka* (misal: *1*) untuk memesan ya Kak!`
        : `Balas *angka* (misal: *1*) untuk memilih produk ya Kak!`) +
      realNavFooter;
  }

  await sock.sendMessage(jid, {
    text: headerText,
    quickReplies: buttonRows,
  });
}

async function promptProductDestination(
  sock: WhatsappReplyTransport,
  jid: string,
  skuOrId: string,
  dryRun?: boolean
) {
  const product = getProductBySkuOrId(skuOrId);
  if (!product || product.status !== 'ACTIVE' || product.is_available !== 1) {
    await sock.sendMessage(jid, {
      text: `Maaf Kak, produk *${skuOrId}* sedang tidak tersedia atau nonaktif.`,
      quickReplies: NAV_BACK_BUTTONS,
    });
    return;
  }

  setBotSession(
    'WHATSAPP',
    jid,
    {
      mode: 'AWAITING_DESTINATION',
      sku: product.sku,
      productName: product.name,
      sellingPrice: product.selling_price,
      updatedAt: Date.now(),
    },
    dryRun
  );

  const rawDesc = product.description?.trim() || null;
  const descBlock = rawDesc ? `${formatWhatsappProductHighlightBlock(rawDesc)}\n\n` : '';

  await sock.sendMessage(jid, {
    text:
      `Pilihan tepat! Anda memilih:\n` +
      `*${product.name}*\n` +
      `Harga: *Rp${product.selling_price.toLocaleString('id-ID')}*\n\n` +
      descBlock +
      `Silakan kirimkan *nomor tujuan / ID pelanggan* Anda sekarang (contoh: *081234567890*, atau tambahkan kode kupon setelah spasi).` +
      (!dryRun ? `\n_Ketik *produk* untuk pilih produk lain atau *batal* untuk ke Menu Utama._` : ''),
    quickReplies: [
      [
        { text: '🛒 Pilih Produk Lain', replyText: '!produk' },
        { text: '❌ Batal / Menu Utama', replyText: '!batal' },
      ],
    ],
  });
}

async function promptWhatsappOrderConfirmation(
  sock: WhatsappReplyTransport,
  jid: string,
  params: { sku: string; destination: string; couponCode?: string | null; dryRun?: boolean }
) {
  const resolvedCoupon =
    params.couponCode?.trim() || getPendingVoucher('WHATSAPP', jid, params.dryRun) || null;
  const preview = previewOrderDryRun({
    platform: 'WHATSAPP',
    platformUserId: jid,
    productSkuOrId: params.sku,
    destination: params.destination,
    couponCode: resolvedCoupon,
  });

  if (!preview.ok || !preview.transaction) {
    clearBotSession('WHATSAPP', jid, params.dryRun);
    await sock.sendMessage(jid, {
      text: `Maaf Kak, ${preview.errorMessage || 'pesanan belum dapat diproses.'}`,
      quickReplies: NAV_BACK_BUTTONS,
    });
    return;
  }

  const p = preview.transaction;
  const sellingPrice = p.supplier_price_snapshot + p.margin_snapshot;
  const productRow = getProductBySkuOrId(p.product_sku_snapshot);
  const productDesc = productRow?.description?.trim() || null;
  const globalDesc = getConfirmationDescription();

  setBotSession(
    'WHATSAPP',
    jid,
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

  const productDescLine = productDesc
    ? productDesc.includes('\n')
      ? `Keterangan:\n${productDesc}\n`
      : `Keterangan: ${productDesc}\n`
    : '';

  await sock.sendMessage(jid, {
    text:
      `*Konfirmasi Pesanan Anda*\n\n` +
      `Produk: *${p.product_name_snapshot}*\n` +
      `Tujuan: *${params.destination.trim()}*\n` +
      `Harga: Rp${sellingPrice.toLocaleString('id-ID')}\n` +
      (p.coupon_code_snapshot ? `Kupon: ${p.coupon_code_snapshot} (-Rp${p.discount_snapshot.toLocaleString('id-ID')})\n` : '') +
      `Estimasi Total (+ Kode Unik): *Rp${p.payment_amount.toLocaleString('id-ID')}*\n` +
      productDescLine +
      (globalDesc ? `Catatan: ${globalDesc}\n` : '') +
      `\nBalas *ya* untuk melanjutkan atau *batal* untuk membatalkan:`,
    quickReplies: [
      [
        { text: '✅ Ya, Buat QRIS', replyText: '!ya' },
        { text: '❌ Batal', replyText: '!batal' },
      ],
    ],
  });
}

async function executeWhatsappOrder(
  sock: WhatsappReplyTransport,
  jid: string,
  params: { sku: string; destination: string; couponCode?: string | null; pushName?: string; dryRun?: boolean }
) {
  clearBotSession('WHATSAPP', jid, params.dryRun);
  const resolvedCoupon =
    params.couponCode?.trim() || getPendingVoucher('WHATSAPP', jid, params.dryRun) || null;
  if (resolvedCoupon) {
    clearPendingVoucher('WHATSAPP', jid, params.dryRun);
  }
  const result = params.dryRun
    ? previewOrderDryRun({
        platform: 'WHATSAPP',
        platformUserId: jid,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: resolvedCoupon,
      })
    : await createOrder({
        platform: 'WHATSAPP',
        platformUserId: jid,
        platformUsername: params.pushName || null,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: resolvedCoupon,
      });

  if (!result.ok || !result.transaction) {
    if (result.activeInvoice) {
      const a = result.activeInvoice;
      await sock.sendMessage(jid, {
        text:
          `Halo Kak, ${result.errorMessage}\n\n` +
          `ID: ${a.transaction_id}\n` +
          `Produk: ${a.product_name_snapshot}\n` +
          `Total: Rp${a.payment_amount.toLocaleString('id-ID')}`,
        quickReplies: [
          [
            { text: '🔍 Cek Status Invoice', replyText: `!status ${a.transaction_id}` },
            { text: '🚫 Batalkan Pesanan', replyText: `!batal ${a.transaction_id}` },
          ],
          [{ text: '🏠 Menu Utama', replyText: '!menu' }],
        ],
      });
      return;
    }
    await sock.sendMessage(jid, {
      text: `Maaf Kak, ${result.errorMessage || 'pesanan belum dapat diproses.'}`,
      quickReplies: NAV_BACK_BUTTONS,
    });
    return;
  }

  const tx = result.transaction;
  const originalPaymentUrl =
    result.qris?.qrUrl && !result.qris.qrUrl.startsWith('data:') ? result.qris.qrUrl : undefined;
  const caption =
    `Terima kasih Kak! Pesanan siap dibayar:\n\n` +
    `*INVOICE PEMBAYARAN QRIS*\n` +
    `ID Transaksi: ${tx.transaction_id}\n` +
    `Produk: ${tx.product_name_snapshot}\n` +
    `Tujuan: ${maskDestination(tx.destination)}\n` +
    (tx.discount_snapshot > 0 ? `Diskon Kupon: -Rp${tx.discount_snapshot.toLocaleString('id-ID')}\n` : '') +
    `Kode Unik: ${tx.unique_code}\n` +
    `*Total Bayar: Rp${tx.payment_amount.toLocaleString('id-ID')}*\n` +
    (originalPaymentUrl ? `Link Pembayaran: ${originalPaymentUrl}\n` : '') +
    `Berlaku hingga: ${new Date(tx.expired_at!).toLocaleTimeString('id-ID')} (${config.transaction.invoiceExpiryMinutes} menit)\n\n` +
    `Silakan scan QRIS di atas atau buka Link Pembayaran dengan nominal TEPAT Rp${tx.payment_amount.toLocaleString('id-ID')} ya Kak.\n` +
    (params.dryRun
      ? `_Ketik *batal* atau tap Batalkan Pesanan untuk membatalkan (minimal 30 detik setelah pesanan dibuat)._`
      : `_Ketik *status ${tx.transaction_id}* untuk cek status atau *batal ${tx.transaction_id}* untuk membatalkan (minimal 30 detik setelah pesanan dibuat)._`) +
    (params.dryRun ? `\n\n_[Mode Demo: pratinjau invoice & QRIS, transaksi tidak disimpan ke database]_` : '');

  const invoiceButtons: WhatsappQuickButton[][] = [
    [
      { text: '🔍 Cek Status Pembayaran', replyText: `!status ${tx.transaction_id}` },
      { text: '🚫 Batalkan Pesanan', replyText: `!batal ${tx.transaction_id}` },
    ],
    [{ text: '🏠 Menu Utama', replyText: '!menu' }],
  ];

  try {
    if (result.qris?.qrString) {
      const pngBuffer = await QRCode.toBuffer(result.qris.qrString, { width: 360, margin: 2 });
      const sent = await sock.sendMessage(jid, { image: pngBuffer, caption, quickReplies: invoiceButtons });
      if (!params.dryRun && sent?.key) {
        saveQrMessageReference(tx.transaction_id, {
          platform: 'WHATSAPP',
          chatId: jid,
          messageId: sent.key as unknown as Record<string, unknown>,
        });
      }
    } else if (result.qris?.qrUrl) {
      const imageBuffer = await fetchQrisImageBuffer(result.qris.qrUrl);
      const sent = await sock.sendMessage(jid, {
        image: imageBuffer,
        caption,
        quickReplies: invoiceButtons,
      });
      if (!params.dryRun && sent?.key) {
        saveQrMessageReference(tx.transaction_id, {
          platform: 'WHATSAPP',
          chatId: jid,
          messageId: sent.key as unknown as Record<string, unknown>,
        });
      }
    } else {
      await sock.sendMessage(jid, { text: caption, quickReplies: invoiceButtons });
    }
  } catch (err) {
    logger.warn('Failed to send QRIS image on WhatsApp', {
      service: 'whatsapp',
      transactionId: tx.transaction_id,
      details: { error: err instanceof Error ? err.message : 'unknown' },
    });
    await sock.sendMessage(jid, { text: caption, quickReplies: invoiceButtons });
  }
}

async function handleWhatsappOrderCancellation(
  sock: WhatsappReplyTransport,
  jid: string,
  params: { transactionId?: string; dryRun?: boolean; pushName?: string }
) {
  if (params.dryRun) {
    await sock.sendMessage(jid, {
      text: params.transactionId?.startsWith('TRX-DEMO-')
        ? `Pembatalan pesanan minimal dilakukan 30 detik setelah pesanan dibuat. (Mode Demo: transaksi ${params.transactionId} tidak tersimpan di database)`
        : '[Mode Demo] Simulasi pembatalan pesanan (minimal 30 detik setelah pesanan dibuat).',
      quickReplies: NAV_BACK_BUTTONS,
    });
    return;
  }

  const res = await cancelCustomerTransaction({
    platform: 'WHATSAPP',
    platformUserId: jid,
    transactionId: params.transactionId,
  });

  if (!res.ok) {
    const buttons: WhatsappQuickButton[][] = res.transaction
      ? [
          [
            { text: '🔍 Cek Status Pembayaran', replyText: `!status ${res.transaction.transaction_id}` },
            { text: '🔄 Coba Batalkan Lagi', replyText: `!batal ${res.transaction.transaction_id}` },
          ],
          [{ text: '🏠 Menu Utama', replyText: '!menu' }],
        ]
      : NAV_BACK_BUTTONS;
    await sock.sendMessage(jid, {
      text: res.errorMessage || 'Maaf Kak, pesanan belum dapat dibatalkan.',
      quickReplies: buttons,
    });
    return;
  }

  await sock.sendMessage(jid, {
    text:
      `Pesanan *${res.transaction!.transaction_id}* (${res.transaction!.product_name_snapshot}) telah *DIBATALKAN*.\n` +
      `Harap tunggu ${config.transaction.cooldownSeconds} detik sebelum membuat pesanan baru ya Kak.`,
    quickReplies: NAV_BACK_BUTTONS,
  });
}

async function sendWhatsappHistory(
  sock: WhatsappReplyTransport,
  jid: string,
  pushName?: string,
  dryRun?: boolean
) {
  clearBotSession('WHATSAPP', jid, dryRun);
  const resolved = dryRun
    ? findCustomerByPlatform({ platform: 'WHATSAPP', platformUserId: jid })
    : resolveOrCreateCustomer({
        platform: 'WHATSAPP',
        platformUserId: jid,
        platformUsername: pushName || null,
      });
  if (!resolved) {
    await sock.sendMessage(jid, {
      text: `*Riwayat Transaksi*\nKredit Refund Internal: Rp0\n\nBelum ada riwayat transaksi ya Kak.`,
      quickReplies: NAV_BACK_BUTTONS,
    });
    return;
  }
  const { customer } = resolved;
  const txs = getCustomerTransactions(customer.id, 5);
  const refundTotal = getCustomerRefundCreditTotal(customer.id);

  const lines = txs.map(
    (t) =>
      `• ${t.transaction_id} — ${t.product_name_snapshot} (Rp${t.payment_amount.toLocaleString('id-ID')}) [${t.transaction_status}]`
  );
  await sock.sendMessage(jid, {
    text:
      `*Riwayat Transaksi (${customer.customer_code})*\n` +
      `Kredit Refund Internal: Rp${refundTotal.toLocaleString('id-ID')}\n\n` +
      (lines.length > 0 ? lines.join('\n') : 'Belum ada riwayat transaksi ya Kak.'),
    quickReplies: NAV_BACK_BUTTONS,
  });
}

export async function handleWhatsappCommand(
  sock: WhatsappReplyTransport,
  jid: string,
  text: string,
  pushName?: string,
  options?: WhatsappCommandOptions
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const dryRun = Boolean(options?.dryRun);
  const now = options?.now ?? Date.now();
  // Rule: 3-second per-user cooldown. Ignore repeat messages within 3s.
  if ((!dryRun || options?.enforceCooldown) && !checkWhatsappCooldown(jid, now)) {
    return;
  }

  // Optional prefix (!, ., or /) is still supported, while plain text without prefix works directly
  const hasPrefix = trimmed.startsWith('!') || trimmed.startsWith('.') || trimmed.startsWith('/');
  const withoutPrefix = hasPrefix ? trimmed.slice(1).trim() : trimmed;
  if (!withoutPrefix) return;

  const parts = withoutPrefix.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Admin commands (require backend RBAC verification via admin_identities)
  // Note: allow non-admin customers to use "cari <kata kunci>" for product search seamlessly
  if (WA_ADMIN_COMMANDS.has(cmd)) {
    const admin: ResolvedAdmin | null = dryRun
      ? options?.demoAdmin
        ? {
            id: 0,
            name: 'Demo Admin',
            role: options.demoAdmin.role,
            permissions: getEffectivePermissions(options.demoAdmin.role, []),
            platformUserId: options.demoAdmin.platformUserId,
          }
        : null
      : resolveAdminByPlatform('WHATSAPP', jid);
    if (cmd === 'cari' && (!admin || (args[0] && !/^TRX-/i.test(args[0])))) {
      const q = args.join(' ').trim();
      if (q) {
        await sendProductPage(sock, jid, { page: 1, search: q }, dryRun);
      } else {
        await promptWhatsappSearch(sock, jid, undefined, dryRun);
      }
      return;
    }
    if (!admin) {
      await sock.sendMessage(jid, {
        text: 'Maaf, perintah admin ditolak atau tidak dikenali. Silakan gunakan Menu Utama untuk layanan pelanggan ya Kak.',
        quickReplies: [[{ text: '🏠 Buka Menu Utama', replyText: '!menu' }]],
      });
      return;
    }

    const adminMenuButtons: WhatsappQuickButton[][] = [
      [
        { text: '📊 Transaksi Terbaru', replyText: '!transaksi' },
        { text: '🩺 Status Layanan', replyText: '!statusbot' },
      ],
      [{ text: '🏠 Menu Pelanggan', replyText: '!menu' }],
    ];

    if (cmd === 'admin') {
      await sock.sendMessage(jid, {
        text:
          `*Panel Admin WhatsApp (${admin.role})*\n` +
          `Halo Admin, pilih menu pengelolaan cepat di bawah ini:\n\n` +
          `• transaksi [halaman] — Ringkasan & riwayat transaksi\n` +
          `• cari <TRX_ID> — Detail transaksi\n` +
          `• statusbot — Status layanan & scheduler\n` +
          `• maintenance on|off — Ubah maintenance mode`,
        quickReplies: adminMenuButtons,
      });
      return;
    }

    if (cmd === 'transaksi') {
      if (!checkAdminPermission(admin, 'transactions:read')) {
        await sock.sendMessage(jid, { text: 'Maaf, akses ditolak: permission transactions:read diperlukan.' });
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
        (i) =>
          `• ${i.transaction_id} | ${i.product_name_snapshot} | Rp${i.payment_amount.toLocaleString('id-ID')} | ${i.transaction_status}`
      );
      await sock.sendMessage(jid, {
        text:
          `*Ringkasan Transaksi (Hal ${report.page}/${report.totalPages})*\n` +
          `Total: ${report.summary.totalCount} | Sukses: ${report.summary.successCount} | Pending: ${report.summary.pendingCount} | Gagal: ${report.summary.failedCount} | Expired: ${report.summary.expiredCount}\n` +
          `Total Nominal: Rp${report.summary.totalAmount.toLocaleString('id-ID')}\n\n` +
          (lines.length > 0 ? lines.join('\n') : 'Belum ada transaksi.'),
        quickReplies: adminMenuButtons,
      });
      return;
    }

    if (cmd === 'cari') {
      if (!checkAdminPermission(admin, 'transactions:read')) {
        await sock.sendMessage(jid, { text: 'Maaf, akses ditolak.' });
        return;
      }
      const txId = args[0]?.trim();
      if (!txId) {
        await sock.sendMessage(jid, { text: 'Silakan sertakan ID transaksi: !cari <TRANSACTION_ID>' });
        return;
      }
      const detail = getTransactionDetail(txId);
      if (!detail) {
        await sock.sendMessage(jid, { text: `Transaksi ${txId} tidak ditemukan.` });
        return;
      }
      const t = detail.transaction;
      await sock.sendMessage(jid, {
        text:
          `*Detail Transaksi ${t.transaction_id}*\n` +
          `Pelanggan: ${t.customer_code}\n` +
          `Produk: ${t.product_name_snapshot} (${t.product_sku_snapshot})\n` +
          `Tujuan: ${t.destination_masked}\n` +
          `Nominal: Rp${t.payment_amount.toLocaleString('id-ID')} (unik: ${t.unique_code})\n` +
          `Status: ${t.transaction_status}\n` +
          `Pembayaran: ${t.payment_status} | Supplier: ${t.supplier_status}\n` +
          `Ref Gateway: ${t.gateway_reference || '-'}\n` +
          `Ref Supplier: ${t.supplier_reference || '-'}`,
        quickReplies: adminMenuButtons,
      });
      return;
    }

    if (cmd === 'statusbot') {
      if (!checkAdminPermission(admin, 'bots:read')) {
        await sock.sendMessage(jid, { text: 'Maaf, akses ditolak.' });
        return;
      }
      const sched = centralScheduler.getStatus();
      await sock.sendMessage(jid, {
        text:
          `*Status Layanan*\n` +
          `Maintenance Mode: ${isMaintenanceMode() ? 'AKTIF' : 'NONAKTIF'}\n` +
          `Scheduler: ${sched.running ? 'RUNNING' : 'STOPPED'}\n` +
          `Last Payment Poll: ${sched.lastPaymentPollAt || '-'}\n` +
          `Last Supplier Poll: ${sched.lastSupplierPollAt || '-'}`,
        quickReplies: adminMenuButtons,
      });
      return;
    }

    if (cmd === 'maintenance') {
      if (!checkAdminPermission(admin, 'maintenance:toggle')) {
        await sock.sendMessage(jid, { text: 'Maaf, akses ditolak: butuh permission maintenance:toggle.' });
        return;
      }
      const val = args[0]?.toLowerCase();
      if (val !== 'on' && val !== 'off') {
        await sock.sendMessage(jid, { text: 'Gunakan: !maintenance on atau !maintenance off' });
        return;
      }
      const next = val === 'on';
      if (dryRun) {
        await sock.sendMessage(jid, {
          text: `[Mode Demo] Maintenance mode akan diubah menjadi: ${next ? 'AKTIF' : 'NONAKTIF'} (tidak mengubah status server aktif).`,
          quickReplies: adminMenuButtons,
        });
        return;
      }
      setMaintenanceMode(next, { id: `WA:${admin.platformUserId}`, role: admin.role }, 'Perintah WhatsApp Admin');
      await sock.sendMessage(jid, {
        text: `Maintenance mode berhasil diubah menjadi: ${next ? 'AKTIF' : 'NONAKTIF'}.`,
        quickReplies: adminMenuButtons,
      });
      return;
    }
  }

  // Known Customer Commands (reset or update conversational flow cleanly)
  if (cmd === 'batal' || cmd === 'cancel' || withoutPrefix === '0') {
    const activeSession = getBotSession('WHATSAPP', jid, dryRun);
    if (activeSession?.mode === 'AWAITING_ORDER_CONFIRMATION' && !args[0]) {
      clearBotSession('WHATSAPP', jid, dryRun);
      await sock.sendMessage(jid, {
        text: 'Pembuatan pesanan dibatalkan sebelum QRIS dibuat.',
        quickReplies: NAV_BACK_BUTTONS,
      });
      return;
    }
    if (
      ((activeSession?.mode === 'AWAITING_DESTINATION' ||
        activeSession?.mode === 'AWAITING_VOUCHER_CODE' ||
        activeSession?.mode === 'BRAND_LIST' ||
        activeSession?.mode === 'SERIES_LIST' ||
        activeSession?.mode === 'DURATION_LIST' ||
        activeSession?.mode === 'AWAITING_SEARCH_QUERY') &&
        !args[0]) ||
      withoutPrefix === '0'
    ) {
      clearBotSession('WHATSAPP', jid, dryRun);
      await sendMainMenu(sock, jid, pushName, dryRun, options?.demoAdmin);
      return;
    }
    clearBotSession('WHATSAPP', jid, dryRun);
    await handleWhatsappOrderCancellation(sock, jid, {
      transactionId: args[0]?.trim(),
      dryRun,
      pushName,
    });
    return;
  }

  if (cmd === 'menu' || cmd === 'start' || cmd === 'hai' || cmd === 'halo' || cmd === 'hi') {
    await sendMainMenu(sock, jid, pushName, dryRun, options?.demoAdmin);
    return;
  }

  if (cmd === 'profil' || cmd === 'profile') {
    await sendWhatsappProfile(sock, jid, pushName, dryRun);
    return;
  }

  if (cmd === 'voucher' || cmd === 'redeem') {
    await handleWhatsappVoucherCommand(sock, jid, args[0], dryRun);
    return;
  }

  if (cmd === 'kontak' || cmd === 'hubungi_admin' || cmd === 'cs' || cmd === 'support') {
    await sendWhatsappContactAdmin(sock, jid, dryRun);
    return;
  }

  if (cmd === 'bantuan' || cmd === 'help') {
    clearBotSession('WHATSAPP', jid, dryRun);
    await sock.sendMessage(jid, {
      text:
        `*Panduan Belanja Praktis*\n` +
        `1. Ketik *kategori* atau *produk* (lalu pilih angka atau kirim *nomor HP* untuk deteksi operator otomatis).\n` +
        `2. Pilih angka produk yang Anda inginkan, kirim *nomor tujuan*, lalu balas *ya* atau *batal*.\n` +
        `3. Scan QRIS atau buka Link Pembayaran sesuai nominal tepat sebelum batas waktu.\n` +
        `4. Ketik *batal* untuk membatalkan pesanan PENDING (minimal 30 detik setelah dibuat).\n\n` +
        `Bisa juga ketik langsung: \`order <SKU> <TUJUAN> [KUPON]\` bila sudah hafal kode SKU.`,
      quickReplies: MAIN_MENU_BUTTONS,
    });
    return;
  }

  if (cmd === 'kategori') {
    await sendCategoryList(sock, jid, dryRun);
    return;
  }

  if (cmd === 'cari_produk') {
    const q = args.join(' ').trim();
    if (q) {
      await sendProductPage(sock, jid, { page: 1, search: q }, dryRun);
    } else {
      await promptWhatsappSearch(sock, jid, undefined, dryRun);
    }
    return;
  }

  if (cmd === 'cari_scope') {
    const session = getBotSession('WHATSAPP', jid, dryRun);
    await promptWhatsappSearch(
      sock,
      jid,
      {
        categoryId: session && 'categoryId' in session ? session.categoryId : undefined,
        brand: session && 'brand' in session ? session.brand : undefined,
        series: session && 'series' in session ? session.series : undefined,
        durationBucket: session?.mode === 'PRODUCT_LIST' ? session.durationBucket : undefined,
        detectedDestination:
          session && 'detectedDestination' in session ? session.detectedDestination : undefined,
        detectedOperatorLabel:
          session && 'detectedOperatorLabel' in session ? session.detectedOperatorLabel : undefined,
      },
      dryRun
    );
    return;
  }

  if (cmd === 'seri') {
    const session = getBotSession('WHATSAPP', jid, dryRun);
    const arg = (args[0] || '').trim();
    if (session && (session.mode === 'SERIES_LIST' || session.mode === 'DURATION_LIST')) {
      if (arg.toUpperCase() === 'ALL') {
        await enterWhatsappSeriesCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: session.brand,
            series: undefined,
            hasSeriesStep: true,
            detectedDestination: session.detectedDestination,
            detectedOperatorLabel: session.detectedOperatorLabel,
          },
          dryRun
        );
        return;
      }
      const idx = Number(arg);
      if (session.mode === 'SERIES_LIST' && Number.isFinite(idx) && session.seriesList[idx]) {
        await enterWhatsappSeriesCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: session.brand,
            series: session.seriesList[idx],
            hasSeriesStep: true,
            detectedDestination: session.detectedDestination,
            detectedOperatorLabel: session.detectedOperatorLabel,
          },
          dryRun
        );
        return;
      }
    }
    await sendCategoryList(sock, jid, dryRun);
    return;
  }

  if (cmd === 'durasi') {
    const session = getBotSession('WHATSAPP', jid, dryRun);
    const bucket = durationBucketFromCode(args[0]);
    if (bucket && session?.mode === 'DURATION_LIST') {
      await sendProductPage(
        sock,
        jid,
        {
          page: 1,
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          durationBucket: bucket,
          hasSeriesStep: session.hasSeriesStep,
          hasDurationStep: true,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    await sendCategoryList(sock, jid, dryRun);
    return;
  }

  if (cmd === 'kembali_seri') {
    const session = getBotSession('WHATSAPP', jid, dryRun);
    if (
      session &&
      (session.mode === 'DURATION_LIST' || session.mode === 'PRODUCT_LIST') &&
      session.categoryId &&
      session.brand
    ) {
      await enterWhatsappBrandCatalog(
        sock,
        jid,
        {
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    await sendCategoryList(sock, jid, dryRun);
    return;
  }

  if (cmd === 'kembali_durasi') {
    const session = getBotSession('WHATSAPP', jid, dryRun);
    if (session?.mode === 'PRODUCT_LIST' && session.categoryId && session.brand) {
      await enterWhatsappSeriesCatalog(
        sock,
        jid,
        {
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          hasSeriesStep: session.hasSeriesStep,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    await sendCategoryList(sock, jid, dryRun);
    return;
  }

  if (cmd === 'produk_filter') {
    const page = Math.max(1, Number(args[0]) || 1);
    const session = getBotSession('WHATSAPP', jid, dryRun);
    if (session?.mode === 'PRODUCT_LIST') {
      await sendProductPage(
        sock,
        jid,
        {
          page,
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          durationBucket: session.durationBucket,
          search: session.search,
          hasSeriesStep: session.hasSeriesStep,
          hasDurationStep: session.hasDurationStep,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    await sendProductPage(sock, jid, { page }, dryRun);
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
            await enterWhatsappBrandCatalog(
              sock,
              jid,
              {
                categoryId: pulsaCat.id,
                categoryName: pulsaCat.name,
                brand: matched,
                detectedDestination: detected.normalizedPhone,
                detectedOperatorLabel: detected.displayName,
              },
              dryRun
            );
            return;
          }
        }
      }
      await sendCategoryBrandOrProducts(sock, jid, pulsaCat.id, dryRun);
      return;
    }
    await sendCategoryList(sock, jid, dryRun);
    return;
  }

  if (cmd === 'produk') {
    const search = args.join(' ').trim() || undefined;
    await sendProductPage(sock, jid, { page: 1, search }, dryRun);
    return;
  }

  if (cmd === 'produk_hal') {
    const page = Math.max(1, Number(args[0]) || 1);
    await sendProductPage(sock, jid, { page }, dryRun);
    return;
  }

  if (cmd === 'produk_brand') {
    const categoryId = Number(args[0]) || undefined;
    const page = Math.max(1, Number(args[1]) || 1);
    const brand = args.slice(2).join(' ').trim() || undefined;
    const existingSession = getBotSession('WHATSAPP', jid, dryRun);
    const detectedDestination =
      existingSession && 'detectedDestination' in existingSession
        ? existingSession.detectedDestination
        : undefined;
    const detectedOperatorLabel =
      existingSession && 'detectedOperatorLabel' in existingSession
        ? existingSession.detectedOperatorLabel
        : undefined;
    if (categoryId && brand && page === 1) {
      await enterWhatsappBrandCatalog(
        sock,
        jid,
        {
          categoryId,
          brand,
          detectedDestination,
          detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    await sendProductPage(
      sock,
      jid,
      { page, categoryId, brand, detectedDestination, detectedOperatorLabel },
      dryRun
    );
    return;
  }

  if (cmd === 'produk_kat') {
    const categoryId = Number(args[0]) || undefined;
    const page = Math.max(1, Number(args[1]) || 1);
    if (categoryId && page === 1) {
      await sendCategoryBrandOrProducts(sock, jid, categoryId, dryRun);
    } else {
      await sendProductPage(sock, jid, { page, categoryId }, dryRun);
    }
    return;
  }

  if (cmd === 'pilih' && args[0]) {
    const skuOrId = args[0].trim();
    const session = getBotSession('WHATSAPP', jid, dryRun);
    if (session?.mode === 'PRODUCT_LIST' && session.detectedDestination) {
      const product = getProductBySkuOrId(skuOrId);
      if (product && product.status === 'ACTIVE' && product.is_available === 1) {
        await promptWhatsappOrderConfirmation(sock, jid, {
          sku: product.sku,
          destination: session.detectedDestination,
          dryRun,
        });
        return;
      }
    }
    await promptProductDestination(sock, jid, skuOrId, dryRun);
    return;
  }

  if (cmd === 'tujuan' && args[0]) {
    const session = getBotSession('WHATSAPP', jid, dryRun);
    if (session?.mode === 'AWAITING_DESTINATION') {
      await promptWhatsappOrderConfirmation(sock, jid, {
        sku: session.sku,
        destination: args[0],
        couponCode: args[1] || null,
        dryRun,
      });
      return;
    }
  }

  if (cmd === 'order') {
    if (args.length < 2) {
      await sock.sendMessage(jid, {
        text:
          `Supaya lebih praktis, Kakak bisa ketik *produk* atau *kategori* lalu balas angka produk tanpa mengetik format manual.\n` +
          `Atau ketik: *order <SKU> <TUJUAN> [KODE_KUPON]*`,
        quickReplies: NAV_BACK_BUTTONS,
      });
      return;
    }
    const [sku, destination, couponCode] = args;
    await promptWhatsappOrderConfirmation(sock, jid, { sku, destination, couponCode, dryRun });
    return;
  }

  if (cmd === 'status') {
    clearBotSession('WHATSAPP', jid, dryRun);
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'WHATSAPP', platformUserId: jid })
      : resolveOrCreateCustomer({
          platform: 'WHATSAPP',
          platformUserId: jid,
          platformUsername: pushName || null,
        });
    const txId = args[0]?.trim();
    if (txId) {
      const detail = resolved ? getTransactionDetail(txId) : null;
      if (!detail || !resolved || detail.transaction.customer_id !== resolved.customer.id) {
        if (dryRun && txId.startsWith('TRX-DEMO-')) {
          await sock.sendMessage(jid, {
            text:
              `*Status Transaksi ${txId} (Mode Demo)*\n` +
              `Status: *PENDING_PAYMENT*\nPembayaran: PENDING | Supplier: NONE`,
            quickReplies: NAV_BACK_BUTTONS,
          });
          return;
        }
        await sock.sendMessage(jid, {
          text: 'Maaf Kak, transaksi tersebut tidak ditemukan pada akun Anda.',
          quickReplies: NAV_BACK_BUTTONS,
        });
        return;
      }
      const t = detail.transaction;
      const canCancel = ['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(t.transaction_status);
      const buttons: WhatsappQuickButton[][] = canCancel
        ? [[{ text: '🚫 Batalkan Pesanan', replyText: `!batal ${t.transaction_id}` }], ...NAV_BACK_BUTTONS]
        : NAV_BACK_BUTTONS;
      await sock.sendMessage(jid, {
        text:
          `*Status Transaksi ${t.transaction_id}*\n` +
          `Produk: ${t.product_name_snapshot}\n` +
          `Tujuan: ${t.destination_masked}\n` +
          `Nominal: Rp${t.payment_amount.toLocaleString('id-ID')}\n` +
          `Status: *${t.transaction_status}*\n` +
          (t.supplier_sn ? `SN / Token: ${t.supplier_sn}\n` : ''),
        quickReplies: buttons,
      });
      return;
    }

    const recent = resolved ? getCustomerTransactions(resolved.customer.id, 1) : [];
    if (recent.length === 0) {
      await sock.sendMessage(jid, {
        text: 'Kakak belum memiliki riwayat transaksi saat ini. Yuk coba lihat produk kami!',
        quickReplies: NAV_BACK_BUTTONS,
      });
      return;
    }
    const latest = recent[0];
    const canCancel = ['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(latest.transaction_status);
    const buttons: WhatsappQuickButton[][] = [];
    if (canCancel) {
      buttons.push([{ text: '🚫 Batalkan Pesanan', replyText: `!batal ${latest.transaction_id}` }]);
    }
    buttons.push([
      { text: '📜 Lihat Semua Riwayat', replyText: '!riwayat' },
      { text: '🏠 Menu Utama', replyText: '!menu' },
    ]);
    await sock.sendMessage(jid, {
      text:
        `*Transaksi Terakhir (${latest.transaction_id})*\n` +
        `Produk: ${latest.product_name_snapshot}\n` +
        `Nominal: Rp${latest.payment_amount.toLocaleString('id-ID')}\n` +
        `Status: *${latest.transaction_status}*`,
      quickReplies: buttons,
    });
    return;
  }

  if (cmd === 'riwayat') {
    await sendWhatsappHistory(sock, jid, pushName, dryRun);
    return;
  }

  if (cmd === 'hubungkan') {
    clearBotSession('WHATSAPP', jid, dryRun);
    const code = args[0]?.trim();
    if (dryRun) {
      await sock.sendMessage(jid, {
        text: code
          ? `[Mode Demo] Simulasi verifikasi kode hubung "${code}" — tidak menautkan akun nyata.`
          : `*Kode Penghubung Akun (Simulasi Demo)*\nKirim perintah berikut di Bot Telegram dalam ${config.accountLinking.codeExpiryMinutes} menit:\n/hubungkan DEMO-123456\n\n_[Mode Demo: token tidak dibuat di database]_`,
        quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
      });
      return;
    }
    if (!code) {
      const res = requestAccountLinkCode({
        platform: 'WHATSAPP',
        platformUserId: jid,
        platformUsername: pushName || null,
      });
      if (!res.ok) {
        await sock.sendMessage(jid, {
          text: res.errorMessage || 'Gagal membuat kode penghubung.',
          quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
        });
        return;
      }
      await sock.sendMessage(jid, {
        text:
          `*Kode Penghubung Akun*\n` +
          `Kirim perintah berikut di Bot Telegram dalam ${config.accountLinking.codeExpiryMinutes} menit:\n` +
          `/hubungkan ${res.code}\n\n` +
          `Jangan bagikan kode ini kepada siapa pun ya Kak.`,
        quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
      });
      return;
    }

    const verify = verifyAndLinkAccount({
      targetPlatform: 'WHATSAPP',
      targetPlatformUserId: jid,
      targetPlatformUsername: pushName || null,
      rawCode: code,
    });
    await sock.sendMessage(jid, {
      text: verify.ok
        ? `Yeay! Akun WhatsApp Kakak berhasil dihubungkan dengan akun ${verify.customerCode}. Riwayat transaksi kini tergabung.`
        : verify.errorMessage || 'Maaf Kak, gagal menghubungkan akun.',
      quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
    });
    return;
  }

  if (cmd === 'unlink') {
    clearBotSession('WHATSAPP', jid, dryRun);
    if (dryRun) {
      await sock.sendMessage(jid, {
        text: '[Mode Demo] Simulasi unlink WhatsApp — identitas nyata tidak diubah.',
        quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
      });
      return;
    }
    const res = unlinkPlatformIdentity({ platform: 'WHATSAPP', platformUserId: jid });
    await sock.sendMessage(jid, {
      text: res.ok
        ? 'Identitas WhatsApp berhasil diputuskan dari akun gabungan.'
        : res.errorMessage || 'Maaf, gagal unlink akun.',
      quickReplies: [[{ text: '🏠 Menu Utama', replyText: '!menu' }]],
    });
    return;
  }

  // Interactive conversation state fallback (prefixed confirmations, destination entry, voucher code, & numeric selection)
  const session = getBotSession('WHATSAPP', jid, dryRun);
  if (session?.mode === 'AWAITING_ORDER_CONFIRMATION') {
    if (['ya', 'iya', 'ok', 'oke', 'lanjut', 'konfirmasi', 'y'].includes(cmd)) {
      if (!acquireOrderExecutionLock('WHATSAPP', jid, dryRun)) {
        return;
      }
      try {
        await executeWhatsappOrder(sock, jid, {
          sku: session.sku,
          destination: session.destination,
          couponCode: session.couponCode || null,
          pushName,
          dryRun,
        });
      } finally {
        releaseOrderExecutionLock('WHATSAPP', jid, dryRun);
      }
      return;
    }
    if (['tidak', 'no', 'n', 'nggak', 'gak'].includes(cmd)) {
      clearBotSession('WHATSAPP', jid, dryRun);
      await sock.sendMessage(jid, {
        text: 'Pembuatan pesanan dibatalkan sebelum QRIS dibuat.',
        quickReplies: NAV_BACK_BUTTONS,
      });
      return;
    }
    await sock.sendMessage(jid, {
      text: dryRun
        ? `Pesanan *${session.productName}* (${session.destination}) menunggu konfirmasi Anda.\nTap tombol *Ya, Buat QRIS* atau *Batal* di bawah ini:`
        : `Pesanan *${session.productName}* (${session.destination}) menunggu konfirmasi Anda.\nBalas *ya* untuk membuat QRIS atau *batal* untuk membatalkan:`,
      quickReplies: [
        [
          { text: '✅ Ya, Buat QRIS', replyText: '!ya' },
          { text: '❌ Batal', replyText: '!batal' },
        ],
      ],
    });
    return;
  }

  if (session?.mode === 'AWAITING_DESTINATION' && !WA_RESERVED_COMMANDS.has(cmd)) {
    const [dest, coupon] = parts;
    await promptWhatsappOrderConfirmation(sock, jid, {
      sku: session.sku,
      destination: dest,
      couponCode: coupon || null,
      dryRun,
    });
    return;
  }

  if (session?.mode === 'AWAITING_VOUCHER_CODE' && !WA_RESERVED_COMMANDS.has(cmd)) {
    await handleWhatsappVoucherCommand(sock, jid, parts[0], dryRun);
    return;
  }

  if (session?.mode === 'AWAITING_SEARCH_QUERY' && !WA_RESERVED_COMMANDS.has(cmd)) {
    await sendProductPage(
      sock,
      jid,
      {
        page: 1,
        categoryId: session.categoryId,
        brand: session.brand,
        series: session.series,
        durationBucket: session.durationBucket,
        search: withoutPrefix,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
      },
      dryRun
    );
    return;
  }

  const numericChoice = /^\d+$/.test(withoutPrefix) ? Number(withoutPrefix) : null;
  if (session?.mode === 'BRAND_LIST' && !WA_RESERVED_COMMANDS.has(cmd)) {
    if (numericChoice !== null && numericChoice >= 1 && numericChoice <= session.brands.length) {
      const chosenBrand = session.brands[numericChoice - 1];
      await enterWhatsappBrandCatalog(
        sock,
        jid,
        {
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: chosenBrand,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }

    const detected = detectOperatorFromPhone(withoutPrefix);
    if (detected) {
      const matchedBrand = matchBrandForDetectedOperator(session.brands, detected);
      if (matchedBrand) {
        await enterWhatsappBrandCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: matchedBrand,
            detectedDestination: detected.normalizedPhone,
            detectedOperatorLabel: detected.displayName,
          },
          dryRun
        );
        return;
      }

      const activeBrands = listActiveBrandsInCategory(session.categoryId).slice(0, 14);
      setBotSession(
        'WHATSAPP',
        jid,
        {
          ...session,
          detectedDestination: detected.normalizedPhone,
          updatedAt: Date.now(),
        },
        dryRun
      );
      const brandAltLines = activeBrands
        .map((b, idx) => `${idx + 1}. *${b.brand}*`)
        .join('\n');
      await sock.sendMessage(jid, {
        text:
          `Nomor *${detected.normalizedPhone}* terdeteksi operator *${detected.displayName}*, namun produk ${detected.displayName} aktif belum tersedia di kategori *${session.categoryName}*.\n` +
          `Silakan pilih operator/brand lain (nomor tetap tersimpan):\n\n` +
          (brandAltLines || '_Belum ada brand aktif lainnya._'),
        quickReplies: buildWhatsappBrandButtons(session.categoryId, activeBrands),
      });
      return;
    }

    await sendProductPage(
      sock,
      jid,
      {
        page: 1,
        categoryId: session.categoryId,
        search: withoutPrefix,
        detectedDestination: session.detectedDestination,
      },
      dryRun
    );
    return;
  }

  if (session?.mode === 'SERIES_LIST' && !WA_RESERVED_COMMANDS.has(cmd)) {
    if (cmd === 'semua' || cmd === 'all') {
      await enterWhatsappSeriesCatalog(
        sock,
        jid,
        {
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: undefined,
          hasSeriesStep: true,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    if (cmd === 'kembali' || cmd === 'back') {
      await sendCategoryBrandOrProducts(sock, jid, session.categoryId, dryRun);
      return;
    }
    if (numericChoice !== null && numericChoice >= 1 && numericChoice <= session.seriesList.length) {
      const chosenSeries = session.seriesList[numericChoice - 1];
      await enterWhatsappSeriesCatalog(
        sock,
        jid,
        {
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: chosenSeries,
          hasSeriesStep: true,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }

    const detected = detectOperatorFromPhone(withoutPrefix);
    if (detected) {
      const brands = listActiveBrandsInCategory(session.categoryId).map((b) => b.brand);
      const matchedBrand = matchBrandForDetectedOperator(brands, detected);
      if (matchedBrand) {
        await enterWhatsappBrandCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: matchedBrand,
            detectedDestination: detected.normalizedPhone,
            detectedOperatorLabel: detected.displayName,
          },
          dryRun
        );
        return;
      }
    }

    await sendProductPage(
      sock,
      jid,
      {
        page: 1,
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        brand: session.brand,
        search: withoutPrefix,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
      },
      dryRun
    );
    return;
  }

  if (session?.mode === 'DURATION_LIST' && !WA_RESERVED_COMMANDS.has(cmd)) {
    if (cmd === 'semua' || cmd === 'all') {
      await sendProductPage(
        sock,
        jid,
        {
          page: 1,
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          durationBucket: 'ALL',
          hasSeriesStep: session.hasSeriesStep,
          hasDurationStep: true,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    if (cmd === 'kembali' || cmd === 'back') {
      if (session.hasSeriesStep && session.brand) {
        await enterWhatsappBrandCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: session.brand,
            detectedDestination: session.detectedDestination,
            detectedOperatorLabel: session.detectedOperatorLabel,
          },
          dryRun
        );
      } else {
        await sendCategoryBrandOrProducts(sock, jid, session.categoryId, dryRun);
      }
      return;
    }
    if (
      numericChoice !== null &&
      numericChoice >= 1 &&
      numericChoice <= session.durationBuckets.length
    ) {
      const chosenBucket = session.durationBuckets[numericChoice - 1];
      await sendProductPage(
        sock,
        jid,
        {
          page: 1,
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          durationBucket: chosenBucket,
          hasSeriesStep: session.hasSeriesStep,
          hasDurationStep: true,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }

    const detected = detectOperatorFromPhone(withoutPrefix);
    if (detected) {
      const brands = listActiveBrandsInCategory(session.categoryId).map((b) => b.brand);
      const matchedBrand = matchBrandForDetectedOperator(brands, detected);
      if (matchedBrand) {
        await enterWhatsappBrandCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: matchedBrand,
            detectedDestination: detected.normalizedPhone,
            detectedOperatorLabel: detected.displayName,
          },
          dryRun
        );
        return;
      }
    }

    await sendProductPage(
      sock,
      jid,
      {
        page: 1,
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        brand: session.brand,
        series: session.series,
        search: withoutPrefix,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
      },
      dryRun
    );
    return;
  }

  if (session?.mode === 'PRODUCT_LIST' && !WA_RESERVED_COMMANDS.has(cmd)) {
    if (cmd === 'next' || cmd === 'berikutnya' || cmd === 'lanjut') {
      await sendProductPage(
        sock,
        jid,
        {
          page: session.page + 1,
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          durationBucket: session.durationBucket,
          search: session.search,
          hasSeriesStep: session.hasSeriesStep,
          hasDurationStep: session.hasDurationStep,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    if (cmd === 'prev' || cmd === 'sebelumnya' || cmd === 'mundur') {
      await sendProductPage(
        sock,
        jid,
        {
          page: Math.max(1, session.page - 1),
          categoryId: session.categoryId,
          categoryName: session.categoryName,
          brand: session.brand,
          series: session.series,
          durationBucket: session.durationBucket,
          search: session.search,
          hasSeriesStep: session.hasSeriesStep,
          hasDurationStep: session.hasDurationStep,
          detectedDestination: session.detectedDestination,
          detectedOperatorLabel: session.detectedOperatorLabel,
        },
        dryRun
      );
      return;
    }
    if (cmd === 'kembali' || cmd === 'back') {
      if (session.hasDurationStep && session.categoryId && session.brand) {
        await enterWhatsappSeriesCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: session.brand,
            series: session.series,
            hasSeriesStep: session.hasSeriesStep,
            detectedDestination: session.detectedDestination,
            detectedOperatorLabel: session.detectedOperatorLabel,
          },
          dryRun
        );
        return;
      }
      if (session.hasSeriesStep && session.categoryId && session.brand) {
        await enterWhatsappBrandCatalog(
          sock,
          jid,
          {
            categoryId: session.categoryId,
            categoryName: session.categoryName,
            brand: session.brand,
            detectedDestination: session.detectedDestination,
            detectedOperatorLabel: session.detectedOperatorLabel,
          },
          dryRun
        );
        return;
      }
      if (session.categoryId) {
        await sendCategoryBrandOrProducts(sock, jid, session.categoryId, dryRun);
        return;
      }
      await sendCategoryList(sock, jid, dryRun);
      return;
    }
  }

  if (numericChoice !== null) {
    if (session?.mode === 'CATEGORY_LIST') {
      const catId = session.categoryIds[numericChoice - 1];
      if (catId) {
        await sendCategoryBrandOrProducts(sock, jid, catId, dryRun);
        return;
      }
    } else if (session?.mode === 'PRODUCT_LIST') {
      const chosenSku = session.skus[numericChoice - 1];
      if (chosenSku) {
        if (session.detectedDestination) {
          await promptWhatsappOrderConfirmation(sock, jid, {
            sku: chosenSku,
            destination: session.detectedDestination,
            dryRun,
          });
        } else {
          await promptProductDestination(sock, jid, chosenSku, dryRun);
        }
        return;
      }
    } else if (numericChoice >= 1 && numericChoice <= 6) {
      if (numericChoice === 1) return sendCategoryList(sock, jid, dryRun);
      if (numericChoice === 2) return sendProductPage(sock, jid, { page: 1 }, dryRun);
      if (numericChoice === 3) return sendWhatsappProfile(sock, jid, pushName, dryRun);
      if (numericChoice === 4) return handleWhatsappVoucherCommand(sock, jid, null, dryRun);
      if (numericChoice === 5) return sendWhatsappHistory(sock, jid, pushName, dryRun);
      if (numericChoice === 6) return sendWhatsappContactAdmin(sock, jid, dryRun);
    }
  }

  // Direct SKU lookup shortcut
  const sampleProduct = getProductBySkuOrId(withoutPrefix);
  if (sampleProduct) {
    await promptProductDestination(sock, jid, sampleProduct.sku, dryRun);
    return;
  }

  // Friendly fallback with numbered menu (and quick-reply buttons for simulator)
  await sock.sendMessage(jid, {
    text:
      `${greetingPrefix(pushName)}! Maaf, saya belum memahami perintah "${trimmed}".\n\n` +
      `Silakan balas *angka* atau ketik menu berikut ya Kak:\n` +
      `*1.* 📂 Kategori Produk (kategori)\n` +
      `*2.* 🛒 Daftar Produk (produk)\n` +
      `*3.* 👤 Profil & Saldo (profil)\n` +
      `*4.* 🎟️ Redeem Voucher (voucher)\n` +
      `*5.* 📜 Riwayat Transaksi (riwayat)\n` +
      `*6.* 👨‍💼 Hubungi Admin (kontak)`,
    quickReplies: MAIN_MENU_BUTTONS,
  });
}
