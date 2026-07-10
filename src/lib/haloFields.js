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
//
// Amazon side today = NTB (really "units sold", but Boss calls it NTB),
// Keyword Search Volume, Revenue/Day. Everything else is TikTok / GMV Max.
// ============================================================

export const HALO_FIELDS = [
  { key: 'gmv',                 label: 'GMV',                  group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'orders',              label: 'Orders',               group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'items_sold',          label: 'Items sold',           group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'aov',                 label: 'AOV',                  group: 'tiktok', agg: 'avg', fmt: 'money' },
  { key: 'live_gmv',            label: 'LIVE GMV',             group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'video_per_day',       label: 'Video/Day',            group: 'tiktok', agg: 'avg', fmt: 'num'   },
  { key: 'product_impressions', label: 'Product impressions',  group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'unique_impressions',  label: 'Unique impressions',   group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'ntb',                 label: 'NTB (units sold)',     group: 'amazon', agg: 'sum', fmt: 'int'   },
  { key: 'keyword_search_volume', label: 'Keyword Search Volume', group: 'amazon', agg: 'sum', fmt: 'int' },
  { key: 'revenue_per_day',     label: 'Revenue/Day',          group: 'amazon', agg: 'sum', fmt: 'money' },
  // Keyword Search Rank — per-keyword search-result position (1 = top). Lower
  // is better, so it rolls up as an average (not a sum) and correlates
  // INVERSELY with reach (more TikTok reach → better/lower rank).
  { key: 'keyword_search_rank', label: 'Keyword Search Rank',  group: 'amazon', agg: 'avg', fmt: 'num'   },
  { key: 'product_clicks',      label: 'Product clicks',       group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'unique_clicks',       label: 'Unique clicks',        group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'cost',                label: 'Cost',                 group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'gmvmax_orders',       label: 'GMV Max Orders',       group: 'tiktok', agg: 'sum', fmt: 'int'   },
  { key: 'cpo',                 label: 'CPO',                  group: 'tiktok', agg: 'avg', fmt: 'money' },
  { key: 'gross_revenue',       label: 'Gross revenue',        group: 'tiktok', agg: 'sum', fmt: 'money' },
  { key: 'roi',                 label: 'ROI',                  group: 'tiktok', agg: 'avg', fmt: 'num'   },
];

export const FIELD_BY_KEY = Object.fromEntries(HALO_FIELDS.map((f) => [f.key, f]));
export const AMAZON_FIELDS = HALO_FIELDS.filter((f) => f.group === 'amazon');
export const TIKTOK_FIELDS = HALO_FIELDS.filter((f) => f.group === 'tiktok');

// Amazon columns that are empty in the real sheet today and may be seeded
// with meaningful test data until the real values arrive.
export const DUMMY_CAPABLE = ['keyword_search_volume', 'keyword_search_rank', 'revenue_per_day'];

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
  productimpressions: 'product_impressions',
  uniqueimpressions: 'unique_impressions',
  ntb: 'ntb',
  keywordsearchvolume: 'keyword_search_volume',
  revenueday: 'revenue_per_day',
  revenueperday: 'revenue_per_day',
  keywordsearchrank: 'keyword_search_rank',
  keywordrank: 'keyword_search_rank',
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

// Format a numeric value for display given a field's fmt.
export function fmtValue(v, fmt) {
  if (v == null || Number.isNaN(v)) return '—';
  if (fmt === 'money') {
    return '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  if (fmt === 'int') return Math.round(Number(v)).toLocaleString();
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
