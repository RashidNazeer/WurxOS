// Report extractor (S5, A§5.2, phases §2.2). Layouts seen in real data
// (inventory §2):
//   monthly  type='monthly'                          keyMetrics / kpis / keyWinsInsights / …
//   single   weekly with data.insightsSingle===true  one narrative in reportInsights
//   legacy   other weekly + all biweekly             six per-section *Insights fields
//   generic  anything unrecognised                   every non-empty string, flattened
//
// Figures are copied as written: they are retrieval context, never answers
// (numbers come from SQL tools). Reviewer-internal fields (rejectionNote,
// submittedBy*, …) and data.highlights (a <mark>-ed duplicate of other
// fields) are never indexed. The author's name goes in metadata only.

import { cleanValue, htmlToText, humanize } from '../text.ts';
import type { DocSection, ExtractedDoc, Extractor } from '../types.ts';

export type ReportRow = {
  id: string;
  type: string;
  brand_id: string | null;
  author_id: string | null;
  status: string;
  period_label?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  data: Record<string, unknown> | null;
  sections_enabled?: Record<string, unknown> | null;
  updated_at?: string | null;
  legacy_id?: string | null;
};

export type ReportCtx = {
  brand?: { brand_name?: string | null; client_name?: string | null; currency?: string | null } | null;
};

export type ReportLayout = 'single' | 'legacy' | 'monthly' | 'generic';

// Owner decision 2026-09-28 (overrides D2): only APPROVED reports are indexed.
// Mirrored in SQL by ai_ingest_source (mig 376) and the reports trigger (mig 374).
const INDEXABLE_STATUS = 'approved';
const TYPE_LABEL: Record<string, string> = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly' };

// Never indexed: reviewer workflow, audit trail, row bookkeeping, duplicates.
const EXCLUDED_PREFIX = /^(rejection|rejected|submitted|verified|approved|reopened|created|lastEdited|updated|author)/i;
const EXCLUDED_KEYS = new Set([
  'highlights', 'currency', 'insightsSingle', 'sectionsEnabled', 'id', 'status', 'type',
  'brandId', 'brandName', 'week', 'weekStart', 'weekEnd', 'weekLabel', 'period', 'periodStart',
  'periodEnd', 'periodLabel', 'monthKey', 'year', 'month', 'legacyId', 'sampleGoals',
]);
const isExcluded = (k: string) => EXCLUDED_KEYS.has(k) || EXCLUDED_PREFIX.test(k);

const WEEKLY_KEYS = new Set([
  'overallPerformance', 'overallNotes', 'overallInsights', 'topCreators', 'topCreatorsInsights',
  'topVideos', 'topVideosInsights', 'gmvMax', 'gmvMaxMtd', 'gmvMaxInsights', 'productHighlights',
  'productHighlightsInsights', 'offsitePerformance', 'offsiteInsights', 'upcomingCampaigns',
  'operationalUpdates', 'recommendations', 'actionItems', 'reportInsights', 'customFields',
]);
const MONTHLY_KEYS = new Set([
  'totalSales', 'keyMetrics', 'kpis', 'gmvBreakdown', 'topCreators', 'topVideos', 'videoPerformance',
  'creatorsPerformance', 'productAnalytics', 'gmvMax', 'customers', 'keyWinsInsights', 'campaignsText',
  'recommendations', 'actionItems', 'customFields',
]);

// ---------------------------------------------------------------- labels
type Labels = Record<string, string>;

