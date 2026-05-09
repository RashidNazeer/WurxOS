import { supabase } from './supabase';

export const SUGGESTION_CATEGORIES = [
  { key: 'feature',     label: 'New Feature', color: '#6610f2' },
  { key: 'improvement', label: 'Improvement', color: '#2563eb' },
  { key: 'bug_fix',     label: 'Bug Fix',     color: '#dc3545' },
  { key: 'ui_ux',       label: 'UI / UX',     color: '#fd7e14' },
  { key: 'other',       label: 'Other',       color: '#6c757d' },
];

export const SUGGESTION_STATUSES = [
  { key: 'new',         label: 'New',         fg: '#4b5563', bg: '#f3f4f6' },
  { key: 'in_review',   label: 'In Review',   fg: '#1e40af', bg: '#dbeafe' },
  { key: 'planned',     label: 'Planned',     fg: '#92400e', bg: '#fff3e0' },
  { key: 'implemented', label: 'Implemented', fg: '#166534', bg: '#ecfdf5' },
  { key: 'rejected',    label: 'Rejected',    fg: '#991b1b', bg: '#fef2f2' },
];

export const suggestionCategoryMeta = (k) =>
  SUGGESTION_CATEGORIES.find((x) => x.key === k) || SUGGESTION_CATEGORIES[4];
export const suggestionStatusMeta = (k) =>
  SUGGESTION_STATUSES.find((x) => x.key === k) || SUGGESTION_STATUSES[0];

// --------------------------------------------------------------
// List + mutations
//
// We pull the per-caller upvote flag via a second targeted query
// (one round trip, small payload) so the UI knows which cards the
// current user has already voted on.
// --------------------------------------------------------------
export async function listSuggestions({ status, category, q, scope = 'all' } = {}) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;

  let query = supabase
    .from('suggestions')
    .select('*, submitter:submitted_by(id, display_name, role, avatar_url)');
  if (status && status !== 'all')     query = query.eq('status', status);
  if (category && category !== 'all') query = query.eq('category', category);
  if (scope === 'mine' && uid)        query = query.eq('submitted_by', uid);
  if (q) {
    const qq = q.replace(/%/g, '').trim();
    if (qq) {
      query = query.or(`title.ilike.%${qq}%,description.ilike.%${qq}%,submitted_by_name.ilike.%${qq}%`);
    }
  }
  query = query.order('upvote_count', { ascending: false }).order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  if (!uid || !data?.length) {
    return (data || []).map((r) => ({ ...r, i_upvoted: false }));
  }
  const { data: votes } = await supabase
    .from('suggestion_upvotes')
    .select('suggestion_id')
    .eq('user_id', uid)
    .in('suggestion_id', data.map((d) => d.id));
  const mine = new Set((votes || []).map((v) => v.suggestion_id));
  return data.map((r) => ({ ...r, i_upvoted: mine.has(r.id) }));
}

export async function createSuggestion({ category, title, description }) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');
  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  const { data, error } = await supabase
    .from('suggestions')
    .insert({
      category,
      title:             title.trim(),
      description:       description.trim(),
      submitted_by:      uid,
      submitted_by_name: profile?.display_name || null,
      submitted_by_role: profile?.role || null,
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateSuggestion(id, patch) {
  const { data: me } = await supabase.auth.getUser();
  const body = { ...patch };
  // If status is changing, stamp reviewer info.
  if ('status' in body) {
    body.reviewed_by      = me?.user?.id ?? null;
    // reviewed_by_name is best filled client-side when we know it,
    // but we still accept it from caller if provided.
  }
  if ('dev_notes' in body && body.dev_notes != null) body.dev_notes = body.dev_notes.trim() || null;
  const { data, error } = await supabase
    .from('suggestions').update(body).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteSuggestion(id) {
  const { error } = await supabase.from('suggestions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Toggle: one row per (user, suggestion) guarded by the PK, so we
// optimistically try to insert; if it already exists (conflict), we
// delete instead — effectively a toggle.
export async function toggleUpvote(suggestionId, currentlyUpvoted) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');

  if (currentlyUpvoted) {
    const { error } = await supabase
      .from('suggestion_upvotes')
      .delete()
      .eq('suggestion_id', suggestionId)
      .eq('user_id', uid);
    if (error) throw new Error(error.message);
    return { upvoted: false };
  }
  const { error } = await supabase
    .from('suggestion_upvotes')
    .insert({ suggestion_id: suggestionId, user_id: uid });
  if (error) throw new Error(error.message);
  return { upvoted: true };
}
