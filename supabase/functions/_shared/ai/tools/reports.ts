// Report data tools (A§11, phase5-design §4). APPROVED REPORTS ONLY (Owner,
// 2026-09-28): a newer unapproved report is named in a `pending` note (period +
// status) and its figures are never returned. Reports are picked by PERIOD
// (findPreviousReport semantics), never by created_at.
// deno-lint-ignore-file no-explicit-any

import type { Db, ToolCtx, ToolSource } from './types.ts';
import { allowed, isBoss, rlsDecides, viewableBrandIds } from './acl.ts';
import { fmtMoney, fmtNum, fmtSigned, normTier, parseMetric, reportCurrency } from './metrics.ts';
import { addDays, applyPeriod, type Period, resolveBrands, resolvePeriod } from './period.ts';
import { clip, has, htmlToText, insightBlock, metricsLine, tableBlock, writtenBlock } from './v1format.ts';

export type Out = { text: string; source: ToolSource; data?: unknown };

export const APPROVED = 'approved';
const REPORT_COLS = 'id, brand_id, type, period_label, period_start, period_end, period_year, period_month, status, data, sections_enabled, brand:brand_id(brand_name, currency)';
const PENDING_COLS = 'id, brand_id, type, period_label, period_start, period_year, period_month, status, brand:brand_id(brand_name)';
const TYPES = ['weekly', 'biweekly', 'monthly'];
// How far before the latest approved report an unapproved one is still worth
// naming (e.g. a verified Week 22 behind an approved Week 24).
const PENDING_LOOKBACK_DAYS = 28;
const PENDING_CAP = 10;

// ------------------------------------------------------------------ pure helpers
const pad = (n: number) => String(n).padStart(2, '0');

// findPreviousReport / findPreviousMonthlyReport (src/lib/reportsApi.js):
// weekly & biweekly compare period_start, monthly compares the month key.
export function periodKey(r: any): string {
  if (r?.type === 'monthly' && r.period_year != null && r.period_month != null) return `${r.period_year}-${pad(Number(r.period_month) + 1)}`;
  return String(r?.period_start ?? '');
}

export function findPreviousByPeriod(rows: any[], cur: any): any | null {
  const k = periodKey(cur);
  if (!k) return null;
  return rows
    .filter((r) => r.brand_id === cur.brand_id && r.type === cur.type && r.id !== cur.id && periodKey(r) < k)
    .sort((a, b) => periodKey(b).localeCompare(periodKey(a)))[0] ?? null;
}

const brandName = (r: any) => r?.brand?.brand_name || 'Unknown brand';
const periodOf = (r: any) => r?.period_label || r?.period_start || '?';
const sectionOn = (r: any, key: string) => {
  const en = r?.sections_enabled ?? r?.data?.sectionsEnabled;
  return !(en && typeof en === 'object' && en[key] === false);
};

export function statusPhrase(status: string): string {
  switch (status) {
    case 'submitted': return 'submitted, awaiting TL verification and approval';
    case 'verified': return 'verified by the TL, awaiting approval';
    case 'draft': return 'still a draft';
    case 'rejected': return 'sent back for changes';
    default: return status || 'unknown status';
  }
}

// Which unapproved reports to name. For each (brand, type) with an approved
// report shown: anything newer, plus non-drafts up to 28 days older. With
// nothing approved shown for that pair (or `all`), every one matching.
export function selectPending(shown: any[], pending: any[], all = false): any[] {
  const latest = new Map<string, string>();
  for (const r of shown) {
    const k = `${r.brand_id}|${r.type}`;
    if (!latest.has(k) || String(r.period_start) > latest.get(k)!) latest.set(k, String(r.period_start));
  }
  return pending.filter((p) => {
    const k = `${p.brand_id}|${p.type}`;
    const top = latest.get(k);
    if (!top) return all || shown.length === 0;
    const ps = String(p.period_start);
    return ps > top || (p.status !== 'draft' && ps >= addDays(top, -PENDING_LOOKBACK_DAYS));
  }).slice(0, PENDING_CAP);
}

export function pendingBlock(pending: any[]): string {
  if (!pending.length) return '';
  return '\n\nNot yet approved (figures withheld; never quote them):\n' + pending.map((p) =>
    `- ${brandName(p)} · ${periodOf(p)} (${p.type}): ${statusPhrase(p.status)}`).join('\n');
}

const pendingSource = (pending: any[]) => pending.map((p) => ({ id: p.id, period: String(periodOf(p)), status: p.status, brand: brandName(p) }));

function currencySummary(rows: any[]): string | null {
  const set = new Set(rows.map((r) => reportCurrency(r)));
  return set.size === 0 ? null : set.size === 1 ? [...set][0] : 'mixed';
}

// ------------------------------------------------------------------ metrics
type Path = [string, string];
type MetricSpec = { label: string; kind: 'money' | 'count' | 'ratio' | 'score'; weekly: Path[]; monthly: Path[] };

export const REPORT_METRICS: Record<string, MetricSpec> = {
  gmv: { label: 'GMV', kind: 'money', weekly: [['overallPerformance', 'gmv']], monthly: [['keyMetrics', 'gmv'], ['totalSales', 'monthGmv']] },
  affiliate_gmv: { label: 'Affiliate GMV', kind: 'money', weekly: [['overallPerformance', 'affiliateGmv']], monthly: [['gmvBreakdown', 'affiliateGmv']] },
  orders: { label: 'Orders', kind: 'count', weekly: [['overallPerformance', 'orders']], monthly: [['keyMetrics', 'orders'], ['kpis', 'totalOrders']] },
  roi: { label: 'ROI', kind: 'ratio', weekly: [['overallPerformance', 'roi']], monthly: [] },
  samples: { label: 'Samples approved', kind: 'count', weekly: [['overallPerformance', 'samplesApproved']], monthly: [['kpis', 'freeSamplesApproved']] },
  videos: { label: 'Videos posted', kind: 'count', weekly: [['overallPerformance', 'videosPosted']], monthly: [['videoPerformance', 'newVideosPosted']] },
  shop_score: { label: 'Shop performance score', kind: 'score', weekly: [['overallPerformance', 'shopPerformanceScore']], monthly: [] },
  gmv_max_gmv: { label: 'GMV Max GMV', kind: 'money', weekly: [], monthly: [] },
  gmv_max_spend: { label: 'GMV Max spend', kind: 'money', weekly: [], monthly: [] },
  gmv_max_roi: { label: 'GMV Max ROI', kind: 'ratio', weekly: [], monthly: [] },
};
export const METRIC_NAMES = Object.keys(REPORT_METRICS);

export type MetricValue = { value: number | null; currency: string | null; raw: string; note?: string };

const SUMMARY_ROW = /^\s*(overall|overall total|total|totals|grand total)\s*$/i;
// Sums of 2-decimal figures: drop binary float noise (140492.83000000002).
const unfloat = (v: number) => Math.round(v * 1e6) / 1e6;

// GMV Max from a report's gmvMax table (A§11: aggregations in code, never the
// model). Rules:
//  • a row named Overall/Total is the author's own total → used as-is, other
//    rows ignored (52 reports on dev carry one; summing would double-count);
//  • otherwise spend and GMV are summed over rows where both parse;
//  • ROI = ΣGMV / Σspend (spend-weighted), never an average of row ROIs; a lone
//    row with only an ROI keeps its stated ROI;
//  • rows with unreadable figures or a currency other than the report's are
//    left out and counted in the note.
export function gmvMaxTotals(report: any): { spend: number | null; gmv: number | null; roi: number | null; rows: number; used: number; summaryRow: boolean; note?: string } {
  const cur = reportCurrency(report);
  const rows = (Array.isArray(report?.data?.gmvMax) ? report.data.gmvMax : []).filter((r: any) => r && typeof r === 'object');
  const val = (raw: unknown) => {
    const p = parseMetric(raw);
    if (p.value == null) return { v: null, bad: p.reason === 'unparseable' };
    if (p.currency && p.currency !== cur) return { v: null, bad: true };
    if (p.unit === 'percent' || p.unit === 'multiplier') return { v: null, bad: true };
    return { v: p.value, bad: false };
  };
  const summary = rows.find((r: any) => SUMMARY_ROW.test(String(r.campaign ?? '')));
  if (summary) {
    const s = val(summary.spend).v, g = val(summary.gmv).v;
    const stated = parseMetric(summary.roi).value;
    const roi = s && g != null ? g / s : stated;
    return { spend: s, gmv: g, roi, rows: rows.length, used: 1, summaryRow: true };
  }
  let spend = 0, gmv = 0, used = 0, bad = 0;
  for (const r of rows) {
    const s = val(r.spend), g = val(r.gmv);
    if (s.bad || g.bad) { bad++; continue; }
    if (s.v == null || g.v == null) continue;
    spend = unfloat(spend + s.v); gmv = unfloat(gmv + g.v); used++;
  }
  let roi: number | null = used && spend > 0 ? gmv / spend : null;
  if (!used && rows.length === 1) roi = parseMetric(rows[0].roi).value;
  const note = bad ? `${bad} of ${rows.length} campaign rows had unreadable figures and were left out` : undefined;
  return { spend: used ? spend : null, gmv: used ? gmv : null, roi, rows: rows.length, used, summaryRow: false, note };
}

