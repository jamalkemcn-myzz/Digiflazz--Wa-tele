import type { Telegraf } from 'telegraf';
import { getEffectivePermissions, type AdminRole } from '../domain/rbac';
import { config } from '../config/env';
import {
  resolveOrCreateCustomer,
  findCustomerByPlatform,
  requestAccountLinkCode,
  getCustomerRefundCreditTotal,
} from '../services/customer.service';
import { getCustomerTransactions, getTransactionDetail } from '../services/transaction.service';
import {
  resolveAdminByPlatform,
  checkAdminPermission,
  getAdminBotTransactionReport,
  type ResolvedAdmin,
} from '../services/admin.service';
import { isMaintenanceMode } from '../services/settings.service';
import { centralScheduler } from '../workers/scheduler';
import {
  getProductBySkuOrId,
  listActiveBrandsInCategory,
} from '../services/product.service';
import { durationBucketFromCode } from '../domain/catalog-filter';
import {
  sendTelegramMainMenu,
  sendTelegramProfile,
  sendTelegramContactAdmin,
  handleTelegramVoucherCommand,
  sendTelegramCategoryList,
  sendTelegramCategorySelection,
  enterTelegramBrandCatalog,
  enterTelegramSeriesCatalog,
  promptTelegramSearch,
  sendTelegramProductPage,
  promptTelegramProductDestination,
  promptTelegramOrderConfirmation,
  executeTelegramOrder,
  handleTelegramOrderCancellation,
  getTelegramMainMenuButtons,
  toMarkupKeyboard,
  toTelegramHtml,
  extractTelegramUserMeta,
  clearTrackedTelegramMessages,
  TG_ADMIN_MENU_BUTTONS,
  TG_NAV_BACK_BUTTONS,
  type TelegramInlineButton,
  type TelegramReplyTransport,
} from './telegram.command-handler';
import { handleTelegramAdminConfigCallback } from './telegram.admin-config';
import { deleteTelegramMessageSafely, sendTelegramQrisInvoice } from './telegram.notification.service';
import {
  acquireOrderExecutionLock,
  clearBotSession,
  getBotSession,
  isOrderExecutionInFlight,
  markOrderConfirmedRecently,
  recordTelegramBotMessageId,
  releaseOrderExecutionLock,
  wasOrderConfirmedRecently,
} from './bot-session';

export function formatTelegramStatusAlertText(text: string): string {
  const clean = text.trim();
  if (clean.length <= 200) return clean;
  return `${clean.slice(0, 197).trimEnd()}...`;
}

