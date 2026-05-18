import { lazy } from 'react';
import { requestAppReload, clearReloadGuard } from './appUpdate';
import ChunkReloadNotice from '../components/common/ChunkReloadNotice';

// Wraps React.lazy() with a non-destructive stale-deploy recovery.
//
// Why this exists:
//   Vite emits content-hashed chunk filenames (e.g. TasksPage-abc123.js).
//   When we redeploy, those filenames change. A user who had the old
//   index.html in memory still has references to the old chunk URLs;
//   when they navigate to a route they hadn't visited before, the
//   dynamic import() hits a 404 on the now-missing chunk.
//
// Recovery (see appUpdate.js for the full rationale):
//   1. Retry the import once after a short backoff — most chunk-load
//      failures are transient network blips, not a real stale deploy.
//   2. If it still fails, hand off to requestAppReload(). That reloads
//      ONLY when the user has no unsaved work; otherwise it raises the
//      "update available" banner and we render a calm refresh notice
//      instead of a blank page. Critically, it never reloads out from
//      under an in-progress form.
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    try {
      const mod = await importFn();
      clearReloadGuard(); // clean load — reset the one-shot guard
      return mod;
    } catch (firstErr) {
      // Retry once after a short backoff. Most chunk-load failures
      // are transient (DNS hiccup, wake-from-sleep TCP zombie,
      // captive-portal interception) and resolve within a second.
      await new Promise((r) => setTimeout(r, 500));
      try {
        const mod = await importFn();
        clearReloadGuard();
        return mod;
      } catch (secondErr) {
        // Genuine stale deploy (or sustained outage). Route through
        // the coordinator: it reloads only when nothing is unsaved.
        const reloaded = requestAppReload('chunk-load');
        // If it reloaded, this Promise is moot but React still wants
        // a module shape — return a noop. If it deferred (unsaved
        // work, or already retried), render the refresh notice so
        // the user keeps their data and reloads when ready.
        return { default: reloaded ? () => null : ChunkReloadNotice };
      }
    }
  });
}