export function metricValue(report: any, metric: string): MetricValue {
  const spec = REPORT_METRICS[metric];
  const cur = reportCurrency(report);
  const money = spec?.kind === 'money';
  if (!spec) return { value: null, currency: null, raw: '', note: `unknown metric ${metric}` };
  if (metric.startsWith('gmv_max_')) {
    if (!sectionOn(report, 'gmvMax')) return { value: null, currency: null, raw: '', note: 'GMV Max section disabled in this report' };
    const t = gmvMaxTotals(report);
    if (!t.rows) return { value: null, currency: null, raw: '', note: 'no GMV Max rows' };
    const v = metric === 'gmv_max_gmv' ? t.gmv : metric === 'gmv_max_spend' ? t.spend : t.roi;
    const how = t.summaryRow ? 'from the Overall row' : `${t.used} of ${t.rows} campaign rows`;
    return { value: v, currency: money ? cur : null, raw: how, note: v == null ? (t.note || 'not computable from the GMV Max rows') : t.note };
  }
  const paths = report?.type === 'monthly' ? spec.monthly : spec.weekly;
  if (!paths.length) return { value: null, currency: null, raw: '', note: `${spec.label} is not part of ${report?.type} reports` };
  let seen: string | null = null;
  for (const [box, key] of paths) {
    if (!sectionOn(report, box)) continue;
    const raw = report?.data?.[box]?.[key];
    const p = parseMetric(raw);
    if (p.value == null) { if (p.reason === 'unparseable') seen = String(raw); continue; }
    if (money && p.currency && p.currency !== cur) return { value: null, currency: null, raw: String(raw), note: `written in ${p.currency}, report currency is ${cur}` };
    if (money && (p.unit === 'percent' || p.unit === 'multiplier')) return { value: null, currency: null, raw: String(raw), note: 'not a money figure' };
    return { value: p.value, currency: money ? cur : null, raw: String(raw) };
  }
  return { value: null, currency: null, raw: seen ?? '', note: seen ? `unreadable value "${clip(seen, 40)}"` : 'not filled' };
}

export function fmtMetric(metric: string, v: number, currency: string | null): string {
  const kind = REPORT_METRICS[metric]?.kind;
  if (kind === 'money') return fmtMoney(v, currency || 'USD');
  if (kind === 'ratio') return v.toFixed(2);
  return fmtNum(v);
}

// ------------------------------------------------------------------ report picking
async function brandScope(admin: Db, ctx: ToolCtx, name: string | undefined): Promise<{ ids: string[] | null; brands: any[]; error?: string }> {
  const visible = await viewableBrandIds(admin, ctx);
  if (!name) return { ids: visible ? [...visible] : null, brands: [] };
  const found = (await resolveBrands(admin, name)).filter((b) => !visible || visible.has(b.id));
  if (!found.length) return { ids: [], brands: [], error: `No brand matches "${name}".` };
  return { ids: found.map((b) => b.id), brands: found };
}

function oneBrand(scope: { brands: any[]; error?: string }, name: string): string | null {
  if (scope.error) return scope.error;
  if (scope.brands.length > 1) return `Several brands match "${name}": ${scope.brands.map((b) => b.brand_name).join(', ')}. Ask which one.`;
  return null;
}

async function fetchPending(admin: Db, f: { brandIds: string[] | null; type?: string; period?: Period | null; since?: string }): Promise<any[]> {
  let q = admin.from('reports').select(PENDING_COLS).neq('status', APPROVED).order('period_start', { ascending: false });
  if (f.brandIds) q = q.in('brand_id', f.brandIds);
  if (f.type) q = q.eq('type', f.type);
  if (f.period) q = applyPeriod(q, f.period);
  if (f.since) q = q.gte('period_start', f.since);
  const { data, error } = await q.limit(40);
  if (error) throw error;
  return data || [];
}

// The approved reports of one brand/type for a period. With a period that has
// none, falls back to the latest approved report before it and says so.
export type PeriodStatus = 'approved' | 'pending' | 'missing';

const awaiting = (status: string) =>
  status === 'draft' ? 'not yet submitted' : status === 'rejected' ? 'sent back for changes' : 'awaiting approval';

// The two cases must never blur (Buddy's smoke: "not approved yet" was said of
// a week with no report at all). `unapproved` = the period's non-approved reports.
export function periodStatusNote(what: string, p: Period, unapproved: any[], latest: any | null): string {
  const when = `${p.label}${p.kind === 'label' ? '' : ' (PKT)'}`;
  const head = unapproved.length
    ? unapproved.map((r) => `The ${what} for ${when}${periodOf(r) !== p.label ? ` (${periodOf(r)})` : ''} exists but is ${r.status}, ${awaiting(r.status)} (figures withheld).`).join(' ')
    : `No ${what} has been submitted for ${when} yet (not in yet).`;
  return head + (latest ? ` Latest approved ${what} instead: ${periodOf(latest)}.` : ` There is no earlier approved ${what} either.`);
}

export async function pickApproved(admin: Db, o: { brandIds: string[]; type?: string; period: Period | null; limit?: number }):
  Promise<{ rows: any[]; note: string; fellBack: boolean; periodStatus: PeriodStatus | null }> {
  let q = admin.from('reports').select(REPORT_COLS).eq('status', APPROVED).in('brand_id', o.brandIds).order('period_start', { ascending: false });
  if (o.type) q = q.eq('type', o.type);
  const { data, error } = await applyPeriod(q, o.period).limit(o.limit ?? 12);
  if (error) throw error;
  if (data?.length || !o.period) return { rows: data || [], note: '', fellBack: false, periodStatus: o.period ? 'approved' : null };
  let fq = admin.from('reports').select(REPORT_COLS).eq('status', APPROVED).in('brand_id', o.brandIds).order('period_start', { ascending: false });
  if (o.type) fq = fq.eq('type', o.type);
  if (o.period.to) fq = fq.lte('period_start', o.period.to);
  const [{ data: prev, error: e2 }, unapproved] = await Promise.all([
    fq.limit(1), fetchPending(admin, { brandIds: o.brandIds, type: o.type, period: o.period }),
  ]);
  if (e2) throw e2;
  const what = `${o.type ? `${o.type} ` : ''}report`;
  return {
    rows: prev || [], fellBack: true, periodStatus: unapproved.length ? 'pending' : 'missing',
    note: periodStatusNote(what, o.period, unapproved, prev?.[0] ?? null),
  };
}

// A period word implies a report type ("August" → monthly, "last week" → weekly).
const typeFor = (args: any, p: Period | null) => (TYPES.includes(String(args?.type)) ? String(args.type) : p?.type);

// v1's metricsLine with the money parts labelled for non-USD reports:
// "GMV 5056.59 (GBP), orders 12". USD returns v1's text unchanged.
export function metricsLineCur(d: any, currency: string): string {
  if (currency === 'USD') return metricsLine(d);
  const o = d?.overallPerformance || d?.keyMetrics || {};
  const off = d?.offsitePerformance || {};
  const c = ` (${currency})`;
  const parts = [
    has(o.gmv) ? `GMV ${o.gmv}${c}` : null,
    has(o.affiliateGmv) ? `affiliate GMV ${o.affiliateGmv}${c}` : null,
    has(o.orders) ? `orders ${o.orders}` : null,
    has(o.samplesApproved) ? `samples ${o.samplesApproved}` : null,
    has(o.videosPosted) ? `videos ${o.videosPosted}` : null,
    has(o.roi) ? `ROI ${o.roi}` : null,
    has(o.shopPerformanceScore) ? `shop score ${o.shopPerformanceScore}` : null,
    has(off.offsiteGmv) ? `offsite GMV ${off.offsiteGmv}${c}` : null,
  ].filter(Boolean).join(', ');
  return parts || 'no headline metrics filled';
}

