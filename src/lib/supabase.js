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
const customFetch = async (input, init = {}) => {
  const res = await fetch(input, init);
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
    return await fetch(input, newInit);
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
// the browser console without needing a UI surface for it. Safe to
// keep in production: it only exposes what the user's own session
// already permits via RLS.
if (typeof window !== 'undefined') {
  window.__sb = supabase;
}
