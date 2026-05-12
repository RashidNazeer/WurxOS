import { lazy } from 'react';

// Wraps React.lazy() with a one-shot reload-on-failure recovery.
//
// Why this exists:
//   Vite emits content-hashed chunk filenames (e.g. TasksPage-abc123.js).
//   When we redeploy, those filenames change. A user who had the old
//   index.html in memory still has references to the old chunk URLs;
//   when they navigate to a route they hadn't visited before, the
//   dynamic import() hits a 404 on the now-missing chunk and the app
//   crashes with "Failed to fetch dynamically imported module".
//
// The fix: catch that import error, mark the page as needing a reload,
// and let the browser fetch the fresh index.html. The new index.html
// references the new chunk filenames, the import succeeds the second
// time. A sessionStorage flag prevents an infinite reload loop if the
// chunk genuinely can't be fetched (e.g. network down).
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    try {
      const mod = await importFn();
      // Success — clear the flag so a *future* stale-deploy can
      // trigger its own single-shot reload.
      try { sessionStorage.removeItem('chunk-reload-pending'); } catch {}
      return mod;
    } catch (firstErr) {
      // Before reloading the page, retry once after a short backoff.
      // Most chunk-load failures are transient network blips (DNS hiccup,
      // wake-from-sleep TCP zombie, captive-portal interception) that
      // resolve within a second. Reloading the whole app for those is
      // jarring and unnecessary. Only if the second attempt also fails
      // do we treat it as a real stale-deploy and reload.
      await new Promise((r) => setTimeout(r, 500));
      try {
        const mod = await importFn();
        try { sessionStorage.removeItem('chunk-reload-pending'); } catch {}
        return mod;
      } catch (secondErr) {
        const pending = (() => {
          try { return sessionStorage.getItem('chunk-reload-pending'); }
          catch { return null; }
        })();
        if (!pending) {
          try { sessionStorage.setItem('chunk-reload-pending', '1'); } catch {}
          // Hard reload — bypasses HTTP cache so we definitely fetch
          // the new index.html.
          window.location.reload();
          // The reload kills this Promise chain, but React still wants
          // a module shape. Return a noop component to keep types happy.
          return { default: () => null };
        }
        // We've already reloaded once and the import is still failing.
        // Bubble the original error so it surfaces to the user instead
        // of looping.
        throw secondErr;
      }
    }
  });
}