// ------------------------------------------------------------------ get_reports
// v1's get_reports, approved-only. The text is v1's for the approved rows plus
// a pending block; a period v1 can't match as a label ("last week", "June" for
// weekly reports) is then matched by dates, which v1 answered with nothing.
// can_view_report lets an author see their own report on a brand whose row
// brands RLS hides, so the embed comes back null ("Unknown brand"). For rows
// the caller's RLS already returned, fetch just the brand's name (and currency,
// or the figures would be labelled in the wrong one) with the service client.
export async function fillHiddenBrands(rows: any[], svc: Db | undefined): Promise<void> {
  const missing = [...new Set(rows.filter((r) => !r.brand && r.brand_id).map((r) => r.brand_id))];
  if (!missing.length || !svc) return;
  const { data } = await svc.from('brands').select('id, brand_name, currency').in('id', missing);
  const by = new Map((data || []).map((b: any) => [b.id, { brand_name: b.brand_name, currency: b.currency }]));
  for (const r of rows) if (!r.brand && by.has(r.brand_id)) r.brand = by.get(r.brand_id);
}

export async function getReports(admin: Db, ctx: ToolCtx, args: any, svc?: Db): Promise<Out> {
  const sections: string[] = Array.isArray(args?.sections) && args.sections.length ? args.sections : ['metrics'];
  const wantAll = sections.includes('all');
  const want = (s: string) => wantAll || sections.includes(s);
  const src: ToolSource = { table: 'reports', status: APPROVED, period: args?.period ? String(args.period) : null };

  // Brand → ids in the DB first (v1: filtering by name after a LIMIT dropped brands).
  let brandIds: string[] | null = null;
  if (args?.brand_name) {
    const { data: bmatch } = await admin.from('brands')
      .select('id, brand_name').ilike('brand_name', `%${String(args.brand_name).trim()}%`).limit(20);
    if (!bmatch || !bmatch.length) return { text: `No brand matches "${args.brand_name}".`, source: src };
    brandIds = bmatch.map((b: any) => b.id);
  }
  // With the caller's JWT, reports_select (can_view_report) decides, including
  // "the author sees their own report"; a brand filter would drop those.
  if (!rlsDecides(ctx)) brandIds = allowed(brandIds, await viewableBrandIds(admin, ctx));
  if (brandIds && !brandIds.length) return { text: 'No matching reports found for that brand/period.', source: src };

  const limit = args?.brand_name && args?.period ? 8 : (args?.brand_name || args?.period ? 40 : 15);
  const build = (p: Period | null) => {
    let query = admin.from('reports').select(REPORT_COLS).eq('status', APPROVED).order('period_start', { ascending: false });
    if (brandIds) query = query.in('brand_id', brandIds);
    if (args?.type) query = query.eq('type', String(args.type));
    if (p) query = applyPeriod(query, p);
    return query.limit(limit);
  };
  const asLabel: Period | null = args?.period ? { kind: 'label', label: String(args.period).trim(), pattern: String(args.period).trim() } : null;
  let used = asLabel;
  const { data: reps, error } = await build(asLabel);
  if (error) throw error;
  let rows: any[] = reps || [];
  let lead = '';
  let periodStatus: PeriodStatus | null = args?.period && rows.length ? 'approved' : null;
  const resolved = args?.period ? resolvePeriod(args.period) : null;
  if (!rows.length && resolved && resolved.kind !== 'label') {
    used = resolved;
    const { data: byDate, error: e2 } = await build(resolved);
    if (e2) throw e2;
    rows = byDate || [];
    if (rows.length) { lead = `(Matched "${args.period}" by dates: ${resolved.label}, PKT.)\n`; periodStatus = 'approved'; }
    else if (brandIds && brandIds.length <= 3) {
      const fb = await pickApproved(admin, { brandIds, type: args?.type ? String(args.type) : resolved.type, period: resolved, limit: 1 });
      rows = fb.rows;
      lead = `${fb.note}\n`;
      periodStatus = fb.periodStatus;
      used = null;
    }
  }
  const data = periodStatus ? { period_status: periodStatus } : undefined;

  // Pending: same scope; for the fallback, anything from 4 weeks before the
  // shown report onwards.
  const since = !used && rows.length ? addDays(String(rows[0].period_start), -PENDING_LOOKBACK_DAYS) : undefined;
  const pendingAll = await fetchPending(admin, { brandIds, type: args?.type ? String(args.type) : undefined, period: used, since });
  const pending = selectPending(rows, pendingAll, !!args?.brand_name);
  if (rlsDecides(ctx)) await fillHiddenBrands([...rows, ...pending], svc);
  src.pending = pendingSource(pending);
  src.ids = rows.map((r) => r.id);
  src.currency = currencySummary(rows);
  if (!rows.length) return { text: lead + 'No matching reports found for that brand/period.' + pendingBlock(pending), source: src, data };

  const detailWanted = want('insights') || want('creators') || want('videos') || want('gmvmax') || want('products') || want('written');
  const detailCap = detailWanted ? 3 : 20;
  let detailShown = 0;
  const blocks = rows.map((r: any) => {
    const d = r.data || {};
    // v1 prints bare figures; non-USD reports get their currency (Lead, WP-B
    // decision 1), USD lines stay byte-identical to v1.
    const cur = reportCurrency(r);
    const t = (title: string) => (cur === 'USD' ? title : `${title} (money in ${cur})`);
    let block = `- ${r.brand?.brand_name || 'Unknown brand'} · ${r.period_label || r.period_start} (${r.type}, ${r.status})`;
    if (want('metrics') || (!detailWanted)) block += `: ${metricsLineCur(d, cur)}`;
    if (detailWanted && detailShown < detailCap) {
      if (want('creators')) block += tableBlock(t('Top creators'), d.topCreators, [['name', 'name'], ['gmv', 'GMV'], ['videosPosted', 'videos'], ['itemsSold', 'sold'], ['notes', 'notes']]);
      if (want('videos')) block += tableBlock(t('Top videos'), d.topVideos, [['creatorName', 'creator'], ['gmv', 'GMV'], ['views', 'views'], ['productClicks', 'clicks'], ['videoLink', 'link']]);
      if (want('gmvmax')) block += tableBlock(t('GMV Max campaigns'), d.gmvMax, [['campaign', 'campaign'], ['spend', 'spend'], ['gmv', 'GMV'], ['roi', 'ROI'], ['orders', 'orders'], ['cpo', 'CPO']]);
      if (want('products')) block += tableBlock(t('Product highlights'), d.productHighlights || d.productAnalytics, [['productName', 'product'], ['gmv', 'GMV'], ['unitsSold', 'units'], ['newVideos', 'new videos']]);
      if (want('insights')) block += insightBlock(d);
      if (want('written')) block += writtenBlock(d);
      detailShown++;
    }
    return block;
  });
  let footer = '';
  if (detailWanted && rows.length > detailCap) footer = `\n\n(Showing full detail for the first ${detailCap} of ${rows.length} reports. Ask about a specific brand + period for the rest.)`;
  return { text: lead + `Reports (${rows.length} matched):\n` + blocks.join('\n') + footer + pendingBlock(pending), source: src, data };
}

// ------------------------------------------------------------------ get_top_creators
const CREATOR_METRICS: Record<string, { key: string; label: string; money: boolean }> = {
  gmv: { key: 'gmv', label: 'GMV', money: true },
  items_sold: { key: 'itemsSold', label: 'items sold', money: false },
  videos: { key: 'videosPosted', label: 'videos', money: false },
};

