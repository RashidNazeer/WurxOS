// Report figures are strings in varied formats (inventory §2). One parser for
// all of them, which never guesses: anything it can't read exactly is null
// with a reason, and the raw string always travels alongside (A§11.2).

import { resolveCurrency, type ReportRow } from '../extractors/report.ts';

export type MetricUnit = 'number' | 'currency' | 'percent' | 'multiplier';
export type ParsedMetric = {
  value: number | null;
  unit: MetricUnit | null;
  currency?: string;
  raw: unknown;
  reason?: 'empty' | 'placeholder' | 'unparseable';
};

// Every "no value" spelling seen on dev: N/A, Null, Not_Available_yet,
// Not_available, Notavailableyet, None, Not_Rated, --, -. Compared with case,
// spaces, dashes and underscores removed.
const PLACEHOLDERS = new Set(['na', 'null', 'none', 'nil', 'undefined', 'nan', 'notavailable', 'notavailableyet', 'notrated', 'tbd', 'pending']);
const SYMBOL: Record<string, string> = { '$': 'USD', '£': 'GBP', '€': 'EUR', '₨': 'PKR' };
const CODES = 'USD|GBP|EUR|PKR';
const NUMBER = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^-?\.\d+$/;

export function parseMetric(raw: unknown): ParsedMetric {
  if (raw == null) return { value: null, unit: null, raw, reason: 'empty' };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, unit: 'number', raw } : { value: null, unit: null, raw, reason: 'unparseable' };
  if (typeof raw !== 'string') return { value: null, unit: null, raw, reason: 'unparseable' };
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return { value: null, unit: null, raw, reason: 'empty' };
  const key = s.toLowerCase().replace(/[\s_\-–—/.]/g, '');
  if (!key || PLACEHOLDERS.has(key)) return { value: null, unit: null, raw, reason: 'placeholder' };
  const fail: ParsedMetric = { value: null, unit: null, raw, reason: 'unparseable' };

  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
  let currency: string | undefined;
  const sym = SYMBOL[s[0]];
  if (sym) { currency = sym; s = s.slice(1).trim(); }
  const pre = s.match(new RegExp(`^(${CODES})\\s*`, 'i'));
  if (pre) { if (currency) return fail; currency = pre[1].toUpperCase(); s = s.slice(pre[0].length); }
  const post = s.match(new RegExp(`\\s*(${CODES})$`, 'i'));
  if (post) { if (currency) return fail; currency = post[1].toUpperCase(); s = s.slice(0, -post[0].length); }
  if (s.startsWith('-')) { if (neg) return fail; neg = true; s = s.slice(1).trim(); }

  let unit: MetricUnit = currency ? 'currency' : 'number';
  const tail = s.slice(-1);
  if (tail === '%' || tail === 'x' || tail === 'X' || tail === '×') {
    if (currency) return fail;
    unit = tail === '%' ? 'percent' : 'multiplier';
    s = s.slice(0, -1).trim();
  }
  let mult = 1;
  const mag = s.slice(-1);
  if (mag === 'k' || mag === 'K') { mult = 1e3; s = s.slice(0, -1).trim(); } else if (mag === 'M') { mult = 1e6; s = s.slice(0, -1).trim(); }
  if (!NUMBER.test(s)) return fail;
  // Round away float noise from the multiplier (1.1k → 1100, not 1100.0000000002).
  const v = Math.round(Number(s.replace(/,/g, '')) * mult * 1e6) / 1e6;
  if (!Number.isFinite(v)) return fail;
  return { value: neg ? -v : v, unit, ...(currency ? { currency } : {}), raw };
}

// Brand currency, then the report's own snapshot, then USD: the Owner's rule
// and the app's (_normReport). One implementation, shared with the extractor.
export function reportCurrency(row: { data?: unknown; brand?: { currency?: string | null } | null }): string {
  return resolveCurrency({ data: (row.data ?? null) as Record<string, unknown> | null } as ReportRow,
    { brand: row.brand ?? null }).currency;
}

const SIGN: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' };
const two = (v: number) => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Money: 2 decimals exact, e.g. $859.95 / £1,200.00 / PKR 5,000.00.
export function fmtMoney(v: number, currency: string): string {
  const s = SIGN[currency];
  return `${v < 0 ? '-' : ''}${s ? s : `${currency} `}${two(v)}`;
}

export function fmtNum(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtSigned(v: number, fmt: (n: number) => string): string {
  return `${v > 0 ? '+' : v < 0 ? '-' : '±'}${fmt(Math.abs(v))}`;
}

// brands.tier is free text on dev: '2000', '2K', '7000', '7K', 'unlimited',
// 'Unlimited', 'starter  pack', ''. Canonical: '2K', '7K', 'Unlimited',
// 'Starter pack'; blank → null.
export function normTier(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^unlimited$/i.test(s)) return 'Unlimited';
  const m = s.replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kK])?$/);
  if (m) {
    const n = Number(m[1]) * (m[2] ? 1000 : 1);
    return n >= 1000 && n % 1000 === 0 ? `${n / 1000}K` : String(n);
  }
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
