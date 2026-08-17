// ============================================================
// Edge Function: tiktok-oauth
//
// The server half of the TikTok Business API (Marketing API) advertiser
// authorization. It exists for exactly one reason: the app SECRET must never
// reach a browser. TikTok's token exchange requires app_id + secret + auth_code
// together, so the trade has to happen somewhere the secret is safe. That is
// here.
//
// WHAT "TOKEN EXCHANGE" MEANS, in one paragraph. When an advertiser approves
// our app, TikTok does NOT hand us a key. It redirects their browser back to
// our redirect URL carrying a short-lived, single-use `auth_code` — a claim
// ticket, useless on its own and worthless to a thief after one use. Our server
// then presents that ticket together with the app secret (proving we are the
// app the advertiser approved) and TikTok returns the real access token. The
// token is the long-lived credential that reads their ad data. Splitting it in
// two is what stops a stolen redirect URL from being a stolen ad account.
//
// ACTIONS (POST { action, ... }):
//   start      → authed (boss/ol/ads_manager). Mints a single-use state nonce
//                and returns the TikTok authorization URL to send the user to.
//   callback   → ANONYMOUS but nonce-gated. { auth_code, state }. Validates the
//                nonce, exchanges the code, stores the token + advertiser list.
//   list       → authed. Connected advertiser accounts (never the token).
//   verify     → authed (boss/ol). Re-calls /oauth2/advertiser/get/ with each
//                stored token to prove it still works and refresh names.
//   disconnect → authed (boss/ol). Revokes a connection and drops its accounts.
//
// SCOPE DISCIPLINE. This function only ever calls /oauth2/access_token/ and
// /oauth2/advertiser/get/. Both are covered by the approved "Ad Account
// Information" scope. Do not add calls to endpoints outside the five approved
// scopes — out-of-scope calls fail and repeated failures are a bad look on a
// freshly approved app.
//
// Env (supabase secrets set):
//   TIKTOK_APP_ID        7674829988993957908
//   TIKTOK_APP_SECRET    from the portal (App Detail → Secret) — SECRET
//   TIKTOK_REDIRECT_URI  https://wurxos.vercel.app/oauth/tiktok/callback
//                        MUST byte-match the portal's redirect URL or TikTok
//                        rejects the exchange.
//   TIKTOK_API_BASE      optional; set to https://sandbox-ads.tiktok.com/open_api
//                        to work against the sandbox instead of production.
//
// Deploy: supabase functions deploy tiktok-oauth
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const APP_ID       = Deno.env.get('TIKTOK_APP_ID') || '';
const APP_SECRET   = Deno.env.get('TIKTOK_APP_SECRET') || '';
const REDIRECT_URI = Deno.env.get('TIKTOK_REDIRECT_URI') || '';
const API_BASE     = (Deno.env.get('TIKTOK_API_BASE') || 'https://business-api.tiktok.com/open_api').replace(/\/+$/, '');
const API_VERSION  = Deno.env.get('TIKTOK_API_VERSION') || 'v1.3';

// The portal's own "Advertiser authorization URL" points at /portal/auth.
const AUTH_PORTAL = 'https://business-api.tiktok.com/portal/auth';

const STATE_TTL_MIN = 15;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function api(path: string): string {
  return `${API_BASE}/${API_VERSION}${path}`;
}

// TikTok answers HTTP 200 even for failures and puts the real verdict in
// `code` (0 = OK). Treating a 200 as success is the classic way to store a
// token that was never issued.
type TikTokResult = { ok: boolean; code: number; message: string; data: any };

async function tiktok(url: string, init: RequestInit): Promise<TikTokResult> {
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { code: -1, message: text }; }
  const code = Number(parsed?.code ?? -1);
  return {
    ok: res.ok && code === 0,
    code,
    message: String(parsed?.message ?? (res.ok ? 'OK' : `HTTP ${res.status}`)),
    data: parsed?.data ?? null,
  };
}

// Caller must be an active profile in one of `roles`. Returns the profile.
async function requireRole(req: Request, roles: string[]) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: json({ error: 'unauthenticated' }, 401) };
  const { data: userData, error } = await admin.auth.getUser(token);
  if (error || !userData?.user) return { error: json({ error: 'unauthenticated' }, 401) };
  // Select ONLY what this check uses. An earlier version also asked for
  // `full_name`, which does not exist on profiles (the column is
  // display_name) — PostgREST failed the whole select, `profile` came back
  // null, and every role including Boss was told "forbidden". Reporting the
  // read error separately is what keeps a schema mistake from masquerading
  // as a permission problem again.
  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (profErr) {
    return { error: json({ error: `could not read your profile: ${profErr.message}` }, 500) };
  }
  if (!profile) return { error: json({ error: 'no profile found for this account' }, 403) };
  if (profile.is_active === false) return { error: json({ error: 'your account is inactive' }, 403) };
  if (!roles.includes(profile.role)) {
    return { error: json({ error: `forbidden — ${roles.join('/')} only (you are ${profile.role})` }, 403) };
  }
  return { profile };
}

