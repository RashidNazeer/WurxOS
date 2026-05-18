// Euka → TikTok Shop metrics API.
//
// Reads the euka_shop_metrics snapshots written by the `euka-sync`
// edge function, and lets an OL trigger a sync / map a Euka store
// to a WurxOS brand.

import { supabase } from './supabase';

// Latest snapshot per store (the table keeps an append-history).
export async function listEukaMetrics() {
  const { data, error } = await supabase
    .from('euka_shop_metrics')
    .select('*, brand:brand_id(id, brand_name)')
    .order('synced_at', { ascending: false });
  if (error) throw new Error(error.message);
  const seen = new Set();
  return (data || []).filter((r) => {
    if (seen.has(r.euka_store_id)) return false;
    seen.add(r.euka_store_id);
    return true;
  });
}

// Trigger an on-demand sync. The edge function self-rate-limits to
// once per 10 min, so a no-op result ({ skipped: true }) is normal.
export async function triggerEukaSync() {
  const { data, error } = await supabase.functions.invoke('euka-sync', { body: {} });
  if (error) throw new Error(error.message);
  return data;
}

export function subscribeEukaMetrics(onChange) {
  const ch = supabase
    .channel(`euka-metrics-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'euka_shop_metrics' },
      () => onChange())
    .subscribe();
  return () => supabase.removeChannel(ch);
}

// Brands available to map a Euka store onto.
export async function listLinkableBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name')
    .order('brand_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// Map a Euka store to a WurxOS brand — the next sync links the
// metrics to that brand (which also opens them to the brand's team).
export async function linkEukaStore(eukaStoreId, brandId) {
  const { error } = await supabase
    .from('brands')
    .update({ euka_store_id: eukaStoreId })
    .eq('id', brandId);
  if (error) throw new Error(error.message);
}
