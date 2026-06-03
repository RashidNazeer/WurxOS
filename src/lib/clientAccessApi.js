// Client Access Links API.
//
// One row per shareable link. Each link bundles a set of brands with
// any subset of share types (weekly/biweekly/paidCollab/gmvMax).
//
// The public RPC get_client_access(token) returns the access record
// plus all permitted data (brands + reports + gmv_max). Paid collab
// data is fetched client-side from the external wurx-base API using
// the brand list returned here.

import { supabase } from './supabase';

export const SHARE_TYPE_OPTIONS = [
  { id: 'weekly',     label: 'Weekly Reports',     icon: 'bi-file-earmark-bar-graph' },
  { id: 'biweekly',   label: 'Bi-Weekly Reports',  icon: 'bi-calendar2-week-fill' },
  { id: 'monthly',    label: 'Monthly Reports',    icon: 'bi-calendar3' },
  { id: 'paidCollab', label: 'Paid Collab',        icon: 'bi-handshake' },
  { id: 'gmvMax',     label: 'GMV Max Reporting',  icon: 'bi-bar-chart-line-fill' },
];

export const SHARE_TYPE_COLORS = {
  weekly:     { bg: '#fef3c7', fg: '#92400e' },
  biweekly:   { bg: '#e0f2fe', fg: '#075985' },
  monthly:    { bg: '#ede9fe', fg: '#5b21b6' },
  paidCollab: { bg: '#fef2f2', fg: '#9f1239' },
  gmvMax:     { bg: '#cffafe', fg: '#0e7490' },
};

function randomToken(len = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

export async function listClientAccessLinks() {
  const { data, error } = await supabase
    .from('client_access')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createClientAccessLink({
  label = '', clientName = '',
  brandIds = [], shareTypes = [],
  expiresAt = null,
}) {
  if (!brandIds.length)   throw new Error('Select at least one brand.');
  if (!shareTypes.length) throw new Error('Select at least one share type.');

  const { data: me } = await supabase.auth.getUser();
  const { data: prof } = await supabase.from('profiles')
    .select('display_name').eq('id', me?.user?.id).maybeSingle();

  const { data, error } = await supabase
    .from('client_access')
    .insert({
      token: randomToken(),
      label,
      client_name: clientName,
      brand_ids: brandIds,
      share_types: shareTypes,
      active: true,
      expires_at: expiresAt,
      created_by: me?.user?.id,
      created_by_name: prof?.display_name || me?.user?.email || '',
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateClientAccessLink(id, patch) {
  const allowed = {};
  if (patch.label != null)       allowed.label       = patch.label;
  if (patch.clientName != null)  allowed.client_name = patch.clientName;
  if (patch.brandIds  != null)   allowed.brand_ids   = patch.brandIds;
  if (patch.shareTypes != null)  allowed.share_types = patch.shareTypes;
  if (patch.active != null)      allowed.active      = patch.active;
  if (patch.expiresAt !== undefined) allowed.expires_at = patch.expiresAt;
  const { data, error } = await supabase
    .from('client_access')
    .update(allowed).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function revokeClientAccessLink(id) {
  const { error } = await supabase
    .from('client_access')
    .update({ revoked_at: new Date().toISOString(), active: false })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteClientAccessLink(id) {
  const { error } = await supabase.from('client_access').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function fetchSharedAccess(token) {
  const { data, error } = await supabase.rpc('get_client_access', { p_token: token });
  if (error) {
    const code = error.message.match(/access_not_found|access_disabled|access_revoked|access_expired/)?.[0];
    throw Object.assign(new Error(friendly(code) || error.message), { code });
  }
  return data;
}

function friendly(code) {
  switch (code) {
    case 'access_not_found': return 'This link is invalid or has been removed.';
    case 'access_disabled':  return 'Access to this dashboard has been disabled.';
    case 'access_revoked':   return 'This link has been revoked.';
    case 'access_expired':   return 'This link has expired.';
    default: return null;
  }
}

// Domain hosting v1 — Firebase Hosting redirects /client/<token> to
// v2's /portal/access/<token>, so the v1 URL still works for the 32
// historical links we synced over. Boss/OL sees the original v1 URL
// for those rows so they don't accidentally re-share a URL the
// client doesn't recognise.
const V1_BASE = 'https://wurxos.web.app';

export function buildClientAccessUrl(token, opts = {}) {
  const { legacyV1 = false } = opts;
  if (legacyV1) {
    return `${V1_BASE}/client/${token}`;
  }
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/portal/access/${token}`;
}
