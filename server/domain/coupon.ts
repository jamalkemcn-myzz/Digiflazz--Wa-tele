export type CouponDiscountType = 'FIXED' | 'PERCENT';
export type CouponScopeType = 'ALL' | 'CATEGORY' | 'PRODUCT';

export interface CouponRecord {
  id: number;
  code: string;
  discountType: CouponDiscountType;
  discountValue: number;
  minPurchase: number;
  maxDiscount: number | null;
  claimLimit: number | null;
  claimedCount: number;
  perCustomerLimit: number;
  scopeType: CouponScopeType;
  scopeId: number | null;
  startsAt: string;
  expiresAt: string;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface CouponValidationContext {
  coupon: CouponRecord;
  sellingPrice: number;
  productId: number;
  categoryId: number | null;
  customerUsageCount: number;
  now?: Date;
}

export interface CouponCalculationResult {
  valid: boolean;
  reason?: string;
  discountAmount: number;
}

export function evaluateCoupon(ctx: CouponValidationContext): CouponCalculationResult {
  const { coupon, sellingPrice, productId, categoryId, customerUsageCount } = ctx;
  const now = ctx.now ?? new Date();

  if (coupon.status !== 'ACTIVE') {
    return { valid: false, reason: 'Kupon tidak aktif', discountAmount: 0 };
  }

  const startsAt = new Date(coupon.startsAt);
  const expiresAt = new Date(coupon.expiresAt);
  if (now < startsAt) {
    return { valid: false, reason: 'Kupon belum mulai berlaku', discountAmount: 0 };
  }
  if (now > expiresAt) {
    return { valid: false, reason: 'Kupon sudah kedaluwarsa', discountAmount: 0 };
  }

  if (coupon.claimLimit !== null && coupon.claimedCount >= coupon.claimLimit) {
    return { valid: false, reason: 'Kuota klaim kupon sudah habis', discountAmount: 0 };
  }

  if (customerUsageCount >= coupon.perCustomerLimit) {
    return { valid: false, reason: 'Batas penggunaan kupon untuk akun Anda telah tercapai', discountAmount: 0 };
  }

  if (sellingPrice < coupon.minPurchase) {
    return {
      valid: false,
      reason: `Minimal pembelian untuk kupon ini adalah Rp${coupon.minPurchase.toLocaleString('id-ID')}`,
      discountAmount: 0,
    };
  }

  if (coupon.scopeType === 'PRODUCT' && coupon.scopeId !== productId) {
    return { valid: false, reason: 'Kupon tidak berlaku untuk produk ini', discountAmount: 0 };
  }
  if (coupon.scopeType === 'CATEGORY' && coupon.scopeId !== categoryId) {
    return { valid: false, reason: 'Kupon tidak berlaku untuk kategori produk ini', discountAmount: 0 };
  }

  let discount = 0;
  if (coupon.discountType === 'FIXED') {
    discount = Math.round(coupon.discountValue);
  } else {
    discount = Math.floor((sellingPrice * coupon.discountValue) / 100);
    if (coupon.maxDiscount !== null && coupon.maxDiscount >= 0) {
      discount = Math.min(discount, Math.round(coupon.maxDiscount));
    }
  }

  // Never discount more than sellingPrice - 100 so payment_amount remains valid
  discount = Math.max(0, Math.min(discount, Math.max(0, sellingPrice - 100)));

  return { valid: true, discountAmount: discount };
}
