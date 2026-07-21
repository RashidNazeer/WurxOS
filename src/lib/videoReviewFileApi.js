// Client for the file-based Video Reviews mode (migration 258).
// The heavy parsing lives in a worker; the queue math in videoReviewQueue.js.
// This module is just the Supabase I/O: brands, baseline, tracker, mark-sent.
import { supabase } from './supabase';

export { downloadHandlesCsv } from './videoReviewApi';

// Normalized creator key — matches videoReviewQueue's default keyOf and the
// `creator` column in video_review_progress.
export const creatorKey = (name) => String(name ?? '').trim().replace(/^@+/, '').toLowerCase();

// Brands the current user may run reviews for: the Boss sees all; an APC sees
// the brands they're assigned to. (File mode needs no Euka link.)
export async function listMyReviewBrands() {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess?.session?.user?.id;
  if (!uid) return [];
  const { data: prof } = await supabase.from('profiles').select('role').eq('id', uid).maybeSingle();
  const isBoss = prof?.role === 'boss';
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, assignments:brand_assignments(user_id)')
    .order('brand_name');
  if (error) throw new Error(error.message);
  const rows = (data || []).filter((b) => isBoss || (b.assignments || []).some((a) => a.user_id === uid));
  return rows.map((b) => ({ id: b.id, brand_name: b.brand_name }));
}

// (The single "sending reviews for" date does the baseline's job now, so the
// per-brand baseline table video_review_settings is no longer read/written.)

// All tracker rows for a brand -> Map(creatorKey -> { sentCount, lastSentDate }).
// Paginated: completed creators (sent_count=3) stay forever, so a brand can
// exceed PostgREST's 1000-row page cap. We need ALL rows (a completed creator
// omitted here would be wrongly re-seeded from the baseline and messaged again).
export async function fetchTracker(brandId) {
  const map = new Map();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('video_review_progress')
      .select('creator, sent_count, last_sent_date')
      .eq('brand_id', brandId)
      .order('creator')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data || []) {
      map.set(r.creator, { sentCount: r.sent_count, lastSentDate: r.last_sent_date });
    }
    if (!data || data.length < PAGE) break;
  }
  return map;
}

// Persist "these creators just got their next message on runDate".
// `updates` = [{ key, sentCount, lastSentDate }] from markSentUpdates().
export async function markSent(brandId, updates) {
  if (!updates?.length) return 0;
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess?.session?.user?.id || null;
  const now = new Date().toISOString();
  const rows = updates.map((u) => ({
    brand_id: brandId,
    creator: u.key,
    sent_count: u.sentCount,
    last_sent_date: u.lastSentDate,
    updated_at: now,
    updated_by: uid,
  }));
  // Chunk to stay well under any request-size limits.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('video_review_progress')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'brand_id,creator' });
    if (error) throw new Error(error.message);
  }
  return rows.length;
}
