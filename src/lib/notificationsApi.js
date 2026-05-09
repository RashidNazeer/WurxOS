import { supabase } from './supabase';

// --------------------------------------------------------------
// Reads
// --------------------------------------------------------------
export async function listNotifications({ limit = 100, onlyUnread = false } = {}) {
  let q = supabase
    .from('notifications')
    .select('*, actor:actor_id(id, display_name, avatar_url, role)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (onlyUnread) q = q.is('read_at', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// Lightweight — just enough for the bell badge + sidebar dots.
// Returns: { total, byCategory: { task: N, brand: N, ... } }
export async function fetchUnreadCounts() {
  const { data, error } = await supabase
    .from('notifications')
    .select('category')
    .is('read_at', null);
  if (error) throw new Error(error.message);
  const byCategory = {};
  (data || []).forEach((r) => {
    byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  });
  return { total: (data || []).length, byCategory };
}

// --------------------------------------------------------------
// Writes
// --------------------------------------------------------------
export async function markRead(id) {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

export async function markManyRead(ids) {
  if (!ids?.length) return;
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

export async function markAllRead() {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

export async function markCategoryRead(category) {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('category', category)
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

export async function clearRead() {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .not('read_at', 'is', null);
  if (error) throw new Error(error.message);
}

// Relative time helper — "just now", "5m", "2h", "3d", or date.
export function formatRelTime(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 45)      return 'just now';
  if (diff < 3600)    return `${Math.floor(diff / 60)}m`;
  if (diff < 86400)   return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800)  return `${Math.floor(diff / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
