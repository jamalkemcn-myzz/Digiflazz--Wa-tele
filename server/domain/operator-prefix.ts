export interface DetectedOperator {
  normalizedPhone: string;
  operatorKey: string;
  displayName: string;
  brandAliases: string[];
}

interface PrefixRule {
  prefixes: string[];
  operatorKey: string;
  displayName: string;
  brandAliases: string[];
}

const OPERATOR_PREFIX_RULES: PrefixRule[] = [
  // by.U / Telkomsel 08515-08518
  {
    prefixes: ['08515', '08516', '08517', '08518'],
    operatorKey: 'TELKOMSEL',
    displayName: 'by.U / Telkomsel',
    brandAliases: ['BY.U', 'BYU', 'TELKOMSEL', 'TSEL'],
  },
  // Telkomsel
  {
    prefixes: ['0811', '0812', '0813', '0821', '0822', '0823', '0851', '0852', '0853'],
    operatorKey: 'TELKOMSEL',
    displayName: 'Telkomsel',
    brandAliases: ['TELKOMSEL', 'TSEL', 'SIMPATI', 'KARTU AS', 'LOOP', 'BY.U', 'BYU'],
  },
  // Indosat Ooredoo Hutchison
  {
    prefixes: ['0814', '0815', '0816', '0855', '0856', '0857', '0858'],
    operatorKey: 'INDOSAT',
    displayName: 'Indosat',
    brandAliases: ['INDOSAT', 'ISAT', 'IM3', 'MENTARI', 'MATRIX'],
  },
  // XL Axiata
  {
    prefixes: ['0817', '0818', '0819', '0859', '0877', '0878'],
    operatorKey: 'XL',
    displayName: 'XL',
    brandAliases: ['XL', 'XL AXIATA', 'XLAXIATA'],
  },
  // Axis
  {
    prefixes: ['0831', '0832', '0833', '0838'],
    operatorKey: 'AXIS',
    displayName: 'Axis',
    brandAliases: ['AXIS'],
  },
  // Tri (3)
  {
    prefixes: ['0895', '0896', '0897', '0898', '0899'],
    operatorKey: 'TRI',
    displayName: 'Tri (3)',
    brandAliases: ['TRI', 'THREE', '3'],
  },
  // Smartfren
  {
    prefixes: ['0881', '0882', '0883', '0884', '0885', '0886', '0887', '0888', '0889'],
    operatorKey: 'SMARTFREN',
    displayName: 'Smartfren',
    brandAliases: ['SMARTFREN', 'SMART'],
  },
];

export function normalizeIndonesianPhone(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s\-().]/g, '');
  if (!cleaned) return null;

  let digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^\d+$/.test(digits)) return null;

  if (digits.startsWith('62')) {
    digits = `0${digits.slice(2)}`;
  } else if (digits.startsWith('8')) {
    digits = `0${digits}`;
  }

  if (!/^08\d{7,12}$/.test(digits)) {
    return null;
  }
  return digits;
}

export function detectOperatorFromPhone(rawPhone: string): DetectedOperator | null {
  const normalizedPhone = normalizeIndonesianPhone(rawPhone);
  if (!normalizedPhone) return null;

  for (const rule of OPERATOR_PREFIX_RULES) {
    if (rule.prefixes.some((prefix) => normalizedPhone.startsWith(prefix))) {
      return {
        normalizedPhone,
        operatorKey: rule.operatorKey,
        displayName: rule.displayName,
        brandAliases: rule.brandAliases,
      };
    }
  }
  return null;
}

export function matchBrandForDetectedOperator(
  availableBrands: string[],
  detected: DetectedOperator
): string | null {
  if (availableBrands.length === 0) return null;
  const upperMap = availableBrands.map((b) => ({
    raw: b,
    upper: b.trim().toUpperCase(),
  }));

  for (const alias of detected.brandAliases) {
    const exact = upperMap.find((b) => b.upper === alias);
    if (exact) return exact.raw;
  }

  for (const alias of detected.brandAliases) {
    if (alias.length < 2) continue;
    const partial = upperMap.find((b) => b.upper.includes(alias) || alias.includes(b.upper));
    if (partial) return partial.raw;
  }

  return null;
}

export function isTelecomCategoryName(categoryName?: string | null): boolean {
  if (!categoryName) return false;
  return /pulsa|data|kuota|internet|paket|sms|telpon|nelpon|masa\s*aktif|telepon/i.test(
    categoryName
  );
}
