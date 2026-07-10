// ============================================================
// Amazon Halo Effect — data access (Boss-only, enforced by RLS + RPC).
// ============================================================

import { supabase } from './supabase';

export async function listHaloDatasets() {
  const { data, error } = await supabase
    .from('halo_datasets')
    .select('id, name, source_filename, period_start, period_end, row_count, has_dummy, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getHaloRows(datasetId) {
  const { data, error } = await supabase
    .from('halo_rows')
    .select('date, metrics, dummy_fields, keywords, keyword_ranks')
    .eq('dataset_id', datasetId)
    .order('date', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => ({
    date: r.date,
    metrics: r.metrics || {},
    dummyFields: r.dummy_fields || [],
    keywords: r.keywords || {},
    keywordRanks: r.keyword_ranks || {},
  }));
}

/**
 * @param {{ name, filename, periodStart, periodEnd, hasDummy,
 *           rows: Array<{date, metrics, dummyFields?, keywords?, keywordRanks?}> }} p
 */
export async function createHaloDataset(p) {
  const payload = (p.rows || []).map((r) => ({
    date: r.date,
    metrics: r.metrics || {},
    dummy_fields: r.dummyFields || [],
    keywords: r.keywords || {},
    keyword_ranks: r.keywordRanks || {},
  }));
  const { data, error } = await supabase.rpc('halo_create_dataset', {
    p_name: p.name,
    p_filename: p.filename || null,
    p_period_start: p.periodStart || null,
    p_period_end: p.periodEnd || null,
    p_rows: payload,
    p_has_dummy: !!p.hasDummy,
  });
  if (error) throw error;
  return data;
}

export async function deleteHaloDataset(id) {
  const { error } = await supabase.from('halo_datasets').delete().eq('id', id);
  if (error) throw error;
  return true;
}
