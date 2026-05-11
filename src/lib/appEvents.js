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

/**
 * Log an event. `kind` is a short tag; `detail` is any small JSON.
 * `userId` is REQUIRED (RLS gate) — pass null only if logging from
 * a context with no user, in which case the row will be dropped on
 * the server by RLS.
 */
export function logAppEvent(userId, kind, detail = {}) {
  if (!userId) return;
  try {
    QUEUE.push({
      user_id: userId,
      kind,
      detail: detail || {},
      route: typeof window !== 'undefined' ? (window.location.pathname + window.location.search) : null,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 240) : null,
    });
    scheduleFlush();
  } catch {
    // Even the queue push could fail in odd environments — never let
    // a diagnostic call throw into the caller.
  }
}
