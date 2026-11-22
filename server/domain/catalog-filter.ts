export type DurationBucket = 'HARIAN' | 'PEKANAN' | 'BULANAN' | 'LAINNYA';

export interface DurationBucketMeta {
  bucket: DurationBucket;
  code: 'H' | 'P' | 'B' | 'L';
  emoji: string;
  shortLabel: string;
  label: string;
}

export const DURATION_BUCKET_ORDER: DurationBucket[] = ['HARIAN', 'PEKANAN', 'BULANAN', 'LAINNYA'];

export const DURATION_BUCKET_META: Record<DurationBucket, DurationBucketMeta> = {
  HARIAN: {
    bucket: 'HARIAN',
    code: 'H',
    emoji: '⚡',
    shortLabel: 'Harian',
    label: 'Harian (1–3 Hr)',
  },
  PEKANAN: {
    bucket: 'PEKANAN',
    code: 'P',
    emoji: '📅',
    shortLabel: 'Pekanan',
    label: 'Pekanan (4–14 Hr)',
  },
  BULANAN: {
    bucket: 'BULANAN',
    code: 'B',
    emoji: '🗓️',
    shortLabel: 'Bulanan',
    label: 'Bulanan (15–30+ Hr)',
  },
  LAINNYA: {
    bucket: 'LAINNYA',
    code: 'L',
    emoji: '📦',
    shortLabel: 'Lainnya',
    label: 'Lainnya',
  },
};

export function durationBucketFromCode(code?: string | null): DurationBucket | 'ALL' | null {
  const clean = (code || '').trim().toUpperCase();
  if (clean === 'ALL' || clean === 'SEMUA' || clean === 'A') return 'ALL';
  if (clean === 'H' || clean === 'HARIAN') return 'HARIAN';
  if (clean === 'P' || clean === 'PEKANAN' || clean === 'MINGGUAN') return 'PEKANAN';
  if (clean === 'B' || clean === 'BULANAN') return 'BULANAN';
  if (clean === 'L' || clean === 'LAINNYA') return 'LAINNYA';
  return null;
}

export function codeFromDurationBucket(bucket?: DurationBucket | 'ALL' | null): string {
  if (!bucket || bucket === 'ALL') return 'ALL';
  return DURATION_BUCKET_META[bucket].code;
}

const GENERIC_PRODUCT_TYPES = new Set([
  '',
  '-',
  'UMUM',
  'GENERAL',
  'DEFAULT',
  'REGULER',
  'REGULAR',
  'PREPAID',
  'PRABAYAR',
  'DATA',
  'PAKET DATA',
  'PULSA',
  'INTERNET',
  'KUOTA',
  'AKTIVASI',
  'VOUCHER',
  'VOUCHER DATA',
  'LAINNYA',
]);

interface SeriesRule {
  label: string;
  pattern: RegExp;
}

