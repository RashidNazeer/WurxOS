// Client for per-brand, per-month goal metrics (migration 260).
// Boss/OL set a target + achieved value for each of 5 metrics, per month.
import { supabase } from './supabase';

// The 10 numeric columns, in one place so select/save stay in sync.
export const METRIC_COLUMNS = [
  'gmv_target', 'gmv_achieved',
  'samples_target', 'samples_achieved',
  'paid_collab_allocated', 'paid_collab_used',
  'gmv_max_allocated', 'gmv_max_used',
  'roi_target', 'roi_achieved',
];

// Active brands for the picker (Boss/OL can view all; RLS on brands still applies).
export async function listActiveBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, client_name, logo_url, status, paid_collab_status, gmv_max_status')
    .eq('status', 'active')
    .order('brand_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// Every brand's metric row for one month -> map of brand_id -> row. Powers the
// brand picker cards (goals-set badge + GMV goal) and the "needs goals" filter.
export async function listBrandMetricsForMonth(monthKey) {
  const { data, error } = await supabase
    .from('brand_monthly_metrics')
    .select(['brand_id', ...METRIC_COLUMNS, 'updated_at'].join(', '))
    .eq('month_key', monthKey);
  if (error) throw new Error(error.message);
  const map = {};
  (data || []).forEach((r) => { map[r.brand_id] = r; });
  return map;
}

// One brand's metrics for a month -> the row, or null if nothing saved yet.
export async function getBrandMonthlyMetrics(brandId, monthKey) {
  const { data, error } = await supabase
    .from('brand_monthly_metrics')
    .select(['brand_id', 'month_key', ...METRIC_COLUMNS, 'updated_at'].join(', '))
    .eq('brand_id', brandId)
    .eq('month_key', monthKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// Save a month's metrics. `values` is a plain object keyed by METRIC_COLUMNS;
// empty/blank/NaN -> null, 0 stays 0. If EVERY value is null (the user cleared
// the whole month), we DELETE the row instead of writing an all-null phantom
// that would read as "no data" yet still show a "last updated" time.
export async function saveBrandMonthlyMetrics(brandId, monthKey, values) {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess?.session?.user?.id || null;
  const coerced = {};
  let allNull = true;
  for (const col of METRIC_COLUMNS) {
    const v = values[col];
    const n = (v === '' || v === null || v === undefined || Number.isNaN(Number(v))) ? null : Number(v);
    coerced[col] = n;
    if (n !== null) allNull = false;
  }
  if (allNull) {
    const { error } = await supabase
      .from('brand_monthly_metrics')
      .delete().eq('brand_id', brandId).eq('month_key', monthKey);
    if (error) throw new Error(error.message);
    return;
  }
  const row = { brand_id: brandId, month_key: monthKey, updated_at: new Date().toISOString(), updated_by: uid, ...coerced };
  const { error } = await supabase
    .from('brand_monthly_metrics')
    .upsert(row, { onConflict: 'brand_id,month_key' });
  if (error) throw new Error(error.message);
}

// Months that already have saved metrics for a brand (newest first) — used to
// mark which months carry data in the navigator.
export async function listMonthsWithData(brandId) {
  const { data, error } = await supabase
    .from('brand_monthly_metrics')
    .select('month_key')
    .eq('brand_id', brandId)
    .order('month_key', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.month_key);
}
