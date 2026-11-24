import type { AppConfig } from '../config/env';
import { extractWhatsappPhoneFromJid } from '../domain/masking';
import type { CustomerProfileSummary } from '../services/customer.service';

export function resolveDisplayName(
  displayName?: string | null,
  username?: string | null,
  fallback = 'Pelanggan'
): string {
  const cleanDisplay = (displayName || '').trim();
  if (cleanDisplay) return cleanDisplay;
  const cleanUsername = (username || '').replace(/^@/, '').trim();
  if (cleanUsername) return cleanUsername;
  return fallback;
}

export function formatRegistrationDate(iso: string, timezone = 'Asia/Jakarta'): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: timezone,
    }).format(parsed);
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

export function formatStartMessage(params: {
  displayName?: string | null;
  username?: string | null;
  shopName: string;
  userId: string;
  isAdmin: boolean;
  totalUsers?: number;
}): string {
  const name = resolveDisplayName(params.displayName, params.username);
  return (
    `Halo Kak ${name}!\n` +
    `Selamat datang di ${params.shopName} — Layanan Pelanggan.\n` +
    `Silakan pilih menu lewat tombol praktis di bawah tanpa perlu mengetik perintah manual:\n\n` +
    `• ID User: ${params.userId}\n` +
    `• Status: ${params.isAdmin ? 'Admin' : 'Member'}`
  );
}

export function formatProfileMessage(
  summary: CustomerProfileSummary,
  timezone = 'Asia/Jakarta'
): string {
  const joinedDate = formatRegistrationDate(summary.joinedAt, timezone);
  return (
    `👤 *Profil Pengguna*\n\n` +
    `📊 *Akun*\n` +
    `• ID: ${summary.userId}\n` +
    `• Username: ${summary.username}\n` +
    `• Bergabung: ${joinedDate}\n\n` +
    `💵 *Keuangan*\n` +
    `• Saldo: Rp ${summary.balance.toLocaleString('id-ID')}\n` +
    `• Poin Loyalitas: ${summary.loyaltyPoints.toLocaleString('id-ID')}\n` +
    `• Tier: ${summary.tier}\n` +
    `• Total Belanja: Rp ${summary.totalSpent.toLocaleString('id-ID')}`
  );
}

export function formatContactAdminMessage(cfg: AppConfig): string {
  const lines: string[] = [
    `*Hubungi Admin — ${cfg.shopName}*`,
    '',
    'Butuh bantuan pesanan, kendala pembayaran QRIS, atau pertanyaan produk?',
  ];

  const contacts: string[] = [];
  if (cfg.auth.ownerWhatsappJid) {
    const waDigits = extractWhatsappPhoneFromJid(cfg.auth.ownerWhatsappJid);
    if (waDigits) {
      contacts.push(`• WhatsApp Admin: https://wa.me/${waDigits}`);
    }
  }
  if (cfg.auth.ownerTelegramId) {
    contacts.push(`• Telegram Admin: tg://user?id=${cfg.auth.ownerTelegramId} (ID: ${cfg.auth.ownerTelegramId})`);
  }

  if (contacts.length > 0) {
    lines.push('', ...contacts);
  } else {
    lines.push('', 'Silakan hubungi admin resmi toko melalui saluran chat ini.');
  }

  lines.push('', 'Mohon sertakan *ID Transaksi* agar admin dapat membantu lebih cepat ya Kak.');
  return lines.join('\n');
}

export function formatVoucherPromptMessage(
  platform: 'WHATSAPP' | 'TELEGRAM',
  activeVoucher?: string | null
): string {
  const exampleCmd = platform === 'WHATSAPP' ? 'voucher KODEPROMO' : '/voucher KODEPROMO';
  const inputHint =
    platform === 'WHATSAPP'
      ? `Balas dengan *kode voucher* Anda sekarang (contoh: *KODEPROMO* atau *${exampleCmd}*).`
      : `Kirimkan *kode voucher* Anda sekarang (contoh: KODEPROMO atau ${exampleCmd}).`;

  return (
    `🎟️ *Redeem Voucher*\n\n` +
    (activeVoucher
      ? `Voucher aktif saat ini: *${activeVoucher}* (akan otomatis dipakai pada pesanan berikutnya).\n\n`
      : '') +
    `${inputHint}`
  );
}

export function formatVoucherSuccessMessage(
  coupon: {
    code: string;
    name: string;
    discountType: 'PERCENT' | 'FIXED';
    discountValue: number;
    minPurchase: number;
    maxDiscount: number | null;
    expiresAt: string;
  },
  timezone = 'Asia/Jakarta'
): string {
  const discountLabel =
    coupon.discountType === 'PERCENT'
      ? `${coupon.discountValue}%${coupon.maxDiscount ? ` (maks. Rp ${coupon.maxDiscount.toLocaleString('id-ID')})` : ''}`
      : `Rp ${coupon.discountValue.toLocaleString('id-ID')}`;

  return (
    `✅ *Voucher Berhasil Diterapkan!*\n\n` +
    `• Kode: *${coupon.code}*\n` +
    `• Program: ${coupon.name}\n` +
    `• Potongan: ${discountLabel}\n` +
    `• Min. Belanja: Rp ${coupon.minPurchase.toLocaleString('id-ID')}\n` +
    `• Berlaku s/d: ${formatRegistrationDate(coupon.expiresAt, timezone)}\n\n` +
    `Voucher akan otomatis terpasang saat Kakak memilih produk di *Daftar Produk*.`
  );
}
