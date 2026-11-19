import { config } from '../config/env';
import { digiflazzService } from '../integrations/digiflazz.service';
import { checkAdminPermission, type ResolvedAdmin } from '../services/admin.service';
import { recordAuditLog } from '../services/audit.service';
import { createCoupon } from '../services/coupon.service';
import { findCustomerByIdentifier, getCustomerRefundCreditTotal } from '../services/customer.service';
import { setGlobalMargin } from '../services/margin.service';
import { getGlobalMarginRule, getProductBySkuOrId, updateProductDescription } from '../services/product.service';
import { applyManualRefundOrAdjustment } from '../services/refund.service';
import { getConfirmationDescription, setConfirmationDescription } from '../services/settings.service';
import {
  clearTelegramAdminSession,
  getTelegramAdminSession,
  setTelegramAdminSession,
  type TelegramAdminSessionState,
} from './bot-session';
import type { TelegramInlineButton, TelegramReplyTransport } from './telegram.command-handler';
import { whatsappService } from './whatsapp.service';

export const TG_ADMIN_MENU_BUTTONS: TelegramInlineButton[][] = [
  [
    { text: '📊 Transaksi Terbaru', callbackData: 'ADMIN_TX_1' },
    { text: '📅 Hari Ini', callbackData: 'ADMIN_TODAY' },
  ],
  [
    { text: '🩺 Status Layanan', callbackData: 'ADMIN_STATUS' },
    { text: '⚙️ Konfigurasi Bot', callbackData: 'ADMIN_CONFIG_MENU' },
  ],
  [{ text: '🏠 Menu Pelanggan', callbackData: 'MAIN_MENU' }],
];

export const TG_ADMIN_CONFIG_BUTTONS: TelegramInlineButton[][] = [
  [
    { text: '📝 Set Deskripsi', callbackData: 'ADMIN_CFG_DESC' },
    { text: '🔄 Refresh Harga', callbackData: 'ADMIN_CFG_SYNC' },
  ],
  [
    { text: '💹 Set Margin', callbackData: 'ADMIN_CFG_MARGIN' },
    { text: '💳 Set Saldo User', callbackData: 'ADMIN_CFG_BALANCE' },
  ],
  [
    { text: '🎟️ Buat Voucher', callbackData: 'ADMIN_CFG_VOUCHER' },
    { text: '🤖 Set Bot WA', callbackData: 'ADMIN_CFG_WABOT' },
  ],
  [{ text: '🔙 Kembali ke Admin', callbackData: 'ADMIN_PANEL' }],
];

const CANCEL_TO_CONFIG_BUTTONS: TelegramInlineButton[][] = [
  [{ text: '❌ Batal / Menu Konfigurasi', callbackData: 'ADMIN_CONFIG_MENU' }],
];

function adminActor(admin: ResolvedAdmin): { id: string; role: string } {
  return {
    id: `TG:${admin.platformUserId}`,
    role: admin.role,
  };
}

function formatCurrentMarginLabel(): string {
  const gm = getGlobalMarginRule();
  if (gm.type === 'PERCENT') {
    const cap =
      gm.maxMargin !== null && gm.maxMargin !== undefined
        ? ` (maks. Rp${gm.maxMargin.toLocaleString('id-ID')})`
        : '';
    return `${gm.value}%${cap}`;
  }
  return `Rp${gm.value.toLocaleString('id-ID')}`;
}

export async function sendTelegramAdminPanel(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun = false
): Promise<void> {
  clearTelegramAdminSession(userId, dryRun);
  await transport.reply(
    `🛠️ *Panel Admin Telegram (${admin.role})*\n` +
      `Halo Admin, pilih menu cepat di bawah atau gunakan perintah:\n\n` +
      `• /konfigurasi — Menu pengaturan toko & bot\n` +
      `• /transaksi [hal] — Ringkasan transaksi\n` +
      `• /riwayat_hari_ini — Transaksi hari ini\n` +
      `• /cari <TRX_ID> — Detail transaksi\n` +
      `• /status_bot — Status layanan & scheduler\n` +
      `• /maintenance on|off — Ubah maintenance mode`,
    TG_ADMIN_MENU_BUTTONS
  );
}

export async function sendTelegramAdminConfigMenu(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun = false
): Promise<void> {
  clearTelegramAdminSession(userId, dryRun);
  const globalDesc = getConfirmationDescription();
  const waStatus = whatsappService.getStatus();
  await transport.reply(
    `⚙️ *Menu Konfigurasi Admin (${admin.role})*\n\n` +
      `• Keterangan Konfirmasi: ${globalDesc ? `"${globalDesc}"` : '_Tidak diatur (lewati)_'}\n` +
      `• Margin Global Aktif: *${formatCurrentMarginLabel()}*\n` +
      `• Bot WhatsApp: *${waStatus.state}*${waStatus.enabled ? '' : ' (Nonaktif di .env)'}\n\n` +
      `Pilih menu konfigurasi di bawah ini:`,
    TG_ADMIN_CONFIG_BUTTONS
  );
}

