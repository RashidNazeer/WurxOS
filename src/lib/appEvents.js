/**
 * Diagnostic event logger — writes structured client events to the
 * `app_events` table so we can trace the cause of "the app keeps
 * refreshing" reports after the fact.
 *
 * Fire-and-forget. Never blocks the UI. Network errors are swallowed
 * because diagnostic logs that themselves fail loudly would be worse
 * than missing one event.
 */

import { supabase } from './supabase';

// Buffer events and flush in batches so we don't make a network call
// per event. The window's beforeunload also flushes synchronously so
// we don't lose the last few events on a real refresh.
const QUEUE = [];
let flushScheduled = false;
const FLUSH_DELAY_MS = 1500;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flush, FLUSH_DELAY_MS);
}

async function flush() {
  flushScheduled = false;
  if (QUEUE.length === 0) return;
  const batch = QUEUE.splice(0, QUEUE.length);
  try {
    await supabase.from('app_events').insert(batch);
  } catch {
    // Drop — diagnostic isn't worth retrying.
  }
}

// Best-effort: try a synchronous beacon on page unload so the last
// events make it before the page tears down. navigator.sendBeacon
// can't speak the supabase-js POST shape directly, so we just flush
// asynchronously and hope; the next tab visit will pick up where we
// left off.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { flush(); });
  window.addEventListener('pagehide',     () => { flush(); });
}

// Suppress repeats of the same event within a short window.
// Supabase's onAuthStateChange fires SIGNED_IN multiple times per
// session (every focus, every cross-tab broadcast). We don't need
// 50 identical rows in app_events — one per minute is plenty.
const RECENT_DEDUP_MS = 60 * 1000;
const recentSigSeen = new Map(); // signature → timestamp

/**
 * Log an event. `kind` is a short tag; `detail` is any small JSON.
 * `userId` is REQUIRED (RLS gate) — pass null only if logging from
 * a context with no user, in which case the row will be dropped on
 * the server by RLS.
 */
export function logAppEvent(userId, kind, detail = {}) {
  if (!userId) return;
  try {
    // Dedupe identical (user, kind, route) within RECENT_DEDUP_MS.
    // We DON'T include detail in the signature so an expiresAt change
    // (which actually means "fresh token") still gets logged once a
    // minute. recheck_fail and session_invalid are NEVER deduped —
    // those are the ones we actually need every instance of.
    const importantKinds = new Set([
      'auth.recheck_fail', 'auth.session_invalid',
      'auth.signed_out_explicit', 'auth.SIGNED_OUT',
    ]);
    const route = typeof window !== 'undefined' ? (window.location.pathname + window.location.search) : null;
    if (!importantKinds.has(kind)) {
      const sig = `${userId}|${kind}|${route}`;
      const last = recentSigSeen.get(sig) || 0;
      const now = Date.now();
      if (now - last < RECENT_DEDUP_MS) return;
      recentSigSeen.set(sig, now);
      // Bound the map so it doesn't leak forever.
      if (recentSigSeen.size > 200) {
        const cutoff = now - RECENT_DEDUP_MS;
        for (const [k, t] of recentSigSeen) {
          if (t < cutoff) recentSigSeen.delete(k);
        }
      }
    }
    QUEUE.push({
      user_id: userId,
      kind,
      detail: detail || {},
      route,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 240) : null,
    });
    scheduleFlush();
  } catch {
    // Even the queue push could fail in odd environments — never let
    // a diagnostic call throw into the caller.
  }
}