const PERF: Labels = {
  gmv: 'GMV', affiliateGmv: 'Affiliate GMV', orders: 'Orders', samplesApproved: 'Samples approved',
  roi: 'ROI', shopPerformanceScore: 'Shop performance score (out of 5)', videosPosted: 'Videos posted',
};
const NOTES: Labels = {
  gmv: 'GMV (MTD)', samplesApproved: 'Samples approved (MTD)', videosMtd: 'Videos posted (MTD)',
  videosPosted: 'Videos posted (all-time total)',
};
const OFFSITE: Labels = { offsiteGmv: 'Offsite GMV', tiktokShopGmv: 'TikTok Shop GMV', offsiteEffect: 'Offsite effect (%)' };
const TOTAL_SALES: Labels = { monthGmv: 'GMV this month', allTimeGmv: 'All-time GMV' };
const KEY_METRICS: Labels = { gmv: 'GMV', orders: 'Orders', customers: 'Customers', itemsSold: 'Items sold' };
const KPIS: Labels = {
  completedCollabs: 'Completed collabs', contentPending: 'Content pending', totalOrders: 'Total orders',
  freeSamplesApproved: 'Free samples approved',
};
const GMV_BREAKDOWN: Labels = {
  affiliateGmv: 'Affiliate GMV', organicGmv: 'Organic GMV', liveGmv: 'LIVE GMV', videoGmv: 'Video GMV',
  productCardGmv: 'Product card GMV',
};
const VIDEO_PERF: Labels = {
  productImpressions: 'Product impressions', productClicks: 'Product clicks', videoViews: 'Video views',
  ctr: 'CTR', ctor: 'CTOR', skuOrders: 'SKU orders', gmv: 'Video GMV', newVideosPosted: 'New videos posted',
  videos1MViews: 'Videos with 1M+ views', videos100kViews: 'Videos with 100k+ views',
  videos10kViews: 'Videos with 10k+ views', videos1000Gmv: 'Videos with 1k+ GMV', videos100Gmv: 'Videos with 100+ GMV',
};
const CREATORS_PERF: Labels = {
  creators1Plus: 'Creators with 1+ videos', creators3Plus: 'Creators with 3+ videos',
  creators10Plus: 'Creators with 10+ videos', creators1kGmv: 'Creators with 1k+ GMV',
  creators100Gmv: 'Creators with 100+ GMV',
};
const CUSTOMERS: Labels = {
  awareCustomers: 'Aware customers', newCustomers: 'New customers', potentialNewCustomers: 'Potential new customers',
  crmMessagesSent: 'CRM messages sent', convertedCustomers: 'Converted customers',
};
const CREATOR_COLS: Labels = { name: 'Creator', username: 'Creator', videosPosted: 'Videos posted', itemsSold: 'Items sold', gmv: 'GMV', notes: 'Notes' };
const VIDEO_COLS: Labels = { creatorName: 'Creator', videoLink: 'Video', gmv: 'GMV', views: 'Views', productClicks: 'Product clicks', itemsSold: 'Items sold', notes: 'Notes' };
const GMVMAX_COLS: Labels = { campaign: 'Campaign', spend: 'Spend', roi: 'ROI', orders: 'Orders', cpo: 'CPO', gmv: 'GMV', notes: 'Notes' };
const PRODUCT_COLS: Labels = {
  productName: 'Product', productId: 'Product ID', unitsSold: 'Units sold', gmv: 'GMV',
  newVideos: 'New videos this week', samplesApprovedWeek: 'Samples approved this week',
  samplesApprovedMtd: 'Samples approved (MTD)', samplesApproved: 'Samples approved', videosMtd: 'Videos (MTD)',
  notes: 'Notes',
};

// ---------------------------------------------------------------- rendering
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

// Known keys first (in label order), then any others, so output is stable.
function pairs(o: Record<string, unknown>, labels: Labels, skip: string[] = []): string[] {
  const keys = [...Object.keys(labels).filter((k) => k in o), ...Object.keys(o).filter((k) => !(k in labels))];
  const out: string[] = [];
  for (const k of keys) {
    if (skip.includes(k) || isExcluded(k)) continue;
    const v = cleanValue(o[k]);
    if (v) out.push(`${labels[k] ?? humanize(k)}: ${v}`);
  }
  return out;
}
const metricsLine = (o: unknown, labels: Labels, skip?: string[]) => pairs(obj(o), labels, skip).join('; ');

function tableText(rows: unknown, cols: Labels): string {
  if (!Array.isArray(rows)) return '';
  return rows.map((r) => pairs(obj(r), cols)).filter((p) => p.length).map((p) => `- ${p.join(', ')}`).join('\n');
}

const prose = (v: unknown) => (typeof v === 'string' ? htmlToText(v) : '');
const nonEmptyProse = (t: string) => (cleanValue(t) ? t : '');

// ---------------------------------------------------------------- layout
export function detectLayout(row: ReportRow): ReportLayout {
  const d = obj(row.data);
  if (row.type === 'monthly') {
    return ['keyMetrics', 'kpis', 'totalSales', 'keyWinsInsights', 'gmvBreakdown'].some((k) => k in d) ? 'monthly' : 'generic';
  }
  if (row.type === 'weekly' || row.type === 'biweekly') {
    if (d.insightsSingle === true) return 'single';
    return ['overallPerformance', 'overallInsights', 'topCreators', 'recommendations'].some((k) => k in d) ? 'legacy' : 'generic';
  }
  return 'generic';
}

