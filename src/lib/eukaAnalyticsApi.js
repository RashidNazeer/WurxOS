// Client for the Euka REST API — always via our Boss-only `euka-api` edge
// proxy (the OpenAPI key stays server-side; the browser never sees it).
//
// Every call returns the raw Euka response `data`. Pass `fresh: true` to
// bypass the server cache (the dashboard's "Refresh" button).
import { supabase } from './supabase';

// Which Euka brand/account the analytics page is currently viewing. Each
// brand is a separate Euka OpenAPI key held server-side; the edge function
// picks the key from this slug. The page sets it via setEukaBrand() when the
// brand selector changes; defaults to Solid Gold (the original single brand)
// so any caller that doesn't set it keeps working.
//
// The brand LIST is discovered at runtime from the edge function's /__brands
// endpoint (which reads env secrets by convention), so adding a brand is a
// pure secrets change — no frontend edit. EUKA_BRANDS_FALLBACK is only used
// if that fetch fails.
export const EUKA_BRANDS_FALLBACK = [
  { slug: 'solidgold', label: 'Solid Gold Pets' },
  { slug: 'innosupps', label: 'InnoSupps' },
];
// Back-compat alias for any older import.
export const EUKA_BRANDS = EUKA_BRANDS_FALLBACK;
let currentBrand = 'solidgold';
// Accept ANY non-empty slug — the brand list is discovered at runtime from the
// server's /__brands, so we must NOT gate against the static EUKA_BRANDS_FALLBACK
// (that list is only the 2 original brands). Gating here silently pinned every
// shared-key brand — Aurelia, Dr Harvey, etc. — to whatever brand was selected
// before, so they showed the previous brand's data. The server safely defaults
// an unknown/empty slug to Solid Gold, so there's nothing to defend against here.
export function setEukaBrand(slug) {
  if (slug) currentBrand = slug;
}
export function getEukaBrand() { return currentBrand; }

async function call(path, { body, query, method, fresh } = {}) {
  const { data, error } = await supabase.functions.invoke('euka-api', {
    body: { path, body, query, method, fresh, brand: currentBrand },
  });
  if (error) throw new Error(error.message || 'Euka request failed');
  if (data?.error) {
    throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  }
  return data?.data;
}

// ── Identity / scope ──────────────────────────────────────────────
export const eukaMe     = () => call('/me');
export const eukaBrands = () => call('/brands');
export const eukaStores = () => call('/stores');

// The available analytics brands (slug + label), discovered server-side from
// env secrets. Used to populate the brand selector. Falls back to the static
// list if the call fails. NOTE: this is brand-agnostic (it doesn't depend on
// currentBrand), so call it once on mount.
export async function eukaBrandList() {
  try {
    const list = await call('/__brands');
    return Array.isArray(list) && list.length ? list : EUKA_BRANDS_FALLBACK;
  } catch {
    return EUKA_BRANDS_FALLBACK;
  }
}

// ── Dashboard — flat {startDate,endDate} form ─────────────────────
export const eukaOverview = (storeId, startDate, endDate, extra = {}, fresh) =>
  call('/dashboard/performance-overview', { body: { storeId, startDate, endDate, ...extra }, fresh });
export const eukaSeries = (storeId, startDate, endDate, extra = {}, fresh) =>
  call('/dashboard/performance-series', { body: { storeId, startDate, endDate, ...extra }, fresh });
export const eukaCampaignBreakdown = (storeId, startDate, endDate, extra = {}, fresh) =>
  call('/dashboard/campaign-breakdown', { body: { storeId, startDate, endDate, ...extra }, fresh });
export const eukaAffiliateFunnel = (storeId, startDate, endDate, fresh) =>
  call('/dashboard/affiliate-funnel', { body: { storeId, startDate, endDate }, fresh });
export const eukaConversionFunnel = (storeId, startDate, endDate, fresh) =>
  call('/dashboard/conversion-funnel', { body: { storeId, startDate, endDate }, fresh });

// ── Dashboard — {postedDateRange:{start,end}} form ────────────────
const pdr = (storeId, start, end, extra = {}) => ({ storeId, postedDateRange: { start, end }, ...extra });
// Products: Euka REMOVED /dashboard/top-products-by-video-revenue (Aug 2026 —
// 404 "Route not found"). products-performance replaces it and is richer: it
// returns per-product totalGmv / affiliateGmv / orders / itemsSold / videosPosted
// in ONE call, so nothing needs a per-product performance-overview follow-up.
// Takes pageSize (not limit) + sortField/sortOrder; there is no revenue delta.
export const eukaTopProducts = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/products-performance', { body: pdr(storeId, start, end, { sortField: 'gmv', sortOrder: 'DESC', ...extra }), fresh });
export const eukaTopCreators = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/top-creators-by-gmv', { body: pdr(storeId, start, end, extra), fresh });
export const eukaLivestreamGmv = (storeId, start, end, fresh) =>
  call('/dashboard/livestream-gmv', { body: pdr(storeId, start, end), fresh });
export const eukaSampleApproval = (storeId, start, end, fresh) =>
  call('/dashboard/sample-approval-rate', { body: pdr(storeId, start, end), fresh });
export const eukaFeaturedProducts = (storeId, start, end, fresh) =>
  call('/dashboard/featured-products-count', { body: pdr(storeId, start, end), fresh });
export const eukaAdsOverview = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/ads-overview', { body: pdr(storeId, start, end, extra), fresh });
export const eukaContentOverview = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/content-overview', { body: pdr(storeId, start, end, extra), fresh });
export const eukaCreatorTiers = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/creator-level-breakdown', { body: pdr(storeId, start, end, extra), fresh });
export const eukaOutreachFunnel = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/creator-outreach-funnel', { body: pdr(storeId, start, end, extra), fresh });

