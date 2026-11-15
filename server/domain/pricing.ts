export type MarginType = 'FIXED' | 'PERCENT';

export interface MarginRule {
  type: MarginType;
  value: number;
  maxMargin?: number | null;
}

export interface MarginResolutionInput {
  supplierPrice: number;
  productMargin?: MarginRule | null;
  categoryMargin?: MarginRule | null;
  globalMargin: MarginRule;
}

export interface MarginResolutionResult {
  appliedScope: 'PRODUCT' | 'CATEGORY' | 'GLOBAL';
  marginType: MarginType;
  marginValue: number;
  maxMargin: number | null;
  marginAmount: number;
  sellingPrice: number;
}

export function resolveEffectiveMargin(input: MarginResolutionInput): MarginResolutionResult {
  if (!Number.isFinite(input.supplierPrice) || input.supplierPrice < 0) {
    throw new Error('Supplier price must be a non-negative finite number');
  }

  let appliedScope: MarginResolutionResult['appliedScope'] = 'GLOBAL';
  let rule: MarginRule = input.globalMargin;

  if (input.productMargin && Number.isFinite(input.productMargin.value)) {
    appliedScope = 'PRODUCT';
    rule = input.productMargin;
  } else if (input.categoryMargin && Number.isFinite(input.categoryMargin.value)) {
    appliedScope = 'CATEGORY';
    rule = input.categoryMargin;
  }

  if (rule.value < 0) {
    throw new Error('Margin value cannot be negative');
  }

  const maxCap =
    rule.maxMargin !== null && rule.maxMargin !== undefined && Number.isFinite(rule.maxMargin)
      ? Math.round(rule.maxMargin)
      : null;

  if (maxCap !== null && maxCap < 0) {
    throw new Error('Max margin cannot be negative');
  }

  let marginAmount = 0;
  if (rule.type === 'FIXED') {
    marginAmount = Math.round(rule.value);
  } else {
    marginAmount = Math.ceil((input.supplierPrice * rule.value) / 100);
    if (maxCap !== null) {
      marginAmount = Math.min(marginAmount, maxCap);
    }
  }

  const sellingPrice = Math.round(input.supplierPrice) + marginAmount;
  if (sellingPrice < input.supplierPrice) {
    throw new Error('Selling price cannot be lower than supplier price');
  }

  return {
    appliedScope,
    marginType: rule.type,
    marginValue: rule.value,
    maxMargin: rule.type === 'PERCENT' ? maxCap : null,
    marginAmount,
    sellingPrice,
  };
}

export function selectAvailableUniqueCode(
  baseAmountBeforeUniqueCode: number,
  activePaymentAmounts: Set<number>,
  minCode = 1,
  maxCode = 99
): number {
  if (baseAmountBeforeUniqueCode <= 0) {
    throw new Error('Base amount before unique code must be positive');
  }
  const candidates: number[] = [];
  for (let code = minCode; code <= maxCode; code++) {
    if (!activePaymentAmounts.has(baseAmountBeforeUniqueCode + code)) {
      candidates.push(code);
    }
  }
  if (candidates.length === 0) {
    throw new Error('No unique payment code available in configured range without amount collision');
  }
  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

export function computeFinalPaymentAmount(
  sellingPrice: number,
  discountAmount: number,
  uniqueCode: number
): number {
  if (discountAmount < 0) throw new Error('Discount amount cannot be negative');
  if (uniqueCode < 1 || uniqueCode > 99) throw new Error('Unique code must be between 1 and 99');
  const afterDiscount = Math.max(0, sellingPrice - discountAmount);
  const total = afterDiscount + uniqueCode;
  if (total <= 0) throw new Error('Final payment amount must be greater than zero');
  return total;
}
