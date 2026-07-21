// ============================================================
// Amazon Halo Effect — canonical field dictionary.
//
// Single source of truth shared by the parser, the correlation math and the
// explorer UI. Each field has:
//   key   — stable id stored in halo_rows.metrics
//   label — display name
//   group — 'amazon' | 'tiktok'  (Boss correlates one side against the other)
//   agg   — how to roll up over a week/month: 'sum' for counts/money,
//           'avg' for ratios/rates (AOV, ROI, CPO, videos-per-day)
//   fmt   — 'money' | 'int' | 'num' for display
//   sheetHeader — the exact source-sheet column name to export under, when it
//           differs from `label` (so a downloaded sheet re-imports cleanly).
//
// 2026-07 format change: the sheet dropped NTB and Keyword Search Rank, split
// Amazon Revenue into per-PRODUCT columns plus a "Total Revenue/Day", and moved
// Keyword Search Volume to a WEEKLY subsheet (see KSV_META + haloParse's weekly
// tab). So the only DAILY Amazon field left here is revenue_per_day; keyword
// search volume is handled weekly-native, outside HALO_FIELDS.
// ============================================================

export const HALO_FIELDS = [
  { key: 'gmv',                 label: 'GMV',                 group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'orders',              label: 'Orders',              group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'items_sold',          label: 'Items sold',          group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'aov',                 label: 'AOV',                 group: 'tiktok', agg: 'avg', fmt: 'money' },
  { key: 'live_gmv',            label: 'LIVE GMV',            group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'video_per_day',       label: 'Video/Day',           group: 'tiktok', agg: 'avg', fmt: 'num'   },
  { key: 'product_impressions', label: 'Product impressions', group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'unique_impressions',  label: 'Unique impressions',  group: 'tiktok', agg: 'sum', fmt: 'int'   },
  // Amazon side (daily) — the branded revenue the halo drives. The sheet calls
  // this "Total Revenue/Day" (= sum of the per-product Revenue (Amazon) cols).
  { key: 'revenue_per_day',     label: 'Amazon Revenue', sheetHeader: 'Total Revenue/Day', group: 'amazon', agg: 'sum', fmt: 'money' },
  { key: 'product_clicks',      label: 'Product clicks',      group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'unique_clicks',       label: 'Unique clicks',       group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'cost',                label: 'Cost',                group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'gmvmax_orders',       label: 'GMV Max Orders', sheetHeader: 'orders', group: 'tiktok', agg: 'sum', fmt: 'int' },
  { key: 'cpo',                 label: 'CPO',                 group: 'tiktok', agg: 'avg', fmt: 'money' },
  { key: 'gross_revenue',       label: 'Gross revenue',       group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'roi',                 label: 'ROI',                 group: 'tiktok', agg: 'avg', fmt: 'num'   },
];

export const FIELD_BY_KEY = Object.fromEntries(HALO_FIELDS.map((f) => [f.key, f]));
export const AMAZON_FIELDS = HALO_FIELDS.filter((f) => f.group === 'amazon');
export const TIKTOK_FIELDS = HALO_FIELDS.filter((f) => f.group === 'tiktok');

// Keyword Search Volume — weekly-only branded search demand from the subsheet.
// Not a daily HALO_FIELD; the Search-demand view handles it weekly-native.
export const KSV_META = { key: 'keyword_search_volume', label: 'Branded Search Volume', fmt: 'int' };

// The daily Amazon field that carries a per-PRODUCT breakdown (Revenue (Amazon)
// columns). "All products" = the stored total (revenue_per_day); a single
// product = that product's daily revenue.
export const PRODUCT_REVENUE_FIELD = 'revenue_per_day';

// ---- currency ---------------------------------------------------------------
// The sheet may be in $, £ or €. parseHaloSheet detects it and stores it on the
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
  totalrevenueday: 'revenue_per_day',   // the sheet's "Total Revenue/Day"
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
