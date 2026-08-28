import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase env vars. Check .env.local for VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  );
}

// Custom fetch wrapper that retries ONCE on JWT-expired responses.
//
// Why: the Supabase client's autoRefreshToken runs on a timer that
// pauses when the tab is backgrounded. If a user backgrounds the
// tab past the 1-hour JWT expiry, then immediately switches back and
// triggers an API call, the call goes out with the stale token and
// the server returns a 401 / "JWT expired" before the auto-refresh
// fires. We catch that response, force a refresh through the auth
// client, and retry the request transparently. The user sees nothing.
//
// Stays a single retry — if the second call also fails, we surface
// the error normally (real refresh-token revocation, etc.).
let supabase;

// ── Auth over our OWN origin, not supabase.co directly ──────────────
// 2026-08-27 outage: staff in both offices could not sign in — the page just
// span forever with no error. Reproduced from the office network: every
// https://<project>.supabase.co/auth/v1/* request took ~300 SECONDS, while
// /rest/v1/* on the exact same host answered in 0.2s. So it is not the app,
// not the database and not Supabase — something on the ISP path mangles that
// one URL prefix. It never errors, it just stalls, which is why the UI showed
// a spinner and nothing else.
//
// Fix: send auth calls to /sb-auth/* on our own domain, which vercel.json
// rewrites to the Supabase auth endpoint SERVER-SIDE. The browser only ever
// talks to wurxos.vercel.app (already fast on those networks); the hop that
// was being throttled now happens inside Vercel.
//
// Falls back to the direct URL if the proxy itself fails, so a bad rewrite
// degrades to today's behaviour rather than locking everyone out.
const AUTH_DIRECT = (url.endsWith('/') ? url : url + '/') + 'auth/v1/';
const AUTH_PROXY  = '/sb-auth/';
const canProxy = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol);
const toProxy = (u) => (canProxy && typeof u === 'string' && u.startsWith(AUTH_DIRECT))
  ? AUTH_PROXY + u.slice(AUTH_DIRECT.length)
  : null;
const customFetch = async (input, init = {}) => {
  // Auth goes through our own origin first (see above). If the proxy itself
  // fails — bad rewrite, Vercel hiccup — fall straight back to the direct URL,
  // so this can never leave us worse off than not having the proxy at all.
  const proxied = toProxy(input);
  let res;
  if (proxied) {
    try {
      res = await fetch(proxied, init);
      if (res.status === 404 || res.status === 502 || res.status === 504) res = await fetch(input, init);
    } catch {
      res = await fetch(input, init);
    }
  } else {
    res = await fetch(input, init);
  }
  if (res.status !== 401) return res;
  // Read once to inspect, but keep the body available for the caller
  // if we decide not to retry.
  const clone = res.clone();
  let body = '';
  try { body = await clone.text(); } catch { /* noop */ }
  const isJwtExpired = /jwt.*expired|invalid.*jwt|invalid.*token/i.test(body);
  if (!isJwtExpired || !supabase) return res;
  // Force a refresh through the auth client. If refresh succeeds,
  // retry once with the new access token in the Authorization header.
  try {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr || !refreshed?.session) return res;
    const newToken = refreshed.session.access_token;
    const newInit = { ...init, headers: new Headers(init.headers || {}) };
    newInit.headers.set('Authorization', `Bearer ${newToken}`);
    newInit.headers.set('apikey', anonKey);
    return await fetch(toProxy(input) || input, newInit);
  } catch {
    return res;
  }
};

supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: {
    fetch: customFetch,
  },
});
export { supabase };

// Debug helper — exposes the authenticated client on the window so
// the Boss can call diagnostic RPCs like debug_recurring_reset() from
// the browser console. RLS still gates everything, BUT having the
// authenticated client one keystroke away in production opens the
// door to console-paste social-engineering attacks against a logged-
// in Boss (and to anything a malicious browser extension can do).
// Restrict to dev builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__sb = supabase;
}
