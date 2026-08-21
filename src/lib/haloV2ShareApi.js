// ============================================================
// Amazon Halo V2 client share links (mig 330).
//
// A SEPARATE system from haloShareApi.js on purpose. V2 has its own table and
// its own tokens, so a link is unambiguously V1 or V2: revoking one does not
// touch the other, and a V1 link in a client's inbox can never start rendering
// the V2 model (which says different things and is willing to report a
// negative or refuse a number altogether).
//
// The DATA behind both is the same halo_brands / halo_datasets / halo_rows.
// Only the analysis and the token differ, which is why these return the exact
// shape getHaloRows() does and HaloV2Explorer needs no change to run in the
// portal.
// ============================================================

import { supabase } from './supabase';

function randomToken(len = 32) {
  // Deliberately no look-alike characters (0/O, 1/l/I): these get read down a
  // phone and retyped by clients.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

export async function listHaloV2Shares() {
  const { data, error } = await supabase
    .from('halo_v2_shares')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createHaloV2Share({ label = '', brandIds = [], expiresAt = null } = {}) {
  if (!brandIds || !brandIds.length) throw new Error('Pick at least one brand for this link.');
  const { data: me } = await supabase.auth.getUser();
  const token = randomToken();
  const { data, error } = await supabase
    .from('halo_v2_shares')
    .insert({ token, label, brand_ids: brandIds, created_by: me?.user?.id, expires_at: expiresAt })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function revokeHaloV2Share(token) {
  const { error } = await supabase
    .from('halo_v2_shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token', token);
  if (error) throw new Error(error.message);
}

export async function fetchSharedHaloV2(token) {
  const { data, error } = await supabase.rpc('get_shared_halo_v2', { p_token: token });
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

export async function fetchSharedHaloV2Rows(token, datasetId) {
  const { data, error } = await supabase.rpc('get_shared_halo_v2_rows', {
    p_token: token,
    p_dataset_id: datasetId,
  });
  if (error) {
    const code = error.message.match(/share_not_found|share_revoked|share_expired|dataset_out_of_scope/)?.[0];
    throw Object.assign(new Error(friendly(code) || error.message), { code });
  }
  // Same shape getHaloRows() returns, so the explorer is loader-agnostic.
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

// Note the /halo-v2/ path: a V2 token on the V1 route (or vice versa) resolves
// to nothing, which is the intended outcome rather than a silent fallback.
export function buildHaloV2ShareUrl(token) {
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/portal/halo-v2/${token}`;
}
