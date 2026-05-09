import { supabase } from './supabase';

function randomToken(len = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join('');
}

export async function listReportShares(reportId) {
  const { data, error } = await supabase
    .from('report_shares')
    .select('*')
    .eq('report_id', reportId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createReportShare(reportId, { expiresAt = null } = {}) {
  const { data: me } = await supabase.auth.getUser();
  const token = randomToken();
  const { data, error } = await supabase
    .from('report_shares')
    .insert({
      token,
      report_id: reportId,
      created_by: me?.user?.id,
      expires_at: expiresAt,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function revokeReportShare(token) {
  const { error } = await supabase
    .from('report_shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token', token);
  if (error) throw new Error(error.message);
}

export async function fetchSharedReport(token) {
  const { data, error } = await supabase.rpc('get_shared_report', { p_token: token });
  if (error) {
    const code = error.message.match(/share_not_found|share_revoked|share_expired|report_not_found|report_not_approved/)?.[0];
    throw Object.assign(new Error(friendly(code) || error.message), { code });
  }
  return data;
}

function friendly(code) {
  switch (code) {
    case 'share_not_found':      return 'This link is invalid.';
    case 'share_revoked':        return 'This link has been revoked.';
    case 'share_expired':        return 'This link has expired.';
    case 'report_not_found':     return 'The underlying report no longer exists.';
    case 'report_not_approved':  return 'The report is no longer approved and cannot be shared.';
    default: return null;
  }
}

export function buildShareUrl(token) {
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/portal/reports/${token}`;
}