// Flattens everything that isn't excluded into "Path › to › key: value" lines.
function flatten(v: unknown, path: string[], out: string[]) {
  if (v == null || typeof v === 'boolean') return;
  if (typeof v === 'string' || typeof v === 'number') {
    const t = typeof v === 'string' ? htmlToText(v) : String(v);
    if (cleanValue(t)) out.push(`${path.join(' › ')}: ${t}`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      const o = obj(item);
      const flat = Object.values(o).every((x) => x == null || typeof x !== 'object');
      if (Object.keys(o).length && flat) {
        const p = pairs(o, {});
        if (p.length) out.push(`${[...path, String(i + 1)].join(' › ')}: ${p.join(', ')}`);
      } else {
        flatten(item, [...path, String(i + 1)], out);
      }
    });
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!isExcluded(k)) flatten(x, [...path, humanize(k)], out);
  }
}

function customSections(d: Record<string, unknown>, on: (k: string) => boolean): DocSection[] {
  const out: DocSection[] = [];
  const short: string[] = [];
  for (const [id, raw] of Object.entries(obj(d.customFields))) {
    const f = obj(raw);
    const gate = [id, f.sectionId, f.sectionKey].filter((x): x is string => typeof x === 'string');
    if (!gate.every(on)) continue;
    const name = cleanValue(f.name) || cleanValue(f.sectionName) || humanize(id);
    if (Array.isArray(f.rows)) {
      const cols: Labels = {};
      for (const c of Array.isArray(f.columns) ? f.columns : []) {
        const co = obj(c);
        if (typeof co.id === 'string') cols[co.id] = cleanValue(co.label) || humanize(co.id);
      }
      // Only declared columns: row objects may carry stale ids of deleted columns.
      const rows = (f.rows as unknown[]).map((r) => {
        const ro = obj(r);
        return Object.keys(cols).map((c) => [cols[c], cleanValue(ro[c])]).filter(([, v]) => v).map(([l, v]) => `${l}: ${v}`);
      }).filter((p) => p.length).map((p) => `- ${p.join(', ')}`).join('\n');
      if (rows) out.push({ key: `custom:${id}`, title: name, kind: 'table', text: rows });
      continue;
    }
    const text = prose(f.value);
    if (!nonEmptyProse(text)) continue;
    if (f.kind === 'long_text' || text.length > 200 || text.includes('\n')) {
      out.push({ key: `custom:${id}`, title: name, kind: 'prose', text });
    } else {
      const where = cleanValue(f.sectionTitle);
      short.push(`- ${where ? `${where} › ` : ''}${name}: ${cleanValue(text)}`);
    }
  }
  if (short.length) out.unshift({ key: 'custom', title: 'Custom fields', kind: 'table', text: short.join('\n') });
  return out;
}

function otherSection(d: Record<string, unknown>, known: Set<string>): DocSection[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(d)) if (!known.has(k) && !isExcluded(k)) flatten(v, [humanize(k)], lines);
  return lines.length ? [{ key: 'other', title: 'Other report fields', kind: 'prose', text: lines.join('\n') }] : [];
}

