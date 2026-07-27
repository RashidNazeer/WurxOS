// ============================================================
// Amazon Halo Effect — canonical field dictionary.
//
// Single source of truth shared by the parser, the correlation math and the
// explorer UI. Each field has:
//   key   — stable id stored in halo_rows.metrics
//   label — display name
//   group — 'amazon' | 'tiktok'  (Boss correlates one side against the other)
//   agg   — how to roll up over a week/month: 'sum' for counts/money,
//           'avg' for ratios/rates (AOV, ROI, CPO, videos-per-day, search rank)
//   fmt   — 'money' | 'int' | 'num' for display
//   sheetHeader — the exact source-sheet column name to export under, when it
//           differs from `label` (so a downloaded sheet re-imports cleanly).
//
// PER-METRIC NATIVE GRANULARITY (2026-07 rework): a metric is no longer flagged
// `weeklyOnly` in this dictionary. Instead each DATASET carries a `metricGran`
// map (fieldKey -> 'day'|'week'|'month') detected from the uploaded data. A
// metric is comparable at its native granularity AND at coarser ones
// (day → day/week/month; week → week/month; month → month). A metric absent
// from the map has no data in that dataset and is hidden. See metricAvailableAt.
//
// Amazon side (the branded demand the halo drives):
//   * NTB (units sold) — daily count
//   * Keyword Search Volume — branded search demand. Daily in the richer
//     single-sheet format (one column per keyword); WEEKLY-native when it only
//     appears in a "Branded Demand" subsheet. The dataset's metricGran decides.
//   * Keyword Search Rank — per-keyword search-result position (1 = top). Lower
//     is better, so it rolls up as an AVERAGE and correlates INVERSELY with reach.
//   * Revenue/Day ("Total Revenue/Day" on the sheet) — carries a per-PRODUCT
//     breakdown in halo_rows.product_revenue.
// ============================================================

export const HALO_FIELDS = [
  { key: 'gmv',                 label: 'GMV',                 group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'orders',              label: 'Orders',              group: 'tiktok', agg: 'sum', fmt: 'int', hidden: true },
  { key: 'items_sold',          label: 'Items sold',          group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'aov',                 label: 'AOV',                 group: 'tiktok', agg: 'avg', fmt: 'money', hidden: true },
  { key: 'live_gmv',            label: 'LIVE GMV',            group: 'tiktok', agg: 'sum', fmt: 'money', hidden: true },
  { key: 'video_per_day',       label: 'Video/Day',           group: 'tiktok', agg: 'avg', fmt: 'num'   },
  { key: 'product_impressions', label: 'Product impressions', group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'unique_impressions',  label: 'Unique impressions',  group: 'tiktok', agg: 'sum', fmt: 'int'   },
  // ---- Amazon side ----
  { key: 'ntb',                 label: 'NTB',                 group: 'amazon', agg: 'sum', fmt: 'int'   },
  { key: 'keyword_search_volume', label: 'Branded Search Volume', group: 'amazon', agg: 'sum', fmt: 'int' },
  // "Total Revenue/Day" on the sheet (= sum of the per-product Revenue cols).
  { key: 'revenue_per_day',     label: 'Amazon Revenue', sheetHeader: 'Total Revenue/Day', group: 'amazon', agg: 'sum', fmt: 'money' },
  { key: 'keyword_search_rank', label: 'Keyword Search Rank', group: 'amazon', agg: 'avg', fmt: 'num', inverse: true },
  // ---- back to TikTok / GMV Max ----
  { key: 'product_clicks',      label: 'Product clicks',      group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'unique_clicks',       label: 'Unique clicks',       group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'cost',                label: 'Cost',                group: 'tiktok', agg: 'sum', fmt: 'money', hidden: true },
  { key: 'gmvmax_orders',       label: 'GMV Max Orders', sheetHeader: 'orders', group: 'tiktok', agg: 'sum', fmt: 'int', hidden: true },
  { key: 'cpo',                 label: 'CPO',                 group: 'tiktok', agg: 'avg', fmt: 'money', hidden: true },
  { key: 'gross_revenue',       label: 'Gross revenue',       group: 'tiktok', agg: 'sum', fmt: 'money', hidden: true },
  { key: 'roi',                 label: 'ROI',                 group: 'tiktok', agg: 'avg', fmt: 'num', hidden: true },
];

export const FIELD_BY_KEY = Object.fromEntries(HALO_FIELDS.map((f) => [f.key, f]));
export const AMAZON_FIELDS = HALO_FIELDS.filter((f) => f.group === 'amazon');
export const TIKTOK_FIELDS = HALO_FIELDS.filter((f) => f.group === 'tiktok');

// The branded-search metric key (may be daily or weekly-native per dataset).
export const KSV_KEY = 'keyword_search_volume';
// The per-keyword search-rank metric key.
export const KSR_KEY = 'keyword_search_rank';

// The daily Amazon field that carries a per-PRODUCT breakdown (Revenue (Amazon)
// columns). "All products" = the stored total (revenue_per_day); a single
// product = that product's daily revenue.
export const PRODUCT_REVENUE_FIELD = 'revenue_per_day';

// ---- per-metric native granularity ------------------------------------------
// day < week < month. A metric bucketed at its native granularity can also be
// compared at any COARSER one (a daily metric rolls up to weeks/months; a weekly
// metric can only be compared weekly or monthly).
export const GRAN_ORDER = { day: 0, week: 1, month: 2 };

