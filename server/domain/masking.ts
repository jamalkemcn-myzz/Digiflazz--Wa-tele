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
