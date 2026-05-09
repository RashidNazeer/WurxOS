import { supabase } from './supabase';

// Calls the create-user Edge Function with the caller's JWT.
// Returns the created profile row on success, throws on failure.
export async function createUser({ email, password, displayName, role, reportsTo = null, permissions = {}, responsibilities = [] }) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');

  const { data, error } = await supabase.functions.invoke('create-user', {
    body: { email, password, displayName, role, reportsTo, permissions, responsibilities },
  });
  if (error) {
    // Edge Functions return non-2xx as `error` with a context blob.
    let msg = error.message;
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch {}
    throw new Error(msg || 'Failed to create user.');
  }
  return data;
}

// Direct update via RLS — Boss has full write access on profiles.
export async function updateUserProfile(userId, patch) {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Calls the delete-user Edge Function. Hard-deletes the auth user
// (cascade removes the profile row) so they cannot sign in again.
// Boss-only; the function rejects self-delete and Boss targets.
export async function deleteUser(userId) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');

  const { data, error } = await supabase.functions.invoke('delete-user', {
    body: { userId },
  });
  if (error) {
    let msg = error.message;
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch {}
    throw new Error(msg || 'Failed to delete user.');
  }
  return data;
}

export async function listProfilesByRole(role) {
  // Join parent profile (reports_to → profiles) so we can show "Reports to: X"
  // Filter out soft-deleted users (deleted_at IS NOT NULL).
  const { data, error } = await supabase
    .from('profiles')
    .select('*, parent:reports_to(id, display_name, role)')
    .eq('role', role)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// Active users of a given role — used to populate the "Reports to" dropdown
// in CreateUserModal / EditUserModal (e.g. pick a TL for a new APC).
export async function listActiveParentsOfRole(parentRole) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('role', parentRole)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function countProfilesByRole() {
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  const counts = { boss: 0, ol: 0, tl: 0, pctl: 0, apc: 0, ipc: 0, developer: 0 };
  (data || []).forEach((row) => {
    if (counts[row.role] != null) counts[row.role]++;
  });
  return counts;
}

// Boss-only nuclear button — wipes operational data AND deletes
// every user account except the calling Boss. Goes through the
// wipe-data Edge Function which runs in two phases:
//   1. wipe_all_operational_data() RPC — TRUNCATEs operational tables
//   2. admin.auth.admin.deleteUser(id) for every non-caller auth user
// Returns: { summary: [{table_name, rows_before}], deletedUsers, ... }
export async function wipeAllOperationalData() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in.');

  const { data, error } = await supabase.functions.invoke('wipe-data', { body: {} });
  if (error) {
    let msg = error.message;
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error;
    } catch {}
    throw new Error(msg || 'Failed to wipe data.');
  }
  return data;
}

export function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}