async function sendDescriptionMenu(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'settings:write') && !checkAdminPermission(admin, 'products:write')) {
    await transport.reply('Maaf, Anda tidak memiliki izin untuk mengatur deskripsi.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const globalDesc = getConfirmationDescription();
  await transport.reply(
    `📝 *Set Deskripsi Konfirmasi Pembayaran*\n\n` +
      `Keterangan ini opsional: jika diisi akan tampil di menu *Konfirmasi Pesanan* pelanggan, jika kosong tidak ditampilkan.\n\n` +
      `• Keterangan Global Saat Ini:\n${globalDesc ? `"${globalDesc}"` : '_(Kosong / tidak aktif)_'}\n\n` +
      `Pilih jenis deskripsi yang ingin diubah:`,
    [
      [
        { text: '🌐 Deskripsi Global', callbackData: 'ADMIN_CFG_DESC_GLOBAL' },
        { text: '📦 Deskripsi Produk (SKU)', callbackData: 'ADMIN_CFG_DESC_PRODUCT' },
      ],
      ...(globalDesc ? [[{ text: '🗑️ Hapus Deskripsi Global', callbackData: 'ADMIN_CFG_DESC_CLEAR' }]] : []),
      [{ text: '🔙 Menu Konfigurasi', callbackData: 'ADMIN_CONFIG_MENU' }],
    ]
  );
}

async function executeRefreshPrices(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'products:write')) {
    await transport.reply('Maaf, izin products:write diperlukan untuk refresh harga.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  if (dryRun) {
    await transport.reply(
      `🔄 *[Mode Demo] Refresh Harga Digiflazz*\n` +
        `Simulasi sinkronisasi harga produk Digiflazz berhasil dijalankan (tidak mengubah produk nyata).\n` +
        `Pada mode live, harga jual dihitung ulang otomatis mengikuti aturan margin aktif.`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }
  if (!digiflazzService.isConfigured()) {
    await transport.reply(
      '⚠️ Kredensial Digiflazz belum dikonfigurasi pada server (.env).',
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  await transport.reply('🔄 Sedang mengambil daftar harga terbaru dari Digiflazz, mohon tunggu sebentar...');
  const result = await digiflazzService.syncPrices('MANUAL');
  recordAuditLog({
    actorId: adminActor(admin).id,
    actorRole: admin.role,
    action: 'TG_ADMIN_DIGIFLAZZ_SYNC',
    targetType: 'PRODUCTS',
    details: { ok: result.ok, successCount: result.successCount, deletedCount: result.deletedCount },
  });

  if (!result.ok) {
    await transport.reply(
      `❌ Refresh harga gagal: ${result.errorMessage || 'Terjadi kesalahan saat menghubungi Digiflazz.'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  await transport.reply(
    `✅ *Refresh Harga Selesai!*\n\n` +
      `• Produk diperbarui: *${result.successCount}*\n` +
      `• Produk tidak tersedia dihapus: *${result.deletedCount}*\n` +
      `• Gagal diproses: *${result.failureCount}*`,
    TG_ADMIN_CONFIG_BUTTONS
  );
}

async function sendMarginMenu(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'margins:write')) {
    await transport.reply('Maaf, izin margins:write diperlukan untuk mengatur margin.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  await transport.reply(
    `💹 *Set Margin Global*\n\n` +
      `Margin global saat ini: *${formatCurrentMarginLabel()}*\n` +
      `Perubahan margin akan menghitung ulang harga jual produk untuk transaksi baru.\n\n` +
      `Pilih tipe margin yang ingin digunakan:`,
    [
      [
        { text: '💵 Nominal Tetap (Rp)', callbackData: 'ADMIN_CFG_MARGIN_FIXED' },
        { text: '📈 Persentase (%)', callbackData: 'ADMIN_CFG_MARGIN_PERCENT' },
      ],
      [{ text: '🔙 Menu Konfigurasi', callbackData: 'ADMIN_CONFIG_MENU' }],
    ]
  );
}

async function sendBalancePrompt(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'refunds:adjust')) {
    await transport.reply(
      'Maaf, izin refunds:adjust diperlukan untuk mengatur Kredit Refund Internal user.',
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }
  setTelegramAdminSession(userId, { mode: 'AWAITING_BALANCE_ADJUSTMENT', updatedAt: Date.now() }, dryRun);
  await transport.reply(
    `💳 *Set Saldo User (Kredit Refund Internal)*\n\n` +
      `Istilah internal di sistem ini adalah *Kredit Refund Internal* (*refund_ledger*).\n\n` +
      `Kirim pesan dengan format:\n` +
      `<ID_USER / CUS-... / TG_ID / NO_WA> <+NOMINAL|-NOMINAL> <alasan min 5 huruf>\n\n` +
      `Contoh:\n` +
      `• CUS-1234ABCD +25000 Kompensasi gangguan produk\n` +
      `• 8686345389 -10000 Koreksi saldo manual`,
    CANCEL_TO_CONFIG_BUTTONS
  );
}

async function sendVoucherPrompt(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'coupons:write')) {
    await transport.reply('Maaf, izin coupons:write diperlukan untuk membuat voucher.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  setTelegramAdminSession(userId, { mode: 'AWAITING_VOUCHER_CREATE', updatedAt: Date.now() }, dryRun);
  await transport.reply(
    `🎟️ *Buat Voucher Promo Baru*\n\n` +
      `Kirim pesan dengan format:\n` +
      `<KODE> <FIXED|PERCENT> <NILAI> <HARI_AKTIF> [MIN_BELANJA] [MAKS_DISKON] [NAMA_VOUCHER]\n\n` +
      `Contoh:\n` +
      `• HEMAT5K FIXED 5000 30\n` +
      `• DISKON10 PERCENT 10 7 25000 5000 Promo Akhir Pekan`,
    CANCEL_TO_CONFIG_BUTTONS
  );
}

async function sendWaBotMenu(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'bots:read')) {
    await transport.reply('Maaf, izin bots:read diperlukan untuk melihat status Bot WhatsApp.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const status = whatsappService.getStatus();
  await transport.reply(
    `🤖 *Pengaturan Bot WhatsApp*\n\n` +
      `• Status: *${status.state}*\n` +
      `• Aktif (.env): ${status.enabled ? 'Ya' : 'Tidak'}\n` +
      `• Sesi Tersimpan: ${status.hasSavedSession ? 'Ada' : 'Belum ada'}\n` +
      `• Percobaan Reconnect: ${status.reconnectAttempts}\n` +
      (status.lastError ? `• Error Terakhir: ${status.lastError}\n` : '') +
      `\nPilih aksi Bot WhatsApp:`,
    [
      [
        { text: '🔄 Reconnect WA', callbackData: 'ADMIN_WA_RECONNECT' },
        { text: '🧹 Reset Sesi WA', callbackData: 'ADMIN_WA_RESET' },
      ],
      [{ text: '🔑 Minta Pairing Code', callbackData: 'ADMIN_WA_PAIRING' }],
      [{ text: '🔙 Menu Konfigurasi', callbackData: 'ADMIN_CONFIG_MENU' }],
    ]
  );
}

async function applyGlobalDescriptionInput(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  text: string,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'settings:write')) {
    await transport.reply('Maaf, izin settings:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const clean = text.trim();
  const isClear = !clean || clean === '-';
  if (dryRun) {
    await transport.reply(
      `🌐 *[Mode Demo] Deskripsi Konfirmasi Global*\n` +
        (isClear
          ? 'Deskripsi global akan dikosongkan (mode demo tidak mengubah database).'
          : `Deskripsi global akan diatur menjadi: "${clean}" (mode demo tidak mengubah database).`),
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }
  try {
    const saved = setConfirmationDescription(isClear ? null : clean, adminActor(admin));
    await transport.reply(
      saved
        ? `✅ Deskripsi konfirmasi global berhasil disimpan:\n"${saved}"`
        : '✅ Deskripsi konfirmasi global berhasil dikosongkan.',
      TG_ADMIN_CONFIG_BUTTONS
    );
  } catch (err) {
    await transport.reply(
      `❌ Gagal menyimpan deskripsi global: ${err instanceof Error ? err.message : 'kesalahan tidak diketahui'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  }
}

async function applyProductDescriptionInput(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  rawText: string,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'products:write')) {
    await transport.reply('Maaf, izin products:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  let sku = '';
  let desc = '';
  const pipeIdx = rawText.indexOf('|');
  if (pipeIdx !== -1) {
    sku = rawText.slice(0, pipeIdx).trim();
    desc = rawText.slice(pipeIdx + 1).trim();
  } else {
    const tokens = rawText.trim().split(/\s+/);
    sku = tokens[0] || '';
    desc = tokens.slice(1).join(' ').trim();
  }

  if (!sku || !desc) {
    await transport.reply(
      '⚠️ Format salah. Gunakan: `<SKU> | <deskripsi baru>` (contoh: `TSEL10 | Proses 1-5 menit`) atau `<SKU> | -` untuk menghapus.',
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  const product = getProductBySkuOrId(sku);
  if (!product) {
    await transport.reply(`❌ Produk dengan SKU "${sku}" tidak ditemukan.`, TG_ADMIN_CONFIG_BUTTONS);
    return;
  }

  const isClear = desc === '-';
  if (dryRun) {
    await transport.reply(
      `📦 *[Mode Demo] Deskripsi Produk ${product.sku}*\n` +
        (isClear
          ? `Deskripsi produk *${product.name}* akan dihapus (mode demo tidak mengubah database).`
          : `Deskripsi produk *${product.name}* akan diatur menjadi: "${desc}" (mode demo tidak mengubah database).`),
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  try {
    const updated = updateProductDescription(product.sku, isClear ? null : desc, adminActor(admin));
    await transport.reply(
      updated.description
        ? `✅ Deskripsi produk *${updated.name}* (${updated.sku}) disimpan:\n"${updated.description}"`
        : `✅ Deskripsi produk *${updated.name}* (${updated.sku}) berhasil dihapus.`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  } catch (err) {
    await transport.reply(
      `❌ Gagal mengubah deskripsi produk: ${err instanceof Error ? err.message : 'kesalahan tidak diketahui'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  }
}

async function applyMarginInput(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  marginType: 'FIXED' | 'PERCENT',
  rawText: string,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'margins:write')) {
    await transport.reply('Maaf, izin margins:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const tokens = rawText.trim().split(/\s+/);
  const val = Number(tokens[0]?.replace(',', '.'));
  const maxVal = tokens[1] ? Number(tokens[1]) : null;
  if (!Number.isFinite(val) || val < 0) {
    await transport.reply(
      `⚠️ Nilai margin tidak valid. Contoh: ${marginType === 'FIXED' ? '1500' : '5 atau 5 3000'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }
  if (maxVal !== null && (!Number.isFinite(maxVal) || maxVal < 0)) {
    await transport.reply('⚠️ Nilai maksimal margin (Rp) tidak valid.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  const appliedMax = marginType === 'PERCENT' ? maxVal : null;
  if (dryRun) {
    const label =
      marginType === 'PERCENT'
        ? `${val}%${appliedMax !== null ? ` (maks. Rp${Math.round(appliedMax).toLocaleString('id-ID')})` : ''}`
        : `Rp${Math.round(val).toLocaleString('id-ID')}`;
    await transport.reply(
      `💹 *[Mode Demo] Set Margin Global*\nMargin global akan diubah ke *${label}* (mode demo tidak mengubah database).`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  try {
    const res = setGlobalMargin(marginType, val, adminActor(admin), appliedMax);
    await transport.reply(
      `✅ *Margin Global Berhasil Diperbarui!*\n\n` +
        `• Margin Baru: *${formatCurrentMarginLabel()}*\n` +
        `• Produk Dihitung Ulang: *${res.updatedProducts}* produk`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  } catch (err) {
    await transport.reply(
      `❌ Gagal menyimpan margin: ${err instanceof Error ? err.message : 'kesalahan tidak diketahui'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  }
}

async function applyBalanceInput(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  rawText: string,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'refunds:adjust')) {
    await transport.reply('Maaf, izin refunds:adjust diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const tokens = rawText.trim().split(/\s+/);
  if (tokens.length < 3) {
    await transport.reply(
      '⚠️ Format salah. Gunakan: `<ID_USER/CUS-.../TG_ID/NO_WA> <+NOMINAL|-NOMINAL> <alasan min 5 huruf>`',
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }
  const [identifier, nominalToken, ...reasonParts] = tokens;
  const isDebit = nominalToken.startsWith('-');
  const parsedAmount = Number(nominalToken.replace(/^[+-]/, ''));
  const reason = reasonParts.join(' ').trim();

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    await transport.reply('⚠️ Nominal harus angka positif (diawali + atau -, misal +25000 / -10000).', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  if (reason.length < 5) {
    await transport.reply('⚠️ Alasan penyesuaian wajib diisi minimal 5 karakter.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }

  const found = findCustomerByIdentifier(identifier);
  if (!found) {
    await transport.reply(
      `❌ User "${identifier}" tidak ditemukan. Cek ID Customer (CUS-...) atau User ID di menu Pelanggan.`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  const amount = Math.round(parsedAmount);
  const currentBal = getCustomerRefundCreditTotal(found.customer.id);
  const entryType = isDebit ? 'MANUAL_ADJUSTMENT_DEBIT' : 'MANUAL_ADJUSTMENT_CREDIT';
  const nextBal = isDebit ? currentBal - amount : currentBal + amount;
  if (nextBal < 0) {
    await transport.reply(
      `⚠️ Penyesuaian ditolak: saldo user ${found.customer.customer_code} saat ini Rp${currentBal.toLocaleString('id-ID')} dan tidak boleh menjadi negatif.`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  if (dryRun) {
    await transport.reply(
      `💳 *[Mode Demo] Set Saldo Kredit Refund Internal*\n` +
        `• Akun: *${found.customer.customer_code}*\n` +
        `• Aksi: ${isDebit ? `Kurangi -Rp${amount.toLocaleString('id-ID')}` : `Tambah +Rp${amount.toLocaleString('id-ID')}`}\n` +
        `• Estimasi Saldo: Rp${currentBal.toLocaleString('id-ID')} -> Rp${nextBal.toLocaleString('id-ID')}\n` +
        `• Alasan: ${reason}\n\n_[Mode Demo: tidak menulis ke refund_ledger]_`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  try {
    const res = applyManualRefundOrAdjustment(
      {
        customerId: found.customer.id,
        entryType,
        amount,
        reason,
      },
      adminActor(admin)
    );
    await transport.reply(
      `✅ *Saldo Kredit Refund Internal Diperbarui!*\n\n` +
        `• Akun: *${found.customer.customer_code}*\n` +
        `• ID Ledger: ${res.ledgerId}\n` +
        `• Saldo Sebelumnya: Rp${res.balanceBefore.toLocaleString('id-ID')}\n` +
        `• Saldo Terbaru: *Rp${res.balanceAfter.toLocaleString('id-ID')}*\n` +
        `• Alasan: ${reason}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  } catch (err) {
    await transport.reply(
      `❌ Gagal mengubah saldo user: ${err instanceof Error ? err.message : 'kesalahan tidak diketahui'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  }
}

async function applyVoucherInput(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  rawText: string,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'coupons:write')) {
    await transport.reply('Maaf, izin coupons:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const tokens = rawText.trim().split(/\s+/);
  if (tokens.length < 4) {
    await transport.reply(
      '⚠️ Format salah. Gunakan: `<KODE> <FIXED|PERCENT> <NILAI> <HARI_AKTIF> [MIN_BELANJA] [MAKS_DISKON] [NAMA_VOUCHER]`',
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  const code = tokens[0].toUpperCase();
  const typeRaw = tokens[1].toUpperCase();
  if (typeRaw !== 'FIXED' && typeRaw !== 'PERCENT') {
    await transport.reply('⚠️ Jenis diskon wajib FIXED atau PERCENT.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  const discountType = typeRaw;
  const discountValue = Number(tokens[2]);
  const activeDays = Number(tokens[3]);
  const minPurchase = tokens[4] ? Number(tokens[4]) : 0;
  const maxDiscount = tokens[5] && Number(tokens[5]) > 0 ? Number(tokens[5]) : null;
  const name = tokens.slice(6).join(' ').trim() || `Promo ${code}`;

  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    await transport.reply('⚠️ Nilai diskon harus angka lebih dari 0.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  if (!Number.isFinite(activeDays) || activeDays < 1 || activeDays > 3650) {
    await transport.reply('⚠️ Durasi hari aktif wajib antara 1 hingga 3650 hari.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }

  const now = new Date();
  const startsAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.round(activeDays) * 86_400_000).toISOString();

  if (dryRun) {
    await transport.reply(
      `🎟️ *[Mode Demo] Buat Voucher Baru*\n` +
        `• Kode: *${code}*\n` +
        `• Nama: ${name}\n` +
        `• Diskon: ${discountType === 'PERCENT' ? `${discountValue}%` : `Rp${discountValue.toLocaleString('id-ID')}`}\n` +
        `• Masa Berlaku: ${Math.round(activeDays)} hari\n\n_[Mode Demo: tidak disimpan ke database]_`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }

  try {
    const created = createCoupon(
      {
        code,
        name,
        discountType,
        discountValue,
        minPurchase: Number.isFinite(minPurchase) && minPurchase >= 0 ? minPurchase : 0,
        maxDiscount: discountType === 'PERCENT' ? maxDiscount : null,
        startsAt,
        expiresAt,
      },
      adminActor(admin)
    );
    await transport.reply(
      `✅ *Voucher Berhasil Dibuat!*\n\n` +
        `• Kode: *${created.code}*\n` +
        `• Nama: ${created.name}\n` +
        `• Potongan: ${created.discount_type === 'PERCENT' ? `${created.discount_value}%${created.max_discount ? ` (maks. Rp${created.max_discount.toLocaleString('id-ID')})` : ''}` : `Rp${created.discount_value.toLocaleString('id-ID')}`}\n` +
        `• Min. Belanja: Rp${created.min_purchase.toLocaleString('id-ID')}\n` +
        `• Aktif selama: ${Math.round(activeDays)} hari (${config.timezone})`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  } catch (err) {
    await transport.reply(
      `❌ Gagal membuat voucher: ${err instanceof Error ? err.message : 'kesalahan tidak diketahui'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  }
}

async function applyWaPairingInput(
  transport: TelegramReplyTransport,
  admin: ResolvedAdmin,
  rawPhone: string,
  userId: string,
  dryRun: boolean
): Promise<void> {
  if (!checkAdminPermission(admin, 'bots:pairing')) {
    await transport.reply('Maaf, izin bots:pairing diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  clearTelegramAdminSession(userId, dryRun);
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 16) {
    await transport.reply('⚠️ Nomor WhatsApp tidak valid. Gunakan format internasional, contoh: 6281234567890.', TG_ADMIN_CONFIG_BUTTONS);
    return;
  }
  if (dryRun) {
    await transport.reply(
      `🔑 *[Mode Demo] Pairing Code WhatsApp*\nTarget: ${digits}\nKode Demo: *DEMO-PAIR*\n\n_[Mode Demo: tidak memanggil koneksi WhatsApp live]_`,
      TG_ADMIN_CONFIG_BUTTONS
    );
    return;
  }
  try {
    const code = await whatsappService.requestPairingCode(digits);
    recordAuditLog({
      actorId: adminActor(admin).id,
      actorRole: admin.role,
      action: 'TG_ADMIN_WA_PAIRING_CODE',
      targetType: 'BOT_WHATSAPP',
      details: { targetLength: digits.length },
    });
    await transport.reply(
      `✅ *Pairing Code WhatsApp Berhasil Dibuat!*\n\n` +
        `Nomor: ${digits}\n` +
        `Kode Pairing: *${code}*\n\n` +
        `Masukkan kode di WhatsApp → Perangkat Tertaut → Tautkan dengan Nomor Telepon.`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  } catch (err) {
    await transport.reply(
      `❌ Gagal meminta Pairing Code WhatsApp: ${err instanceof Error ? err.message : 'pastikan bot WA dalam kondisi waiting/connecting'}`,
      TG_ADMIN_CONFIG_BUTTONS
    );
  }
}

export async function handleTelegramAdminConfigCallback(params: {
  data: string;
  transport: TelegramReplyTransport;
  admin: ResolvedAdmin;
  userId: string;
  dryRun: boolean;
}): Promise<boolean> {
  const { data, transport, admin, userId, dryRun } = params;

  if (data === 'ADMIN_PANEL') {
    await sendTelegramAdminPanel(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CONFIG_MENU') {
    await sendTelegramAdminConfigMenu(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_DESC') {
    await sendDescriptionMenu(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_DESC_GLOBAL') {
    if (!checkAdminPermission(admin, 'settings:write')) {
      await transport.reply('Maaf, izin settings:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
      return true;
    }
    setTelegramAdminSession(userId, { mode: 'AWAITING_GLOBAL_DESC', updatedAt: Date.now() }, dryRun);
    await transport.reply(
      `🌐 *Ubah Deskripsi Global Konfirmasi*\n\n` +
        `Kirimkan teks keterangan yang ingin ditampilkan pada menu *Konfirmasi Pesanan* semua produk.\n` +
        `Atau kirim *-* untuk mengosongkan.`,
      CANCEL_TO_CONFIG_BUTTONS
    );
    return true;
  }
  if (data === 'ADMIN_CFG_DESC_CLEAR') {
    await applyGlobalDescriptionInput(transport, admin, '-', userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_DESC_PRODUCT') {
    if (!checkAdminPermission(admin, 'products:write')) {
      await transport.reply('Maaf, izin products:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
      return true;
    }
    setTelegramAdminSession(userId, { mode: 'AWAITING_PRODUCT_DESC', updatedAt: Date.now() }, dryRun);
    await transport.reply(
      `📦 *Ubah Deskripsi Produk per SKU*\n\n` +
        `Kirimkan dengan format:\n` +
        `<SKU> | <deskripsi baru>\n\n` +
        `Contoh:\n` +
        `• TSEL10 | Proses otomatis 1-3 menit\n` +
        `• TSEL10 | -  (untuk menghapus deskripsi produk ini)`,
      CANCEL_TO_CONFIG_BUTTONS
    );
    return true;
  }
  if (data === 'ADMIN_CFG_SYNC') {
    await executeRefreshPrices(transport, admin, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_MARGIN') {
    await sendMarginMenu(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_MARGIN_FIXED' || data === 'ADMIN_CFG_MARGIN_PERCENT') {
    if (!checkAdminPermission(admin, 'margins:write')) {
      await transport.reply('Maaf, izin margins:write diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
      return true;
    }
    const marginType = data === 'ADMIN_CFG_MARGIN_PERCENT' ? 'PERCENT' : 'FIXED';
    setTelegramAdminSession(userId, { mode: 'AWAITING_MARGIN_INPUT', marginType, updatedAt: Date.now() }, dryRun);
    await transport.reply(
      marginType === 'PERCENT'
        ? `📈 *Input Margin Persentase (%)*\n\nKirimkan angka persentase (dan opsional batas maksimal Rp dipisah spasi).\nContoh: *5* atau *5 3000*`
        : `💵 *Input Margin Nominal Tetap (Rp)*\n\nKirimkan angka nominal rupiah.\nContoh: *1500*`,
      CANCEL_TO_CONFIG_BUTTONS
    );
    return true;
  }
  if (data === 'ADMIN_CFG_BALANCE') {
    await sendBalancePrompt(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_VOUCHER') {
    await sendVoucherPrompt(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_CFG_WABOT') {
    await sendWaBotMenu(transport, admin, userId, dryRun);
    return true;
  }
  if (data === 'ADMIN_WA_RECONNECT' || data === 'ADMIN_WA_RESET') {
    if (!checkAdminPermission(admin, 'bots:manage')) {
      await transport.reply('Maaf, izin bots:manage diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
      return true;
    }
    const resetSession = data === 'ADMIN_WA_RESET';
    if (dryRun) {
      await transport.reply(
        `🤖 *[Mode Demo] ${resetSession ? 'Reset Sesi & Reconnect' : 'Reconnect'} Bot WhatsApp*\n` +
          `Simulasi berhasil (mode demo tidak memutus sesi WhatsApp live).`,
        TG_ADMIN_CONFIG_BUTTONS
      );
      return true;
    }
    try {
      await whatsappService.reconnect(resetSession);
      recordAuditLog({
        actorId: adminActor(admin).id,
        actorRole: admin.role,
        action: resetSession ? 'TG_ADMIN_WA_RESET_SESSION' : 'TG_ADMIN_WA_RECONNECT',
        targetType: 'BOT_WHATSAPP',
        details: { resetSession },
      });
      const st = whatsappService.getStatus();
      await transport.reply(
        `✅ ${resetSession ? 'Sesi WhatsApp direset & ' : ''}Bot WhatsApp mulai menyambung ulang.\nStatus saat ini: *${st.state}*`,
        TG_ADMIN_CONFIG_BUTTONS
      );
    } catch (err) {
      await transport.reply(
        `❌ Gagal reconnect Bot WhatsApp: ${err instanceof Error ? err.message : 'kesalahan tidak diketahui'}`,
        TG_ADMIN_CONFIG_BUTTONS
      );
    }
    return true;
  }
  if (data === 'ADMIN_WA_PAIRING') {
    if (!checkAdminPermission(admin, 'bots:pairing')) {
      await transport.reply('Maaf, izin bots:pairing diperlukan.', TG_ADMIN_CONFIG_BUTTONS);
      return true;
    }
    setTelegramAdminSession(userId, { mode: 'AWAITING_WA_PAIRING_PHONE', updatedAt: Date.now() }, dryRun);
    await transport.reply(
      `🔑 *Minta Pairing Code WhatsApp*\n\nKirim nomor WhatsApp bot (awalan 62, contoh: *6281234567890*):`,
      CANCEL_TO_CONFIG_BUTTONS
    );
    return true;
  }

  return false;
}

export async function handleTelegramAdminPendingSessionInput(params: {
  session: TelegramAdminSessionState;
  transport: TelegramReplyTransport;
  admin: ResolvedAdmin | null;
  userId: string;
  text: string;
  dryRun: boolean;
}): Promise<boolean> {
  const { session, transport, admin, userId, text, dryRun } = params;
  if (!admin) {
    clearTelegramAdminSession(userId, dryRun);
    return false;
  }

  const lower = text.trim().toLowerCase();
  if (lower === 'batal' || lower === 'cancel') {
    await sendTelegramAdminConfigMenu(transport, admin, userId, dryRun);
    return true;
  }

  if (session.mode === 'AWAITING_GLOBAL_DESC') {
    await applyGlobalDescriptionInput(transport, admin, text, userId, dryRun);
    return true;
  }
  if (session.mode === 'AWAITING_PRODUCT_DESC') {
    await applyProductDescriptionInput(transport, admin, text, userId, dryRun);
    return true;
  }
  if (session.mode === 'AWAITING_MARGIN_INPUT') {
    await applyMarginInput(transport, admin, session.marginType, text, userId, dryRun);
    return true;
  }
  if (session.mode === 'AWAITING_BALANCE_ADJUSTMENT') {
    await applyBalanceInput(transport, admin, text, userId, dryRun);
    return true;
  }
  if (session.mode === 'AWAITING_VOUCHER_CREATE') {
    await applyVoucherInput(transport, admin, text, userId, dryRun);
    return true;
  }
  if (session.mode === 'AWAITING_WA_PAIRING_PHONE') {
    await applyWaPairingInput(transport, admin, text, userId, dryRun);
    return true;
  }
  return false;
}

export async function handleTelegramAdminConfigSlashCommand(params: {
  cmd: string;
  args: string[];
  transport: TelegramReplyTransport;
  resolveAdmin: () => ResolvedAdmin | null;
  userId: string;
  dryRun: boolean;
}): Promise<boolean> {
  const { cmd, args, transport, resolveAdmin, userId, dryRun } = params;
  const configCmds = new Set([
    'konfigurasi',
    'set_deskripsi',
    'refresh_harga',
    'set_margin',
    'set_saldo',
    'buat_voucher',
    'set_bot_wa',
  ]);
  if (!configCmds.has(cmd)) return false;

  const admin = resolveAdmin();
  if (!admin) {
    await transport.reply(
      'Maaf, akses ditolak karena akun Anda tidak terdaftar sebagai admin.',
      [[{ text: '🏠 Buka Menu Pelanggan', callbackData: 'MAIN_MENU' }]]
    );
    return true;
  }

  if (cmd === 'konfigurasi') {
    await sendTelegramAdminConfigMenu(transport, admin, userId, dryRun);
    return true;
  }
  if (cmd === 'set_deskripsi') {
    if (args.length === 0) {
      await sendDescriptionMenu(transport, admin, userId, dryRun);
      return true;
    }
    if (args[0].toLowerCase() === 'global') {
      await applyGlobalDescriptionInput(transport, admin, args.slice(1).join(' '), userId, dryRun);
      return true;
    }
    await applyProductDescriptionInput(transport, admin, args.join(' '), userId, dryRun);
    return true;
  }
  if (cmd === 'refresh_harga') {
    await executeRefreshPrices(transport, admin, dryRun);
    return true;
  }
  if (cmd === 'set_margin') {
    if (args.length < 2) {
      await sendMarginMenu(transport, admin, userId, dryRun);
      return true;
    }
    const typeArg = args[0].toUpperCase();
    if (typeArg !== 'FIXED' && typeArg !== 'PERCENT') {
      await transport.reply('⚠️ Gunakan: /set_margin <FIXED|PERCENT> <NILAI> [MAKS_RP]', TG_ADMIN_CONFIG_BUTTONS);
      return true;
    }
    await applyMarginInput(transport, admin, typeArg, args.slice(1).join(' '), userId, dryRun);
    return true;
  }
  if (cmd === 'set_saldo') {
    if (args.length < 3) {
      await sendBalancePrompt(transport, admin, userId, dryRun);
      return true;
    }
    await applyBalanceInput(transport, admin, args.join(' '), userId, dryRun);
    return true;
  }
  if (cmd === 'buat_voucher') {
    if (args.length < 4) {
      await sendVoucherPrompt(transport, admin, userId, dryRun);
      return true;
    }
    await applyVoucherInput(transport, admin, args.join(' '), userId, dryRun);
    return true;
  }
  if (cmd === 'set_bot_wa') {
    const sub = args[0]?.toLowerCase();
    if (!sub) {
      await sendWaBotMenu(transport, admin, userId, dryRun);
      return true;
    }
    if (sub === 'reconnect') {
      await handleTelegramAdminConfigCallback({ data: 'ADMIN_WA_RECONNECT', transport, admin, userId, dryRun });
      return true;
    }
    if (sub === 'reset') {
      await handleTelegramAdminConfigCallback({ data: 'ADMIN_WA_RESET', transport, admin, userId, dryRun });
      return true;
    }
    if (sub === 'pairing' && args[1]) {
      await applyWaPairingInput(transport, admin, args[1], userId, dryRun);
      return true;
    }
    await sendWaBotMenu(transport, admin, userId, dryRun);
    return true;
  }
  return false;
}