function configError(): Response | null {
  const missing = [
    !APP_ID && 'TIKTOK_APP_ID',
    !APP_SECRET && 'TIKTOK_APP_SECRET',
    !REDIRECT_URI && 'TIKTOK_REDIRECT_URI',
  ].filter(Boolean);
  if (missing.length) {
    return json({ error: `TikTok app not configured — missing secret(s): ${missing.join(', ')}` }, 500);
  }
  return null;
}

// Pull advertiser id + name for a token. This is the only read we make, and it
// doubles as the health check: if it returns 0 the token is alive.
async function fetchAdvertisers(accessToken: string) {
  const qs = new URLSearchParams({ app_id: APP_ID, secret: APP_SECRET });
  return await tiktok(`${api('/oauth2/advertiser/get/')}?${qs}`, {
    method: 'GET',
    headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const payload = await req.json().catch(() => ({}));
    const action = String(payload?.action || '');

    // ────────────────────────────────────────────────────────────────
    // start — mint a nonce, hand back the URL to send the advertiser to
    // ────────────────────────────────────────────────────────────────
    if (action === 'start') {
      const cfg = configError(); if (cfg) return cfg;
      const { error, profile } = await requireRole(req, ['boss', 'ol', 'ads_manager']);
      if (error) return error;

      const state = crypto.randomUUID().replace(/-/g, '');
      const expiresAt = new Date(Date.now() + STATE_TTL_MIN * 60_000).toISOString();

      const { error: insErr } = await admin.from('tiktok_oauth_states').insert({
        state,
        created_by: profile!.id,
        expires_at: expiresAt,
        note: String(payload?.note || '').slice(0, 200) || null,
      });
      if (insErr) return json({ error: `could not start authorization: ${insErr.message}` }, 500);

      // Best-effort tidy-up of old nonces; never block the flow on it.
      admin.rpc('tiktok_purge_expired_states').then(() => {}, () => {});

      const url = `${AUTH_PORTAL}?app_id=${encodeURIComponent(APP_ID)}`
        + `&state=${encodeURIComponent(state)}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

      return json({ url, state, expiresAt });
    }

    // ────────────────────────────────────────────────────────────────
    // callback — the actual token exchange. Anonymous, nonce-gated.
    // ────────────────────────────────────────────────────────────────
    if (action === 'callback') {
      const cfg = configError(); if (cfg) return cfg;

      const authCode = String(payload?.auth_code || payload?.code || '').trim();
      const state    = String(payload?.state || '').trim();
      if (!authCode) return json({ error: 'missing auth_code' }, 400);
      if (!state)    return json({ error: 'missing state' }, 400);

      // Validate the nonce BEFORE spending the auth code.
      const { data: st } = await admin
        .from('tiktok_oauth_states')
        .select('state, created_by, expires_at, used_at')
        .eq('state', state)
        .maybeSingle();

      if (!st) return json({ error: 'This authorization link was not recognised. Start again from Settings.' }, 400);
      if (st.used_at) return json({ error: 'This authorization link has already been used. Start again from Settings.' }, 400);
      if (new Date(st.expires_at).getTime() < Date.now()) {
        return json({ error: `This authorization link expired (it is valid for ${STATE_TTL_MIN} minutes). Start again from Settings.` }, 400);
      }

      // Burn the nonce first. A replay of the same state now fails even if the
      // exchange below is slow or the user double-submits.
      const { error: burnErr } = await admin
        .from('tiktok_oauth_states')
        .update({ used_at: new Date().toISOString() })
        .eq('state', state)
        .is('used_at', null);
      if (burnErr) return json({ error: `could not lock the authorization: ${burnErr.message}` }, 500);

      // Trade the claim ticket for the real credential.
      const ex = await tiktok(api('/oauth2/access_token/'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: APP_ID,
          secret: APP_SECRET,
          auth_code: authCode,
          grant_type: 'auth_code',
        }),
      });

      if (!ex.ok || !ex.data?.access_token) {
        // Surface TikTok's own wording — its messages are specific and are the
        // fastest route to the cause (redirect mismatch, expired code, ...).
        return json({
          error: `TikTok refused the exchange (code ${ex.code}): ${ex.message}`,
          hint: 'The usual causes are a redirect URL that does not byte-match the portal, a reused auth code, or the wrong app secret.',
        }, 400);
      }

      const accessToken: string = ex.data.access_token;
      const scope = ex.data.scope ?? null;
      const advertiserIds: string[] = Array.isArray(ex.data.advertiser_ids)
        ? ex.data.advertiser_ids.map(String) : [];

      const { data: conn, error: connErr } = await admin
        .from('tiktok_connections')
        .insert({
          access_token: accessToken,
          scope,
          connected_by: st.created_by,
          last_verified_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (connErr || !conn) return json({ error: `could not store the connection: ${connErr?.message}` }, 500);

      // Name the accounts. Non-fatal: the connection is already good, and
      // `verify` can fill names in later.
      const info = await fetchAdvertisers(accessToken);
      const nameById = new Map<string, string>();
      if (info.ok && Array.isArray(info.data?.list)) {
        for (const a of info.data.list) {
          if (a?.advertiser_id) nameById.set(String(a.advertiser_id), String(a.advertiser_name || ''));
        }
      }

      const ids = advertiserIds.length ? advertiserIds : [...nameById.keys()];
      const rows = ids.map((id) => ({
        advertiser_id: id,
        advertiser_name: nameById.get(id) || null,
        connection_id: conn.id,
        is_active: true,
        updated_at: new Date().toISOString(),
      }));

      if (rows.length) {
        // An advertiser re-authorizing points its row at the NEW connection.
        const { error: upErr } = await admin
          .from('tiktok_ad_accounts')
          .upsert(rows, { onConflict: 'advertiser_id' });
        if (upErr) return json({ error: `connected, but could not save the accounts: ${upErr.message}` }, 500);
      }

      return json({
        connected: true,
        connectionId: conn.id,
        accounts: rows.map((r) => ({ advertiserId: r.advertiser_id, name: r.advertiser_name })),
        scope,
        namesResolved: info.ok,
        noteIfNoAccounts: rows.length ? null
          : 'TikTok returned no advertiser accounts for this authorization. The person who approved it may not have selected an ad account.',
      });
    }

    // ────────────────────────────────────────────────────────────────
    // list — what is connected right now (no secrets)
    // ────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const { error } = await requireRole(req, ['boss', 'ol', 'ads_manager']);
      if (error) return error;

      const { data: accounts } = await admin
        .from('tiktok_ad_accounts')
        .select('advertiser_id, advertiser_name, brand_id, is_active, connected_at, connection_id')
        .order('connected_at', { ascending: false });

      const { data: conns } = await admin
        .from('tiktok_connections')
        .select('id, connected_at, last_verified_at, last_error, revoked_at, scope')
        .is('revoked_at', null)
        .order('connected_at', { ascending: false });

      return json({
        accounts: accounts || [],
        connections: (conns || []).map((c) => ({
          id: c.id,
          connectedAt: c.connected_at,
          lastVerifiedAt: c.last_verified_at,
          lastError: c.last_error,
          scope: c.scope,
        })),
        configured: !configError(),
        sandbox: API_BASE.includes('sandbox'),
      });
    }

    // ────────────────────────────────────────────────────────────────
    // verify — prove the stored tokens still work, refresh names
    // ────────────────────────────────────────────────────────────────
    if (action === 'verify') {
      const cfg = configError(); if (cfg) return cfg;
      const { error } = await requireRole(req, ['boss', 'ol']);
      if (error) return error;

      const { data: conns } = await admin
        .from('tiktok_connections')
        .select('id, access_token')
        .is('revoked_at', null);

      if (!conns?.length) return json({ results: [], message: 'No TikTok account is connected yet.' });

      const results: any[] = [];
      for (const c of conns) {
        const info = await fetchAdvertisers(c.access_token);
        const now = new Date().toISOString();

        if (info.ok && Array.isArray(info.data?.list)) {
          for (const a of info.data.list) {
            if (!a?.advertiser_id) continue;
            await admin.from('tiktok_ad_accounts').upsert({
              advertiser_id: String(a.advertiser_id),
              advertiser_name: String(a.advertiser_name || ''),
              connection_id: c.id,
              is_active: true,
              updated_at: now,
            }, { onConflict: 'advertiser_id' });
          }
        }

        await admin.from('tiktok_connections').update({
          last_verified_at: now,
          last_error: info.ok ? null : `code ${info.code}: ${info.message}`,
        }).eq('id', c.id);

        results.push({
          connectionId: c.id,
          ok: info.ok,
          message: info.ok ? 'Token is live' : `code ${info.code}: ${info.message}`,
          accounts: info.ok && Array.isArray(info.data?.list)
            ? info.data.list.map((a: any) => ({
                advertiserId: String(a.advertiser_id), name: String(a.advertiser_name || ''),
              }))
            : [],
        });
      }
      return json({ results });
    }

    // ────────────────────────────────────────────────────────────────
    // disconnect
    // ────────────────────────────────────────────────────────────────
    if (action === 'disconnect') {
      const { error } = await requireRole(req, ['boss', 'ol']);
      if (error) return error;

      const connectionId = String(payload?.connectionId || '').trim();
      if (!connectionId) return json({ error: 'missing connectionId' }, 400);

      // Clear the token as well as flagging it: a revoked row should not keep a
      // usable credential sitting in the table.
      const { error: revErr } = await admin
        .from('tiktok_connections')
        .update({ revoked_at: new Date().toISOString(), access_token: '' })
        .eq('id', connectionId);
      if (revErr) return json({ error: revErr.message }, 500);

      await admin.from('tiktok_ad_accounts').delete().eq('connection_id', connectionId);
      return json({ disconnected: true });
    }

    return json({ error: `unknown action: ${action || '(none)'}` }, 400);
  } catch (err) {
    console.error('tiktok-oauth failed:', err);
    return json({ error: String(err) }, 500);
  }
});