export async function dispatchTelegramCallback(
  transport: TelegramReplyTransport,
  input: {
    data: string;
    userId?: string | null;
    username?: string | null;
    displayName?: string | null;
    sourceMessageId?: number | null;
  },
  options?: { dryRun?: boolean; demoAdmin?: { role: AdminRole; platformUserId: string } | null }
): Promise<void> {
  const dryRun = Boolean(options?.dryRun);
  const data = input.data;
  if (!data) {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    return;
  }

  if (data === 'CONFIRM_ORDER' || data === 'CONFIRM_ORDER_BALANCE') {
    const paymentMethod = data === 'CONFIRM_ORDER_BALANCE' ? 'BALANCE' : 'QRIS';
    const userId = input.userId || 'guest';
    if (!acquireOrderExecutionLock('TELEGRAM', userId, dryRun)) {
      if (transport.answerCbQuery) {
        await transport.answerCbQuery(
          paymentMethod === 'BALANCE'
            ? 'Sedang memproses pembayaran saldo, mohon tunggu...'
            : 'Sedang membuat invoice QRIS, mohon tunggu...',
          false
        );
      }
      return;
    }

    try {
      const session = getBotSession('TELEGRAM', userId, dryRun);
      if (session?.mode !== 'AWAITING_ORDER_CONFIRMATION') {
        if (wasOrderConfirmedRecently('TELEGRAM', userId, dryRun, input.sourceMessageId)) {
          if (transport.answerCbQuery) {
            await transport.answerCbQuery(
              paymentMethod === 'BALANCE'
                ? 'Pembayaran saldo baru saja diproses, silakan cek pesan terbaru.'
                : 'Invoice QRIS baru saja diproses, silakan cek pesan terbaru.',
              false
            );
          }
          return;
        }
        if (transport.deleteSourceMessage) {
          await transport.deleteSourceMessage();
        }
        if (transport.answerCbQuery) await transport.answerCbQuery();
        await transport.reply(
          'Sesi konfirmasi pesanan sudah berakhir ya Kak. Silakan pilih produk kembali.',
          TG_NAV_BACK_BUTTONS
        );
        return;
      }

      markOrderConfirmedRecently('TELEGRAM', userId, dryRun, input.sourceMessageId);
      if (transport.deleteSourceMessage) {
        await transport.deleteSourceMessage();
      }
      if (transport.answerCbQuery) {
        await transport.answerCbQuery(
          paymentMethod === 'BALANCE' ? '⏳ Memproses pembayaran saldo...' : '⏳ Membuat QRIS pembayaran...',
          false
        );
      }
      await executeTelegramOrder(transport, {
        userId,
        username: input.username,
        sku: session.sku,
        destination: session.destination,
        couponCode: session.couponCode || null,
        paymentMethod,
        dryRun,
      });
      return;
    } finally {
      releaseOrderExecutionLock('TELEGRAM', userId, dryRun);
    }
  }

  if (data === 'CANCEL_CONFIRM_ORDER') {
    const userId = input.userId || 'guest';
    if (isOrderExecutionInFlight('TELEGRAM', userId, dryRun)) {
      if (transport.answerCbQuery) {
        await transport.answerCbQuery('Invoice QRIS sedang dibuat, silakan tunggu sebentar.', false);
      }
      return;
    }
    if (transport.deleteSourceMessage) {
      await transport.deleteSourceMessage();
    }
    clearBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await transport.reply('Pembuatan pesanan dibatalkan sebelum QRIS dibuat.', TG_NAV_BACK_BUTTONS);
    return;
  }

  const isAlertOnlyCallback = data.startsWith('STATUS_');
  if (!isAlertOnlyCallback && transport.deleteSourceMessage) {
    await transport.deleteSourceMessage();
  }

  if (data === 'MAIN_MENU' || data === 'CANCEL_ORDER') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramMainMenu(
      transport,
      input.userId || 'guest',
      input.username,
      dryRun,
      input.displayName,
      options?.demoAdmin
    );
    return;
  }

  if (data === 'MY_PROFILE') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramProfile(transport, {
      userId: input.userId || 'guest',
      displayName: input.displayName,
      username: input.username,
      dryRun,
    });
    return;
  }

  if (data === 'REDEEM_VOUCHER') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await handleTelegramVoucherCommand(transport, {
      userId: input.userId || 'guest',
      username: input.username,
      dryRun,
    });
    return;
  }

  if (data === 'CONTACT_ADMIN') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramContactAdmin(transport);
    return;
  }

  if (data === 'CAT_LIST') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data === 'CARI_PRODUK') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await promptTelegramSearch(transport, {
      userId: input.userId || 'guest',
      dryRun,
    });
    return;
  }

  if (data === 'CARI_SCOPE') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    await promptTelegramSearch(transport, {
      userId,
      categoryId: session && 'categoryId' in session ? session.categoryId : undefined,
      brand: session && 'brand' in session ? session.brand : undefined,
      series: session && 'series' in session ? session.series : undefined,
      durationBucket: session?.mode === 'PRODUCT_LIST' ? session.durationBucket : undefined,
      detectedDestination:
        session && 'detectedDestination' in session ? session.detectedDestination : undefined,
      detectedOperatorLabel:
        session && 'detectedOperatorLabel' in session ? session.detectedOperatorLabel : undefined,
      dryRun,
    });
    return;
  }

  if (data.startsWith('SELSER_')) {
    const idx = Number(data.replace('SELSER_', ''));
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (session?.mode === 'SERIES_LIST' && Number.isFinite(idx) && session.seriesList[idx]) {
      await enterTelegramSeriesCatalog(transport, {
        userId,
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        brand: session.brand,
        series: session.seriesList[idx],
        hasSeriesStep: true,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
        dryRun,
      });
      return;
    }
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data === 'SELALLSER') {
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (session && (session.mode === 'SERIES_LIST' || session.mode === 'DURATION_LIST')) {
      await enterTelegramSeriesCatalog(transport, {
        userId,
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        brand: session.brand,
        series: undefined,
        hasSeriesStep: true,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
        dryRun,
      });
      return;
    }
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data.startsWith('SELDUR_')) {
    const code = data.replace('SELDUR_', '').trim();
    const bucket = durationBucketFromCode(code);
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (bucket && session?.mode === 'DURATION_LIST') {
      await sendTelegramProductPage(transport, {
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
        userId,
        dryRun,
      });
      return;
    }
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data === 'BACK_SERIES') {
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (
      session &&
      (session.mode === 'DURATION_LIST' || session.mode === 'PRODUCT_LIST') &&
      session.categoryId &&
      session.brand
    ) {
      await enterTelegramBrandCatalog(transport, {
        userId,
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        brand: session.brand,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
        dryRun,
      });
      return;
    }
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data === 'BACK_DUR') {
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (session?.mode === 'PRODUCT_LIST' && session.categoryId && session.brand) {
      await enterTelegramSeriesCatalog(transport, {
        userId,
        categoryId: session.categoryId,
        categoryName: session.categoryName,
        brand: session.brand,
        series: session.series,
        hasSeriesStep: session.hasSeriesStep,
        detectedDestination: session.detectedDestination,
        detectedOperatorLabel: session.detectedOperatorLabel,
        dryRun,
      });
      return;
    }
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data.startsWith('PGFL_')) {
    const page = Number(data.replace('PGFL_', '')) || 1;
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (session?.mode === 'PRODUCT_LIST') {
      await sendTelegramProductPage(transport, {
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
        userId,
        dryRun,
      });
      return;
    }
    await sendTelegramProductPage(transport, { page, userId, dryRun });
    return;
  }

  if (data.startsWith('CATBR_')) {
    const match = data.match(/^CATBR_(\d+)_(\d+)_(.+)$/);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (match) {
      const categoryId = Number(match[1]);
      const page = Number(match[2]) || 1;
      const brand = match[3];
      const userId = input.userId || 'guest';
      const existingSession = getBotSession('TELEGRAM', userId, dryRun);
      const detectedDestination =
        existingSession && 'detectedDestination' in existingSession
          ? existingSession.detectedDestination
          : undefined;
      const detectedOperatorLabel =
        existingSession && 'detectedOperatorLabel' in existingSession
          ? existingSession.detectedOperatorLabel
          : undefined;
      if (page === 1) {
        await enterTelegramBrandCatalog(transport, {
          userId,
          categoryId,
          brand,
          detectedDestination,
          detectedOperatorLabel,
          dryRun,
        });
      } else {
        await sendTelegramProductPage(transport, {
          page,
          categoryId,
          brand,
          detectedDestination,
          detectedOperatorLabel,
          userId,
          dryRun,
        });
      }
      return;
    }
  }

  if (data.startsWith('CATBI_')) {
    const match = data.match(/^CATBI_(\d+)_(\d+)_(\d+)$/);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (match) {
      const categoryId = Number(match[1]);
      const brandIdx = Number(match[2]);
      const page = Number(match[3]) || 1;
      const userId = input.userId || 'guest';
      const existingSession = getBotSession('TELEGRAM', userId, dryRun);
      const sessionBrand = existingSession?.mode === 'BRAND_LIST' ? existingSession.brands[brandIdx] : undefined;
      const brand = sessionBrand || listActiveBrandsInCategory(categoryId)[brandIdx]?.brand;
      const detectedDestination =
        existingSession && 'detectedDestination' in existingSession
          ? existingSession.detectedDestination
          : undefined;
      const detectedOperatorLabel =
        existingSession && 'detectedOperatorLabel' in existingSession
          ? existingSession.detectedOperatorLabel
          : undefined;
      if (page === 1) {
        await enterTelegramBrandCatalog(transport, {
          userId,
          categoryId,
          brand,
          detectedDestination,
          detectedOperatorLabel,
          dryRun,
        });
      } else {
        await sendTelegramProductPage(transport, {
          page,
          categoryId,
          brand,
          detectedDestination,
          detectedOperatorLabel,
          userId,
          dryRun,
        });
      }
      return;
    }
  }

  if (data.startsWith('CAT_')) {
    const [, catIdStr, pageStr] = data.split('_');
    const categoryId = Number(catIdStr);
    const page = Number(pageStr) || 1;
    const userId = input.userId || 'guest';
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (!pageStr || page === 1) {
      await sendTelegramCategorySelection(transport, { userId, categoryId, dryRun });
    } else {
      await sendTelegramProductPage(transport, { page, categoryId, userId, dryRun });
    }
    return;
  }

  if (data.startsWith('PROD_PAGE_')) {
    const page = Number(data.replace('PROD_PAGE_', '')) || 1;
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramProductPage(transport, { page, userId: input.userId || 'guest', dryRun });
    return;
  }

  if (data.startsWith('BUY_SKU_') || data.startsWith('BUY_ID_')) {
    const skuOrId = data.startsWith('BUY_SKU_')
      ? data.replace('BUY_SKU_', '').trim()
      : data.replace('BUY_ID_', '').trim();
    const userId = input.userId || 'guest';
    const session = getBotSession('TELEGRAM', userId, dryRun);
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (session?.mode === 'PRODUCT_LIST' && session.detectedDestination) {
      const product = getProductBySkuOrId(skuOrId);
      if (product && product.status === 'ACTIVE' && product.is_available === 1) {
        await promptTelegramOrderConfirmation(transport, {
          userId,
          username: input.username,
          sku: product.sku,
          destination: session.detectedDestination,
          dryRun,
        });
        return;
      }
    }
    await promptTelegramProductDestination(transport, userId, skuOrId, dryRun);
    return;
  }



  if (data.startsWith('CANCEL_TX_') && input.userId) {
    const txId = data.replace('CANCEL_TX_', '').trim();
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await handleTelegramOrderCancellation(transport, {
      userId: input.userId,
      transactionId: txId,
      dryRun,
    });
    return;
  }

  if (data === 'MY_LATEST_STATUS' && input.userId) {
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: input.userId })
      : resolveOrCreateCustomer({ platform: 'TELEGRAM', platformUserId: input.userId });
    const recent = resolved ? getCustomerTransactions(resolved.customer.id, 1) : [];
    if (transport.answerCbQuery) await transport.answerCbQuery();
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
      buttons.push([{ text: '🚫 Batalkan Pesanan', callbackData: `CANCEL_TX_${latest.transaction_id}` }]);
    }
    buttons.push([
      { text: '📜 Riwayat Lengkap', callbackData: 'MY_HISTORY' },
      { text: '🏠 Menu Utama', callbackData: 'MAIN_MENU' },
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

  if (data === 'MY_HISTORY' && input.userId) {
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: input.userId })
      : resolveOrCreateCustomer({ platform: 'TELEGRAM', platformUserId: input.userId });
    const txs = resolved ? getCustomerTransactions(resolved.customer.id, 5) : [];
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (!resolved || txs.length === 0) {
      await transport.reply('Belum ada riwayat transaksi ya Kak.', TG_NAV_BACK_BUTTONS);
      return;
    }
    const refundTotal = getCustomerRefundCreditTotal(resolved.customer.id);
    const lines = txs.map(
      (t) => `• ${t.transaction_id} — ${t.product_name_snapshot} (Rp${t.payment_amount.toLocaleString('id-ID')}) [${t.transaction_status}]`
    );
    await transport.reply(
      `Riwayat Transaksi (${input.userId})\n` +
        `Saldo: Rp${refundTotal.toLocaleString('id-ID')}\n\n` +
        lines.join('\n'),
      TG_NAV_BACK_BUTTONS
    );
    return;
  }

  if (data === 'LINK_ACCOUNT' && input.userId) {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (dryRun) {
      await transport.reply(
        `Kode Penghubung Akun (Simulasi Demo, berlaku ${config.accountLinking.codeExpiryMinutes} menit):\n\n` +
          `hubungkan DEMO-123456\n\n` +
          `Kirim perintah di atas ke Bot WhatsApp kami.\n[Mode Demo: token tidak dibuat di database]`,
        [[{ text: '🏠 Menu Utama', callbackData: 'MAIN_MENU' }]]
      );
      return;
    }
    const res = requestAccountLinkCode({
      platform: 'TELEGRAM',
      platformUserId: input.userId,
      platformUsername: input.username ?? null,
    });
    if (!res.ok) {
      await transport.reply(
        res.errorMessage || 'Maaf Kak, gagal membuat kode penghubung.',
        [[{ text: '🏠 Menu Utama', callbackData: 'MAIN_MENU' }]]
      );
      return;
    }
    await transport.reply(
      `Kode Penghubung Akun (berlaku ${config.accountLinking.codeExpiryMinutes} menit):\n\n` +
        `hubungkan ${res.code}\n\n` +
        `Kirim perintah di atas ke Bot WhatsApp kami. Jangan bagikan kode ini kepada siapa pun ya Kak.`,
      [[{ text: '🏠 Menu Utama', callbackData: 'MAIN_MENU' }]]
    );
    return;
  }

  if (data.startsWith('STATUS_') && input.userId) {
    const txId = data.replace('STATUS_', '').trim();
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: input.userId })
      : resolveOrCreateCustomer({
          platform: 'TELEGRAM',
          platformUserId: input.userId,
        });
    const detail = resolved ? getTransactionDetail(txId) : null;

    if (!detail || !resolved || detail.transaction.customer_id !== resolved.customer.id) {
      if (dryRun && txId.startsWith('TRX-DEMO-')) {
        const demoAlert = formatTelegramStatusAlertText(
          `Status ${txId}\nStatus: PENDING_PAYMENT (Mode Demo)\nPembayaran: PENDING | Supplier: NONE`
        );
        if (transport.answerCbQuery) {
          await transport.answerCbQuery(demoAlert, true);
        } else {
          await transport.reply(demoAlert, TG_NAV_BACK_BUTTONS);
        }
        return;
      }
      const notFoundAlert = 'Maaf Kak, transaksi tersebut tidak ditemukan pada akun Anda.';
      if (transport.answerCbQuery) {
        await transport.answerCbQuery(notFoundAlert, true);
      } else {
        await transport.reply(notFoundAlert, TG_NAV_BACK_BUTTONS);
      }
      return;
    }

    const t = detail.transaction;
    const shortProduct =
      t.product_name_snapshot.length > 42
        ? `${t.product_name_snapshot.slice(0, 39).trimEnd()}...`
        : t.product_name_snapshot;
    const alertText = formatTelegramStatusAlertText(
      `ID: ${t.transaction_id}\n` +
        `Produk: ${shortProduct}\n` +
        `Status: ${t.transaction_status}\n` +
        `Bayar: ${t.payment_status} | Supplier: ${t.supplier_status}` +
        (t.supplier_sn ? `\nSN: ${t.supplier_sn}` : '')
    );

    if (transport.answerCbQuery) {
      await transport.answerCbQuery(alertText, true);
    } else {
      const canCancel = ['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(t.transaction_status);
      const buttons: TelegramInlineButton[][] = canCancel
        ? [
            [{ text: '🚫 Batalkan Pesanan', callbackData: `CANCEL_TX_${t.transaction_id}` }],
            ...TG_NAV_BACK_BUTTONS,
          ]
        : TG_NAV_BACK_BUTTONS;
      await transport.reply(alertText, buttons);
    }
    return;
  }

  if (data === 'HELP') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await transport.reply(
      `Panduan Belanja Praktis:\n` +
        `1. Tap tombol Daftar Produk atau Kategori Produk (lalu pilih operator / kirim nomor HP).\n` +
        `2. Pilih produk yang Anda mau, kirim nomor tujuan, lalu konfirmasi (Ya/Batal).\n` +
        `3. Bayar QRIS atau klik Link Pembayaran sebelum 5 menit sesuai nominal tepat.\n` +
        `4. Ketik /batal untuk membatalkan pesanan PENDING (minimal 30 detik setelah dibuat).\n` +
        `5. Hubungkan akun WhatsApp melalui tombol Hubungkan WhatsApp.`,
      getTelegramMainMenuButtons()
    );
    return;
  }

  // Admin inline callbacks
  if (data.startsWith('ADMIN_')) {
    if (transport.answerCbQuery) await transport.answerCbQuery();
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
        : input.userId
          ? resolveAdminByPlatform('TELEGRAM', input.userId)
          : null;

    const admin = resolveAdmin();
    if (!admin) {
      await transport.reply('Maaf, akses admin ditolak.', [[{ text: '🏠 Menu Pelanggan', callbackData: 'MAIN_MENU' }]]);
      return;
    }

    const handledConfig = await handleTelegramAdminConfigCallback({
      data,
      transport,
      admin,
      userId: input.userId || 'guest',
      dryRun,
    });
    if (handledConfig) {
      return;
    }

    if (data.startsWith('ADMIN_TX_') && checkAdminPermission(admin, 'transactions:read')) {
      const page = Number(data.replace('ADMIN_TX_', '')) || 1;
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

    if (data === 'ADMIN_TODAY' && checkAdminPermission(admin, 'transactions:read')) {
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

    if (data === 'ADMIN_STATUS' && checkAdminPermission(admin, 'bots:read')) {
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

    await transport.reply('Maaf, Anda tidak memiliki izin untuk aksi ini.', TG_ADMIN_MENU_BUTTONS);
    return;
  }

  if (transport.answerCbQuery) await transport.answerCbQuery();
}

export function registerTelegramCallbacks(bot: Telegraf): void {
  bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? ctx.from?.id;
    let answered = false;
    let deleted = false;

    const answerOnce = async (text?: string, showAlert?: boolean) => {
      if (answered) return;
      answered = true;
      await ctx.answerCbQuery(text, showAlert ? { show_alert: true } : undefined).catch(() => undefined);
    };

    // Immediately acknowledge non-alert, non-confirmation callbacks so Telegram removes the spinner right away;
    // STATUS_* waits for DB lookup alert text, and CONFIRM_ORDER / CANCEL_CONFIRM_ORDER answer right after lock check.
    if (
      !data.startsWith('STATUS_') &&
      data !== 'CONFIRM_ORDER' &&
      data !== 'CONFIRM_ORDER_BALANCE' &&
      data !== 'CANCEL_CONFIRM_ORDER'
    ) {
      void answerOnce();
    }

    let cleanupPromise: Promise<void> | null = null;
    const transport: TelegramReplyTransport = {
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
        void ctx.telegram.sendChatAction(chatId, 'upload_photo').catch(() => undefined);
        const msgId = await sendTelegramQrisInvoice(bot, chatId, caption, qris, toMarkupKeyboard(buttons));
        if (msgId) {
          recordTelegramBotMessageId(chatId, msgId);
        }
        return msgId;
      },
      async sendStatusMessage(text: string) {
        if (!chatId) return undefined;
        let sentMsgId: number | null = null;
        try {
          const sent = await ctx.reply(toTelegramHtml(text), { parse_mode: 'HTML' });
          sentMsgId = sent.message_id;
        } catch {
          const sent = await ctx.reply(text).catch(() => null);
          sentMsgId = sent?.message_id ?? null;
        }
        void ctx.telegram.sendChatAction(chatId, 'upload_photo').catch(() => undefined);
        if (!sentMsgId) return undefined;
        let dismissed = false;
        return async () => {
          if (dismissed) return;
          dismissed = true;
          await deleteTelegramMessageSafely(bot, chatId, sentMsgId);
        };
      },
      async answerCbQuery(text?: string, showAlert?: boolean) {
        await answerOnce(text, showAlert);
      },
      async deleteSourceMessage() {
        if (deleted) return;
        deleted = true;
        cleanupPromise = Promise.allSettled([
          ctx.deleteMessage().catch(() => undefined),
          chatId ? clearTrackedTelegramMessages(bot, chatId) : Promise.resolve(),
        ]).then(() => undefined);
      },
    };
    const { displayName, username } = extractTelegramUserMeta(ctx.from);
    const sourceMessageId =
      ctx.callbackQuery && 'message' in ctx.callbackQuery && ctx.callbackQuery.message
        ? ctx.callbackQuery.message.message_id
        : null;
    await dispatchTelegramCallback(transport, {
      data,
      userId: ctx.from ? String(ctx.from.id) : null,
      username,
      displayName,
      sourceMessageId,
    });
    if (cleanupPromise) {
      await cleanupPromise;
    }
  });
}