// Is `key` comparable at `gran`, given the dataset's detected metricGran map?
//   * No map at all (legacy dataset / unknown) → treat as available (day-native).
//   * A key present in the map → available at its native granularity and coarser.
//   * A key ABSENT from a populated map → no data in this dataset → unavailable.
export function metricAvailableAt(key, gran, metricGran) {
  if (!metricGran || Object.keys(metricGran).length === 0) return true;
  const nat = metricGran[key];
  if (!nat) return false;
  return (GRAN_ORDER[gran] ?? 0) >= (GRAN_ORDER[nat] ?? 0);
}

// Fields selectable at a given granularity for a dataset. metricGran is the
// dataset's fieldKey→granularity map (see metricAvailableAt).
export function fieldsForGran(gran, metricGran) {
  return HALO_FIELDS.filter((f) => !f.hidden && metricAvailableAt(f.key, gran, metricGran));
}
export const AMAZON_FIELDS_FOR = (gran, metricGran) => fieldsForGran(gran, metricGran).filter((f) => f.group === 'amazon');
export const TIKTOK_FIELDS_FOR = (gran, metricGran) => fieldsForGran(gran, metricGran).filter((f) => f.group === 'tiktok');

// Native granularity of a metric ('day' when absent/unknown — the finest).
export function nativeGranOf(key, metricGran) {
  return (metricGran && metricGran[key]) || 'day';
}
// The coarsest of a set of granularities (the effective compare granularity).
export function coarsestGran(...grans) {
  let best = 'day';
  for (const g of grans) if ((GRAN_ORDER[g] ?? 0) > (GRAN_ORDER[best] ?? 0)) best = g;
  return best;
}

// ---- per-SOURCE availability (per-brand 3-sheet model) ----------------------
// A view's fields come from the ONE source chosen for that granularity (the
// matching sheet, else the finest finer sheet). A metric is offered only if that
// source carries NON-ZERO data for it (0 = "not available", per the sheet
// convention) — so e.g. NTB left blank/0 in the daily sheet is hidden in Daily
// but shows in Weekly where it was filled. This intentionally does NOT follow the
// old "native-and-coarser" monotonic rule: availability is per chosen source.
export function availSetForRows(rows) {
  const s = new Set();
  for (const r of rows || []) {
    const m = (r && r.metrics) || {};
    for (const k in m) if (m[k]) s.add(k); // truthy = non-zero, non-null
  }
  return s;
}
export function fieldsAvail(availSet) {
  // `hidden` fields are still parsed/stored/exported (format unchanged) but are
  // not offered in the explorer's dropdowns/heatmap/overlay/halo-finder.
  return HALO_FIELDS.filter((f) => !f.hidden && availSet && availSet.has(f.key));
}
export const amazonAvail = (availSet) => fieldsAvail(availSet).filter((f) => f.group === 'amazon');
export const tiktokAvail = (availSet) => fieldsAvail(availSet).filter((f) => f.group === 'tiktok');

// ---- currency ---------------------------------------------------------------
// The sheet may be in $, £ or €. parseHaloGranularitySheet detects it and stores it on the
// dataset; fmtValue reads this module-level symbol so every chart/tooltip shows
// the right currency without threading it through dozens of call sites. It is a
// pure display symbol (numbers are unaffected), reset whenever a dataset loads.
let _currency = '$';
export function setHaloCurrency(sym) { _currency = sym || '$'; }
export function getHaloCurrency() { return _currency; }

// Normalise a header cell to match against the synonym table:
// lowercase, drop everything that isn't a letter or digit.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// normalized header text -> canonical key. 'orders' is special-cased in the
// parser (first occurrence = TikTok Orders, second = GMV Max orders).
const HEADER_SYNONYMS = {
  date: 'date',
  gmv: 'gmv',
  orders: 'orders',
  itemssold: 'items_sold',
  aov: 'aov',
  livegmv: 'live_gmv',
  videoday: 'video_per_day',
  videoperday: 'video_per_day',
  videos: 'video_per_day',
  productimpressions: 'product_impressions',
  uniqueimpressions: 'unique_impressions',
  ntb: 'ntb',
  ntbunitssold: 'ntb',                   // our own export writes "NTB (units sold)"
  keywordsearchvolume: 'keyword_search_volume',
  keywordsearchrank: 'keyword_search_rank',
  keywordrank: 'keyword_search_rank',
  totalrevenueday: 'revenue_per_day',    // the sheet's "Total Revenue/Day"
  totalrevenueperday: 'revenue_per_day',
  revenueday: 'revenue_per_day',         // our own export / older sheets
  revenueperday: 'revenue_per_day',
  gmvmaxorders: 'gmvmax_orders',         // our own export writes "GMV Max Orders"
  productclicks: 'product_clicks',
  uniqueclicks: 'unique_clicks',
  cost: 'cost',
  cpo: 'cpo',
  grossrevenue: 'gross_revenue',
  roi: 'roi',
};

export function headerKey(cell) {
  return HEADER_SYNONYMS[norm(cell)] || null;
}

export { norm as normHeader };

// Format a numeric value for display given a field's fmt (money uses the
// dataset's detected currency symbol).
export function fmtValue(v, fmt) {
  if (v == null || Number.isNaN(v)) return '—';
  if (fmt === 'money') {
    return _currency + Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (fmt === 'int') return Math.round(Number(v)).toLocaleString();
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