function weeklySections(row: ReportRow, d: Record<string, unknown>, layout: 'single' | 'legacy', on: (k: string) => boolean): DocSection[] {
  const s: DocSection[] = [];
  const add = (key: string, title: string, kind: DocSection['kind'], text: string) => { if (text.trim()) s.push({ key, title, kind, text }); };
  const when = row.type === 'biweekly' ? 'this period' : 'this week';

  if (on('overallPerformance')) {
    const perf = metricsLine(d.overallPerformance, PERF);
    const mtd = metricsLine(d.overallNotes, NOTES);
    add('summary', 'Overall performance', 'metrics',
      [perf && `Performance ${when}: ${perf}.`, mtd && `Month to date: ${mtd}.`].filter(Boolean).join(' '));
  }
  if (layout === 'single') {
    add('insights:all', 'Insights', 'prose', nonEmptyProse(prose(d.reportInsights)));
  } else {
    const areas: [string, string, string, string][] = [
      ['overallInsights', 'overallPerformance', 'insights:overall', 'Overall performance insights'],
      ['topCreatorsInsights', 'topCreators', 'insights:creators', 'Top creators insights'],
      ['topVideosInsights', 'topVideos', 'insights:videos', 'Top videos insights'],
      ['gmvMaxInsights', 'gmvMax', 'insights:gmvmax', 'GMV Max insights'],
      ['productHighlightsInsights', 'productHighlights', 'insights:products', 'Product highlights insights'],
    ];
    for (const [field, gate, key, title] of areas) if (on(gate)) add(key, title, 'prose', nonEmptyProse(prose(d[field])));
  }
  if (on('recommendations')) add('written:recommendations', 'Recommendations & action items', 'prose', recommendations(d));
  if (on('upcomingCampaigns')) add('written:campaigns', 'Current & upcoming campaigns', 'prose', nonEmptyProse(prose(d.upcomingCampaigns)));
  if (on('operationalUpdates')) add('written:operational', 'Operational updates', 'prose', nonEmptyProse(prose(d.operationalUpdates)));
  if (on('offsitePerformance')) {
    const o = obj(d.offsitePerformance);
    const nums = metricsLine(o, OFFSITE, ['dataFrom', 'dataTo']);
    const from = cleanValue(o.dataFrom), to = cleanValue(o.dataTo);
    const window = from || to ? ` (figures for ${from || '?'} → ${to || '?'}, not this ${row.type === 'biweekly' ? 'period' : 'week'})` : '';
    const insights = layout === 'legacy' ? nonEmptyProse(prose(d.offsiteInsights)) : '';
    add('offsite', 'Offsite performance', 'prose', [nums && `${nums}${window}.`, insights].filter(Boolean).join('\n\n'));
  }
  if (on('topCreators')) add('table:creators', 'Top creators', 'table', tableText(d.topCreators, CREATOR_COLS));
  if (on('topVideos')) add('table:videos', 'Top videos', 'table', tableText(d.topVideos, VIDEO_COLS));
  if (on('gmvMax')) {
    add('table:gmvmax', `GMV Max campaigns (${when})`, 'table', tableText(d.gmvMax, GMVMAX_COLS));
    add('table:gmvmax_mtd', 'GMV Max campaigns (month to date)', 'table', tableText(d.gmvMaxMtd, GMVMAX_COLS));
  }
  if (on('productHighlights')) add('table:products', 'Product highlights', 'table', tableText(d.productHighlights, PRODUCT_COLS));
  return s;
}

function monthlySections(d: Record<string, unknown>, on: (k: string) => boolean): DocSection[] {
  const s: DocSection[] = [];
  const add = (key: string, title: string, kind: DocSection['kind'], text: string) => { if (text.trim()) s.push({ key, title, kind, text }); };
  const part = (gate: string, label: string, v: unknown, labels: Labels) => {
    if (!on(gate)) return '';
    const m = metricsLine(v, labels);
    return m ? `${label}: ${m}.` : '';
  };
  add('summary', 'Monthly summary', 'metrics', [
    part('totalSales', 'Total sales', d.totalSales, TOTAL_SALES),
    part('keyMetrics', 'Key metrics', d.keyMetrics, KEY_METRICS),
    part('kpis', 'KPIs', d.kpis, KPIS),
  ].filter(Boolean).join(' '));
  if (on('keyWinsInsights')) add('insights:keywins', 'Key wins & insights', 'prose', nonEmptyProse(prose(d.keyWinsInsights)));
  if (on('recommendations')) add('written:recommendations', 'Recommendations & action items', 'prose', recommendations(d));
  if (on('campaignsText')) add('written:campaigns', 'Campaigns', 'prose', nonEmptyProse(prose(d.campaignsText)));
  add('monthly:breakdown', 'Monthly breakdown', 'metrics', [
    part('gmvBreakdown', 'GMV breakdown', d.gmvBreakdown, GMV_BREAKDOWN),
    part('videoPerformance', 'Video performance', d.videoPerformance, VIDEO_PERF),
    part('creatorsPerformance', "Creators' performance", d.creatorsPerformance, CREATORS_PERF),
    part('customers', 'Customers', d.customers, CUSTOMERS),
  ].filter(Boolean).join('\n'));
  if (on('topCreators')) add('table:creators', 'Top creators', 'table', tableText(d.topCreators, CREATOR_COLS));
  if (on('topVideos')) add('table:videos', 'Top videos', 'table', tableText(d.topVideos, VIDEO_COLS));
  if (on('productAnalytics')) add('table:products', 'Product analytics', 'table', tableText(d.productAnalytics, PRODUCT_COLS));
  if (on('gmvMax')) add('table:gmvmax', 'GMV Max campaigns', 'table', tableText(d.gmvMax, GMVMAX_COLS));
  return s;
}

