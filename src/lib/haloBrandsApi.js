// ============================================================
// Amazon Halo Effect — brand enablement (Boss/OL-only).
//
// `halo_brands` is the curated list of brands Halo is turned on for — it drives
// the main-page brand dropdown and the client-link brand picker. A brand can be
// enabled before any sheet is uploaded (shows "no sheets yet").
// ============================================================

import { supabase } from './supabase';
import { listBrands } from './brandsApi';

const DS_COLS = 'id, brand_id, granularity, name, source_filename, period_start, period_end, row_count, currency, created_at';

// Enabled brands, each with its up-to-3 datasets keyed by granularity:
//   [{ brand: {id, brand_name, client_name, logo_url, status},
//      datasets: { day?, week?, month? } }]  (sorted by brand name)
export async function listHaloEnabledBrands() {
  const { data: enabled, error: e1 } = await supabase
    .from('halo_brands')
    .select('brand_id, enabled_at');
  if (e1) throw e1;
  const ids = [...new Set((enabled || []).map((r) => r.brand_id))];
  if (!ids.length) return [];

  const [{ data: brands, error: e2 }, { data: datasets, error: e3 }] = await Promise.all([
    supabase.from('brands').select('id, brand_name, client_name, logo_url, status').in('id', ids),
    supabase.from('halo_datasets').select(DS_COLS).in('brand_id', ids),
  ]);
  if (e2) throw e2;
  if (e3) throw e3;

  const dsByBrand = {};
  for (const d of datasets || []) {
    if (!d.granularity) continue;
    (dsByBrand[d.brand_id] = dsByBrand[d.brand_id] || {})[d.granularity] = { ...d, currency: d.currency || '$' };
  }
  // Only active brands surface on /halo — an archived brand that's still enabled
  // is dropped here (and its counts are handled active-only in Settings).
  const byId = Object.fromEntries((brands || []).filter((b) => b.status === 'active').map((b) => [b.id, b]));
  return ids
    .map((id) => (byId[id] ? { brand: byId[id], datasets: dsByBrand[id] || {} } : null))
    .filter(Boolean)
    .sort((a, b) => (a.brand.brand_name || '').localeCompare(b.brand.brand_name || ''));
}

// Just the id set of enabled brands (cheap; for the settings checkbox state).
export async function listHaloEnabledBrandIds() {
  const { data, error } = await supabase.from('halo_brands').select('brand_id');
  if (error) throw error;
  return [...new Set((data || []).map((r) => r.brand_id))];
}

export async function enableHaloBrand(brandId) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('halo_brands')
    .upsert({ brand_id: brandId, enabled_by: me?.user?.id || null }, { onConflict: 'brand_id', ignoreDuplicates: true });
  if (error) throw error;
  return true;
}

export async function disableHaloBrand(brandId) {
  const { error } = await supabase.from('halo_brands').delete().eq('brand_id', brandId);
  if (error) throw error;
  return true;
}

// Every active brand (for the enablement checkbox list). Uses the shared,
// RLS-filtered brand reader so Boss/OL see all brands.
export async function listAllBrandsForHaloSettings() {
  return listBrands({ status: 'active' });
}
