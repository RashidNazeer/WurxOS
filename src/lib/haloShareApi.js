// ============================================================
// Amazon Halo share links — Boss creates/lists/revokes (RLS-guarded);
// anon clients read via the SECURITY DEFINER RPCs. Mirrors
// reportShareApi.js. A link exposes the WHOLE Halo (all datasets).
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

export async function createHaloShare({ label = '', expiresAt = null } = {}) {
  const { data: me } = await supabase.auth.getUser();
  const token = randomToken();
  const { data, error } = await supabase
    .from('halo_shares')
    .insert({
      token,
      label,
      created_by: me?.user?.id,
      expires_at: expiresAt,
    })
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
  // Normalise dataset-level fields so the explorer's granularity gating works
  // the same as the Boss loader (missing jsonb → sensible defaults).
  return {
    ...data,
    datasets: (data?.datasets || []).map((d) => ({
      ...d,
      currency: d.currency || '$',
      weekly_keywords: d.weekly_keywords || [],
      metric_gran: d.metric_gran || {},
      weekly_metrics: d.weekly_metrics || [],
      monthly_metrics: d.monthly_metrics || [],
    })),
  };
}

export async function fetchSharedHaloRows(token, datasetId) {
  const { data, error } = await supabase.rpc('get_shared_halo_rows', {
    p_token: token,
    p_dataset_id: datasetId,
  });
  if (error) {
    const code = error.message.match(/share_not_found|share_revoked|share_expired/)?.[0];
    throw Object.assign(new Error(friendly(code) || error.message), { code });
  }
  // Normalise to the same shape getHaloRows() returns so the explorer
  // is loader-agnostic.
  return (data || []).map((r) => ({
    date: r.date,
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
    default: return null;
  }
}

export function buildHaloShareUrl(token) {
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/portal/halo/${token}`;
}