// Ordered from most specific to more general so e.g. "Xtra Combo Plus" matches before "Xtra Combo" or "Combo".
const SERIES_RULES: SeriesRule[] = [
  // XL Axiata
  { label: 'Xtra Combo Plus', pattern: /\b(?:xtra|extra)\s*combo\s*plus\b/i },
  { label: 'Xtra Combo Flex', pattern: /\b(?:xtra|extra)\s*combo\s*flex\b/i },
  { label: 'Xtra Combo Mini', pattern: /\b(?:xtra|extra)\s*combo\s*mini\b/i },
  { label: 'Xtra Combo VIP', pattern: /\b(?:xtra|extra)\s*combo\s*vip\b/i },
  { label: 'Xtra Combo', pattern: /\b(?:xtra|extra)\s*combo\b/i },
  { label: 'Xtra Kuota', pattern: /\b(?:xtra|extra)\s*kuota\b/i },
  { label: 'Bebas Puas', pattern: /\bbebas\s*puas\b/i },
  { label: 'Akrab', pattern: /\bakrab\b/i },
  { label: 'HotRod', pattern: /\bhot\s*rod\b/i },

  // Telkomsel / by.U
  { label: 'Combo Sakti', pattern: /\bcombo\s*sakti\b/i },
  { label: 'Internet Sakti', pattern: /\binternet\s*sakti\b/i },
  { label: 'Super Seru', pattern: /\bsuper\s*seru\b/i },
  { label: 'MaxStream', pattern: /\bmax\s*stream\b/i },
  { label: 'GamesMax', pattern: /\bgames\s*max\b/i },
  { label: 'Ketengan', pattern: /\bketengan\b/i },
  { label: 'Orbit', pattern: /\borbit\b/i },
  { label: 'OMG', pattern: /\bomg\b/i },
  { label: 'Flash', pattern: /\bflash\b/i },

  // Indosat
  { label: 'Freedom Internet', pattern: /\bfreedom\s*internet\b/i },
  { label: 'Freedom Combo', pattern: /\bfreedom\s*combo\b/i },
  { label: 'Freedom U', pattern: /\bfreedom\s*u\b/i },
  { label: 'Freedom', pattern: /\bfreedom\b/i },
  { label: 'Sensasional', pattern: /\bsensasional\b/i },
  { label: 'Yellow', pattern: /\byellow\b/i },

  // Tri (3)
  { label: 'AlwaysOn (AON)', pattern: /\b(?:always\s*on|aon)\b/i },
  { label: 'GetMore', pattern: /\bget\s*more\b/i },
  { label: 'KeepOn', pattern: /\bkeep\s*on\b/i },
  { label: '3 Home', pattern: /\b(?:3|tri)\s*home\b/i },
  { label: 'Happy', pattern: /\bhappy\b/i },
  { label: 'Add-On', pattern: /\badd[\s-]*on\b/i },
  { label: 'Cinta', pattern: /\bcinta\b/i },
  { label: 'Mini', pattern: /\bmini\b/i },
  { label: 'Mix', pattern: /\bmix\b/i },

  // Axis
  { label: 'Bronet', pattern: /\bbronet\b/i },
  { label: 'Owsem', pattern: /\bowsem\b/i },
  { label: 'Boostr', pattern: /\bboostr\b/i },
  { label: 'Warnet', pattern: /\bwarnet\b/i },
  { label: 'Suka-Suka', pattern: /\bsuka[\s-]*suka\b/i },
  { label: 'Teng-Go', pattern: /\bteng[\s-]*go\b/i },
  { label: 'KZL', pattern: /\bkzl\b/i },

  // Smartfren
  { label: 'Unlimited Nonstop', pattern: /\bunlimited\s*nonstop\b/i },
  { label: 'Unlimited', pattern: /\bunlimited\b/i },
  { label: 'Gokil Max', pattern: /\bgokil\s*max\b/i },
  { label: 'Nonstop', pattern: /\bnonstop\b/i },
  { label: 'Kuota Volume', pattern: /\bvolume\b/i },

  // Generic compound / fallback series
  { label: 'Flex', pattern: /\bflex\b/i },
  { label: 'Combo', pattern: /\bcombo\b/i },
];

export function extractProductSeries(product: {
  name: string;
  type?: string | null;
}): string {
  const rawType = (product.type || '').trim();
  const upperType = rawType.toUpperCase();
  if (rawType && !GENERIC_PRODUCT_TYPES.has(upperType)) {
    return rawType;
  }

  const name = (product.name || '').trim();
  if (name) {
    for (const rule of SERIES_RULES) {
      if (rule.pattern.test(name)) {
        return rule.label;
      }
    }
  }

  return 'Umum';
}

function parseDurationFromText(text: string): number | null {
  const clean = text.trim();
  if (!clean) return null;

  const yearMatch = clean.match(/(?:^|[\s(/\-+])(\d{1,2})\s*(?:tahun|thn|year|years|yr|yrs)(?=$|[\s)/\-+,.;])/i);
  if (yearMatch) {
    const years = Number(yearMatch[1]);
    if (years > 0 && years <= 10) return years * 365;
  }

  const monthMatch = clean.match(/(?:^|[\s(/\-+])(\d{1,2})\s*(?:bulan|bln|month|months|mo|mos)(?=$|[\s)/\-+,.;])/i);
  if (monthMatch) {
    const months = Number(monthMatch[1]);
    if (months > 0 && months <= 24) return months * 30;
  }

  const weekMatch = clean.match(/(?:^|[\s(/\-+])(\d{1,2})\s*(?:minggu|mgg|week|weeks|wk|wks)(?=$|[\s)/\-+,.;])/i);
  if (weekMatch) {
    const weeks = Number(weekMatch[1]);
    if (weeks > 0 && weeks <= 52) return weeks * 7;
  }

  const dayMatch = clean.match(/(?:^|[\s(/\-+])(\d{1,3})\s*(?:hari|hr|days|day|h|d)(?=$|[\s)/\-+,.;])/i);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (days > 0 && days <= 3650) return days;
  }

  const hourMatch = clean.match(/(?:^|[\s(/\-+])(\d{1,2})\s*(?:jam)(?=$|[\s)/\-+,.;])/i);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    if (hours > 0 && hours <= 72) {
      return Math.max(1, Math.ceil(hours / 24));
    }
  }

  return null;
}

