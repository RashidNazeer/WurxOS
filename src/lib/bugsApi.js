import { supabase } from './supabase';

// --------------------------------------------------------------
// Constants (mirrors v1's color + label tables)
// --------------------------------------------------------------
export const BUG_TYPES = [
  { key: 'ui',          label: 'UI / Visual',     color: '#6366f1' },
  { key: 'functional',  label: 'Functional',      color: '#2563eb' },
  { key: 'performance', label: 'Performance',     color: '#f59e0b' },
  { key: 'data',        label: 'Data / Sync',     color: '#10b981' },
  { key: 'auth',        label: 'Login / Access',  color: '#ef4444' },
  { key: 'other',       label: 'Other',           color: '#6b7280' },
];

export const BUG_PRIORITIES = [
  { key: 'low',      label: 'Low',      fg: '#166534', bg: '#ecfdf5' },
  { key: 'medium',   label: 'Medium',   fg: '#92400e', bg: '#fffbeb' },
  { key: 'high',     label: 'High',     fg: '#991b1b', bg: '#fef2f2' },
  { key: 'critical', label: 'Critical', fg: '#7f1d1d', bg: '#fee2e2' },
];

export const BUG_STATUSES = [
  { key: 'open',         label: 'Open',         fg: '#4338ca', bg: '#eef2ff' },
  { key: 'in_progress',  label: 'In Progress',  fg: '#92400e', bg: '#fffbeb' },
  { key: 'fixed',        label: 'Fixed',        fg: '#166534', bg: '#ecfdf5' },
  { key: 'closed',       label: 'Closed',       fg: '#4b5563', bg: '#f3f4f6' },
  { key: 'temp_closed',  label: 'Temp Closed',  fg: '#5b21b6', bg: '#f5f3ff' },
  { key: 'wont_fix',     label: "Won't Fix",    fg: '#991b1b', bg: '#fef2f2' },
];

export const bugTypeMeta     = (k) => BUG_TYPES.find((x) => x.key === k)       || BUG_TYPES[5];
export const bugPriorityMeta = (k) => BUG_PRIORITIES.find((x) => x.key === k)  || BUG_PRIORITIES[1];
export const bugStatusMeta   = (k) => BUG_STATUSES.find((x) => x.key === k)    || BUG_STATUSES[0];

// --------------------------------------------------------------
// Queries
// --------------------------------------------------------------
// RLS enforces visibility:
//   * reporters see their own bugs
//   * developer / boss see everything
// So one call covers all roles — no separate "mine" query needed.
export async function listBugs({ status, type, priority, reporterRole, q, sort = 'newest' } = {}) {
  let query = supabase
    .from('bug_reports')
    .select('*');

  if (status && status !== 'all')         query = query.eq('status', status);
  if (type && type !== 'all')             query = query.eq('bug_type', type);
  if (priority && priority !== 'all')     query = query.eq('priority', priority);
  if (reporterRole && reporterRole !== 'all') query = query.eq('reporter_role', reporterRole);
  if (q) {
    const qq = q.replace(/%/g, '').trim();
    if (qq) {
      query = query.or(`title.ilike.%${qq}%,description.ilike.%${qq}%,reporter_name.ilike.%${qq}%`);
    }
  }

  if (sort === 'oldest') query = query.order('created_at', { ascending: true });
  else if (sort === 'priority') {
    // Priority-first, then newest — we do priority ordering client-side
    // since text columns don't sort by our enum naturally.
    query = query.order('created_at', { ascending: false });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  if (sort === 'priority') {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    return (data || []).slice().sort((a, b) =>
      (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9)
    );
  }
  return data || [];
}

export async function getBug(id) {
  const { data, error } = await supabase.from('bug_reports').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Mutations
// --------------------------------------------------------------
export async function submitBug({ bugType, priority, title, description }) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');

  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  const { data, error } = await supabase
    .from('bug_reports')
    .insert({
      bug_type:      bugType,
      priority:      priority || 'medium',
      title:         title.trim(),
      description:   description.trim(),
      reporter_id:   uid,
      reporter_name: profile?.display_name || null,
      reporter_role: profile?.role || null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateBug(id, patch) {
  const { data: me } = await supabase.auth.getUser();
  const body = { ...patch };
  if ('dev_notes' in body && body.dev_notes != null) body.dev_notes = body.dev_notes.trim() || null;
  body.last_actor_id = me?.user?.id ?? null;
  const { data, error } = await supabase
    .from('bug_reports')
    .update(body).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteBug(id) {
  const { error } = await supabase.from('bug_reports').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Thread
// --------------------------------------------------------------
export async function listBugMessages(bugId) {
  const { data, error } = await supabase
    .from('bug_report_messages')
    .select('*')
    .eq('bug_id', bugId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function postBugMessage(bugId, text) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');
  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  const { data, error } = await supabase
    .from('bug_report_messages')
    .insert({
      bug_id:      bugId,
      sender_id:   uid,
      sender_name: profile?.display_name || null,
      sender_role: profile?.role || null,
      text:        text.trim(),
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}
