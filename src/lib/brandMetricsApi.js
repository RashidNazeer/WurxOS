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
    .select('id, brand_name, client_name, logo_url, status, paid_collab_status, gmv_max_status, unlimited_sample_goal')
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

// The goal (target) half of METRIC_COLUMNS. Bulk update writes only these.
export const GOAL_COLUMNS = [
  'gmv_target', 'samples_target', 'paid_collab_allocated', 'gmv_max_allocated', 'roi_target',
];

// Write ONLY the goal columns the caller names; leave every other column alone.
//
// Deliberately NOT a read-modify-write through saveBrandMonthlyMetrics. That
// writes all ten columns, so anything it isn't handed becomes null — and a merge
// built from a row read even seconds earlier would clobber a gmv_achieved the
// APC refreshed at clock-in in between (mig 311), which is the number a GMV Max
// incentive reads to decide it is payable (mig 366). A partial upsert updates
// only the columns present in the payload, so the achieved side is never touched
// and there is no race to lose.
//
// One call per brand on purpose: a batched upsert whose rows carry different
// column sets nulls the columns each row omits.
export async function saveBrandGoals(brandId, monthKey, targets) {
  const { data: sess } = await supabase.auth.getSession();
  const row = {
    brand_id: brandId,
    month_key: monthKey,
    updated_at: new Date().toISOString(),
    updated_by: sess?.session?.user?.id || null,
  };
  for (const col of GOAL_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(targets || {}, col)) row[col] = targets[col];
  }
  const { data, error } = await supabase
    .from('brand_monthly_metrics')
    .upsert(row, { onConflict: 'brand_id,month_key' })
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  // RLS refuses a write by returning no row rather than raising, so an
  // unverified "success" here would be a silent no-op on someone else's brand.
  if (!data) throw new Error('No row came back — you may not have permission to edit this brand.');
  for (const col of GOAL_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(row, col)) continue;
    const want = row[col];
    const got = data[col];
    if (want == null ? got != null : (got == null || Number(got) !== Number(want))) {
      throw new Error(`Saved ${col} as ${got}, expected ${want}.`);
    }
  }
  return data;
}

// Who is on this brand's "Total Revenue in GMV Max" incentive for the month,
// and whether the brand's figure has reached their target (mig 366).
//
// The goal drives every one of those targets, so this is how the person setting
// it sees the consequence: the APC, the Team Lead and the Ads Manager all read
// from one number. It carries no compensation figures, and the RPC only answers
// Boss/OL/developer or the brand's owner TL — the same people who may set the
// goal. Advisory: a failure returns [] rather than breaking the page.
export async function gmvMaxIncentiveLinks(brandId, monthKey) {
  if (!brandId || !monthKey) return [];
  const { data, error } = await supabase.rpc('gmv_max_incentive_links', {
    p_brand: brandId, p_month: monthKey,
  });
  if (error) return [];
  return data || [];
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
