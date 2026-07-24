// ============================================================
// Amazon Halo Effect — per-brand dataset access (Boss/OL-only, RLS + RPC).
//
// Each brand has up to three datasets, one per granularity ('day','week',
// 'month'). Re-uploading a granularity REPLACES that brand's dataset for it
// (handled atomically by the halo_create_dataset RPC).
// ============================================================

import { supabase } from './supabase';

const DS_COLS = 'id, brand_id, granularity, name, source_filename, period_start, period_end, row_count, currency, created_at';

// A brand's up-to-3 datasets (day/week/month).
export async function listHaloDatasetsForBrand(brandId) {
  if (!brandId) return [];
  const { data, error } = await supabase
    .from('halo_datasets')
    .select(DS_COLS)
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((d) => ({ ...d, currency: d.currency || '$' }));
}

export async function getHaloRows(datasetId) {
  const { data, error } = await supabase
    .from('halo_rows')
    .select('date, period_label, metrics, product_revenue, keywords, keyword_ranks')
    .eq('dataset_id', datasetId)
    .order('date', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => ({
    date: r.date,
    periodLabel: r.period_label || null,
    metrics: r.metrics || {},
    productRevenue: r.product_revenue || {},
    keywords: r.keywords || {},
    keywordRanks: r.keyword_ranks || {},
  }));
}

/**
 * Create (REPLACE) one brand's dataset for a granularity.
 * @param {{ brandId, granularity, name, filename, periodStart, periodEnd,
 *           currency, rows: Array<{date, periodLabel?, metrics?, productRevenue?,
 *           keywords?, keywordRanks?}> }} p
 */
export async function createHaloDataset(p) {
  const payload = (p.rows || []).map((r) => ({
    date: r.date,
    period_label: r.periodLabel || null,
    metrics: r.metrics || {},
    product_revenue: r.productRevenue || {},
    keywords: r.keywords || {},
    keyword_ranks: r.keywordRanks || {},
  }));
  const { data, error } = await supabase.rpc('halo_create_dataset', {
    p_brand_id: p.brandId,
    p_granularity: p.granularity,
    p_name: p.name,
    p_filename: p.filename || null,
    p_period_start: p.periodStart || null,
    p_period_end: p.periodEnd || null,
    p_rows: payload,
    p_currency: p.currency || '$',
  });
  if (error) throw error;
  return data;
}

export async function deleteHaloDataset(id) {
  const { error } = await supabase.from('halo_datasets').delete().eq('id', id);
  if (error) throw error;
  return true;
}
