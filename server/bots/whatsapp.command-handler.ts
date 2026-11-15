import { getEffectivePermissions, type AdminRole } from '../domain/rbac';
import QRCode from 'qrcode';
import { config } from '../config/env';
import { logger } from '../logging/logger';
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
import { clearBotSession, getBotSession, setBotSession } from './bot-session';

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
  demoAdmin?: {
    role: AdminRole;
    platformUserId: string;
  } | null;
}

const MAIN_MENU_BUTTONS: WhatsappQuickButton[][] = [
  [
    { text: '1. Kategori Produk', replyText: 'kategori' },
    { text: '2. Daftar Produk', replyText: 'produk' },
  ],
  [
    { text: '3. Cek Status', replyText: 'status' },
    { text: '4. Riwayat & Refund', replyText: 'riwayat' },
  ],
  [
    { text: '5. Hubungkan Akun', replyText: 'hubungkan' },
    { text: '6. Panduan', replyText: 'bantuan' },
  ],
];

const NAV_BACK_BUTTONS: WhatsappQuickButton[][] = [
  [
    { text: 'Daftar Produk', replyText: 'produk' },
    { text: 'Menu Utama', replyText: 'menu' },
  ],
];

// Bounded in-memory rate limit for WhatsApp customer commands
const rateMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(jid: string, max = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateMap.get(jid);
  if (!entry || now > entry.resetAt) {
    if (rateMap.size > 5000) rateMap.clear();
    rateMap.set(jid, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function greetingPrefix(pushName?: string): string {
  const clean = (pushName || '').trim();
  return clean ? `Halo Kak *${clean}*` : 'Halo Kak';
}

async function sendMainMenu(sock: WhatsappReplyTransport, jid: string, pushName?: string, dryRun?: boolean) {
  setBotSession('WHATSAPP', jid, { mode: 'MAIN_MENU', updatedAt: Date.now() }, dryRun);
  await sock.sendMessage(jid, {
    text:
      `${greetingPrefix(pushName)}! Selamat datang di *PPOB Bot Ecosystem*.\n` +
      `Silakan pilih layanan melalui tombol menu di bawah atau balas dengan angkanya:\n\n` +
      `1. *Kategori Produk* — Jelajahi layanan berdasarkan kategori\n` +
      `2. *Daftar Produk* — Lihat produk aktif & harga terbaru\n` +
      `3. *Cek Status* — Pantau status transaksi terakhir Anda\n` +
      `4. *Riwayat & Refund* — Riwayat belanja & kredit refund\n` +
      `5. *Hubungkan Akun* — Tautkan akun WhatsApp & Telegram\n` +
      `6. *Panduan* — Cara pesan cepat\n\n` +
      `_*PPOB Bot — Menu Utama*_`,
    quickReplies: MAIN_MENU_BUTTONS,
  });
}

async function sendCategoryList(sock: WhatsappReplyTransport, jid: string, dryRun?: boolean) {
  const cats = listCategories(true);
  if (cats.length === 0) {
    await sock.sendMessage(jid, {
      text: 'Maaf Kak, belum ada kategori produk yang aktif saat ini. Silakan coba lagi nanti ya.',
      quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
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
      replyText: `produk_kat ${c.id} 1`,
    }));
    buttonRows.push(row);
  }
  buttonRows.push([
    { text: 'Semua Produk', replyText: 'produk' },
    { text: 'Menu Utama', replyText: 'menu' },
  ]);

  await sock.sendMessage(jid, {
    text:
      `*Kategori Produk Aktif*\n` +
      `${lines}\n\n` +
      `Pilih salah satu tombol kategori di bawah atau balas dengan *angka kategori* ya Kak.`,
    quickReplies: buttonRows,
  });
}

async function sendProductPage(
  sock: WhatsappReplyTransport,
  jid: string,
  params: { page: number; categoryId?: number; search?: string },
  dryRun?: boolean
) {
  const res = listProducts({
    page: params.page,
    limit: 6,
    categoryId: params.categoryId,
    search: params.search,
    onlyActive: true,
  });

  if (res.items.length === 0) {
    await sock.sendMessage(jid, {
      text: params.search
        ? `Maaf Kak, produk untuk kata kunci "${params.search}" belum ditemukan. Coba lihat kategori atau semua produk ya.`
        : 'Maaf Kak, belum ada produk aktif di daftar ini saat ini.',
      quickReplies: [
        [
          { text: 'Lihat Kategori', replyText: 'kategori' },
          { text: 'Semua Produk', replyText: 'produk' },
        ],
        [{ text: 'Menu Utama', replyText: 'menu' }],
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
      updatedAt: Date.now(),
    },
    dryRun
  );

  const lines = res.items.map(
    (p, idx) => `${idx + 1}. *${p.name}* (${p.sku})\n    Rp${p.selling_price.toLocaleString('id-ID')}`
  );

  const buttonRows: WhatsappQuickButton[][] = [];
  for (let i = 0; i < res.items.length; i += 2) {
    const row = res.items.slice(i, i + 2).map((p, offset) => ({
      text: `${i + offset + 1}. ${p.sku} · Rp${p.selling_price.toLocaleString('id-ID')}`,
      replyText: `pilih ${p.sku}`,
    }));
    buttonRows.push(row);
  }

  const navRow: WhatsappQuickButton[] = [];
  if (params.page > 1) {
    navRow.push({
      text: 'Sebelumnya',
      replyText: params.categoryId
        ? `produk_kat ${params.categoryId} ${params.page - 1}`
        : `produk_hal ${params.page - 1}`,
    });
  }
  if (params.page < res.pagination.totalPages) {
    navRow.push({
      text: 'Berikutnya',
      replyText: params.categoryId
        ? `produk_kat ${params.categoryId} ${params.page + 1}`
        : `produk_hal ${params.page + 1}`,
    });
  }
  if (navRow.length > 0) buttonRows.push(navRow);

  buttonRows.push([
    { text: 'Kategori Lain', replyText: 'kategori' },
    { text: 'Menu Utama', replyText: 'menu' },
  ]);

  await sock.sendMessage(jid, {
    text:
      `*Daftar Produk (Hal ${params.page}/${res.pagination.totalPages})*\n` +
      `${lines.join('\n')}\n\n` +
      `Tap tombol produk di bawah (atau balas angkanya) untuk langsung memesan tanpa mengetik SKU manual!`,
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
      `*${product.name}* (${product.sku})\n` +
      `Harga: *Rp${product.selling_price.toLocaleString('id-ID')}*\n\n` +
      `Silakan ketik *nomor tujuan / ID pelanggan* Anda sekarang ya Kak (contoh: \`081234567890\`, atau tambahkan kode kupon setelah spasi).`,
    quickReplies: [
      [
        { text: 'Pilih Produk Lain', replyText: 'produk' },
        { text: 'Batal / Menu Utama', replyText: 'batal' },
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
  const result = params.dryRun
    ? previewOrderDryRun({
        platform: 'WHATSAPP',
        platformUserId: jid,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: params.couponCode || null,
      })
    : await createOrder({
        platform: 'WHATSAPP',
        platformUserId: jid,
        platformUsername: params.pushName || null,
        productSkuOrId: params.sku,
        destination: params.destination,
        couponCode: params.couponCode || null,
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
            { text: 'Cek Status Invoice', replyText: `status ${a.transaction_id}` },
            { text: 'Menu Utama', replyText: 'menu' },
          ],
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
  const caption =
    `Terima kasih Kak! Pesanan siap dibayar:\n\n` +
    `*INVOICE PEMBAYARAN QRIS*\n` +
    `ID Transaksi: ${tx.transaction_id}\n` +
    `Produk: ${tx.product_name_snapshot}\n` +
    `Tujuan: ${maskDestination(tx.destination)}\n` +
    (tx.discount_snapshot > 0 ? `Diskon Kupon: -Rp${tx.discount_snapshot.toLocaleString('id-ID')}\n` : '') +
    `Kode Unik: ${tx.unique_code}\n` +
    `*Total Bayar: Rp${tx.payment_amount.toLocaleString('id-ID')}*\n` +
    `Berlaku hingga: ${new Date(tx.expired_at!).toLocaleTimeString('id-ID')} (${config.transaction.invoiceExpiryMinutes} menit)\n\n` +
    `Silakan scan QRIS di atas dengan nominal TEPAT Rp${tx.payment_amount.toLocaleString('id-ID')} ya Kak.` +
    (params.dryRun ? `\n\n_[Mode Demo: pratinjau invoice & QRIS, transaksi tidak disimpan ke database]_` : '');

  const invoiceButtons: WhatsappQuickButton[][] = [
    [
      { text: 'Cek Status Pembayaran', replyText: `status ${tx.transaction_id}` },
      { text: 'Menu Utama', replyText: 'menu' },
    ],
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
      const sent = await sock.sendMessage(jid, {
        image: { url: result.qris.qrUrl },
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

export async function handleWhatsappCommand(
  sock: WhatsappReplyTransport,
  jid: string,
  text: string,
  pushName?: string,
  options?: WhatsappCommandOptions
): Promise<void> {
  const dryRun = Boolean(options?.dryRun);
  if (!dryRun && !checkRateLimit(jid)) {
    await sock.sendMessage(jid, {
      text: 'Mohon tunggu sebentar ya Kak, permintaan terlalu cepat.',
    });
    return;
  }

  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/^[!/]/, '');
  const args = parts.slice(1);

  // Admin commands (require backend RBAC verification via admin_identities)
  if (trimmed.startsWith('!')) {
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
        quickReplies: [[{ text: 'Buka Menu Utama', replyText: 'menu' }]],
      });
      return;
    }

    const adminMenuButtons: WhatsappQuickButton[][] = [
      [
        { text: 'Transaksi Terbaru', replyText: '!transaksi' },
        { text: 'Status Layanan', replyText: '!statusbot' },
      ],
      [{ text: 'Menu Pelanggan', replyText: 'menu' }],
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
  if (cmd === 'batal' || cmd === 'cancel' || trimmed === '0') {
    clearBotSession('WHATSAPP', jid, dryRun);
    await sendMainMenu(sock, jid, pushName, dryRun);
    return;
  }

  if (cmd === 'menu' || cmd === 'start' || cmd === 'hai' || cmd === 'halo' || cmd === 'hi') {
    await sendMainMenu(sock, jid, pushName, dryRun);
    return;
  }

  if (cmd === 'bantuan' || cmd === 'help') {
    clearBotSession('WHATSAPP', jid, dryRun);
    await sock.sendMessage(jid, {
      text:
        `*Panduan Belanja Praktis*\n` +
        `1. Tap tombol *Daftar Produk* atau *Kategori Produk*.\n` +
        `2. Pilih produk yang Anda inginkan, lalu kirim nomor tujuan.\n` +
        `3. Scan QRIS yang muncul sesuai nominal tepat sebelum batas waktu.\n\n` +
        `Bisa juga ketik langsung: \`order <SKU> <TUJUAN> [KUPON]\` bila sudah hafal kode SKU.`,
      quickReplies: MAIN_MENU_BUTTONS,
    });
    return;
  }

  if (cmd === 'kategori') {
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

  if (cmd === 'produk_kat') {
    const categoryId = Number(args[0]) || undefined;
    const page = Math.max(1, Number(args[1]) || 1);
    await sendProductPage(sock, jid, { page, categoryId }, dryRun);
    return;
  }

  if (cmd === 'pilih' && args[0]) {
    await promptProductDestination(sock, jid, args[0].trim(), dryRun);
    return;
  }

  if (cmd === 'order') {
    if (args.length < 2) {
      await sock.sendMessage(jid, {
        text:
          `Supaya lebih praktis, Kakak bisa tap tombol *Daftar Produk* lalu pilih produk tanpa mengetik format manual.\n` +
          `Atau ketik: *order <SKU> <TUJUAN> [KODE_KUPON]*`,
        quickReplies: NAV_BACK_BUTTONS,
      });
      return;
    }
    const [sku, destination, couponCode] = args;
    await executeWhatsappOrder(sock, jid, { sku, destination, couponCode, pushName, dryRun });
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
      await sock.sendMessage(jid, {
        text:
          `*Status Transaksi ${t.transaction_id}*\n` +
          `Produk: ${t.product_name_snapshot}\n` +
          `Tujuan: ${t.destination_masked}\n` +
          `Nominal: Rp${t.payment_amount.toLocaleString('id-ID')}\n` +
          `Status: *${t.transaction_status}*\n` +
          (t.supplier_sn ? `SN / Token: ${t.supplier_sn}\n` : ''),
        quickReplies: NAV_BACK_BUTTONS,
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
    await sock.sendMessage(jid, {
      text:
        `*Transaksi Terakhir (${latest.transaction_id})*\n` +
        `Produk: ${latest.product_name_snapshot}\n` +
        `Nominal: Rp${latest.payment_amount.toLocaleString('id-ID')}\n` +
        `Status: *${latest.transaction_status}*`,
      quickReplies: [
        [
          { text: 'Lihat Semua Riwayat', replyText: 'riwayat' },
          { text: 'Menu Utama', replyText: 'menu' },
        ],
      ],
    });
    return;
  }

  if (cmd === 'riwayat') {
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
      (t) => `• ${t.transaction_id} — ${t.product_name_snapshot} (Rp${t.payment_amount.toLocaleString('id-ID')}) [${t.transaction_status}]`
    );
    await sock.sendMessage(jid, {
      text:
        `*Riwayat Transaksi (${customer.customer_code})*\n` +
        `Kredit Refund Internal: Rp${refundTotal.toLocaleString('id-ID')}\n\n` +
        (lines.length > 0 ? lines.join('\n') : 'Belum ada riwayat transaksi ya Kak.'),
      quickReplies: NAV_BACK_BUTTONS,
    });
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
        quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
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
          quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
        });
        return;
      }
      await sock.sendMessage(jid, {
        text:
          `*Kode Penghubung Akun*\n` +
          `Kirim perintah berikut di Bot Telegram dalam ${config.accountLinking.codeExpiryMinutes} menit:\n` +
          `/hubungkan ${res.code}\n\n` +
          `Jangan bagikan kode ini kepada siapa pun ya Kak.`,
        quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
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
      quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
    });
    return;
  }

  if (cmd === 'unlink') {
    clearBotSession('WHATSAPP', jid, dryRun);
    if (dryRun) {
      await sock.sendMessage(jid, {
        text: '[Mode Demo] Simulasi unlink WhatsApp — identitas nyata tidak diubah.',
        quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
      });
      return;
    }
    const res = unlinkPlatformIdentity({ platform: 'WHATSAPP', platformUserId: jid });
    await sock.sendMessage(jid, {
      text: res.ok
        ? 'Identitas WhatsApp berhasil diputuskan dari akun gabungan.'
        : res.errorMessage || 'Maaf, gagal unlink akun.',
      quickReplies: [[{ text: 'Menu Utama', replyText: 'menu' }]],
    });
    return;
  }

  // Interactive conversation state fallback (numbered menu replies & guided destination entry)
  const session = getBotSession('WHATSAPP', jid, dryRun);
  if (session?.mode === 'AWAITING_DESTINATION') {
    const [dest, coupon] = parts;
    await executeWhatsappOrder(sock, jid, {
      sku: session.sku,
      destination: dest,
      couponCode: coupon || null,
      pushName,
      dryRun,
    });
    return;
  }

  const numericChoice = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  if (numericChoice !== null) {
    if (session?.mode === 'CATEGORY_LIST') {
      const catId = session.categoryIds[numericChoice - 1];
      if (catId) {
        await sendProductPage(sock, jid, { page: 1, categoryId: catId }, dryRun);
        return;
      }
    } else if (session?.mode === 'PRODUCT_LIST') {
      const chosenSku = session.skus[numericChoice - 1];
      if (chosenSku) {
        await promptProductDestination(sock, jid, chosenSku, dryRun);
        return;
      }
    } else if (numericChoice >= 1 && numericChoice <= 6) {
      if (numericChoice === 1) return sendCategoryList(sock, jid, dryRun);
      if (numericChoice === 2) return sendProductPage(sock, jid, { page: 1 }, dryRun);
      if (numericChoice === 3) return handleWhatsappCommand(sock, jid, 'status', pushName, options);
      if (numericChoice === 4) return handleWhatsappCommand(sock, jid, 'riwayat', pushName, options);
      if (numericChoice === 5) return handleWhatsappCommand(sock, jid, 'hubungkan', pushName, options);
      if (numericChoice === 6) return handleWhatsappCommand(sock, jid, 'bantuan', pushName, options);
    }
  }

  // Direct SKU lookup shortcut
  const sampleProduct = getProductBySkuOrId(trimmed);
  if (sampleProduct) {
    await promptProductDestination(sock, jid, sampleProduct.sku, dryRun);
    return;
  }

  // Friendly fallback with clickable menu buttons
  await sock.sendMessage(jid, {
    text:
      `${greetingPrefix(pushName)}! Maaf, saya belum memahami pesan "${trimmed}".\n` +
      `Silakan pilih langsung menu di bawah ini agar lebih mudah ya Kak:`,
    quickReplies: MAIN_MENU_BUTTONS,
  });
}
