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
export const eukaTopProducts = (storeId, start, end, extra = {}, fresh) =>
  call('/dashboard/top-products-by-video-revenue', { body: pdr(storeId, start, end, extra), fresh });
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
