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
  sendTelegramMainMenu,
  sendTelegramCategoryList,
  sendTelegramProductPage,
  promptTelegramProductDestination,
  handleTelegramOrderCancellation,
  toMarkupKeyboard,
  clearTrackedTelegramMessages,
  TG_ADMIN_MENU_BUTTONS,
  TG_MAIN_MENU_BUTTONS,
  TG_NAV_BACK_BUTTONS,
  type TelegramInlineButton,
  type TelegramReplyTransport,
} from './telegram.command-handler';
import { sendTelegramQrisInvoice } from './telegram.notification.service';
import { recordTelegramBotMessageId } from './bot-session';

export async function dispatchTelegramCallback(
  transport: TelegramReplyTransport,
  input: { data: string; userId?: string | null; username?: string | null },
  options?: { dryRun?: boolean; demoAdmin?: { role: AdminRole; platformUserId: string } | null }
): Promise<void> {
  const dryRun = Boolean(options?.dryRun);
  const data = input.data;
  if (!data) {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    return;
  }
  if (transport.deleteSourceMessage) {
    await transport.deleteSourceMessage();
  }

  if (data === 'MAIN_MENU' || data === 'CANCEL_ORDER') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramMainMenu(transport, input.userId || 'guest', input.username, dryRun);
    return;
  }

  if (data === 'CAT_LIST') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramCategoryList(transport);
    return;
  }

  if (data.startsWith('CAT_')) {
    const [, catIdStr, pageStr] = data.split('_');
    const categoryId = Number(catIdStr);
    const page = Number(pageStr) || 1;
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramProductPage(transport, { page, categoryId });
    return;
  }

  if (data.startsWith('PROD_PAGE_')) {
    const page = Number(data.replace('PROD_PAGE_', '')) || 1;
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await sendTelegramProductPage(transport, { page });
    return;
  }

  if (data.startsWith('BUY_SKU_')) {
    const sku = data.replace('BUY_SKU_', '').trim();
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await promptTelegramProductDestination(transport, input.userId || 'guest', sku, dryRun);
    return;
  }

  if (data.startsWith('BUY_ID_')) {
    const prodId = data.replace('BUY_ID_', '').trim();
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await promptTelegramProductDestination(transport, input.userId || 'guest', prodId, dryRun);
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
      `Riwayat Transaksi (${resolved.customer.customer_code})\n` +
        `Kredit Refund Internal: Rp${refundTotal.toLocaleString('id-ID')}\n\n` +
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
        [[{ text: 'Menu Utama', callbackData: 'MAIN_MENU' }]]
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

  if (data.startsWith('STATUS_') && input.userId) {
    const txId = data.replace('STATUS_', '');
    const resolved = dryRun
      ? findCustomerByPlatform({ platform: 'TELEGRAM', platformUserId: input.userId })
      : resolveOrCreateCustomer({
          platform: 'TELEGRAM',
          platformUserId: input.userId,
        });
    const detail = resolved ? getTransactionDetail(txId) : null;
    if (transport.answerCbQuery) await transport.answerCbQuery();
    if (!detail || !resolved || detail.transaction.customer_id !== resolved.customer.id) {
      if (dryRun && txId.startsWith('TRX-DEMO-')) {
        await transport.reply(
          `Status ${txId}: PENDING_PAYMENT (Mode Demo)\nPembayaran: PENDING | Supplier: NONE`,
          TG_NAV_BACK_BUTTONS
        );
        return;
      }
      await transport.reply('Maaf Kak, transaksi tersebut tidak ditemukan pada akun Anda.', TG_NAV_BACK_BUTTONS);
      return;
    }
    const t = detail.transaction;
    const canCancel = ['CREATED', 'PENDING_PAYMENT', 'PAYMENT_PROCESSING'].includes(t.transaction_status);
    const buttons: TelegramInlineButton[][] = canCancel
      ? [
          [{ text: 'Batalkan Pesanan', callbackData: `CANCEL_TX_${t.transaction_id}` }],
          ...TG_NAV_BACK_BUTTONS,
        ]
      : TG_NAV_BACK_BUTTONS;
    await transport.reply(
      `Status ${t.transaction_id}: ${t.transaction_status}\n` +
        `Pembayaran: ${t.payment_status} | Supplier: ${t.supplier_status}` +
        (t.supplier_sn ? `\nSN / Token: ${t.supplier_sn}` : ''),
      buttons
    );
    return;
  }

  if (data === 'HELP') {
    if (transport.answerCbQuery) await transport.answerCbQuery();
    await transport.reply(
      `Panduan Belanja Praktis:\n` +
        `1. Tap tombol Daftar Produk atau Kategori Produk.\n` +
        `2. Pilih produk yang Anda mau, lalu kirim nomor tujuan.\n` +
        `3. Bayar QRIS sebelum 5 menit sesuai nominal tepat.\n` +
        `4. Hubungkan akun WhatsApp melalui tombol Hubungkan WhatsApp.`,
      TG_MAIN_MENU_BUTTONS
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
      await transport.reply('Maaf, akses admin ditolak.', [[{ text: 'Menu Pelanggan', callbackData: 'MAIN_MENU' }]]);
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
    let deleted = false;
    const transport: TelegramReplyTransport = {
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
      async answerCbQuery() {
        await ctx.answerCbQuery().catch(() => undefined);
      },
      async deleteSourceMessage() {
        if (deleted) return;
        deleted = true;
        await ctx.deleteMessage().catch(() => undefined);
        if (chatId) {
          await clearTrackedTelegramMessages(bot, chatId);
        }
      },
    };
    await dispatchTelegramCallback(transport, {
      data,
      userId: ctx.from ? String(ctx.from.id) : null,
      username: ctx.from ? ctx.from.username || ctx.from.first_name || null : null,
    });
  });
}