// The same creator is '@tavo2real' in a monthly report (username) and
// 'tavo2real' in a weekly one (name). Compare on this key; display the original.
export function normHandle(raw: unknown): string {
  return String(raw ?? '').trim()
    .replace(/^(https?:\/\/)?(www\.|m\.)?tiktok\.com\//i, '')
    .replace(/^@+/, '').replace(/[/?#].*$/, '').trim().toLowerCase();
}

export const NO_ITEMS_NOTE = 'monthly reports do not record items sold per creator';

export type CreatorRow = {
  order: number; name: string; key: string; gmv: number | null; gmvRaw: unknown;
  items: number | null; itemsRaw: unknown; videos: number | null; notes: string;
};

// Weekly rows carry name/gmv/itemsSold/videosPosted; monthly rows only
// username/gmv. `tracksItems` says whether the report has the column at all.
export function rankCreators(report: any, metric = 'gmv'): { rows: CreatorRow[]; tracksItems: boolean } {
  const cur = reportCurrency(report);
  const list = (Array.isArray(report?.data?.topCreators) ? report.data.topCreators : []).filter((r: any) => r && typeof r === 'object');
  const tracksItems = list.some((r: any) => 'itemsSold' in r);
  const rows: CreatorRow[] = list.map((r: any, i: number) => {
    const gmv = parseMetric(r.gmv), items = parseMetric(r.itemsSold), videos = parseMetric(r.videosPosted);
    const name = String(r.name || r.username || '').trim() || '(unnamed)';
    return {
      order: i + 1, name, key: normHandle(name),
      // A cell written in another currency than the report's is not comparable.
      gmv: !gmv.currency || gmv.currency === cur ? gmv.value : null, gmvRaw: r.gmv,
      items: items.value, itemsRaw: r.itemsSold,
      videos: videos.value, notes: typeof r.notes === 'string' ? clip(htmlToText(r.notes), 120) : '',
    };
  });
  const k = metric === 'items_sold' && tracksItems ? 'items' : metric === 'videos' ? 'videos' : 'gmv';
  rows.sort((a, b) => ((b[k] ?? -Infinity) as number) - ((a[k] ?? -Infinity) as number) || a.order - b.order);
  return { rows, tracksItems };
}

export type WeekAgg = { key: string; name: string; gmv: number | null; items: number | null; videos: number | null; weeks: string[] };

// Sums creators across approved weekly reports. Partial by nature: a weekly
// top list only names the creators who made that week's list.
export function aggregateWeekly(weeks: any[]): WeekAgg[] {
  const by = new Map<string, WeekAgg>();
  const add = (a: number | null, b: number | null) => (b == null ? a : unfloat((a ?? 0) + b));
  for (const w of [...weeks].sort((a, b) => periodKey(a).localeCompare(periodKey(b)))) {
    if (!sectionOn(w, 'topCreators')) continue;
    for (const c of rankCreators(w).rows) {
      const cur = by.get(c.key) ?? { key: c.key, name: c.name, gmv: null, items: null, videos: null, weeks: [] };
      cur.gmv = add(cur.gmv, c.gmv); cur.items = add(cur.items, c.items); cur.videos = add(cur.videos, c.videos);
      if (!cur.weeks.includes(periodOf(w))) cur.weeks.push(String(periodOf(w)));
      by.set(c.key, cur);
    }
  }
  return [...by.values()];
}

// Weekly reports fully inside [from, to] vs those that straddle an edge.
export function splitWeeks(rows: any[], from: string, to: string): { inside: any[]; straddle: any[] } {
  const inside: any[] = [], straddle: any[] = [];
  for (const r of rows) {
    const s = String(r.period_start), e = String(r.period_end ?? r.period_start);
    if (e < from || s > to) continue;
    (s >= from && e <= to ? inside : straddle).push(r);
  }
  return { inside, straddle };
}

// Two paths:
//  • a month (Owner rule, phase5-design §3 6a): the approved monthly report
//    gives its own fields (the ranking by GMV); what it doesn't record (items
//    sold per creator) is DERIVED from the approved weekly reports lying fully
//    inside the month. With no approved monthly, everything is derived from
//    those weeklies and the monthly's pending note is shown. Disclosure fields
//    travel in `data` (derived_from, weeks_used, weeks_excluded, note,
//    partial_per_creator).
//  • any other period: one approved report (last week → that week's report,
//    or the latest approved one before it, said so).
export async function getTopCreators(admin: Db, ctx: ToolCtx, args: any): Promise<Out> {
  const src: ToolSource = { table: 'reports', status: APPROVED };
  if (!args?.brand) return { text: 'Name the brand.', source: src };
  const scope = await brandScope(admin, ctx, String(args.brand));
  const bad = oneBrand(scope, String(args.brand));
  if (bad) return { text: bad, source: src };
  const brand = scope.brands[0];
  src.brand = brand.brand_name;
  const period = args?.period ? resolvePeriod(args.period) : null;
  const metric = CREATOR_METRICS[String(args?.metric)] ? String(args.metric) : 'gmv';
  const topN = Math.min(Math.max(Number(args?.top_n) || 5, 1), 20);
  const type = typeFor(args, period);
  if (period?.kind === 'month' && type === 'monthly') return monthCreators(admin, brand, period, metric, topN, src);
  const pick = await pickApproved(admin, { brandIds: [brand.id], type, period, limit: 12 });
  const shown = pick.rows.slice(0, 1);
  const pending = selectPending(shown, await fetchPending(admin, {
    brandIds: [brand.id], type, since: shown.length ? addDays(String(shown[0].period_start), -PENDING_LOOKBACK_DAYS) : undefined,
    period: shown.length ? null : period }), true);
  src.pending = pendingSource(pending);
  const status = { period_status: pick.periodStatus, shown_period: shown.length ? String(periodOf(shown[0])) : null };
  if (!shown.length) return { text: (pick.note || `No approved report for ${brand.brand_name}${period ? ` in ${period.label}` : ''}.`) + pendingBlock(pending), source: src, data: status };

  const r = shown[0];
  const cur = reportCurrency(r);
  Object.assign(src, { ids: [r.id], period: String(periodOf(r)), currency: cur });
  const lead = [pick.note, pick.rows.length > 1 && !pick.fellBack ? `${pick.rows.length} approved reports match ${period?.label}; showing the latest. Ask for a specific one for the others.` : '']
    .filter(Boolean).join('\n');
  const done = (lines: string[], data?: Record<string, unknown>) => ({ text: [lead, ...lines].filter(Boolean).join('\n') + pendingBlock(pending), source: src, data: { ...status, ...data } });
  if (!sectionOn(r, 'topCreators')) return done([`${brand.brand_name} · ${periodOf(r)}: the top-creators section is switched off in this report.`]);
  const { rows, tracksItems } = rankCreators(r, metric);
  const by = metric === 'items_sold' && !tracksItems ? 'GMV' : CREATOR_METRICS[metric].label;
  const head = `Top creators — ${brand.brand_name} · ${periodOf(r)} (${r.type}, approved), ranked by ${by}; money in ${cur}:`;
  if (!rows.length) return done([head, 'No creators listed in this report.']);
  const show = (v: number | null, raw: unknown, f: (n: number) => string) => (v != null ? f(v) : has(raw) ? `"${clip(String(raw), 30)}" (unreadable)` : 'n/a');
  const lines = rows.slice(0, topN).map((c, i) =>
    `${i + 1}. ${c.name} — GMV ${show(c.gmv, c.gmvRaw, (n) => fmtMoney(n, cur))}, items sold ${tracksItems ? show(c.items, c.itemsRaw, fmtNum) : 'n/a'}` +
    `${c.videos != null ? `, videos ${fmtNum(c.videos)}` : ''} (row ${c.order} in the report)${c.notes ? ` — ${c.notes}` : ''}`);
  const notes = [
    !tracksItems ? `Items sold: not available — ${NO_ITEMS_NOTE}${r.type === 'monthly' ? ' (ask for the month by name to get items derived from its weekly reports)' : ''}.` : '',
    `Report's own order: ${[...rows].sort((a, b) => a.order - b.order).map((c) => c.name).join(', ')}.`,
  ];
  return done([head, ...lines, ...notes], {
    mode: 'report', report: { id: r.id, period: periodOf(r), type: r.type, currency: cur },
    items_sold_note: tracksItems ? null : NO_ITEMS_NOTE,
    creators: rows.slice(0, topN).map((c, i) => ({ rank: i + 1, name: c.name, handle: c.key, gmv: c.gmv, items_sold: tracksItems ? c.items : null, videos: c.videos, report_order: c.order })),
  });
}

export type MonthCreator = {
  rank: number; name: string; handle: string;
  gmv: number | null; gmv_source: 'monthly' | 'weekly';
  items_sold: number | null; items_source: 'monthly' | 'weekly';
  weeks_listed: number; report_order: number | null;
};
export type MonthCreatorView = {
  mode: 'month'; currency: string | null;
  monthly_report: { id: string; period: string } | null;
  derived_from: 'weekly' | null;
  weeks_used: string[];
  weeks_excluded: { period: string; reason: string }[];
  note: string | null;
  partial_per_creator: boolean;
  creators: MonthCreator[];
};

// Pure core of the month path. `monthly` = the APPROVED monthly report or null;
// `weeks` = every weekly report (any status) overlapping [from, to].
export function monthCreatorView(monthly: any | null, weeks: any[], from: string, to: string, metric = 'gmv'): MonthCreatorView {
  const { inside, straddle } = splitWeeks(weeks, from, to);
  const used = inside.filter((r) => r.status === APPROVED);
  const excluded = [
    ...straddle.map((r) => ({ r, reason: r.status === APPROVED ? 'straddles the month' : `straddles the month; not approved (${r.status})` })),
    ...inside.filter((r) => r.status !== APPROVED).map((r) => ({ r, reason: `not approved (${r.status})` })),
  ].sort((a, b) => String(a.r.period_start).localeCompare(String(b.r.period_start)))
    .map(({ r, reason }) => ({ period: String(periodOf(r)), reason }));
  const weekCurs = new Set(used.map((r) => reportCurrency(r)));
  const agg = aggregateWeekly(used);
  const byKey = new Map(agg.map((a) => [a.key, a]));
  const k = metric === 'items_sold' ? 'items_sold' : 'gmv';
  const rank = (list: Omit<MonthCreator, 'rank'>[]) => list
    .sort((a, b) => ((b[k] ?? -Infinity) as number) - ((a[k] ?? -Infinity) as number) || (a.report_order ?? 999) - (b.report_order ?? 999) || a.name.localeCompare(b.name))
    .map((c, i) => ({ rank: i + 1, ...c }));

  if (monthly && sectionOn(monthly, 'topCreators')) {
    const { rows, tracksItems } = rankCreators(monthly, 'gmv');
    return {
      mode: 'month', currency: reportCurrency(monthly),
      monthly_report: { id: monthly.id, period: String(periodOf(monthly)) },
      derived_from: tracksItems ? null : 'weekly',
      weeks_used: tracksItems ? [] : used.map((r) => String(periodOf(r))),
      weeks_excluded: tracksItems ? [] : excluded,
      note: tracksItems ? null : NO_ITEMS_NOTE,
      partial_per_creator: !tracksItems,
      creators: rank(rows.map((c) => ({
        name: c.name, handle: c.key, gmv: c.gmv, gmv_source: 'monthly' as const,
        items_sold: tracksItems ? c.items : byKey.get(c.key)?.items ?? null,
        items_source: tracksItems ? 'monthly' as const : 'weekly' as const,
        weeks_listed: byKey.get(c.key)?.weeks.length ?? 0, report_order: c.order,
      }))),
    };
  }
  // No approved monthly: everything from the weeklies. GMV is only summed
  // when the weeks share one currency.
  const oneCur = weekCurs.size === 1 ? [...weekCurs][0] as string : null;
  return {
    mode: 'month', currency: oneCur ?? (weekCurs.size ? 'mixed' : null), monthly_report: null,
    derived_from: 'weekly', weeks_used: used.map((r) => String(periodOf(r))), weeks_excluded: excluded,
    note: NO_ITEMS_NOTE, partial_per_creator: true,
    creators: rank(agg.map((a) => ({
      name: a.name, handle: a.key, gmv: oneCur ? a.gmv : null, gmv_source: 'weekly' as const,
      items_sold: a.items, items_source: 'weekly' as const, weeks_listed: a.weeks.length, report_order: null,
    }))),
  };
}

async function monthCreators(admin: Db, brand: any, period: Period, metric: string, topN: number, src: ToolSource): Promise<Out> {
  const [m, w] = await Promise.all([
    admin.from('reports').select(REPORT_COLS).eq('brand_id', brand.id).eq('type', 'monthly')
      .gte('period_start', period.from).lte('period_start', period.to).order('period_start', { ascending: false }).limit(5),
    admin.from('reports').select(REPORT_COLS).eq('brand_id', brand.id).eq('type', 'weekly')
      .lte('period_start', period.to).gte('period_end', period.from).order('period_start', { ascending: true }).limit(20),
  ]);
  if (m.error) throw m.error;
  if (w.error) throw w.error;
  const monthly = (m.data || []).find((r: any) => r.status === APPROVED) ?? null;
  const monthlyPending = monthly ? [] : (m.data || []).filter((r: any) => r.status !== APPROVED);
  const v = monthCreatorView(monthly, w.data || [], period.from!, period.to!, metric);
  const usedIds = (w.data || []).filter((r: any) => r.status === APPROVED && v.weeks_used.includes(String(periodOf(r)))).map((r: any) => r.id);
  Object.assign(src, {
    ids: [...(monthly ? [monthly.id] : []), ...usedIds], period: period.label, currency: v.currency,
    pending: pendingSource(monthlyPending), extra: { derived_from: v.derived_from },
  });
  const cur = v.currency && v.currency !== 'mixed' ? v.currency : null;
  const periodStatus: PeriodStatus = monthly ? 'approved' : monthlyPending.length ? 'pending' : 'missing';
  const data = { ...v, period_status: periodStatus };
  // Never blur "not in yet" with "in but not approved" (Buddy's smoke).
  const monthlyState = monthlyPending.length
    ? monthlyPending.map((r: any) => `the ${periodOf(r)} monthly report exists but is ${r.status}, ${awaiting(r.status)} (figures withheld)`).join('; ')
    : `no monthly report has been submitted for ${period.label} yet (not in yet)`;
  const weeksTxt = v.weeks_used.length ? v.weeks_used.join('; ') : 'none';
  const excl = v.weeks_excluded.length ? `Excluded weeks: ${v.weeks_excluded.map((x) => `${x.period} (${x.reason})`).join('; ')}.` : '';
  const partial = 'Per creator the weekly figures are partial: a creator only counts in the weeks they made that week\'s top list.';
  const by = metric === 'items_sold' ? 'items sold' : 'GMV';
  const lines: string[] = [];
  if (monthly) {
    lines.push(`Top creators — ${brand.brand_name}, ${periodOf(monthly)} (approved monthly report), ranked by ${by}; money in ${v.currency}.`);
    if (!sectionOn(monthly, 'topCreators')) lines.push('The top-creators section is switched off in this monthly report.');
  } else {
    if (!v.weeks_used.length) {
      lines.push(`${brand.brand_name}, ${period.label}: ${monthlyState}, and no approved weekly report lies fully inside the month.`);
      if (excl) lines.push(excl);
      return { text: lines.join('\n') + pendingBlock(monthlyPending), source: src, data };
    }
    lines.push(`Top creators — ${brand.brand_name}, ${period.label}: ${monthlyState}, so this is DERIVED from the approved weekly reports fully inside the month (${weeksTxt}), ranked by ${by}${cur ? `; money in ${cur}` : ''}.`);
  }
  if (!v.creators.length) lines.push('No creators listed.');
  v.creators.slice(0, topN).forEach((c) => {
    const gmv = c.gmv != null && cur ? fmtMoney(c.gmv, cur) : 'n/a';
    const items = c.items_sold != null ? fmtNum(c.items_sold) : 'n/a';
    lines.push(c.gmv_source === 'monthly'
      ? `${c.rank}. ${c.name} — GMV ${gmv} (monthly report, row ${c.report_order}), items sold ${items}${c.items_source === 'weekly' ? (c.weeks_listed ? ` (derived: ${c.weeks_listed} of ${v.weeks_used.length} weekly lists)` : ' (not in any weekly top list)') : ''}`
      : `${c.rank}. ${c.name} — GMV ${gmv}, items sold ${items} (derived: sums over the ${c.weeks_listed} of ${v.weeks_used.length} weekly lists they appear in)`);
  });
  if (v.derived_from) {
    lines.push(`${monthly ? 'Items sold are' : 'All figures are'} derived from the approved weekly reports fully inside ${period.label}: ${weeksTxt}. Reason: ${NO_ITEMS_NOTE}.`);
    lines.push(partial);
    if (excl) lines.push(excl);
  }
  return { text: lines.join('\n') + pendingBlock(monthlyPending), source: src, data };
}

// ------------------------------------------------------------------ compare_periods
export async function comparePeriods(admin: Db, ctx: ToolCtx, args: any): Promise<Out> {
  const src: ToolSource = { table: 'reports', status: APPROVED };
  const metric = String(args?.metric || '');
  if (!REPORT_METRICS[metric]) return { text: `Unknown metric "${metric}". Use one of: ${METRIC_NAMES.join(', ')}.`, source: src };
  if (!args?.brand) return { text: 'Name the brand.', source: src };
  const scope = await brandScope(admin, ctx, String(args.brand));
  const bad = oneBrand(scope, String(args.brand));
  if (bad) return { text: bad, source: src };
  const brand = scope.brands[0];
  const pa = resolvePeriod(args?.period_a);
  if (!pa) return { text: 'Give period_a (e.g. "last week", "August", "2026-08").', source: src };
  const pb = args?.period_b && !/^(prev|previous|prior|before)/i.test(String(args.period_b)) ? resolvePeriod(args.period_b) : null;
  const type = typeFor(args, pa) ?? pb?.type;
  const label = REPORT_METRICS[metric].label;
  src.brand = brand.brand_name;

  const pick = async (p: Period) => {
    let q = admin.from('reports').select(REPORT_COLS).eq('status', APPROVED).eq('brand_id', brand.id).order('period_start', { ascending: false });
    if (type) q = q.eq('type', type);
    const { data, error } = await applyPeriod(q, p).limit(6);
    if (error) throw error;
    return data || [];
  };
  const none = async (p: Period) => {
    const fb = await pickApproved(admin, { brandIds: [brand.id], type, period: p, limit: 1 });
    const pend = selectPending(fb.rows, await fetchPending(admin, { brandIds: [brand.id], type, period: p }), true);
    src.pending = pendingSource(pend);
    return { text: `${label} for ${brand.brand_name}: ${fb.note} Nothing compared.` + pendingBlock(pend), source: src,
      data: { period_status: fb.periodStatus, period: p.label, which: p === pa ? 'period_a' : 'period_b' } };
  };
  const many = (p: Period, rows: any[]) => ({ text: `${rows.length} approved ${type ?? ''} reports for ${brand.brand_name} fall in ${p.label}: ${rows.map(periodOf).join('; ')}. Name one period (or set type).`, source: src });

  const aRows = await pick(pa);
  if (!aRows.length) return none(pa);
  if (aRows.length > 1) return many(pa, aRows);
  const a = aRows[0];
  let b: any;
  if (pb) {
    const bRows = await pick(pb);
    if (!bRows.length) return none(pb);
    if (bRows.length > 1) return many(pb, bRows);
    b = bRows[0];
  } else {
    // Baseline = the previous approved report BY PERIOD (findPreviousReport).
    let q = admin.from('reports').select(REPORT_COLS).eq('status', APPROVED).eq('brand_id', brand.id).eq('type', a.type).lt('period_start', a.period_start).order('period_start', { ascending: false });
    const { data, error } = await q.limit(12);
    if (error) throw error;
    b = findPreviousByPeriod(data || [], a);
    if (!b) return { text: `${label} for ${brand.brand_name}: ${periodOf(a)} has no earlier approved ${a.type} report to compare with.`, source: { ...src, ids: [a.id] } };
  }
  if (a.type !== b.type) return { text: `${periodOf(a)} is a ${a.type} report and ${periodOf(b)} is ${b.type}; compare like with like (set type).`, source: { ...src, ids: [a.id, b.id] } };

  const lo = periodKey(a) < periodKey(b) ? a : b, hi = lo === a ? b : a;
  const pend = selectPending([hi], await fetchPending(admin, { brandIds: [brand.id], type: a.type, since: String(lo.period_start) }), true)
    .filter((p) => String(p.period_start) > String(lo.period_start));
  Object.assign(src, { ids: [a.id, b.id], period: `${periodOf(a)} vs ${periodOf(b)}`, pending: pendingSource(pend) });
  const va = metricValue(a, metric), vb = metricValue(b, metric);
  const line = (r: any, v: MetricValue, tag: string) =>
    `- ${periodOf(r)}${tag}: ${v.value != null ? fmtMetric(metric, v.value, v.currency) : `not available (${v.note})`}${v.value != null && v.note ? ` (${v.note})` : ''}`;
  const out = [`${label} — ${brand.brand_name}, ${a.type} reports (approved only):`, line(a, va, ''), line(b, vb, ' (baseline)')];
  if (va.value == null || vb.value == null) out.push('No change computed: a value is missing.');
  else if (va.currency !== vb.currency) {
    out.push(`No change computed: the reports are in different currencies (${va.currency} vs ${vb.currency}).`);
    src.currency = 'mixed';
  } else {
    src.currency = va.currency;
    const diff = va.value - vb.value;
    const pct = vb.value !== 0 ? `${fmtSigned((diff / Math.abs(vb.value)) * 100, (n) => n.toFixed(2))}%` : 'n/a (baseline is 0)';
    out.push(`Change: ${fmtSigned(diff, (n) => fmtMetric(metric, n, va.currency))} (${pct}).`);
  }
  return { text: out.join('\n') + pendingBlock(pend), source: src, data: { period_status: 'approved' } };
}

// ------------------------------------------------------------------ rank_brands
// Ranks brands on one metric from ONE approved report each: the latest of the
// type inside the period. Coverage is over ACTIVE brands the caller can see.
// Money metrics are ranked within one currency (the most common); brands in
// another currency are listed apart, never mixed into the order.
export async function rankBrands(admin: Db, ctx: ToolCtx, args: any): Promise<Out> {
  const src: ToolSource = { table: 'reports', status: APPROVED };
  const metric = String(args?.metric || '');
  const spec = REPORT_METRICS[metric];
  if (!spec) return { text: `Unknown metric "${metric}". Use one of: ${METRIC_NAMES.join(', ')}.`, source: src };
  const period = resolvePeriod(args?.period);
  if (!period) return { text: 'Give a period (e.g. "August", "last week", "2026-08").', source: src };
  const type = typeFor(args, period) ?? 'monthly';
  const topN = Math.min(Math.max(Number(args?.top_n) || 10, 1), 50);
  const asc = String(args?.order || 'desc').toLowerCase() === 'asc';
  src.period = period.label;

  const visible = await viewableBrandIds(admin, ctx);
  const { data: brands, error: be } = await admin.from('brands').select('id, brand_name, status, currency').order('brand_name').limit(500);
  if (be) throw be;
  const inScope = (brands || []).filter((b: any) => !visible || visible.has(b.id));
  const active = inScope.filter((b: any) => String(b.status || '').toLowerCase() === 'active');
  const ids = inScope.map((b: any) => b.id);
  if (!ids.length) return { text: 'No brands visible to you.', source: src };

  let q = admin.from('reports').select(REPORT_COLS).eq('status', APPROVED).eq('type', type).in('brand_id', ids).order('period_start', { ascending: false });
  const { data: reps, error } = await applyPeriod(q, period).limit(1000);
  if (error) throw error;
  const latest = new Map<string, any>();
  for (const r of reps || []) if (!latest.has(r.brand_id)) latest.set(r.brand_id, r);
  const reported = [...latest.values()];
  const activeIds = new Set(active.map((b: any) => b.id));
  const covered = reported.filter((r) => activeIds.has(r.brand_id)).length;

  const { ranked, apart, missing, totals } = rankCore(reported, metric, asc);

  const pendAll = await fetchPending(admin, { brandIds: ids, type, period });
  const pend = pendAll.filter((p) => !latest.has(p.brand_id)).slice(0, PENDING_CAP);
  const approvedCount = (reps || []).length;
  src.ids = reported.map((r) => r.id).slice(0, 50);
  src.pending = pendingSource(pend);
  src.currency = spec.kind === 'money' ? (apart.length ? 'mixed' : ranked[0]?.v.currency ?? null) : null;
  src.extra = { covered, active: active.length, reported: reported.length, approved_reports: approvedCount, unapproved_reports: pendAll.length };

  const typeLabel = `${type} report`;
  const byStatus = [...pendAll.reduce((m, p) => m.set(p.status, (m.get(p.status) || 0) + 1), new Map<string, number>())].map(([s, n]) => `${n} ${s}`).join(', ');
  const lines = [
    `${spec.label} ranking — approved ${typeLabel}s for ${period.label}${period.kind === 'label' ? '' : ' (PKT)'}; ${asc ? 'lowest' : 'highest'} first${spec.kind === 'money' && ranked.length ? `, in ${ranked[0].v.currency}` : ''}.`,
    `Coverage: ${covered} of ${active.length} active brands have an approved ${typeLabel} for ${period.label}` +
      (reported.length > covered ? ` (+${reported.length - covered} inactive brand${reported.length - covered > 1 ? 's' : ''})` : '') +
      `; ${approvedCount} of ${approvedCount + pendAll.length} ${typeLabel}s in the period are approved${pendAll.length ? ` (not yet: ${byStatus})` : ''}.`,
  ];
  if (metric.startsWith('gmv_max_')) lines.push('GMV Max figures come from each report\'s GMV Max table: the Overall row when present, else the sum of campaign rows; ROI = total GMV ÷ total spend, never an average of campaign ROIs.');
  if (!ranked.length) lines.push(`No brand has a readable ${spec.label} for this period.`);
  ranked.slice(0, topN).forEach((x, i) => lines.push(`${i + 1}. ${brandName(x.r)} — ${fmtMetric(metric, x.v.value!, x.v.currency)} (${periodOf(x.r)})`));
  if (ranked.length > topN) lines.push(`(${ranked.length - topN} more ranked brands not shown; raise top_n to see them.)`);
  if (apart.length) lines.push(`Not ranked (different currency): ${apart.map((x) => `${brandName(x.r)} ${fmtMetric(metric, x.v.value!, x.v.currency)}`).join('; ')}.`);
  if (totals.length) lines.push(`Total: ${totals.map((t) => `${fmtMoney(t.sum, t.currency)} across ${t.reports} report${t.reports > 1 ? 's' : ''}`).join('; ')}${totals.length > 1 ? ' (currencies kept separate)' : ''}.`);
  if (missing.length) lines.push(`No readable ${spec.label}: ${missing.map((x) => `${brandName(x.r)} (${x.v.note})`).join('; ')}.`);
  return { text: lines.join('\n') + pendingBlock(pend), source: src, data: { ranked: ranked.map((x) => ({ brand: brandName(x.r), value: x.v.value, currency: x.v.currency, report_id: x.r.id })), totals, covered, active: active.length } };
}

// Pure ranking over one report per brand. Money is ranked within the most
// common currency (USD on a tie); totals are per currency, never mixed.
export function rankCore(reports: any[], metric: string, asc = false) {
  const spec = REPORT_METRICS[metric];
  const vals = reports.map((r) => ({ r, v: metricValue(r, metric) }));
  const got = vals.filter((x) => x.v.value != null);
  const missing = vals.filter((x) => x.v.value == null);
  let ranked = got, apart: typeof got = [];
  const totals: { currency: string; sum: number; reports: number }[] = [];
  if (spec?.kind === 'money') {
    const by = new Map<string, { sum: number; n: number }>();
    got.forEach((x) => { const t = by.get(x.v.currency!) ?? { sum: 0, n: 0 }; t.sum += x.v.value!; t.n++; by.set(x.v.currency!, t); });
    const order = [...by.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] === 'USD' ? -1 : b[0] === 'USD' ? 1 : a[0].localeCompare(b[0])));
    order.forEach(([currency, t]) => totals.push({ currency, sum: Math.round(t.sum * 100) / 100, reports: t.n }));
    ranked = got.filter((x) => x.v.currency === order[0]?.[0]);
    apart = got.filter((x) => x.v.currency !== order[0]?.[0]);
  }
  ranked.sort((a, b) => (asc ? a.v.value! - b.v.value! : b.v.value! - a.v.value!) || brandName(a.r).localeCompare(brandName(b.r)));
  return { ranked, apart, missing, totals };
}

// ------------------------------------------------------------------ get_gmv_max
// gmv_max_reports + campaigns. Figures are stored numeric, in the row's
// currency (USD on dev).
export async function getGmvMax(admin: Db, ctx: ToolCtx, args: any): Promise<Out> {
  const src: ToolSource = { table: 'gmv_max_reports' };
  const scope = await brandScope(admin, ctx, args?.brand ? String(args.brand) : undefined);
  if (scope.error) return { text: scope.error, source: src };
  const period = args?.period ? resolvePeriod(args.period) : null;
  let q = admin.from('gmv_max_reports')
    .select('id, brand_id, brand_name, period, period_label, period_start, period_end, cost, sku_orders, cost_per_order, gross_revenue, roi, currency, notes, campaigns')
    .order('period_start', { ascending: false });
  if (scope.ids) q = q.in('brand_id', scope.ids);
  const { data, error } = await applyPeriod(q, period).limit(10);
  if (error) throw error;
  const rows = data || [];
  src.period = period?.label ?? null;
  if (!rows.length) return { text: `No GMV Max reports${args?.brand ? ` for ${scope.brands.map((b) => b.brand_name).join(', ')}` : ''}${period ? ` in ${period.label}` : ''}.`, source: src };
  src.ids = rows.map((r: any) => r.id);
  const curs = new Set(rows.map((r: any) => r.currency || 'USD'));
  src.currency = curs.size === 1 ? [...curs][0] as string : 'mixed';
  const n = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const m = (v: unknown, c: string) => (n(v) == null || !Number.isFinite(n(v)!) ? 'n/a' : fmtMoney(n(v)!, c));
  const blocks = rows.map((r: any) => {
    const c = r.currency || 'USD';
    const head = `- ${r.brand_name || 'Unknown brand'} · ${r.period_label || r.period_start} (${r.period || 'report'}, ${c}): spend ${m(r.cost, c)}, gross revenue ${m(r.gross_revenue, c)}, ROI ${n(r.roi) != null ? n(r.roi)!.toFixed(2) : 'n/a'}, SKU orders ${n(r.sku_orders) != null ? fmtNum(n(r.sku_orders)!) : 'n/a'}, cost per order ${m(r.cost_per_order, c)}`;
    const camps = (Array.isArray(r.campaigns) ? r.campaigns : []).slice(0, 8).map((k: any) =>
      `    • ${String(k.campaignName || k.campaignId || 'campaign').trim()}${k.status ? ` [${k.status}]` : ''}: spend ${m(k.cost, c)}, revenue ${m(k.grossRevenue, c)}, ROI ${n(k.roi) != null ? n(k.roi)!.toFixed(2) : 'n/a'}${n(k.targetRoi) != null ? ` (target ${n(k.targetRoi)!.toFixed(2)})` : ''}, orders ${n(k.skuOrders) != null ? fmtNum(n(k.skuOrders)!) : 'n/a'}`);
    const more = Array.isArray(r.campaigns) && r.campaigns.length > 8 ? [`    …and ${r.campaigns.length - 8} more campaigns`] : [];
    const notes = r.notes ? [`    Notes: ${clip(htmlToText(r.notes), 300)}`] : [];
    return [head, ...camps, ...more, ...notes].join('\n');
  });
  return { text: `GMV Max reports (${rows.length}):\n` + blocks.join('\n'), source: src };
}

// ------------------------------------------------------------------ brand_overview
export async function brandOverview(admin: Db, ctx: ToolCtx, args: any): Promise<Out> {
  const src: ToolSource = { table: 'brands' };
  if (!args?.brand) return { text: 'Name the brand.', source: src };
  const scope = await brandScope(admin, ctx, String(args.brand));
  const bad = oneBrand(scope, String(args.brand));
  if (bad) return { text: bad, source: src };
  const b = scope.brands[0];
  const { data: full, error } = await admin.from('brands')
    .select('id, brand_name, client_name, status, tier, owner_id, currency, gmv_max_status, paid_collab_status, last_sale_generated_date')
    .eq('id', b.id).maybeSingle();
  if (error) throw error;
  const cur = (full?.currency || 'USD').toUpperCase();
  let owner = '';
  if (full?.owner_id) {
    const { data: o } = await admin.from('profiles').select('display_name').eq('id', full.owner_id).maybeSingle();
    owner = o?.display_name || 'unknown';
  }
  const { data: mets, error: me } = await admin.from('brand_monthly_metrics')
    .select('month_key, gmv_target, gmv_achieved, samples_target, samples_achieved, roi_target, roi_achieved, gmv_max_allocated, gmv_max_used, paid_collab_allocated, paid_collab_used')
    .eq('brand_id', b.id).order('month_key', { ascending: false }).limit(3);
  if (me) throw me;
  const num = (v: unknown) => (v == null ? null : Number(v));
  const pair = (label: string, got: unknown, target: unknown, f: (n: number) => string) => {
    const g = num(got), t = num(target);
    if (g == null && t == null) return null;
    const pct = g != null && t ? ` (${((g / t) * 100).toFixed(1)}%)` : '';
    return `${label} ${g != null ? f(g) : 'n/a'} of ${t != null ? f(t) : 'no'} target${pct}`;
  };
  const money = (n: number) => fmtMoney(n, cur);
  const metLines = (mets || []).map((m: any) => '  - ' + m.month_key + ': ' + [
    pair('GMV', m.gmv_achieved, m.gmv_target, money),
    pair('samples', m.samples_achieved, m.samples_target, fmtNum),
    pair('ROI', m.roi_achieved, m.roi_target, (n) => n.toFixed(2)),
    num(m.gmv_max_allocated) != null || num(m.gmv_max_used) != null ? `GMV Max budget used ${num(m.gmv_max_used) != null ? money(num(m.gmv_max_used)!) : 'n/a'} of ${num(m.gmv_max_allocated) != null ? money(num(m.gmv_max_allocated)!) : 'n/a'}` : null,
    num(m.paid_collab_allocated) != null || num(m.paid_collab_used) != null ? `paid collab used ${num(m.paid_collab_used) != null ? money(num(m.paid_collab_used)!) : 'n/a'} of ${num(m.paid_collab_allocated) != null ? money(num(m.paid_collab_allocated)!) : 'n/a'}` : null,
  ].filter(Boolean).join('; '));

  const { data: latest, error: le } = await admin.from('reports').select(REPORT_COLS)
    .eq('status', APPROVED).eq('brand_id', b.id).order('period_start', { ascending: false }).limit(1);
  if (le) throw le;
  const r = latest?.[0];
  const pend = selectPending(r ? [r] : [], (await fetchPending(admin, { brandIds: [b.id], since: r ? String(r.period_start) : undefined }))
    .filter((p) => !r || String(p.period_start) > String(r.period_start)), true);
  Object.assign(src, {
    ids: [b.id, ...(r ? [r.id] : [])], brand: b.brand_name, currency: cur, pending: pendingSource(pend),
    extra: { metrics: 'brand_monthly_metrics', months: (mets || []).map((m: any) => m.month_key), report: r ? { table: 'reports', id: r.id, period: periodOf(r) } : null },
  });
  const lines = [
    `${full?.brand_name || b.brand_name}${full?.client_name ? ` (client: ${full.client_name})` : ''}`,
    `- Status: ${full?.status || 'n/a'} · tier: ${normTier(full?.tier) ?? 'not set'} · currency: ${cur}`,
    `- Owner: ${owner || 'not set'}`,
    full?.gmv_max_status || full?.paid_collab_status ? `- GMV Max: ${full?.gmv_max_status || 'n/a'} · paid collab: ${full?.paid_collab_status || 'n/a'}` : null,
    full?.last_sale_generated_date ? `- Last sale generated: ${full.last_sale_generated_date}` : null,
    metLines.length ? `- Monthly targets vs achieved (latest ${metLines.length}):\n${metLines.join('\n')}` : isBoss(ctx) ? '- Monthly targets: none recorded.' : '- Monthly targets: none I can show you.',   // bmm RLS is narrower than brands; no hint which
    r ? `- Latest approved report: ${periodOf(r)} (${r.type}, ${reportCurrency(r)}): ${metricsLineCur(r.data || {}, reportCurrency(r))}` : '- No approved report yet.',
  ].filter(Boolean);
  return { text: lines.join('\n') + pendingBlock(pend), source: src };
}

// ------------------------------------------------------------------ list_brands
// v1's list_brands; non-Boss callers see only brands they can view.
export async function listBrands(admin: Db, ctx: ToolCtx): Promise<Out> {
  const src: ToolSource = { table: 'brands' };
  const { data: all } = await admin.from('brands').select('id, brand_name, status, owner_id').order('brand_name').limit(200);
  const visible = await viewableBrandIds(admin, ctx);
  const brands = (all || []).filter((b: any) => !visible || visible.has(b.id));
  if (!brands.length) return { text: 'No brands found.', source: src };
  const ids = brands.map((b: any) => b.owner_id).filter(Boolean);
  const { data: profs } = await admin.from('profiles').select('id, display_name').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
  src.ids = brands.map((b: any) => b.id).slice(0, 50);
  return {
    text: `${visible ? 'Brands you can see' : 'Brands'} (${brands.length}):\n` + brands.map((b: any) =>
      `- ${b.brand_name} (${b.status || 'n/a'})${b.owner_id ? ` — owner: ${nameOf.get(b.owner_id) || 'unknown'}` : ''}`).join('\n'),
    source: src,
  };
}

// ------------------------------------------------------------------ get_agenda_tasks
// Same visibility as agenda_tasks RLS: Boss/OL/developer see all; others see
// tasks assigned to or created by them, or on a brand they can view.
export async function getAgendaTasks(admin: Db, ctx: ToolCtx, args: any): Promise<Out> {
  const src: ToolSource = { table: 'agenda_tasks', status: args?.status ? String(args.status) : null };
  const all = ['boss', 'ol', 'developer'].includes(String(ctx.role || '').toLowerCase());
  let q = admin.from('agenda_tasks')
    .select('id, brand_id, assignee_id, created_by, title, details, status, due_date, link, updated_at, brand:brand_id(brand_name)')
    .order('due_date', { ascending: true, nullsFirst: false }).order('updated_at', { ascending: false });
  if (args?.brand) {
    const scope = await brandScope(admin, ctx, String(args.brand));
    if (scope.error) return { text: scope.error, source: src };
    q = q.in('brand_id', scope.ids!);
  }
  let person: any = null;
  if (args?.person) {
    const { data: people } = await admin.from('profiles').select('id, display_name').ilike('display_name', `%${String(args.person).trim()}%`).is('deleted_at', null).limit(8);
    if (!people?.length) return { text: `No active employee matches "${args.person}".`, source: src };
    if (people.length > 1) return { text: `Multiple people match "${args.person}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`, source: src };
    person = people[0];
    q = q.eq('assignee_id', person.id);
  }
  if (args?.status) q = q.eq('status', String(args.status));
  const CAP = Math.min(Math.max(Number(args?.limit) || 30, 1), 100);
  const { data, error } = await q.limit(all || rlsDecides(ctx) ? CAP + 1 : 500);
  if (error) throw error;
  let rows = data || [];
  if (!all && !rlsDecides(ctx)) {   // with the caller's JWT, agenda_tasks_select already did this
    const visible = await viewableBrandIds(admin, ctx);
    rows = rows.filter((t: any) => t.assignee_id === ctx.userId || t.created_by === ctx.userId || (t.brand_id && (!visible || visible.has(t.brand_id))));
  }
  const truncated = rows.length > CAP;
  rows = rows.slice(0, CAP);
  if (!rows.length) return { text: `No agenda tasks found${person ? ` for ${person.display_name}` : ''}${args?.status ? ` (${args.status})` : ''}.`, source: src };
  const ids = [...new Set(rows.map((t: any) => t.assignee_id).filter(Boolean))];
  const { data: profs } = ids.length ? await admin.from('profiles').select('id, display_name').in('id', ids) : { data: [] };
  const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
  src.ids = rows.map((t: any) => t.id);
  const lines = rows.map((t: any) => {
    const det = t.details ? clip(htmlToText(t.details), 200) : '';
    return `- [${t.status || '?'}] ${String(t.title || '(untitled)').trim()}${t.brand?.brand_name ? ` — ${t.brand.brand_name}` : ''}${t.assignee_id ? ` · ${nameOf.get(t.assignee_id) || 'unknown'}` : ''}${t.due_date ? ` · due ${t.due_date}` : ''}${det ? ` — ${det}` : ''}${t.link ? ` (${t.link})` : ''}`;
  });
  return {
    text: `Agenda tasks (${rows.length}):\n` + lines.join('\n') +
      (truncated ? `\n\n(Showing the first ${CAP}; narrow by brand, person or status for the rest.)` : ''),
    source: src,
  };
}
