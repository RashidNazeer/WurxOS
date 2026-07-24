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
//
// IMPORTANT: content saves (autosave, "Done") must NOT touch `status` — a
// submitted/verified/approved checkpoint being edited would otherwise get
// silently reverted to 'draft'. `status` is written ONLY when explicitly
// passed (e.g. the workflow functions below); new rows fall back to the DB
// default 'draft' on insert.
export async function saveCheckpoint({ brandId, weekStart, weekLabel, data, status }) {
  const me = await uid();
  const patch = {
    brand_id: brandId, week_start: weekStart, week_label: weekLabel,
    data, updated_by: me, updated_at: new Date().toISOString(),
  };
  if (status) patch.status = status;
  const { data: upd, error: upErr } = await supabase
    .from(TABLE).update(patch)
    .eq('brand_id', brandId).eq('week_start', weekStart)
    .select().maybeSingle();
  if (upErr) throw new Error(upErr.message);
  if (upd) return upd;

  const { data: ins, error: insErr } = await supabase
    .from(TABLE).insert({ ...patch, status: status || 'draft', author_id: me })
    .select().single();
  if (insErr) throw new Error(insErr.message);
  return ins;
}

// Update a checkpoint by id and return the fresh row. maybeSingle() + re-fetch
// fallback survives the RLS edge case where a status change moves the row
// outside the actor's post-update SELECT reach (mirrors reports' _updateAndReturn).
async function _updateAndReturn(id, patch) {
  const { data: saved, error } = await supabase
    .from(TABLE).update(patch).eq('id', id).select().maybeSingle();
  if (error) throw new Error(error.message);
  if (saved) return saved;
  const fresh = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (fresh.data) return fresh.data;
  return { id, ...patch };
}

// ── approval workflow: draft → submitted → verified → approved ────────
// APC submits for the TL to verify. Clears any prior return note.
export async function submitCheckpoint(id) {
  const me = await uid();
  return _updateAndReturn(id, {
    status: 'submitted', submitted_at: new Date().toISOString(), submitted_by: me, return_note: null,
  });
}

// TL verifies; the OL then approves. Clears any prior return note.
export async function verifyCheckpoint(id) {
  const me = await uid();
  return _updateAndReturn(id, {
    status: 'verified', verified_at: new Date().toISOString(), verified_by: me, return_note: null,
  });
}

// OL approves — the terminal state.
export async function approveCheckpoint(id) {
  const me = await uid();
  return _updateAndReturn(id, {
    status: 'approved', approved_at: new Date().toISOString(), approved_by: me,
  });
}

// Return down the chain WITH a note. Default drops one stage (verified →
// submitted = OL back to TL; submitted → draft = TL back to APC). Status +
// note are written in ONE update so the log trigger captures the note.
export async function returnCheckpoint(id, { note, toStatus } = {}) {
  const me = await uid();
  let next = toStatus;
  if (!next) {
    const { data: cur } = await supabase.from(TABLE).select('status').eq('id', id).maybeSingle();
    next = cur?.status === 'verified' ? 'submitted' : 'draft';
  }
  return _updateAndReturn(id, {
    status: next, return_note: note || null,
    returned_at: new Date().toISOString(), returned_by: me,
  });
}

// OL reopens an approved checkpoint to edit (self-edit, no note, not a return).
export async function reopenCheckpoint(id) {
  const me = await uid();
  return _updateAndReturn(id, {
    status: 'verified', return_note: null,
    returned_at: new Date().toISOString(), returned_by: me,
  });
}

// Append-only return history (newest first) with the returner's name. Powers
// the "Checkpoint Returned" notice + history (mig 268). Silent on failure → [].
export async function listCheckpointReturns(id) {
  if (!id) return [];
  const { data, error } = await supabase
    .from('checkpoint_returns')
    .select('id, checkpoint_id, returned_at, from_status, to_status, note, by:returned_by(id, display_name, role)')
    .eq('checkpoint_id', id)
    .order('returned_at', { ascending: false });
  if (error) return [];
  return data || [];
}

// The APC (author) + TL (brand owner) so a return notice can name the
// recipient. Best-effort — returns whatever resolves.
export async function getCheckpointParties(id) {
  if (!id) return { apc: null, tl: null };
  const { data, error } = await supabase
    .from(TABLE)
    .select('author:author_id(id, display_name, role), brand:brand_id(owner_id, owner:owner_id(id, display_name, role))')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return { apc: null, tl: null };
  const apc = data.author ? { id: data.author.id, name: data.author.display_name } : null;
  const owner = data.brand?.owner;
  const tl = owner ? { id: owner.id, name: owner.display_name } : null;
  return { apc, tl };
}

export async function deleteCheckpoint(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// The brand's WEEKLY report weeks (period_start + label), newest first. Used to
// align the checkpoint's week grid to reporting (so week_start == period_start)
// and to show whether a report exists for the selected week (auto-fetch ready).
// Light query — no report `data`. RLS on `reports` still applies.
export async function listReportWeeks(brandId) {
  const { data, error } = await supabase
    .from('reports')
    .select('period_start, period_label')
    .eq('brand_id', brandId)
    .eq('type', 'weekly')
    .order('period_start', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}
