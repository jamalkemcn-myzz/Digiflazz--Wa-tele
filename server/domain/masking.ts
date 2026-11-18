export function normalizeWhatsappNumber(input: string): string {
  const digits = input.replace(/[^\d]/g, '');
  if (!digits) {
    throw new Error('Nomor WhatsApp tidak valid');
  }
  if (digits.startsWith('0')) {
    return `62${digits.slice(1)}`;
  }
  if (digits.startsWith('8')) {
    return `62${digits}`;
  }
  if (digits.startsWith('62')) {
    return digits;
  }
  return digits;
}

export function extractWhatsappPhoneFromJid(jid: string): string {
  const local = jid.split('@')[0]?.split(':')[0] || '';
  return normalizeWhatsappNumber(local);
}

export function toWhatsappJid(phoneOrJid: string): string {
  if (phoneOrJid.includes('@')) return phoneOrJid;
  return `${normalizeWhatsappNumber(phoneOrJid)}@s.whatsapp.net`;
}

export function maskDestination(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '****';
  if (trimmed.length <= 7) {
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function maskCustomerIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length <= 4) return '****';
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}

export function maskTransactionId(transactionId: string): string {
  const trimmed = transactionId.trim();
  if (!trimmed) return '****';
  const parts = trimmed.split('-').filter(Boolean);
  if (parts.length >= 2) {
    const prefix = parts[0];
    const last = parts[parts.length - 1];
    const suffix = last.length > 4 ? last.slice(-4) : last;
    return `${prefix}-****-${suffix}`;
  }
  if (trimmed.length <= 7) return '****';
  return `${trimmed.slice(0, 3)}-****-${trimmed.slice(-4)}`;
}

export function maskSerialNumber(sn: string): string {
  const trimmed = sn.trim();
  if (!trimmed) return '-';
  if (trimmed.length <= 4) return '****';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

export function maskBuyerForTestimony(params: {
  customerCode: string;
  platformUsername?: string | null;
  platformUserId?: string | null;
}): { buyerLabel: string; maskedId: string } {
  const rawUsername = (params.platformUsername || '').trim().replace(/^@+/, '');
  const rawUserId = (params.platformUserId || '').trim();
  const baseId = rawUserId || params.customerCode;
  const digitsOnly = baseId.replace(/\D/g, '');
  const idTail = digitsOnly.length >= 4 ? digitsOnly.slice(-4) : baseId.slice(-4);

  let buyerLabel: string;
  if (rawUsername) {
    const safeUser =
      rawUsername.length <= 3
        ? '***'
        : `${rawUsername.slice(0, 2)}***${rawUsername.slice(-1)}`;
    buyerLabel = `@${safeUser}`;
  } else if (idTail) {
    buyerLabel = `User ****${idTail}`;
  } else {
    buyerLabel = `Member ${maskCustomerIdentifier(params.customerCode)}`;
  }

  const maskedId =
    baseId.length <= 4
      ? '****'
      : baseId.length <= 7
        ? `${baseId.slice(0, 2)}***${baseId.slice(-2)}`
        : `${baseId.slice(0, 3)}****${baseId.slice(-3)}`;

  return { buyerLabel, maskedId };
}

