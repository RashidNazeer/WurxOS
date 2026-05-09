import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase env vars. Check .env.local for VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// Debug helper — exposes the authenticated client on the window so
// the Boss can call diagnostic RPCs like debug_recurring_reset() from
// the browser console without needing a UI surface for it. Safe to
// keep in production: it only exposes what the user's own session
// already permits via RLS.
if (typeof window !== 'undefined') {
  window.__sb = supabase;
}
