import { getEffectivePermissions, type AdminRole } from '../domain/rbac';
import QRCode from 'qrcode';
import { config } from '../config/env';
import { logger } from '../logging/logger';
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
import { fetchQrisImageBuffer } from '../integrations/qris-image';
import {
  resolveAdminByPlatform,
  checkAdminPermission,
  getAdminBotTransactionReport,
  type ResolvedAdmin,
} from '../services/admin.service';
import { isMaintenanceMode, setMaintenanceMode } from '../services/settings.service';
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
    { text: 'Kategori Produk', replyText: '!kategori' },
    { text: 'Daftar Produk', replyText: '!produk' },
  ],
  [
    { text: 'Profil & Saldo', replyText: '!profil' },
    { text: 'Redeem Voucher', replyText: '!voucher' },
  ],
  [
    { text: 'Riwayat Transaksi', replyText: '!riwayat' },
    { text: 'Hubungi Admin', replyText: '!kontak' },
  ],
];

const NAV_BACK_BUTTONS: WhatsappQuickButton[][] = [
  [
    { text: 'Daftar Produk', replyText: '!produk' },
    { text: 'Menu Utama', replyText: '!menu' },
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
  const totalUsers = getTotalBotUsersCount();
  const isAdmin = dryRun ? Boolean(demoAdmin) : Boolean(resolveAdminByPlatform('WHATSAPP', jid));

  await sock.sendMessage(jid, {
    text:
      `${formatStartMessage({
        displayName: pushName,
        shopName: config.shopName,
        userId: summary.userId,
        isAdmin,
        totalUsers,
      })}\n\n` +
      `*Menu Utama (Prefix ! / .):*\n` +
      `• *!kategori* — Kategori Produk\n` +
      `• *!produk* — Daftar Produk\n` +
      `• *!profil* — Profil & Saldo\n` +
      `• *!voucher* — Redeem Voucher\n` +
      `• *!riwayat* — Riwayat Transaksi\n` +
      `• *!kontak* — Hubungi Admin\n\n` +
      `_Gunakan awalan *!* atau *.* untuk setiap perintah (misal: !menu, !profil)._`,
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
        { text: 'Daftar Produk', replyText: '!produk' },
        { text: 'Riwayat Transaksi', replyText: '!riwayat' },
      ],
      [{ text: 'Menu Utama', replyText: '!menu' }],
    ],
  });
}

async function sendWhatsappContactAdmin(sock: WhatsappReplyTransport, jid: string, dryRun?: boolean) {
  clearBotSession('WHATSAPP', jid, dryRun);
  await sock.sendMessage(jid, {
    text: formatContactAdminMessage(config),
    quickReplies: [
      [
        { text: 'Riwayat Transaksi', replyText: '!riwayat' },
        { text: 'Menu Utama', replyText: '!menu' },
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
      quickReplies: [[{ text: 'Batal / Menu Utama', replyText: '!menu' }]],
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
          { text: 'Coba Lagi', replyText: '!voucher' },
          { text: 'Menu Utama', replyText: '!menu' },
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
        { text: 'Daftar Produk', replyText: '!produk' },
        { text: 'Menu Utama', replyText: '!menu' },
      ],
    ],
  });
}

