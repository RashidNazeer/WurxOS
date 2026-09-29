// Brand, period and synonym resolution (phase5-design.md §2.4, A§10.3), shared
// by the search tools and the data tools so "June" means the same everywhere.
// Pure TS: runs on Deno and Node.

import type { Rpc } from '../ingest/db.ts';

// ── brands ──────────────────────────────────────────────────────────────────

export type BrandMatch = {
  brand_id: string;
  brand_name: string;
  client_name: string | null;
  status: string | null;
  currency: string | null;
  score: number;
};

export type BrandResolution = { query: string; matches: BrandMatch[]; best: BrandMatch | null; ambiguous: boolean };

export const BRAND_SURE = 0.6;     // a match this good is used without asking…
export const BRAND_MARGIN = 0.2;   // …when the runner-up is at least this far behind

export function cleanBrandQuery(name: string): string {
  return String(name ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/["“”]/g, '')
    .replace(/'s\b|s'(?=\s|$)/gi, (m) => (m.toLowerCase() === "'s" ? '' : 's'))
    .replace(/\s+/g, ' ')
    .trim();
}

// ACL applies inside ai_resolve_brands: only brands the caller can view.
export async function resolveBrands(rpc: Rpc, name: string, opts: { asUser?: string | null } = {}): Promise<BrandResolution> {
  const query = cleanBrandQuery(name);
  if (!query) return { query, matches: [], best: null, ambiguous: false };
  const rows = (await rpc('ai_resolve_brands', { p_name: query, p_as_user: opts.asUser ?? undefined })) ?? [];
  const matches: BrandMatch[] = (Array.isArray(rows) ? rows : []).map((r: any) => ({ ...r, score: Number(r.score) }));
  return { query, matches, ...pickBrand(matches) };
}

export function pickBrand(matches: BrandMatch[]): { best: BrandMatch | null; ambiguous: boolean } {
  const [a, b] = [...matches].sort((x, y) => y.score - x.score);
  if (!a) return { best: null, ambiguous: false };
  if (a.score >= BRAND_SURE && (!b || a.score - b.score >= BRAND_MARGIN)) return { best: a, ambiguous: false };
  return { best: null, ambiguous: true };
}

// ── periods (Asia/Karachi: UTC+5, no DST) ───────────────────────────────────

export type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'range';
export type DateRange = { from: string; to: string; label: string; unit: Unit; inProgress?: boolean };
export type PeriodResolution =
  | { kind: 'range'; range: DateRange }
  // Report week numbers count from each brand's own start ("Week 24" of one
  // brand is "Week 7" of another), so they have no calendar dates.
  | { kind: 'week_number'; week: number; label: string }
  | { kind: 'ambiguous'; question: string; options: Array<{ kind: 'range'; range: DateRange } | { kind: 'week_number'; week: number; label: string }> }
  | { kind: 'unknown' };

const PKT_OFFSET_MS = 5 * 3600_000;
// A bare month or quarter that is the current one and less elapsed than this
// could mean this year's (in progress) or last year's: ask.
const IN_PROGRESS_ASK = 0.25;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

export function pktToday(now: Date = new Date()): Date {
  const t = new Date(now.getTime() + PKT_OFFSET_MS);
  return utc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

const range = (from: Date, to: Date, label: string, unit: Unit, today?: Date): { kind: 'range'; range: DateRange } => {
  const r: DateRange = { from: iso(from), to: iso(to), label, unit };
  if (today && from <= today && today < to) r.inProgress = true;
  return { kind: 'range', range: r };
};
const monthRange = (y: number, m: number, today?: Date) => range(utc(y, m, 1), utc(y, m + 1, 0), `${MONTH_NAMES[m - 1]} ${y}`, 'month', today);
const quarterRange = (y: number, q: number, today?: Date) => range(utc(y, 3 * q - 2, 1), utc(y, 3 * q + 1, 0), `Q${q} ${y}`, 'quarter', today);
// The org's report weeks run Sunday to Saturday ("Week 24 (Sep 13 - 19)");
// a brand that reports on another day passes its own start (weekStartFromReports).
export const DEFAULT_WEEK_START_DOW = 0;
const weekOf = (d: Date, dow: number) => addDays(d, -((d.getUTCDay() - dow + 7) % 7));
const weekRange = (start: Date, today?: Date) => range(start, addDays(start, 6), `week of ${iso(start)} → ${iso(addDays(start, 6))}`, 'week', today);

function elapsed(r: DateRange, today: Date): number {
  const from = Date.parse(r.from), to = Date.parse(r.to) + 86_400_000;
  return (today.getTime() + 86_400_000 - from) / (to - from);
}

// A named month/quarter without a year = the most recent one that has started.
function namedPeriod(kind: 'month' | 'quarter', n: number, today: Date): PeriodResolution {
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1;
  const startMonth = kind === 'month' ? n : 3 * n - 2;
  const y = startMonth <= tm ? ty : ty - 1;
  const cur = kind === 'month' ? monthRange(y, n, today) : quarterRange(y, n, today);
  if (cur.range.inProgress && elapsed(cur.range, today) < IN_PROGRESS_ASK) {
    const prev = kind === 'month' ? monthRange(y - 1, n) : quarterRange(y - 1, n);
    return { kind: 'ambiguous', question: `${cur.range.label} (in progress) or ${prev.range.label}?`, options: [cur, prev] };
  }
  return cur;
}

// "Sep 13 - 19", "Aug 30 - Sep 5, 2026", "Sep 13 to Sep 19 2026". No year →
// the most recent occurrence that has started.
function dayRange(m1: number, d1: number, m2: number, d2: number, y: number | null, today: Date): PeriodResolution {
  let yy = y ?? today.getUTCFullYear();
  let from = utc(yy, m1, d1);
  if (y == null && from > today) from = utc(--yy, m1, d1);
  let to = utc(yy, m2, d2);
  if (to < from) to = utc(yy + 1, m2, d2);            // "Dec 28 - Jan 3"
  if (from.getUTCDate() !== d1 || to.getUTCDate() !== d2) return { kind: 'unknown' };
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return range(from, to, `${iso(from)} → ${iso(to)}`, days === 0 ? 'day' : days === 6 ? 'week' : 'range', today);
}

export type PeriodOptions = { weekStartDow?: number };

export function resolvePeriod(input: string, now: Date = new Date(), opts: PeriodOptions = {}): PeriodResolution {
  const today = pktToday(now);
  const dow = Number.isInteger(opts.weekStartDow) && opts.weekStartDow! >= 0 && opts.weekStartDow! <= 6 ? opts.weekStartDow! : DEFAULT_WEEK_START_DOW;
  const s = String(input ?? '').toLowerCase().replace(/[–—]/g, '-').replace(/[?.!]+$/, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(?:(?:in|for|during|of|over|from|the)\s+)+/, '');
  if (!s) return { kind: 'unknown' };
  const ty = today.getUTCFullYear(), tm = today.getUTCMonth() + 1;
  let m: RegExpMatchArray | null;

  if (s === 'today') return range(today, today, `today (${iso(today)})`, 'day');
  if (s === 'yesterday') { const y = addDays(today, -1); return range(y, y, `yesterday (${iso(y)})`, 'day'); }
  if ((m = s.match(/^(this|current|last|previous|past|prior) (week|month|quarter|year)$/)) || (m = s.match(/^(this) (week|month|quarter|year) so far$/))) {
    const back = m[1] === 'this' || m[1] === 'current' ? 0 : 1;
    if (m[2] === 'week') return weekRange(addDays(weekOf(today, dow), -7 * back), today);
    if (m[2] === 'month') { const d = utc(ty, tm - back, 1); return monthRange(d.getUTCFullYear(), d.getUTCMonth() + 1, today); }
    if (m[2] === 'quarter') { const q = Math.ceil(tm / 3) - back; return q > 0 ? quarterRange(ty, q, today) : quarterRange(ty - 1, 4); }
    return range(utc(ty - back, 1, 1), utc(ty - back, 12, 31), String(ty - back), 'year', today);
  }
  if (s === 'week before last') return weekRange(addDays(weekOf(today, dow), -14));
  if (s === 'month to date' || s === 'mtd') return monthRange(ty, tm, today);
  if (s === 'year to date' || s === 'ytd') return range(utc(ty, 1, 1), today, `${ty} to date`, 'year');
  if ((m = s.match(/^(?:last|past) (\d{1,3}) (day|week|month)s?$/))) {
    const n = Number(m[1]);
    const from = m[2] === 'day' ? addDays(today, -(n - 1)) : m[2] === 'week' ? addDays(today, -(7 * n - 1)) : utc(ty, tm - n, today.getUTCDate() + 1);
    return range(from, today, `last ${n} ${m[2]}${n > 1 ? 's' : ''}`, 'range');
  }
  if ((m = s.match(/^(?:wk|week) ?(\d{1,2})$/))) {
    const w = Number(m[1]);
    return w >= 1 && w <= 60 ? { kind: 'week_number', week: w, label: `Week ${w}` } : { kind: 'unknown' };
  }
  if ((m = s.match(/^q([1-4])(?:,? (\d{4}))?$/)) || (m = s.match(/^(\d{4}) q([1-4])$/))) {
    const [q, y] = m[0].startsWith('q') ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    return y ? quarterRange(Number(y), q, today) : namedPeriod('quarter', q, today);
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return dayRange(Number(m[2]), Number(m[3]), Number(m[2]), Number(m[3]), Number(m[1]), today);
  if ((m = s.match(/^(\d{4})-(\d{2})$/)) && Number(m[2]) >= 1 && Number(m[2]) <= 12) return monthRange(Number(m[1]), Number(m[2]), today);
  if ((m = s.match(new RegExp(`^${MON}\\.? (\\d{1,2})(?:st|nd|rd|th)? ?(?:-|to) ?(?:${MON}\\.? )?(\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`)))) {
    const m1 = MONTHS[m[1]], m2 = m[3] ? MONTHS[m[3]] : m1;
    return dayRange(m1, Number(m[2]), m2, Number(m[4]), m[5] ? Number(m[5]) : null, today);
  }
  if ((m = s.match(new RegExp(`^${MON}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`)))) {
    const d = Number(m[2]);
    return dayRange(MONTHS[m[1]], d, MONTHS[m[1]], d, m[3] ? Number(m[3]) : null, today);
  }
  if ((m = s.match(new RegExp(`^${MON},? (\\d{4})$`)))) return monthRange(Number(m[2]), MONTHS[m[1]], today);
  if ((m = s.match(new RegExp(`^${MON}$`)))) return namedPeriod('month', MONTHS[m[1]], today);
  if ((m = s.match(/^(20\d{2})$/))) { const y = Number(m[1]); return range(utc(y, 1, 1), utc(y, 12, 31), String(y), 'year', today); }
  if ((m = s.match(/^(\d{1,2})$/))) {
    const n = Number(m[1]);
    const options: Array<{ kind: 'range'; range: DateRange } | { kind: 'week_number'; week: number; label: string }> = [{ kind: 'week_number', week: n, label: `Week ${n}` }];
    if (n >= 1 && n <= 12) { const r = namedPeriod('month', n, today); if (r.kind === 'range') options.push(r); }
    return { kind: 'ambiguous', question: `Week ${n}${options.length > 1 ? ` or ${MONTH_NAMES[n - 1]}` : ''}?`, options };
  }
  return { kind: 'unknown' };
}

// Period phrases inside free text, in order, non-overlapping. A fallback for
// when the model passes a whole question; the agent normally passes the phrase.
// "may" and "march" count as months only after a preposition or before a year.
const DETECTORS: RegExp[] = [
  new RegExp(`\\b${MON}\\.? \\d{1,2}(?:st|nd|rd|th)? ?(?:-|–|to) ?(?:${MON}\\.? )?\\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b`, 'gi'),
  /\b\d{4}-\d{2}(?:-\d{2})?\b/g,
  new RegExp(`\\b${MON},? \\d{4}\\b`, 'gi'),
  /\b(?:q[1-4](?:,? \d{4})?|\d{4} q[1-4])\b/gi,
  /\b(?:this|current|last|previous|past|prior) (?:week|month|quarter|year)\b|\bweek before last\b|\b(?:month|year) to date\b|\b(?:mtd|ytd|yesterday|today)\b|\b(?:last|past) \d{1,3} (?:days?|weeks?|months?)\b/gi,
  /\b(?:week|wk) ?\d{1,2}\b/gi,
  new RegExp(`\\b(?:(?:in|for|of|during|since|from|by|until|through|over) )?${MON}\\b`, 'gi'),
];

export function detectPeriods(text: string, now: Date = new Date(), opts: PeriodOptions = {}): Array<{ phrase: string; at: number; resolution: PeriodResolution }> {
  const src = String(text ?? '').replace(/[–—]/g, '-');
  const taken: Array<[number, number]> = [];
  const out: Array<{ phrase: string; at: number; resolution: PeriodResolution }> = [];
  for (const re of DETECTORS) {
    for (const m of src.matchAll(re)) {
      const at = m.index ?? 0, end = at + m[0].length;
      if (taken.some(([a, b]) => at < b && end > a)) continue;
      const phrase = m[0];
      const word = phrase.toLowerCase().replace(/^(?:in|for|of|during|since|from|by|until|through|over) /, '');
      if ((word === 'may' || word === 'march') && word === phrase.toLowerCase()) continue;
      const resolution = resolvePeriod(phrase, now, opts);
      if (resolution.kind === 'unknown') continue;
      taken.push([at, end]);
      out.push({ phrase, at, resolution });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── a brand's own report calendar ──────────────────────────────────────────

export type ReportPeriodRow = {
  report_id: string;
  brand_id: string;
  report_type: string;
  status: string;
  period_label: string | null;
  period_start: string;
  period_end: string | null;
};

// pg returns a date column as a Date at local midnight, PostgREST as 'YYYY-MM-DD'.
export function toIsoDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60_000);
    return d.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
}

// The weekday the brand's recent weekly reports start on (their mode), else
// the org default. `source` says which, so the answer can be honest about it.
export function weekStartFromReports(rows: ReportPeriodRow[]): { dow: number; source: 'brand' | 'default' } {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const s = toIsoDate(r.period_start), e = toIsoDate(r.period_end);
    if (r.report_type !== 'weekly' || !s || !e) continue;
    if ((Date.parse(e) - Date.parse(s)) / 86_400_000 !== 6) continue;
    const dow = new Date(Date.parse(s)).getUTCDay();
    counts.set(dow, (counts.get(dow) ?? 0) + 1);
    if ([...counts.values()].reduce((a, b) => a + b, 0) >= 8) break;   // rows are newest first
  }
  if (!counts.size) return { dow: DEFAULT_WEEK_START_DOW, source: 'default' };
  const [dow] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { dow, source: 'brand' };
}

export type Coverage = {
  brand_id: string;
  // covered: an approved report of the matching type overlaps the period ·
  // awaiting_approval: only submitted/verified ones do · not_in_yet: none does.
  status: 'covered' | 'awaiting_approval' | 'not_in_yet';
  approved: ReportPeriodRow[];
  pending: ReportPeriodRow[];
  latestApproved: ReportPeriodRow | null;
  // Approved reports of the other types in the period (e.g. the weeklies of a
  // month whose monthly report is still awaiting approval).
  otherApproved: ReportPeriodRow[];
};

const TYPES_FOR_UNIT: Partial<Record<Unit, string[]>> = { week: ['weekly', 'biweekly'], month: ['monthly'] };

export function coverageFor(rows: ReportPeriodRow[], brandIds: string[], res: PeriodResolution): Coverage[] {
  if (res.kind !== 'range' && res.kind !== 'week_number') return [];
  const types = res.kind === 'range' ? TYPES_FOR_UNIT[res.range.unit] : ['weekly', 'biweekly'];
  const weekRe = res.kind === 'week_number' ? new RegExp(`^\\s*week\\s*${res.week}\\b`, 'i') : null;
  return brandIds.map((brand_id) => {
    const mine = rows.filter((r) => r.brand_id === brand_id)
      .sort((a, b) => String(toIsoDate(b.period_start)).localeCompare(String(toIsoDate(a.period_start))));
    const inPeriod = mine.filter((r) => {
      if (weekRe) return weekRe.test(r.period_label ?? '');
      const s = toIsoDate(r.period_start)!, e = toIsoDate(r.period_end) ?? s;
      return e >= (res as { range: DateRange }).range.from && s <= (res as { range: DateRange }).range.to;
    });
    const ofType = (r: ReportPeriodRow) => !types || types.includes(r.report_type);
    const hits = inPeriod.filter(ofType);
    const approved = hits.filter((r) => r.status === 'approved');
    const pending = hits.filter((r) => r.status !== 'approved');
    const otherApproved = inPeriod.filter((r) => !ofType(r) && r.status === 'approved');
    const latestApproved = mine.find((r) => r.status === 'approved' && ofType(r)) ?? null;
    const status = approved.length ? 'covered' : pending.length ? 'awaiting_approval' : 'not_in_yet';
    return { brand_id, status, approved, pending, latestApproved, otherApproved };
  });
}

export type ReportPeriodResolution = {
  resolution: PeriodResolution;
  weekStart: { dow: number; source: 'brand' | 'default' };
  coverage: Coverage[];
};

// "last week" for a brand = the brand's own last reporting week, plus whether
// a report for it is in. With several brands the most common week start wins.
export async function resolveReportPeriod(rpc: Rpc, input: string,
  opts: { brandIds?: string[]; asUser?: string | null; now?: Date } = {}): Promise<ReportPeriodResolution> {
  const now = opts.now ?? new Date();
  const brandIds = (opts.brandIds ?? []).filter(Boolean);
  const rows: ReportPeriodRow[] = brandIds.length
    ? ((await rpc('ai_report_periods', { p_brand_ids: brandIds, p_limit: 200, p_as_user: opts.asUser ?? undefined })) ?? [])
    : [];
  const weekStart = weekStartFromReports(rows);
  const resolution = resolvePeriod(input, now, { weekStartDow: weekStart.dow });
  return { resolution, weekStart, coverage: brandIds.length ? coverageFor(rows, brandIds, resolution) : [] };
}

// ── synonyms (the v1 list plus Phase 5 additions) ──────────────────────────

const SYNONYMS: Array<[RegExp, string]> = [
  [/\b(time off|day off|days off|vacation|holiday|absence)\b/i, 'leave'],
  [/\b(punch(?:ed|ing)? (?:in|out)|clock(?:ed|ing)? (?:in|out)|clock-?in|clock-?out|check(?:ed)? in)\b/i, 'attendance clock'],
  [/\b(wfh|remote work|work(?:ing)? from home)\b/i, 'work from home WFH'],
  [/\b(budget|roi|roas|ad spend|ads spend)\b/i, 'GMV Max'],
  [/\b(influencers?|kols?|affiliates?)\b/i, 'creator'],
  [/\b(bann?ed|ban|strikes?|suspended|suspension|penalt(?:y|ies)|infractions?)\b/i, 'violation'],
  [/\b(free samples?|sample requests?|seeding)\b/i, 'sample'],
  [/\b(sps|shop score)\b/i, 'shop performance score'],
  [/\b(ldr)\b/i, 'late dispatch rate'],
  [/\b(payouts?|bonus(?:es)?|commission plan)\b/i, 'incentive'],
  [/\b(promo(?:tion)? codes?|discounts?|vouchers?)\b/i, 'coupon'],
  [/\b(live ?streams?|going live)\b/i, 'LIVE'],
  [/\b(listings?)\b/i, 'product listing'],
  [/\b(appeal(?:ing)?)\b/i, 'appeal violation'],
  [/\btls?\b/i, 'team lead'],
  [/\bols?\b/i, 'operations lead'],
  [/\bapcs?\b/i, 'affiliate partnership coordinator'],
];

// Extra terms for the keyword arm; terms the query already has are skipped.
export function expandSynonyms(query: string): string[] {
  const q = String(query ?? '');
  const lower = q.toLowerCase();
  const out: string[] = [];
  for (const [re, add] of SYNONYMS) {
    if (!re.test(q)) continue;
    const words = add.split(' ').filter((w) => !lower.includes(w.toLowerCase()));
    if (words.length && !out.includes(add)) out.push(words.join(' '));
  }
  return out;
}