// actionItems is effectively unused (2 rows) and shares the section in the UI.
function recommendations(d: Record<string, unknown>): string {
  const rec = nonEmptyProse(prose(d.recommendations));
  const act = nonEmptyProse(prose(d.actionItems));
  return [rec, act && `Action items:\n${act}`].filter(Boolean).join('\n\n');
}

// App rule (reportsApi _normReport): brand currency, then the report's own
// snapshot, then USD. 23 GBP-brand reports on dev carry no data.currency.
export function resolveCurrency(row: ReportRow, ctx?: ReportCtx): { currency: string; source: 'brand' | 'report' | 'default' } {
  const b = cleanValue(ctx?.brand?.currency);
  if (b) return { currency: b.toUpperCase(), source: 'brand' };
  const r = cleanValue(obj(row.data).currency);
  if (r) return { currency: r.toUpperCase(), source: 'report' };
  return { currency: 'USD', source: 'default' };
}

// No status: submitted → verified → approved must not touch a single chunk
// (QA F1). The status lives in metadata, which ai_search returns.
export function reportHeader(row: ReportRow, ctx: ReportCtx | undefined, currency: string): string {
  const d = obj(row.data);
  const brand = cleanValue(ctx?.brand?.brand_name) || cleanValue(d.brandName) || 'Unknown brand';
  const client = cleanValue(ctx?.brand?.client_name);
  const type = TYPE_LABEL[row.type] ?? humanize(row.type || 'report');
  const parts = [
    `${type} report`,
    client ? `${brand} (client: ${client})` : brand,
    cleanValue(row.period_label),
    row.period_start || row.period_end ? `${row.period_start ?? '?'} → ${row.period_end ?? '?'}` : '',
    `currency: ${currency}`,
  ].filter(Boolean);
  return `[${parts.join(' · ')}]`;
}

export const reportExtractor: Extractor<ReportRow, ReportCtx | undefined> = {
  sourceType: 'report',

  indexable: (row) => row.status === INDEXABLE_STATUS,
  skipReason: (row) => (row.status === INDEXABLE_STATUS ? null : `status ${row.status || '(none)'}: only approved reports are indexed`),

  toDocument(row, ctx) {
    const d = obj(row.data);
    const layout = detectLayout(row);
    const { currency, source } = resolveCurrency(row, ctx);
    const enabled = obj(row.sections_enabled ?? d.sectionsEnabled);
    const on = (k: string) => enabled[k] !== false;

    let sections: DocSection[];
    if (layout === 'monthly') {
      sections = [...monthlySections(d, on), ...customSections(d, on), ...otherSection(d, MONTHLY_KEYS)];
    } else if (layout === 'single' || layout === 'legacy') {
      sections = [...weeklySections(row, d, layout, on), ...customSections(d, on), ...otherSection(d, WEEKLY_KEYS)];
    } else {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(d)) if (!isExcluded(k)) flatten(v, [humanize(k)], lines);
      sections = lines.length ? [{ key: 'generic', title: 'Report content', kind: 'prose', text: lines.join('\n') }] : [];
    }

    const brandName = cleanValue(ctx?.brand?.brand_name) || cleanValue(d.brandName) || null;
    return {
      title: [`${TYPE_LABEL[row.type] ?? humanize(row.type || 'report')} report`, brandName ?? 'Unknown brand', cleanValue(row.period_label)].filter(Boolean).join(' · '),
      brandId: row.brand_id ?? undefined,
      periodStart: row.period_start ?? undefined,
      periodEnd: row.period_end ?? undefined,
      acl: { mode: 'report', authorId: row.author_id },
      metadata: {
        report_id: row.id,
        report_type: row.type,
        brand_name: brandName,
        client_name: cleanValue(ctx?.brand?.client_name) || null,
        period_label: row.period_label ?? null,
        status: row.status,
        currency,
        currency_source: source,
        // author_id only: a name here would make a profile rename rewrite
        // every report the person wrote (QA F5). Tools resolve names live.
        author_id: row.author_id,
        layout,
        ...(row.legacy_id ? { legacy_id: row.legacy_id } : {}),
      },
      header: reportHeader(row, ctx, currency),
      sections,
      sourceUpdatedAt: row.updated_at ?? undefined,
    };
  },
};
