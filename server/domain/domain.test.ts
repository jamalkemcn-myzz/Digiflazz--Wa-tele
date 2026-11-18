import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffectiveMargin,
  selectAvailableUniqueCode,
  computeFinalPaymentAmount,
} from './pricing';
import { evaluateCoupon } from './coupon';
import {
  canTransitionTransaction,
  isActiveTransactionStatus,
  isEligibleForInternalRefund,
  shouldTriggerCooldown,
} from './state-machine';
import {
  normalizeWhatsappNumber,
  maskDestination,
  maskTransactionId,
  maskSerialNumber,
  maskBuyerForTestimony,
} from './masking';
import { hasPermission } from './rbac';

test('Margin priority: product overrides category and global', () => {
  const res = resolveEffectiveMargin({
    supplierPrice: 10000,
    productMargin: { type: 'FIXED', value: 1500 },
    categoryMargin: { type: 'FIXED', value: 2000 },
    globalMargin: { type: 'FIXED', value: 1000 },
  });
  assert.equal(res.appliedScope, 'PRODUCT');
  assert.equal(res.marginAmount, 1500);
  assert.equal(res.sellingPrice, 11500);
});

test('Margin priority: category overrides global when product has no margin', () => {
  const res = resolveEffectiveMargin({
    supplierPrice: 20000,
    productMargin: null,
    categoryMargin: { type: 'PERCENT', value: 5 },
    globalMargin: { type: 'FIXED', value: 1000 },
  });
  assert.equal(res.appliedScope, 'CATEGORY');
  assert.equal(res.marginAmount, 1000);
  assert.equal(res.sellingPrice, 21000);
});

test('Margin priority: global fallback works cleanly', () => {
  const res = resolveEffectiveMargin({
    supplierPrice: 5000,
    globalMargin: { type: 'FIXED', value: 800 },
  });
  assert.equal(res.appliedScope, 'GLOBAL');
  assert.equal(res.sellingPrice, 5800);
});

test('Percentage margin supports optional maxMargin cap (e.g. 30% max Rp3.000)', () => {
  const capped = resolveEffectiveMargin({
    supplierPrice: 20000,
    globalMargin: { type: 'PERCENT', value: 30, maxMargin: 3000 },
  });
  assert.equal(capped.marginAmount, 3000);
  assert.equal(capped.sellingPrice, 23000);
  assert.equal(capped.maxMargin, 3000);

  const uncapped = resolveEffectiveMargin({
    supplierPrice: 5000,
    globalMargin: { type: 'PERCENT', value: 30, maxMargin: 3000 },
  });
  assert.equal(uncapped.marginAmount, 1500);
  assert.equal(uncapped.sellingPrice, 6500);
});

test('Unique code selection avoids active payment amount collisions in 1..99', () => {
  const active = new Set<number>();
  for (let i = 1; i <= 98; i++) {
    active.add(10000 + i);
  }
  const code = selectAvailableUniqueCode(10000, active, 1, 99);
  assert.equal(code, 99);
  assert.equal(computeFinalPaymentAmount(11000, 1000, code), 10099);
});

