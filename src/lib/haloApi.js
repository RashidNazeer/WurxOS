// ============================================================
// Amazon Halo Effect — data access (Boss-only, enforced by RLS + RPC).
// ============================================================

import { supabase } from './supabase';

export async function listHaloDatasets() {
  const { data, error } = await supabase
    .from('halo_datasets')
    .select('id, name, source_filename, period_start, period_end, row_count, has_dummy, currency, weekly_keywords, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((d) => ({
    ...d,
    currency: d.currency || '$',
    weekly_keywords: d.weekly_keywords || [],
  }));
}

export async function getHaloRows(datasetId) {
  const { data, error } = await supabase
    .from('halo_rows')
    .select('date, metrics, product_revenue')
    .eq('dataset_id', datasetId)
    .order('date', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => ({
    date: r.date,
    metrics: r.metrics || {},
    productRevenue: r.product_revenue || {},
  }));
}

/**
 * @param {{ name, filename, periodStart, periodEnd, currency, weeklyKeywords,
 *           rows: Array<{date, metrics, productRevenue?}> }} p
 */
export async function createHaloDataset(p) {
  const payload = (p.rows || []).map((r) => ({
    date: r.date,
    metrics: r.metrics || {},
    dummy_fields: [],
    product_revenue: r.productRevenue || {},
  }));
  const { data, error } = await supabase.rpc('halo_create_dataset', {
    p_name: p.name,
    p_filename: p.filename || null,
    p_period_start: p.periodStart || null,
    p_period_end: p.periodEnd || null,
    p_rows: payload,
    p_has_dummy: false,
    p_currency: p.currency || '$',
    p_weekly_keywords: p.weeklyKeywords || [],
  });
  if (error) throw error;
  return data;
}

export async function deleteHaloDataset(id) {
  const { error } = await supabase.from('halo_datasets').delete().eq('id', id);
  if (error) throw error;
  return true;
}