async function sendCategoryList(sock: WhatsappReplyTransport, jid: string, dryRun?: boolean) {
  const cats = listCategories(true);
  if (cats.length === 0) {
    await sock.sendMessage(jid, {
      text: 'Maaf Kak, belum ada kategori produk yang aktif saat ini. Silakan coba lagi nanti ya.',
      quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
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
      text: `${i + offset + 1}. ${c.name}`,
      replyText: `!produk_kat ${c.id} 1`,
    }));
    buttonRows.push(row);
  }
  buttonRows.push([
    { text: 'Cari Produk', replyText: '!cari_produk' },
    { text: 'Semua Produk', replyText: '!produk' },
  ]);
  buttonRows.push([{ text: 'Menu Utama', replyText: '!menu' }]);

  await sock.sendMessage(jid, {
    text:
      `*Kategori Produk Aktif*\n` +
      `${lines}\n\n` +
      `Pilih tombol kategori atau balas dengan *!angka* kategori (misal: *!1*) ya Kak.`,
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
        text: `${i + offset + 1}. ${b.brand} (${b.productCount})`,
        replyText: `!produk_brand ${categoryId} 1 ${b.brand}`,
      }))
    );
  }
  buttonRows.push([
    { text: 'Cari Produk', replyText: '!cari_produk' },
    { text: 'Kategori Lain', replyText: '!kategori' },
  ]);
  buttonRows.push([{ text: 'Menu Utama', replyText: '!menu' }]);
  return buttonRows;
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
    await sendProductPage(
      sock,
      jid,
      { page: 1, categoryId, brand: brands[0]?.brand },
      dryRun
    );
    return;
  }

  const shown = brands.slice(0, 14);
  const existingSession = getBotSession('WHATSAPP', jid, dryRun);
  const preservedDestination =
    existingSession?.mode === 'BRAND_LIST' || existingSession?.mode === 'PRODUCT_LIST'
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
    ? `Kirim *!nomor_hp* untuk deteksi operator otomatis (contoh: *!081812345678*), atau balas *!angka* untuk memilih operator:`
    : `Balas *!angka* (misal: *!1*) untuk melihat daftar produk brand tersebut:`;

  await sock.sendMessage(jid, {
    text:
      `*Kategori: ${cat?.name || 'Produk'}*\n\n` +
      `${lines}\n\n` +
      `${promptHint}`,
    quickReplies: buildWhatsappBrandButtons(categoryId, shown),
  });
}

