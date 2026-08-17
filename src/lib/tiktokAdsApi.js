import { supabase } from './supabase';

// Client for the tiktok-oauth Edge Function (TikTok Business / Marketing API).
//
// Nothing here ever sees an access token — the function deliberately never
// returns one. The browser only learns which advertiser accounts are connected.

// WHY THIS HEADER IS NOT OPTIONAL.
// Supabase edge functions run in the region nearest the caller. Our team is in
// Pakistan, so that region is Mumbai (ap-south-1) — and TikTok's Business API
// refuses every request from India, which has banned TikTok since 2020:
//     code -1 "Client IP address is in banned Country list."
// It looks exactly like a credentials failure and is not one. Pinning the
// invocation is the fix.
//
// Tokyo is chosen over the other working regions because it is also the
// Supabase project's own region, so the function sits next to the database it
// queries instead of calling it across an ocean.
//
// Probed 2026-08-17 via the function's `diagnose` action:
//     ap-south-1 BLOCKED · ap-northeast-1, ap-southeast-1, eu-west-2,
//     us-east-1 all reachable.
// Re-run that action before changing this, rather than guessing.
const TIKTOK_SAFE_REGION = 'ap-northeast-1';

async function call(body, { anon = false } = {}) {
  if (!anon) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in.');
  }
  const { data, error } = await supabase.functions.invoke('tiktok-oauth', {
    body,
    headers: { 'x-region': TIKTOK_SAFE_REGION },
  });
  if (error) {
    // Edge Functions surface non-2xx as `error` with the response in context.
    let msg = error.message;
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.hint ? `${ctx.error} ${ctx.hint}` : ctx.error;
    } catch { /* fall back to the transport message */ }
    throw new Error(msg || 'TikTok request failed.');
  }
  if (data?.error) throw new Error(data.hint ? `${data.error} ${data.hint}` : data.error);
  return data;
}

// Mint a state nonce and get the URL to send the advertiser to.
export function startTikTokAuth(note) {
  return call({ action: 'start', note });
}

// Called from the public callback page. `anon` because the person who
// authorized may not be signed in to WurxOS — the single-use state nonce is
// what authorises this call, not a session.
export function completeTikTokAuth({ authCode, state }) {
  return call({ action: 'callback', auth_code: authCode, state }, { anon: true });
}

export function listTikTokConnections() {
  return call({ action: 'list' });
}

// Live health check: re-reads each token against TikTok.
export function verifyTikTokConnections() {
  return call({ action: 'verify' });
}

export function disconnectTikTok(connectionId) {
  return call({ action: 'disconnect', connectionId });
}

// brand_id is the one column the UI edits directly (RLS: boss/ol).
export async function setAdAccountBrand(advertiserId, brandId) {
  const { error } = await supabase
    .from('tiktok_ad_accounts')
    .update({ brand_id: brandId || null, updated_at: new Date().toISOString() })
    .eq('advertiser_id', advertiserId);
  if (error) throw new Error(error.message);
}
