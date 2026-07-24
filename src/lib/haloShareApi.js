// ============================================================
// Amazon Halo share links — Boss/OL create/list/revoke (RLS-guarded); anon
// clients read via the SECURITY DEFINER RPCs. A link is scoped to one or more
// BRANDS (halo_shares.brand_ids) — the client sees only those brands' Halo.
// ============================================================

import { supabase } from './supabase';

function randomToken(len = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

export async function listHaloShares() {
  const { data, error } = await supabase
    .from('halo_shares')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createHaloShare({ label = '', brandIds = [], expiresAt = null } = {}) {
  if (!brandIds || !brandIds.length) throw new Error('Pick at least one brand for this link.');
  const { data: me } = await supabase.auth.getUser();
  const token = randomToken();
  const { data, error } = await supabase
    .from('halo_shares')
    .insert({ token, label, brand_ids: brandIds, created_by: me?.user?.id, expires_at: expiresAt })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function revokeHaloShare(token) {
  const { error } = await supabase
    .from('halo_shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token', token);
  if (error) throw new Error(error.message);
}

export async function fetchSharedHalo(token) {
  const { data, error } = await supabase.rpc('get_shared_halo', { p_token: token });
  if (error) {
    const code = error.message.match(/share_not_found|share_revoked|share_expired/)?.[0];
    throw Object.assign(new Error(friendly(code) || error.message), { code });
  }
  return {
    label: data?.label || '',
    brands: data?.brands || [],
    datasets: (data?.datasets || []).map((d) => ({ ...d, currency: d.currency || '$' })),
  };
}

export async function fetchSharedHaloRows(token, datasetId) {
  const { data, error } = await supabase.rpc('get_shared_halo_rows', {
    p_token: token,
    p_dataset_id: datasetId,
  });
  if (error) {
    const code = error.message.match(/share_not_found|share_revoked|share_expired|dataset_out_of_scope/)?.[0];
    throw Object.assign(new Error(friendly(code) || error.message), { code });
  }
  // Same shape getHaloRows() returns so the explorer is loader-agnostic.
  return (data || []).map((r) => ({
    date: r.date,
    periodLabel: r.period_label || null,
    metrics: r.metrics || {},
    productRevenue: r.product_revenue || {},
    keywords: r.keywords || {},
    keywordRanks: r.keyword_ranks || {},
  }));
}

function friendly(code) {
  switch (code) {
    case 'share_not_found': return 'This link is invalid.';
    case 'share_revoked':   return 'This link has been revoked.';
    case 'share_expired':   return 'This link has expired.';
    case 'dataset_out_of_scope': return 'This data is not part of this link.';
    default: return null;
  }
}

export function buildHaloShareUrl(token) {
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/portal/halo/${token}`;
}
