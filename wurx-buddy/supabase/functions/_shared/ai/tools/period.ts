// Local period + brand resolution for the data tools (A§10.3). WP-A builds the
// shared resolve.ts; these switch to it in WP-D. All dates are Asia/Karachi
// calendar days; weekly reports run Sunday → Saturday ("Week 24 (Sep 13 - 19)").

import type { Db } from './types.ts';

export type Period = {
  kind: 'month' | 'week' | 'day' | 'range' | 'label';
  label: string;          // human form, e.g. "August 2026", "Sep 20 – 26, 2026"
  from?: string;          // YYYY-MM-DD inclusive
  to?: string;            // YYYY-MM-DD inclusive
  pattern?: string;       // kind 'label': substring of reports.period_label
  type?: 'weekly' | 'monthly';
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function pktToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const x = d(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();   // m 0-based
const pad = (n: number) => String(n).padStart(2, '0');

function monthPeriod(y: number, m: number): Period {
  return { kind: 'month', label: `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${y}`, from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(lastDay(y, m))}`, type: 'monthly' };
}

export function weekLabel(from: string, to: string): string {
  const a = d(from), b = d(to);
  const left = `${MON[a.getUTCMonth()]} ${a.getUTCDate()}`;
  const right = a.getUTCMonth() === b.getUTCMonth() ? `${b.getUTCDate()}` : `${MON[b.getUTCMonth()]} ${b.getUTCDate()}`;
  return `${left} – ${right}, ${b.getUTCFullYear()}`;
}

function weekPeriod(anyDay: string, weeksBack: number): Period {
  const sun = addDays(anyDay, -d(anyDay).getUTCDay() - 7 * weeksBack);
  const sat = addDays(sun, 6);
  return { kind: 'week', label: weekLabel(sun, sat), from: sun, to: sat, type: 'weekly' };
}

// "June" | "Jun 2026" | "2026-06" | "last week" | "this month" | "Q3" | "week 12"
// | "2026-09-14" | "2026-09-01..2026-09-30". Anything else is matched as a
// period_label substring, which is exactly v1's behaviour.
export function resolvePeriod(input: unknown, now: Date = new Date()): Period | null {
  const raw = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const s = raw.toLowerCase();
  const today = pktToday(now);
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];

  if (/^(this|current) week$/.test(s)) return weekPeriod(today, 0);
  if (/^(last|previous|past|prior) week$/.test(s)) return weekPeriod(today, 1);
  if (/^((the )?week before last|2 weeks ago|two weeks ago)$/.test(s)) return weekPeriod(today, 2);
  if (/^(this|current) month$/.test(s)) return monthPeriod(ty, tm);
  if (/^(last|previous|past|prior) month$/.test(s)) return tm === 0 ? monthPeriod(ty - 1, 11) : monthPeriod(ty, tm - 1);

  let m = s.match(/^(\d{4})-(\d{2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return monthPeriod(+m[1], +m[2] - 1);
  m = s.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|—)\s*(\d{4}-\d{2}-\d{2})$/);
  if (m && m[1] <= m[2]) return { kind: 'range', label: `${m[1]} – ${m[2]}`, from: m[1], to: m[2] };
  m = s.match(/^\d{4}-\d{2}-\d{2}$/);
  if (m && !Number.isNaN(d(s).getTime())) return { kind: 'day', label: s, from: s, to: s };

  // "<month> [year]" or "<year> <month>"
  const my = s.match(/^([a-z]+)\.?,? ?(\d{4})?$/) ?? (/^\d{4} [a-z]+$/.test(s) ? [s, s.split(' ')[1], s.split(' ')[0]] : null);
  if (my && my[1].length >= 3) {
    const idx = MONTHS.findIndex((n) => n.startsWith(my[1]));
    if (idx >= 0) {
      // A bare month is its most recent occurrence, the current month included.
      return monthPeriod(my[2] ? Number(my[2]) : (idx <= tm ? ty : ty - 1), idx);
    }
  }
  // "Q3" | "Q3 2026" | "2026 Q3"
  const qy = s.match(/^q([1-4])(?: (\d{4}))?$/) ?? (/^\d{4} q[1-4]$/.test(s) ? [s, s.slice(-1), s.slice(0, 4)] : null);
  if (qy) {
    const q = Number(qy[1]) - 1;
    const y = qy[2] ? Number(qy[2]) : (q * 3 <= tm ? ty : ty - 1);
    return { kind: 'range', label: `Q${q + 1} ${y}`, from: `${y}-${pad(q * 3 + 1)}-01`, to: `${y}-${pad(q * 3 + 3)}-${pad(lastDay(y, q * 3 + 2))}` };
  }
  m = s.match(/^(\d{4})$/);
  if (m) return { kind: 'range', label: m[1], from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
  // Week numbers are per brand (Week 2 exists in April and in June), so they
  // stay a label match: "Week 12 (" never matches "Week 120".
  m = s.match(/^w(?:ee)?k ?(\d{1,3})$/);
  if (m) return { kind: 'label', label: `Week ${m[1]}`, pattern: `Week ${m[1]} (`, type: 'weekly' };
  return { kind: 'label', label: raw, pattern: raw };
}

// Applies a resolved period to a reports / gmv_max_reports query (period_start).
// deno-lint-ignore no-explicit-any
export function applyPeriod(q: any, p: Period | null): any {
  if (!p) return q;
  if (p.kind === 'label') return q.ilike('period_label', `%${p.pattern}%`);
  if (p.kind === 'day') return q.lte('period_start', p.from).gte('period_end', p.from);
  return q.gte('period_start', p.from).lte('period_start', p.to);
}

// Pure mirror of applyPeriod for rows already in memory.
export function inPeriod(r: { period_start?: string | null; period_end?: string | null; period_label?: string | null }, p: Period | null): boolean {
  if (!p) return true;
  const ps = String(r.period_start ?? '');
  if (p.kind === 'label') return String(r.period_label ?? '').toLowerCase().includes(String(p.pattern).toLowerCase());
  if (p.kind === 'day') return ps <= p.from! && String(r.period_end ?? ps) >= p.from!;
  return ps >= p.from! && ps <= p.to!;
}

export type BrandRow = {
  id: string; brand_name: string; client_name?: string | null; status?: string | null; tier?: string | null;
  owner_id?: string | null; currency?: string | null;
};
const BRAND_COLS = 'id, brand_name, client_name, status, tier, owner_id, currency';

// ilike first (v1's rule); if nothing, every word ≥ 3 chars with a trailing
// plural 's' dropped, so "Cutler Nutrition" and "cutler nutritions co" both
// find "Cutler Nutritions". An exact (case-insensitive) name wins outright.
export async function resolveBrands(admin: Db, name: string, limit = 20): Promise<BrandRow[]> {
  const q = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!q) return [];
  const esc = (x: string) => x.replace(/[%_\\]/g, (c) => `\\${c}`);
  let { data } = await admin.from('brands').select(BRAND_COLS).ilike('brand_name', `%${esc(q)}%`).order('brand_name').limit(limit);
  if (!data?.length) {
    const words = q.toLowerCase().split(' ').map((w) => w.replace(/[^a-z0-9&]/g, '')).filter((w) => w.length >= 3).map((w) => (w.length > 3 ? w.replace(/s$/, '') : w));
    if (words.length) {
      let wq = admin.from('brands').select(BRAND_COLS);
      for (const w of words.slice(0, 4)) wq = wq.ilike('brand_name', `%${esc(w)}%`);
      ({ data } = await wq.order('brand_name').limit(limit));
    }
  }
  const rows: BrandRow[] = data || [];
  const exact = rows.filter((b) => b.brand_name.trim().toLowerCase() === q.toLowerCase());
  return exact.length === 1 ? exact : rows;
}