export function extractProductDurationDays(name: string, description?: string | null): number | null {
  const fromName = parseDurationFromText(name);
  if (fromName !== null) return fromName;
  if (description) {
    return parseDurationFromText(description);
  }
  return null;
}

export function classifyDurationBucket(name: string, description?: string | null): DurationBucket {
  const days = extractProductDurationDays(name, description);
  if (days === null) return 'LAINNYA';
  if (days <= 3) return 'HARIAN';
  if (days <= 14) return 'PEKANAN';
  return 'BULANAN';
}

export interface SeriesSummary {
  series: string;
  productCount: number;
  minPrice: number;
}

export interface DurationSummary {
  bucket: DurationBucket;
  code: 'H' | 'P' | 'B' | 'L';
  emoji: string;
  shortLabel: string;
  label: string;
  productCount: number;
  minPrice: number;
}

export interface FilterableProductLike {
  name: string;
  description?: string | null;
  type?: string | null;
  selling_price: number;
}

export function summarizeSeries<T extends FilterableProductLike>(products: T[]): SeriesSummary[] {
  const map = new Map<string, SeriesSummary>();
  for (const p of products) {
    const series = extractProductSeries(p);
    const key = series.toUpperCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        series,
        productCount: 1,
        minPrice: p.selling_price,
      });
    } else {
      existing.productCount += 1;
      if (p.selling_price < existing.minPrice) {
        existing.minPrice = p.selling_price;
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const aGeneric = a.series.toUpperCase() === 'UMUM';
    const bGeneric = b.series.toUpperCase() === 'UMUM';
    if (aGeneric !== bGeneric) return aGeneric ? 1 : -1;
    return a.series.localeCompare(b.series, 'id-ID');
  });
}

export function summarizeDurations<T extends FilterableProductLike>(products: T[]): DurationSummary[] {
  const map = new Map<DurationBucket, { count: number; minPrice: number }>();
  for (const p of products) {
    const bucket = classifyDurationBucket(p.name, p.description);
    const existing = map.get(bucket);
    if (!existing) {
      map.set(bucket, { count: 1, minPrice: p.selling_price });
    } else {
      existing.count += 1;
      if (p.selling_price < existing.minPrice) {
        existing.minPrice = p.selling_price;
      }
    }
  }

  const summaries: DurationSummary[] = [];
  for (const bucket of DURATION_BUCKET_ORDER) {
    const entry = map.get(bucket);
    if (!entry) continue;
    const meta = DURATION_BUCKET_META[bucket];
    summaries.push({
      bucket,
      code: meta.code,
      emoji: meta.emoji,
      shortLabel: meta.shortLabel,
      label: meta.label,
      productCount: entry.count,
      minPrice: entry.minPrice,
    });
  }
  return summaries;
}

export function filterProductsBySeriesAndDuration<T extends FilterableProductLike>(
  products: T[],
  filter: { series?: string | null; durationBucket?: DurationBucket | 'ALL' | null }
): T[] {
  const targetSeries = (filter.series || '').trim().toUpperCase();
  const useSeries = Boolean(targetSeries && targetSeries !== 'ALL' && targetSeries !== 'SEMUA');
  const targetDuration =
    filter.durationBucket && filter.durationBucket !== 'ALL' ? filter.durationBucket : null;

  if (!useSeries && !targetDuration) {
    return products;
  }

  return products.filter((p) => {
    if (useSeries && extractProductSeries(p).toUpperCase() !== targetSeries) {
      return false;
    }
    if (targetDuration && classifyDurationBucket(p.name, p.description) !== targetDuration) {
      return false;
    }
    return true;
  });
}

export function shouldShowSeriesPicker(
  seriesSummaries: SeriesSummary[],
  totalProducts?: number
): boolean {
  if (seriesSummaries.length < 2) return false;
  const meaningfulCount = seriesSummaries.filter(
    (s) => s.series.trim().toUpperCase() !== 'UMUM'
  ).length;
  if (meaningfulCount >= 2) return true;
  const total =
    totalProducts ?? seriesSummaries.reduce((acc, s) => acc + s.productCount, 0);
  return meaningfulCount >= 1 && total > 6;
}

export function shouldShowDurationPicker(
  durationSummaries: DurationSummary[],
  totalProducts: number
): boolean {
  return totalProducts >= 3 && durationSummaries.length >= 2;
}