async function promptWhatsappSearch(
  sock: WhatsappReplyTransport,
  jid: string,
  categoryId?: number,
  dryRun?: boolean
) {
  setBotSession(
    'WHATSAPP',
    jid,
    {
      mode: 'AWAITING_SEARCH_QUERY',
      categoryId,
      updatedAt: Date.now(),
    },
    dryRun
  );
  await sock.sendMessage(jid, {
    text:
      `Silakan ketik awalan *!* atau *.* diikuti kata kunci produk yang dicari (contoh: *!xl 10*, *!telkomsel*, *!ml 86*, *!pln 50*).`,
    quickReplies: [
      [
        { text: 'Kategori Produk', replyText: '!kategori' },
        { text: 'Batal / Menu Utama', replyText: '!menu' },
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
    brand?: string;
    search?: string;
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
    search: params.search,
    onlyActive: true,
    sortBy: 'PRICE_ASC',
  });

  if (res.items.length === 0) {
    await sock.sendMessage(jid, {
      text: params.search
        ? `Maaf Kak, produk untuk kata kunci "${params.search}" belum ditemukan. Coba cari kata kunci lain atau lihat kategori.`
        : 'Maaf Kak, belum ada produk aktif di daftar ini saat ini.',
      quickReplies: [
        [
          { text: 'Cari Produk', replyText: '!cari_produk' },
          { text: 'Lihat Kategori', replyText: '!kategori' },
        ],
        [
          { text: 'Semua Produk', replyText: '!produk' },
          { text: 'Menu Utama', replyText: '!menu' },
        ],
      ],
    });
    return;
  }

  setBotSession(
    'WHATSAPP',
    jid,
    {
      mode: 'PRODUCT_LIST',
      skus: res.items.map((p) => p.sku),
      page: params.page,
      categoryId: params.categoryId,
      brand: params.brand,
      detectedDestination: params.detectedDestination,
      updatedAt: Date.now(),
    },
    dryRun
  );

  const lines = res.items.map(
    (p, idx) => `${idx + 1}. *${p.name}*\n    Rp${p.selling_price.toLocaleString('id-ID')}`
  );

  const buttonRows: WhatsappQuickButton[][] = res.items.map((p, idx) => [
    {
      text: formatWaProductButtonLabel(p.name, p.selling_price, idx + 1),
      replyText: `!pilih ${p.sku}`,
    },
  ]);

  const makePageCmd = (targetPage: number) => {
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
      text: 'Sebelumnya',
      replyText: makePageCmd(params.page - 1),
    });
  }
  if (params.page < res.pagination.totalPages) {
    navRow.push({
      text: 'Berikutnya',
      replyText: makePageCmd(params.page + 1),
    });
  }
  if (navRow.length > 0) buttonRows.push(navRow);

  if (params.categoryId && params.brand) {
    buttonRows.push([
      { text: 'Ganti Operator / Brand', replyText: `!produk_kat ${params.categoryId} 1` },
      { text: 'Cari Produk', replyText: '!cari_produk' },
    ]);
    buttonRows.push([
      { text: 'Kategori Lain', replyText: '!kategori' },
      { text: 'Menu Utama', replyText: '!menu' },
    ]);
  } else {
    buttonRows.push([
      { text: 'Cari Produk', replyText: '!cari_produk' },
      { text: 'Kategori Lain', replyText: '!kategori' },
    ]);
    buttonRows.push([{ text: 'Menu Utama', replyText: '!menu' }]);
  }

  let headerText: string;
  if (params.detectedDestination) {
    headerText =
      `*Nomor ${params.detectedDestination} Terdeteksi: ${params.brand || params.detectedOperatorLabel}* (Hal ${params.page}/${res.pagination.totalPages})\n` +
      `${lines.join('\n')}\n\n` +
      `Tap produk di bawah atau balas *!angka* (misal: *!1*) untuk langsung konfirmasi pesanan ya Kak!`;
  } else if (params.brand) {
    headerText =
      `*Daftar ${params.brand}* (Hal ${params.page}/${res.pagination.totalPages})\n` +
      `${lines.join('\n')}\n\n` +
      `Tap tombol produk di bawah atau balas *!angka* (misal: *!1*) untuk memesan ya Kak!`;
  } else {
    headerText =
      `*Daftar Produk (Hal ${params.page}/${res.pagination.totalPages})*\n` +
      `${lines.join('\n')}\n\n` +
      `Tap tombol produk di bawah atau balas *!angka* (misal: *!1*) untuk memesan ya Kak!`;
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

  await sock.sendMessage(jid, {
    text:
      `Pilihan tepat! Anda memilih:\n` +
      `*${product.name}*\n` +
      `Harga: *Rp${product.selling_price.toLocaleString('id-ID')}*\n\n` +
      `Silakan ketik awalan *!* atau *.* diikuti *nomor tujuan / ID pelanggan* Anda sekarang (contoh: *!081234567890*, atau tambahkan kode kupon setelah spasi).`,
    quickReplies: [
      [
        { text: 'Pilih Produk Lain', replyText: '!produk' },
        { text: 'Batal / Menu Utama', replyText: '!batal' },
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

  await sock.sendMessage(jid, {
    text:
      `*Konfirmasi Pesanan Anda*\n\n` +
      `Produk: *${p.product_name_snapshot}*\n` +
      `Tujuan: *${params.destination.trim()}*\n` +
      `Harga: Rp${sellingPrice.toLocaleString('id-ID')}\n` +
      (p.coupon_code_snapshot ? `Kupon: ${p.coupon_code_snapshot} (-Rp${p.discount_snapshot.toLocaleString('id-ID')})\n` : '') +
      `Estimasi Total (+ Kode Unik): *Rp${p.payment_amount.toLocaleString('id-ID')}*\n\n` +
      `Balas *!ya* untuk melanjutkan atau *!batal* untuk membatalkan:`,
    quickReplies: [
      [
        { text: 'Ya, Buat QRIS', replyText: '!ya' },
        { text: 'Batal', replyText: '!batal' },
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
            { text: 'Cek Status Invoice', replyText: `!status ${a.transaction_id}` },
            { text: 'Batalkan Pesanan', replyText: `!batal ${a.transaction_id}` },
          ],
          [{ text: 'Menu Utama', replyText: '!menu' }],
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
    `_Ketik *!batal* atau tap Batalkan Pesanan untuk membatalkan (minimal 30 detik setelah pesanan dibuat)._` +
    (params.dryRun ? `\n\n_[Mode Demo: pratinjau invoice & QRIS, transaksi tidak disimpan ke database]_` : '');

  const invoiceButtons: WhatsappQuickButton[][] = [
    [
      { text: 'Cek Status Pembayaran', replyText: `!status ${tx.transaction_id}` },
      { text: 'Batalkan Pesanan', replyText: `!batal ${tx.transaction_id}` },
    ],
    [{ text: 'Menu Utama', replyText: '!menu' }],
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
            { text: 'Cek Status Pembayaran', replyText: `!status ${res.transaction.transaction_id}` },
            { text: 'Coba Batalkan Lagi', replyText: `!batal ${res.transaction.transaction_id}` },
          ],
          [{ text: 'Menu Utama', replyText: '!menu' }],
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

  // Rule: mandatory prefix (! or .). Messages without prefix are silently ignored.
  if (!trimmed.startsWith('!') && !trimmed.startsWith('.')) {
    return;
  }

  const dryRun = Boolean(options?.dryRun);
  const now = options?.now ?? Date.now();
  // Rule: 3-second per-user cooldown. Ignore repeat messages within 3s.
  if ((!dryRun || options?.enforceCooldown) && !checkWhatsappCooldown(jid, now)) {
    return;
  }

  const withoutPrefix = trimmed.slice(1).trim();
  if (!withoutPrefix) return;

  const parts = withoutPrefix.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  // Admin commands (require backend RBAC verification via admin_identities)
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
    if (!admin) {
      await sock.sendMessage(jid, {
        text: 'Maaf, perintah admin ditolak atau tidak dikenali. Silakan gunakan Menu Utama untuk layanan pelanggan ya Kak.',
        quickReplies: [[{ text: 'Buka Menu Utama', replyText: '!menu' }]],
      });
      return;
    }

    const adminMenuButtons: WhatsappQuickButton[][] = [
      [
        { text: 'Transaksi Terbaru', replyText: '!transaksi' },
        { text: 'Status Layanan', replyText: '!statusbot' },
      ],
      [{ text: 'Menu Pelanggan', replyText: '!menu' }],
    ];

    if (cmd === 'admin') {
      await sock.sendMessage(jid, {
        text:
          `*Panel Admin WhatsApp (${admin.role})*\n` +
          `Halo Admin, pilih menu pengelolaan cepat di bawah ini:\n\n` +
          `• !transaksi [halaman] — Ringkasan & riwayat transaksi\n` +
          `• !cari <TRX_ID> — Detail transaksi\n` +
          `• !statusbot — Status layanan & scheduler\n` +
          `• !maintenance on|off — Ubah maintenance mode`,
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
        `1. Tap tombol *Daftar Produk* atau *Kategori Produk* (lalu pilih operator / kirim *!nomor_hp* untuk deteksi otomatis).\n` +
        `2. Pilih produk yang Anda inginkan, kirim *!nomor_tujuan*, lalu konfirmasi (*!ya*/* !batal*).\n` +
        `3. Scan QRIS atau buka Link Pembayaran sesuai nominal tepat sebelum batas waktu.\n` +
        `4. Ketik *!batal* untuk membatalkan pesanan PENDING (minimal 30 detik setelah dibuat).\n\n` +
        `Bisa juga ketik langsung: \`!order <SKU> <TUJUAN> [KUPON]\` bila sudah hafal kode SKU.`,
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
            await sendProductPage(
              sock,
              jid,
              {
                page: 1,
                categoryId: pulsaCat.id,
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
      existingSession?.mode === 'BRAND_LIST' || existingSession?.mode === 'PRODUCT_LIST'
        ? existingSession.detectedDestination
        : undefined;
    await sendProductPage(
      sock,
      jid,
      { page, categoryId, brand, detectedDestination },
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
          `Supaya lebih praktis, Kakak bisa tap tombol *Daftar Produk* lalu pilih produk tanpa mengetik format manual.\n` +
          `Atau ketik: *!order <SKU> <TUJUAN> [KODE_KUPON]*`,
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
        ? [[{ text: 'Batalkan Pesanan', replyText: `!batal ${t.transaction_id}` }], ...NAV_BACK_BUTTONS]
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
      buttons.push([{ text: 'Batalkan Pesanan', replyText: `!batal ${latest.transaction_id}` }]);
    }
    buttons.push([
      { text: 'Lihat Semua Riwayat', replyText: '!riwayat' },
      { text: 'Menu Utama', replyText: '!menu' },
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
        quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
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
          quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
        });
        return;
      }
      await sock.sendMessage(jid, {
        text:
          `*Kode Penghubung Akun*\n` +
          `Kirim perintah berikut di Bot Telegram dalam ${config.accountLinking.codeExpiryMinutes} menit:\n` +
          `/hubungkan ${res.code}\n\n` +
          `Jangan bagikan kode ini kepada siapa pun ya Kak.`,
        quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
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
      quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
    });
    return;
  }

  if (cmd === 'unlink') {
    clearBotSession('WHATSAPP', jid, dryRun);
    if (dryRun) {
      await sock.sendMessage(jid, {
        text: '[Mode Demo] Simulasi unlink WhatsApp — identitas nyata tidak diubah.',
        quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
      });
      return;
    }
    const res = unlinkPlatformIdentity({ platform: 'WHATSAPP', platformUserId: jid });
    await sock.sendMessage(jid, {
      text: res.ok
        ? 'Identitas WhatsApp berhasil diputuskan dari akun gabungan.'
        : res.errorMessage || 'Maaf, gagal unlink akun.',
      quickReplies: [[{ text: 'Menu Utama', replyText: '!menu' }]],
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
      text: `Pesanan *${session.productName}* (${session.destination}) menunggu konfirmasi Anda.\nTap tombol *Ya, Buat QRIS* atau *Batal* di bawah ini:`,
      quickReplies: [
        [
          { text: 'Ya, Buat QRIS', replyText: '!ya' },
          { text: 'Batal', replyText: '!batal' },
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
    await sendProductPage(sock, jid, { page: 1, categoryId: session.categoryId, search: withoutPrefix }, dryRun);
    return;
  }

  const numericChoice = /^\d+$/.test(withoutPrefix) ? Number(withoutPrefix) : null;
  if (session?.mode === 'BRAND_LIST' && !WA_RESERVED_COMMANDS.has(cmd)) {
    if (numericChoice !== null && numericChoice >= 1 && numericChoice <= session.brands.length) {
      const chosenBrand = session.brands[numericChoice - 1];
      await sendProductPage(
        sock,
        jid,
        {
          page: 1,
          categoryId: session.categoryId,
          brand: chosenBrand,
          detectedDestination: session.detectedDestination,
        },
        dryRun
      );
      return;
    }

    const detected = detectOperatorFromPhone(withoutPrefix);
    if (detected) {
      const matchedBrand = matchBrandForDetectedOperator(session.brands, detected);
      if (matchedBrand) {
        await sendProductPage(
          sock,
          jid,
          {
            page: 1,
            categoryId: session.categoryId,
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
      await sock.sendMessage(jid, {
        text:
          `Nomor *${detected.normalizedPhone}* terdeteksi operator *${detected.displayName}*, namun produk ${detected.displayName} aktif belum tersedia di kategori *${session.categoryName}*.\n` +
          `Silakan pilih operator/brand lain di bawah ini (nomor tetap tersimpan):`,
        quickReplies: buildWhatsappBrandButtons(session.categoryId, activeBrands),
      });
      return;
    }

    await sendProductPage(
      sock,
      jid,
      { page: 1, categoryId: session.categoryId, search: withoutPrefix },
      dryRun
    );
    return;
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

  // Friendly fallback with clickable menu buttons
  await sock.sendMessage(jid, {
    text:
      `${greetingPrefix(pushName)}! Maaf, saya belum memahami perintah "${trimmed}".\n` +
      `Silakan pilih langsung menu di bawah ini agar lebih mudah ya Kak:`,
    quickReplies: MAIN_MENU_BUTTONS,
  });
}
