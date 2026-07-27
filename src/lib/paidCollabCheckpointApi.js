// Client for the Paid-Collab weekly checkpoint §09 (migration 279).
// The paid collab team (pctl/ipc) fills §09 per (brand, week) in
// paid_collab_entries; the SHARED team list of brands lives in paid_collab_brands.
// The APC checkpoint reads these to show §09 read-only (or hide it) + a reminder.
import { supabase } from './supabase';

const ENTRIES = 'paid_collab_entries';
const BRANDS  = 'paid_collab_brands';

async function uid() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

// Default §09 shape — mirrors EMPTY_CHECKPOINT().paidCollab.
export function emptyPaidCollab() {
  return {
    creatorsOnboarded: '', creatorsInPipeline: '', videosCompleted: '',
    totalVideos: '', totalBudget: '', budgetAllocated: '', notes: '',
  };
}

// Any non-empty value → the section counts as filled for the week.
export function isPaidCollabFilled(data) {
  if (!data) return false;
  return Object.values(data).some((v) => v != null && String(v).trim() !== '');
}

// ── shared team brand list ────────────────────────────────────────────
export async function listManagedBrands() {
  const { data, error } = await supabase
    .from(BRANDS)
    .select('brand_id, created_at, brand:brand_id(id, brand_name, client_name, status)')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => (r.brand ? { ...r.brand, added_at: r.created_at } : null)).filter(Boolean);
}

// Just the managed brand ids — for the APC show/hide gate + settings toggles.
export async function listManagedBrandIds() {
  const { data, error } = await supabase.from(BRANDS).select('brand_id');
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.brand_id);
}

export async function addManagedBrand(brandId) {
  const me = await uid();
  const { error } = await supabase.from(BRANDS).insert({ brand_id: brandId, added_by: me });
  if (error) throw new Error(error.message);
}
export async function removeManagedBrand(brandId) {
  const { error } = await supabase.from(BRANDS).delete().eq('brand_id', brandId);
  if (error) throw new Error(error.message);
}

// ── §09 entry per (brand, week) ───────────────────────────────────────
export async function getPaidCollabEntry(brandId, weekStart) {
  const { data, error } = await supabase
    .from(ENTRIES).select('*')
    .eq('brand_id', brandId).eq('week_start', weekStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// Entries for many brands in one week (dashboard status) → { brandId: entry }.
export async function getPaidCollabEntriesForWeek(brandIds, weekStart) {
  if (!brandIds?.length) return {};
  const { data, error } = await supabase
    .from(ENTRIES).select('*')
    .in('brand_id', brandIds).eq('week_start', weekStart);
  if (error) throw new Error(error.message);
  const m = {};
  for (const r of data || []) m[r.brand_id] = r;
  return m;
}

// Upsert — update-then-insert so the row's id/created_at stay stable.
export async function savePaidCollabEntry({ brandId, weekStart, data }) {
  const me = await uid();
  const patch = { brand_id: brandId, week_start: weekStart, data, updated_by: me };
  const { data: upd, error: upErr } = await supabase
    .from(ENTRIES).update(patch)
    .eq('brand_id', brandId).eq('week_start', weekStart)
    .select().maybeSingle();
  if (upErr) throw new Error(upErr.message);
  if (upd) return upd;
  const { data: ins, error: insErr } = await supabase.from(ENTRIES).insert(patch).select().single();
  if (insErr) throw new Error(insErr.message);
  return ins;
}

// APC/TL/OL nudges the paid collab team to fill §09 for this brand+week.
export async function remindPaidCollab(brandId, weekStart) {
  const { data, error } = await supabase.rpc('remind_paid_collab', { p_brand: brandId, p_week: weekStart });
  if (error) throw new Error(error.message);
  return data; // number of team members notified
}
