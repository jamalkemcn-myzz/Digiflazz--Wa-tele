export const TRANSACTION_STATUSES = [
  'CREATED',
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAID',
  'PAID_PROCESSING',
  'SUPPLIER_PENDING',
  'SUPPLIER_PROCESSING',
  'SUCCESS',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'UNKNOWN',
  'REFUND_PENDING',
  'REFUNDED',
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'PROCESSING',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
  'UNKNOWN',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SUPPLIER_STATUSES = [
  'NONE',
  'PENDING',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'UNKNOWN',
] as const;

export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const ACTIVE_CUSTOMER_TRANSACTION_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  'CREATED',
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
  'PAID',
  'PAID_PROCESSING',
  'SUPPLIER_PENDING',
  'SUPPLIER_PROCESSING',
]);

export const PENDING_INVOICE_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  'CREATED',
  'PENDING_PAYMENT',
  'PAYMENT_PROCESSING',
]);

export const TERMINAL_TRANSACTION_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  'SUCCESS',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]);

const ALLOWED_TRANSITIONS: Record<TransactionStatus, ReadonlySet<TransactionStatus>> = {
  CREATED: new Set(['PENDING_PAYMENT', 'FAILED', 'CANCELLED', 'UNKNOWN']),
  PENDING_PAYMENT: new Set(['PAYMENT_PROCESSING', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED', 'UNKNOWN']),
  PAYMENT_PROCESSING: new Set(['PAID', 'EXPIRED', 'CANCELLED', 'FAILED', 'UNKNOWN']),
  PAID: new Set(['PAID_PROCESSING', 'SUPPLIER_PENDING', 'SUPPLIER_PROCESSING']),
  PAID_PROCESSING: new Set(['SUPPLIER_PENDING', 'SUPPLIER_PROCESSING', 'SUCCESS', 'FAILED', 'UNKNOWN']),
  SUPPLIER_PENDING: new Set(['SUPPLIER_PROCESSING', 'SUCCESS', 'FAILED', 'UNKNOWN']),
  SUPPLIER_PROCESSING: new Set(['SUPPLIER_PENDING', 'SUCCESS', 'FAILED', 'UNKNOWN']),
  SUCCESS: new Set([]),
  FAILED: new Set(['REFUND_PENDING', 'REFUNDED']),
  EXPIRED: new Set(['PAID', 'PAID_PROCESSING']), // only via verified late-payment reconciliation
  CANCELLED: new Set([]),
  UNKNOWN: new Set([
    'PENDING_PAYMENT',
    'PAID',
    'PAID_PROCESSING',
    'SUPPLIER_PENDING',
    'SUPPLIER_PROCESSING',
    'SUCCESS',
    'FAILED',
    'EXPIRED',
  ]),
  REFUND_PENDING: new Set(['REFUNDED']),
  REFUNDED: new Set([]),
};

export function canTransitionTransaction(from: TransactionStatus, to: TransactionStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function isActiveTransactionStatus(status: TransactionStatus): boolean {
  return ACTIVE_CUSTOMER_TRANSACTION_STATUSES.has(status);
}

export function isTerminalTransactionStatus(status: TransactionStatus): boolean {
  return TERMINAL_TRANSACTION_STATUSES.has(status);
}

export interface RefundEligibilityInput {
  paymentStatus: PaymentStatus;
  supplierStatus: SupplierStatus;
  transactionStatus: TransactionStatus;
  alreadyRefunded: boolean;
}

export function isEligibleForInternalRefund(input: RefundEligibilityInput): {
  eligible: boolean;
  reason: string;
} {
  if (input.alreadyRefunded || input.transactionStatus === 'REFUNDED') {
    return { eligible: false, reason: 'Transaksi sudah pernah direfund (idempotent)' };
  }
  if (input.paymentStatus !== 'PAID') {
    return { eligible: false, reason: 'Pembayaran pelanggan belum terverifikasi PAID' };
  }
  if (input.supplierStatus === 'PENDING' || input.supplierStatus === 'PROCESSING') {
    return { eligible: false, reason: 'Transaksi supplier masih PENDING/PROCESSING, refund dilarang' };
  }
  if (input.supplierStatus === 'UNKNOWN' || input.transactionStatus === 'UNKNOWN') {
    return { eligible: false, reason: 'Status supplier/transaksi UNKNOWN, wajib rekonsiliasi sebelum refund' };
  }
  if (input.supplierStatus !== 'FAILED') {
    return { eligible: false, reason: 'Supplier belum menyatakan kegagalan definitif (FAILED)' };
  }
  if (input.transactionStatus !== 'FAILED' && input.transactionStatus !== 'REFUND_PENDING') {
    return { eligible: false, reason: 'Status transaksi belum FAILED atau REFUND_PENDING' };
  }
  return { eligible: true, reason: 'Memenuhi syarat refund internal (pembayaran PAID & supplier gagal definitif)' };
}

export function shouldTriggerCooldown(status: TransactionStatus): boolean {
  return status === 'EXPIRED' || status === 'CANCELLED' || status === 'FAILED';
}
