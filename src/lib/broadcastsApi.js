import { supabase } from './supabase';

export const BROADCAST_TARGETS = {
  all:     { label: 'Everyone',      desc: 'Fan-out to every active user' },
  role:    { label: 'By role',        desc: 'Pick one or more roles' },
  users:   { label: 'Specific users', desc: 'Hand-picked recipients' },
  my_team: { label: 'My team',        desc: 'Your direct reports' },
  brand:   { label: 'Brand team',     desc: 'Owner + APCs of a brand' },
};

// Which targets each role is allowed to send to.
export function allowedTargetsFor(role) {
  if (!role) return [];
  if (role === 'boss' || role === 'ol' || role === 'developer') {
    return ['all', 'role', 'users', 'brand'];
  }
  if (role === 'tl' || role === 'pctl') {
    return ['my_team', 'users'];
  }
  return []; // apc/ipc can't broadcast
}

export function canBroadcast(role) {
  return allowedTargetsFor(role).length > 0;
}

export async function listBroadcasts({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('broadcasts')
    .select('*, author:author_id(display_name, role, avatar_url)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createBroadcast({
  authorId, title, body,
  target, targetRoles = [], targetUserIds = [], targetBrandId = null,
  scheduledFor = null,
  responseOptions = [],  // array of {id, label}
}) {
  const payload = {
    author_id:        authorId,
    title:            title.trim(),
    body:             (body || '').trim(),
    target,
    target_roles:     target === 'role'  ? targetRoles : [],
    target_user_ids:  target === 'users' ? targetUserIds : [],
    target_brand_id:  target === 'brand' ? targetBrandId : null,
    scheduled_for:    scheduledFor || null,
    response_options: Array.isArray(responseOptions) ? responseOptions : [],
  };
  const { data, error } = await supabase
    .from('broadcasts').insert(payload).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Poll / response APIs
// --------------------------------------------------------------

// Submit or change the current user's response.
export async function submitResponse(broadcastId, option) {
  const { data, error } = await supabase.rpc('broadcast_respond', {
    p_id:           broadcastId,
    p_option_id:    option.id,
    p_option_label: option.label || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

// The caller's own response to a broadcast (or null).
export async function getMyResponse(broadcastId, userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('broadcast_responses')
    .select('*')
    .eq('broadcast_id', broadcastId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// All responses for a broadcast (author / admins only per RLS).
export async function listResponses(broadcastId) {
  const { data, error } = await supabase
    .from('broadcast_responses')
    .select('*, user:user_id(id, display_name, role, avatar_url)')
    .eq('broadcast_id', broadcastId)
    .order('responded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// Expected recipients for a broadcast — used by the author to see
// who's pending.
export async function listRecipients(broadcast) {
  if (!broadcast) return [];
  const base = 'id, display_name, role, avatar_url, email, reports_to';
  const activeBase = supabase.from('profiles').select(base).eq('is_active', true);
  const { target, author_id } = broadcast;

  if (target === 'all') {
    const { data, error } = await activeBase.neq('id', author_id).order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  if (target === 'role' && (broadcast.target_roles || []).length) {
    const { data, error } = await activeBase
      .in('role', broadcast.target_roles)
      .neq('id', author_id)
      .order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  if (target === 'users' && (broadcast.target_user_ids || []).length) {
    const { data, error } = await activeBase
      .in('id', broadcast.target_user_ids)
      .order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  if (target === 'my_team') {
    const { data, error } = await activeBase
      .eq('reports_to', author_id)
      .order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  if (target === 'brand' && broadcast.target_brand_id) {
    const [{ data: brand }, { data: assigns }] = await Promise.all([
      supabase.from('brands').select('owner_id').eq('id', broadcast.target_brand_id).maybeSingle(),
      supabase.from('brand_assignments').select('user_id').eq('brand_id', broadcast.target_brand_id),
    ]);
    const ids = new Set();
    if (brand?.owner_id) ids.add(brand.owner_id);
    (assigns || []).forEach((a) => ids.add(a.user_id));
    ids.delete(author_id);
    if (ids.size === 0) return [];
    const { data, error } = await activeBase
      .in('id', Array.from(ids))
      .order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  return [];
}

// Author-only: ping a specific user who hasn't responded.
export async function renotifyUser(broadcastId, userId) {
  const { error } = await supabase.rpc('broadcast_renotify', {
    p_id:      broadcastId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
}

// Author-only: ping everyone who hasn't responded yet.
export async function renotifyPending(broadcastId) {
  const { data, error } = await supabase.rpc('broadcast_renotify_pending', {
    p_id: broadcastId,
  });
  if (error) throw new Error(error.message);
  return data;  // number pinged
}

// For the audience picker — "people you can broadcast to".
// Boss/OL/dev: everyone active. TL/PCTL: direct reports only.
export async function listRecipientCandidates({ role, uid }) {
  let q = supabase.from('profiles')
    .select('id, display_name, email, role, reports_to, avatar_url')
    .eq('is_active', true)
    .order('display_name');
  if (role === 'tl' || role === 'pctl') q = q.eq('reports_to', uid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).filter((p) => p.id !== uid);
}

// Helper: how many people would receive a broadcast with these params?
export async function previewRecipientCount({
  target, targetRoles = [], targetUserIds = [], targetBrandId = null, authorId,
}) {
  if (target === 'users') return targetUserIds.length;
  if (target === 'my_team') {
    const { count, error } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .eq('reports_to', authorId);
    if (error) return null;
    return count || 0;
  }
  if (target === 'all') {
    const { count, error } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true);
    if (error) return null;
    return Math.max(0, (count || 0) - 1);  // exclude author
  }
  if (target === 'role' && targetRoles.length) {
    // Exclude the author so picking your own role (e.g. an OL targeting
    // "OL") doesn't include yourself. Matches the resolveRecipients
    // fanout, which also does .neq('id', author_id).
    const { count, error } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .in('role', targetRoles)
      .neq('id', authorId);
    if (error) return null;
    return count || 0;
  }
  if (target === 'brand' && targetBrandId) {
    // Brand owner + assignments — exclude author (resolveRecipients
    // does the same on send).
    const [{ data: brand }, { data: assigns }] = await Promise.all([
      supabase.from('brands').select('owner_id').eq('id', targetBrandId).maybeSingle(),
      supabase.from('brand_assignments').select('user_id').eq('brand_id', targetBrandId),
    ]);
    const ids = new Set();
    if (brand?.owner_id) ids.add(brand.owner_id);
    (assigns || []).forEach((a) => ids.add(a.user_id));
    ids.delete(authorId);
    return ids.size;
  }
  return null;
}
