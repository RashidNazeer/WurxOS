import { createClient } from '@supabase/supabase-js';
import { DEMO_MODE, assertAllowedInDemo } from './demoMode';

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
// How long to let a direct auth call stall before routing around it. The
// healthy figure is ~0.3s; the outage figure was ~300s. 8s is far outside
// normal and far inside a user's patience.
const AUTH_STALL_MS = 8000;
// Only calls that are safe to send a second time. A stalled request may
// still have reached the server, so signup / recovery / verification are
// deliberately NOT retried — a duplicate there means a second confirmation
// email or a colliding account, which is worse than a slow request.
const AUTH_REPEATABLE_PATHS = ['/token', '/user', '/logout', '/health', '/settings'];
const isRepeatableAuthCall = (u) => {
  const path = String(u).split('?')[0];
  return AUTH_REPEATABLE_PATHS.some((p) => path.endsWith(p));
};
// The /sb-auth rewrite in vercel.json names the production project explicitly
// (Vercel does not interpolate env vars into rewrites). A demo deployment
// shares that file, so its fallback would aim at production's auth endpoint —
// harmless, since a demo token means nothing there, but it is the wrong server
// and would make a stalled demo login fail in a confusing way. The proxy is a
// contingency for one ISP-level outage on the office network; a demo does not
// need it, so demo builds go direct and only direct.
const canProxy = typeof window !== 'undefined'
  && /^https?:$/.test(window.location.protocol)
  && !DEMO_MODE;
const toProxy = (u) => (canProxy && typeof u === 'string' && u.startsWith(AUTH_DIRECT))
  ? AUTH_PROXY + u.slice(AUTH_DIRECT.length)
  : null;

// Direct first — that is the fast path on a healthy network and adds no hop.
// Only if it STALLS do we abandon it and go via our own origin.
const authAwareFetch = async (input, init) => {
  const proxied = toProxy(input);
  if (!proxied || !isRepeatableAuthCall(input) || init?.signal) {
    return fetch(input, init);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AUTH_STALL_MS);
  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } catch {
    return await fetch(proxied, init);   // direct stalled — route around it
  } finally {
    clearTimeout(timer);
  }
};

const customFetch = async (input, init = {}) => {
  const res = await authAwareFetch(input, init);
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
// In a demo build, stop the calls that would reach a third party (or erase the
// sample data) before they leave the browser. Wrapping the client here means a
// page added later is covered without anyone remembering to gate it — the only
// gap is a call made by raw fetch instead of the client, and those two files
// call assertAllowedInDemo themselves.
//
// Shaped to look exactly like a normal invoke failure ({ data, error }) so no
// caller needs a demo-specific branch.
if (DEMO_MODE) {
  const realInvoke = supabase.functions.invoke.bind(supabase.functions);
  supabase.functions.invoke = async (name, opts) => {
    try {
      assertAllowedInDemo(name);
    } catch (e) {
      return { data: null, error: e };
    }
    return realInvoke(name, opts);
  };
}

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
