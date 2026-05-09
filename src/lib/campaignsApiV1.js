// v1-compat layer for the `campaigns` table (Campaign Tracker).
//
// v1 stored every campaign in a Firestore collection at /campaigns and
// the v1 components read camelCase fields (`brandId`, `promotionName`,
// `startTime`, etc.) plus Firestore Timestamp objects with `.toDate()`.
//
// This layer:
//   - Exposes `subscribeAllCampaigns()` and `subscribeBrandCampaigns()`
//     which behave like v1's `onSnapshot`. They wrap a Realtime channel
//     and refetch on any change.
//   - Returns rows normalized to expose BOTH snake_case (DB) and v1
//     camelCase aliases. Timestamp columns are wrapped in a tiny shim
//     with a `.toDate()` method and `.seconds` property so v1's
//     `formatDateTime`, `daysUntil`, `toLocalInput` all work unchanged.
//   - Exposes `addCampaign`, `updateCampaign`, `deleteCampaign`,
//     `addCampaignsBulk`, `bulkDeleteCampaigns` with the v1 payload
//     shape (camelCase keys, ISO strings or Date for timestamps).
//
// The underlying Supabase backend (mig 067-077) remains unchanged.

import { supabase } from './supabase';

// --- Timestamp shim ------------------------------------------------
// Firestore Timestamp has `.toDate()` and `.seconds`. Wrap a Date so
// v1 markup can call those without crashing.
function tsShim(input) {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  return {
    toDate: () => d,
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
  };
}

// --- Row normalizer ------------------------------------------------
// Adds v1 camelCase aliases on top of snake_case Postgres fields.
// `addedByName` is filled from the joined profile when available.
export function _normCampaign(row) {
  if (!row) return row;
  const addedByProfile = row.added_by_profile || row.added_by_profile_v1 || null;
  return {
    ...row,
    // Identity
    id: row.id,
    brandId: row.brand_id,
    brandName: row.brand?.brand_name || row.brand_name || '',
    // Display fields
    promotionName: row.promotion_name || '',
    status: row.status || 'Ongoing',
    type: row.type || '',
    notes: row.notes || '',
    // Timestamps (Firestore-shape shim)
    startTime: tsShim(row.start_time),
    endTime: tsShim(row.end_time),
    createdAt: tsShim(row.created_at),
    updatedAt: tsShim(row.updated_at),
    // Authorship
    ownerId: row.owner_id || null,
    addedBy: row.added_by || null,
    addedByName: addedByProfile?.display_name || row.added_by_name || '',
    addedByRole: row.added_by_role || addedByProfile?.role || null,
    // Reminders blob (v1 reads + writes this; we keep the JSONB column)
    reminders: row.reminders || {},
  };
}

// --- Reads ---------------------------------------------------------
// Match v1's "most recent N campaigns" cap.
const QUERY_SELECT = `
  *,
  brand:brand_id(id, brand_name, logo_url, owner_id),
  added_by_profile:added_by(display_name, role)
`;

async function fetchAll() {
  const { data, error } = await supabase
    .from('campaigns')
    .select(QUERY_SELECT)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data || []).map(_normCampaign);
}

async function fetchByBrand(brandId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select(QUERY_SELECT)
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normCampaign);
}

// v1 used onSnapshot. We wrap a Realtime channel with a refetch-on-change.
export function subscribeAllCampaigns(onRows, onError) {
  let cancelled = false;
  let channel = null;

  const refresh = async () => {
    try {
      const rows = await fetchAll();
      if (!cancelled) onRows(rows);
    } catch (e) {
      if (!cancelled && onError) onError(e);
    }
  };
  refresh();

  channel = supabase
    .channel(`campaigns-all-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, refresh)
    .subscribe();

  // Returns the unsubscribe function with a `.refetch()` attached for
  // callers that want to force a fresh fetch after their own action
  // (realtime in v2 is unreliable; never depend solely on it).
  const unsubscribe = () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
  unsubscribe.refetch = refresh;
  return unsubscribe;
}

export function subscribeBrandCampaigns(brandId, onRows, onError) {
  let cancelled = false;
  let channel = null;

  const refresh = async () => {
    try {
      const rows = await fetchByBrand(brandId);
      if (!cancelled) onRows(rows);
    } catch (e) {
      if (!cancelled && onError) onError(e);
    }
  };
  refresh();

  channel = supabase
    .channel(`campaigns-brand-${brandId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'campaigns', filter: `brand_id=eq.${brandId}` },
      refresh,
    )
    .subscribe();

  const unsubscribe = () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
  unsubscribe.refetch = refresh;
  return unsubscribe;
}

// --- Writes (camelCase v1 payloads) --------------------------------

function _toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    // datetime-local value is "YYYY-MM-DDTHH:MM" (no TZ). Treat as local time.
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  // Firestore Timestamp shim
  if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
  return null;
}

function _toRow(payload) {
  return {
    brand_id: payload.brandId,
    promotion_name: (payload.promotionName || '').trim(),
    status: payload.status || 'Ongoing',
    start_time: _toIso(payload.startTime),
    end_time: _toIso(payload.endTime),
    type: (payload.type || '').trim() || null,
    notes: (payload.notes || '').trim() || null,
    reminders: payload.reminders ?? {},
    owner_id: payload.ownerId ?? null,
    added_by: payload.addedBy ?? null,
    added_by_role: payload.addedByRole ?? null,
  };
}

export async function addCampaign(payload) {
  const row = _toRow(payload);
  // owner_id defaults to brand owner if not provided
  if (!row.owner_id && row.brand_id) {
    const { data: brand } = await supabase
      .from('brands').select('owner_id').eq('id', row.brand_id).maybeSingle();
    row.owner_id = brand?.owner_id || row.added_by;
  }
  const { data, error } = await supabase
    .from('campaigns').insert(row).select(QUERY_SELECT).single();
  if (error) throw new Error(error.message);
  return _normCampaign(data);
}

export async function updateCampaign(id, payload) {
  const row = _toRow(payload);
  // Don't try to overwrite added_by/added_by_role/owner_id on edit
  delete row.added_by;
  delete row.added_by_role;
  delete row.owner_id;
  const { data, error } = await supabase
    .from('campaigns').update(row).eq('id', id).select(QUERY_SELECT).single();
  if (error) throw new Error(error.message);
  return _normCampaign(data);
}

export async function deleteCampaign(id) {
  const { error } = await supabase.from('campaigns').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Bulk insert from paste parser. Same payload shape as addCampaign,
// but we resolve owner_id once per brand and emit a single insert.
export async function addCampaignsBulk(rows) {
  if (!rows || rows.length === 0) return [];
  const brandIds = Array.from(new Set(rows.map(r => r.brandId).filter(Boolean)));
  const { data: brands } = brandIds.length
    ? await supabase.from('brands').select('id, owner_id').in('id', brandIds)
    : { data: [] };
  const ownerByBrand = new Map((brands || []).map(b => [b.id, b.owner_id]));

  const insertables = rows.map(r => {
    const row = _toRow(r);
    if (!row.owner_id) row.owner_id = ownerByBrand.get(row.brand_id) || row.added_by;
    return row;
  });

  const { data, error } = await supabase
    .from('campaigns').insert(insertables).select(QUERY_SELECT);
  if (error) throw new Error(error.message);
  return (data || []).map(_normCampaign);
}

// Bulk delete (v1 used writeBatch)
export async function bulkDeleteCampaigns(ids) {
  if (!ids || ids.length === 0) return;
  const { error } = await supabase.from('campaigns').delete().in('id', Array.from(ids));
  if (error) throw new Error(error.message);
}