// ── Top videos — nested {filter:{postedDateRange}} form ───────────
export const eukaTopVideos = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/top-videos-by-revenue', { body: { storeId, filter: { postedDateRange: { start, end }, ...extra } }, fresh });

// ── Data export (json) ────────────────────────────────────────────
export const eukaDataExport = (type, storeId, { startDate, endDate, exportType = 'json', creatorHandle, creatorUsername } = {}) =>
  call('/data-export', {
    method: 'GET',
    query: { type, store_id: storeId, start_date: startDate, end_date: endDate, export_type: exportType, creator_handle: creatorHandle, creator_username: creatorUsername },
  });

// ── Weekly-report autofill — EXACT fields only ────────────────────
// Fetches a week's stats from Euka and returns a PARTIAL weekly-report
// `data` object containing ONLY the numbers Euka provides that are
// verified to match the manual report exactly:
//   Overall: GMV (totalShopGMV), Affiliate GMV (totalAffiliateGMV), Orders
//   Top Creators: name / videosPosted / gmv  (per-creator itemsSold is NOT
//     available from Euka → left blank)
//   Product Highlights: productId / name / GMV (per-product affiliate GMV
//     via the productIds filter) / unitsSold
//   overallInsights: a short auto-generated summary
// Everything else (samples, ROI, shop score, videos posted, GMV Max,
// offsite, top videos, all narrative) is DELIBERATELY omitted so it stays
// blank for manual entry — Euka either lacks it or counts it differently
// than the report does (e.g. samples 96 vs 67). Merge the result over
// EMPTY_REPORT_DATA() before saving.
//
// Date shapes are non-interchangeable, so we reuse the wrappers above,
// which already encode the right shape per endpoint:
//   performance-overview  → flat {startDate,endDate}
//   top-creators / top-products → {postedDateRange:{start,end}}
const _num = (v) => (v == null || Number.isNaN(Number(v)) ? '' : Number(v));

function _overallInsightsHtml(ov, creators) {
  const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const top = (creators || []).slice(0, 3)
    .map((c) => `${c.name} (${money(typeof c.gmv === 'number' ? c.gmv : null)})`)
    .filter((s) => !s.startsWith(' '))
    .join(', ');
  return '<ul>'
    + `<li>Total Shop GMV <b>${money(ov.totalShopGMV)}</b>, Affiliate GMV <b>${money(ov.totalAffiliateGMV)}</b>, with <b>${n(ov.totalOrders)}</b> orders this week.</li>`
    + (top ? `<li>Top creators by GMV: <b>${top}</b>.</li>` : '')
    + '</ul>';
}

// Returns { data, meta } where `data` is a partial weekly-report data
// object (exact fields only) and `meta` reports what was filled. `week`
// is a weekInfo from makeWeekFromStart/buildWeekInfoFromRange:
//   { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', ... }
export async function buildEukaAutofillData({ storeId, week, fresh = false }) {
  if (!storeId) throw new Error('No Euka store selected.');
  if (!week?.startDate || !week?.endDate) throw new Error('No week selected.');
  const s = week.startDate, e = week.endDate;

  const [overview, creatorsResp, prodResp] = await Promise.all([
    eukaOverview(storeId, s, e, {}, fresh),
    eukaTopCreators(storeId, s, e, { limit: 10 }, fresh).catch(() => null),
    eukaTopProducts(storeId, s, e, { pageSize: 25 }, fresh).catch(() => null),
  ]);
  if (!overview) throw new Error('Euka returned no performance data for this week.');

  const topCreators = (creatorsResp?.affiliates || []).map((c) => ({
    name: c.handle ? `@${c.handle}` : '',
    videosPosted: _num(c.videoCount),
    itemsSold: '',            // no per-creator units from Euka → manual
    gmv: _num(c.totalGmv),
    notes: '',
  }));

  // Per-product AFFILIATE GMV + orders — the numbers the report's product
  // column uses. products-performance returns both per row, so this no longer
  // fans out one filtered performance-overview call per product.
  const productHighlights = (prodResp?.products || [])
    .filter((p) => Number(p.affiliateGmv) > 0)
    .sort((a, b) => Number(b.affiliateGmv) - Number(a.affiliateGmv))
    .slice(0, 8)
    .map((p) => ({
      productId: p.productId || '',
      productName: p.title || '',
      unitsSold: _num(p.orders),
      gmv: _num(p.affiliateGmv),
      newVideos: '',           // Euka videoCount ≠ report "new videos" → manual
      videosMtd: '',
      samplesApprovedWeek: '',
      samplesApprovedMtd: '',
      notes: '',
    }));

  const data = {
    overallPerformance: {
      gmv: _num(overview.totalShopGMV),
      affiliateGmv: _num(overview.totalAffiliateGMV),
      orders: _num(overview.totalOrders),
      samplesApproved: '',      // Euka count ≠ report → manual
      roi: '',                  // needs ad spend (hasAdsApiConfig=false) → manual
      shopPerformanceScore: '', // not exposed by Euka → manual
      videosPosted: '',         // Euka counts differ → manual
    },
    overallInsights: _overallInsightsHtml(overview, topCreators),
    topCreators: topCreators.length ? topCreators : undefined,
    productHighlights: productHighlights.length ? productHighlights : undefined,
  };

  return {
    data,
    meta: {
      filledOverall: true,
      creatorCount: topCreators.length,
      productCount: productHighlights.length,
    },
  };
}