test('Coupon evaluation enforces min purchase, percentage cap, expiry, and claim limit', () => {
  const baseCoupon = {
    id: 1,
    code: 'PROMO10',
    discountType: 'PERCENT' as const,
    discountValue: 10,
    minPurchase: 10000,
    maxDiscount: 2000,
    claimLimit: 5,
    claimedCount: 1,
    perCustomerLimit: 1,
    scopeType: 'ALL' as const,
    scopeId: null,
    startsAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    status: 'ACTIVE' as const,
  };

  const now = new Date('2026-06-01T00:00:00.000Z');
  // Valid capped at maxDiscount=2000
  const ok = evaluateCoupon({
    coupon: baseCoupon,
    sellingPrice: 50000,
    productId: 1,
    categoryId: 1,
    customerUsageCount: 0,
    now,
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.discountAmount, 2000);

  // Below minPurchase
  const low = evaluateCoupon({
    coupon: baseCoupon,
    sellingPrice: 9000,
    productId: 1,
    categoryId: 1,
    customerUsageCount: 0,
    now,
  });
  assert.equal(low.valid, false);

  // Expired
  const expired = evaluateCoupon({
    coupon: baseCoupon,
    sellingPrice: 20000,
    productId: 1,
    categoryId: 1,
    customerUsageCount: 0,
    now: new Date('2028-01-01T00:00:00.000Z'),
  });
  assert.equal(expired.valid, false);

  // Claim limit reached
  const maxed = evaluateCoupon({
    coupon: { ...baseCoupon, claimedCount: 5 },
    sellingPrice: 20000,
    productId: 1,
    categoryId: 1,
    customerUsageCount: 0,
    now,
  });
  assert.equal(maxed.valid, false);
});

test('Refund eligibility forbids refund when supplier is PENDING or UNKNOWN or unpaid', () => {
  assert.equal(
    isEligibleForInternalRefund({
      paymentStatus: 'PAID',
      supplierStatus: 'PENDING',
      transactionStatus: 'SUPPLIER_PENDING',
      alreadyRefunded: false,
    }).eligible,
    false
  );

  assert.equal(
    isEligibleForInternalRefund({
      paymentStatus: 'PAID',
      supplierStatus: 'UNKNOWN',
      transactionStatus: 'UNKNOWN',
      alreadyRefunded: false,
    }).eligible,
    false
  );

  assert.equal(
    isEligibleForInternalRefund({
      paymentStatus: 'PENDING',
      supplierStatus: 'FAILED',
      transactionStatus: 'FAILED',
      alreadyRefunded: false,
    }).eligible,
    false
  );

  assert.equal(
    isEligibleForInternalRefund({
      paymentStatus: 'PAID',
      supplierStatus: 'FAILED',
      transactionStatus: 'FAILED',
      alreadyRefunded: false,
    }).eligible,
    true
  );

  assert.equal(
    isEligibleForInternalRefund({
      paymentStatus: 'PAID',
      supplierStatus: 'FAILED',
      transactionStatus: 'REFUNDED',
      alreadyRefunded: true,
    }).eligible,
    false
  );
});

test('State machine transitions and cooldown rules', () => {
  assert.equal(canTransitionTransaction('CREATED', 'PENDING_PAYMENT'), true);
  assert.equal(canTransitionTransaction('PENDING_PAYMENT', 'PAID'), true);
  assert.equal(canTransitionTransaction('SUCCESS', 'FAILED'), false);
  assert.equal(canTransitionTransaction('REFUNDED', 'SUCCESS'), false);
  assert.equal(isActiveTransactionStatus('SUPPLIER_PENDING'), true);
  assert.equal(isActiveTransactionStatus('EXPIRED'), false);
  assert.equal(shouldTriggerCooldown('EXPIRED'), true);
  assert.equal(shouldTriggerCooldown('PENDING_PAYMENT'), false);
});

test('Phone normalization, masking, and RBAC checks', () => {
  assert.equal(normalizeWhatsappNumber('081234567890'), '6281234567890');
  assert.equal(normalizeWhatsappNumber('+62 812-3456-7890'), '6281234567890');
  assert.equal(maskDestination('081234567890'), '0812****7890');
  assert.equal(maskTransactionId('TRX-20261118-3082'), 'TRX-****-3082');
  assert.equal(maskSerialNumber('123456789012'), '1234****9012');
  const buyer = maskBuyerForTestimony({
    customerCode: 'CUS-000123',
    platformUsername: 'budi_santoso',
    platformUserId: '8686345389',
  });
  assert.equal(buyer.buyerLabel, '@bu***o');
  assert.equal(buyer.maskedId, '868****389');
  assert.equal(hasPermission('OWNER', [], 'refunds:adjust'), true);
  assert.equal(hasPermission('ADMIN', [], 'refunds:adjust'), false);
  assert.equal(hasPermission('OPERATOR', [], 'transactions:read'), true);
  assert.equal(hasPermission('OPERATOR', [], 'settings:write'), false);
});
