// Client for weekly_checkpoints (migration 264). One row per brand per week.
import { supabase } from './supabase';

const TABLE = 'weekly_checkpoints';

async function uid() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

// Week rows for a brand (newest first) — for the navigator's "has data" markers.
export async function listCheckpoints(brandId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, week_start, week_label, status, updated_at')
    .eq('brand_id', brandId)
    .order('week_start', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// One brand+week checkpoint, or null.
export async function getCheckpoint(brandId, weekStart) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('brand_id', brandId)
    .eq('week_start', weekStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// The most recent checkpoint strictly BEFORE weekStart (for carry-forward).
export async function findPreviousCheckpoint(brandId, weekStart) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('brand_id', brandId)
    .lt('week_start', weekStart)
    .order('week_start', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// Upsert a checkpoint. Update-then-insert so the original author_id is
// preserved across edits (a plain upsert would overwrite it).
export async function saveCheckpoint({ brandId, weekStart, weekLabel, data, status = 'draft' }) {
  const me = await uid();
  const patch = {
    brand_id: brandId, week_start: weekStart, week_label: weekLabel,
    data, status, updated_by: me, updated_at: new Date().toISOString(),
  };
  const { data: upd, error: upErr } = await supabase
    .from(TABLE).update(patch)
    .eq('brand_id', brandId).eq('week_start', weekStart)
    .select().maybeSingle();
  if (upErr) throw new Error(upErr.message);
  if (upd) return upd;

  const { data: ins, error: insErr } = await supabase
    .from(TABLE).insert({ ...patch, author_id: me })
    .select().single();
  if (insErr) throw new Error(insErr.message);
  return ins;
}

export async function deleteCheckpoint(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(error.message);
}
