// ============================================================
// App-update coordinator
//
// Fixes the #1 cause of lost work in WurxOS: a stale-deploy hard
// reload firing while a user is mid-task.
//
// Background
// ----------
// Vite emits content-hashed chunk filenames (TasksPage-ab12.js).
// After a redeploy those filenames change and the old ones 404.
// A browser tab that has been open since before the deploy still
// holds the OLD index.html in memory; the moment it tries to load
// a not-yet-cached chunk (navigating to a new route, or a form
// lazy-loading an editor/PDF parser) the import() hits a 404:
// "Failed to fetch dynamically imported module".
//
// The previous recovery was an immediate window.location.reload().
// That reload DESTROYS every unsaved form on the page — exactly the
// "app suddenly refreshed and I lost my report" bug.
//
// What this module does
// ---------------------
//  • requestAppReload() is the SINGLE chokepoint for stale-deploy
//    reloads. It reloads silently ONLY when the user has nothing to
//    lose (no typing this session, no dirty form registered).
//    Otherwise it does NOT reload — it raises a non-blocking
//    "update available" banner and lets the user reload when ready.
//  • A proactive poll detects a new deploy early, so users usually
//    see the calm banner BEFORE they ever hit a broken chunk.
//  • A dirty-form registry drives a beforeunload guard so an
//    accidental tab close / browser reload is also caught.
//
// Deferring a reload is ALWAYS safe — it never loses data. The only
// cost is the user clicks "Reload" instead of it happening for them.
// ============================================================

// Has the user typed into any field this session? Once true we
// never auto-reload — there may be unsaved work somewhere.
let everEdited = false;
// A new build has been detected (poll or failed chunk import).
let updateAvailable = false;
// Ids of mounted forms that currently hold unsaved changes.
const dirtyForms = new Set();
// Banner subscribers.
const updateListeners = new Set();

// ── Editing signal ──────────────────────────────────────────────
// One capture-phase listener; self-removes after the first input.
function onFirstInput() {
  everEdited = true;
  if (typeof document !== 'undefined') {
    document.removeEventListener('input', onFirstInput, true);
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('input', onFirstInput, true);
}

/** True once the user has typed anything this session. */
export function hasUserEdited() {
  return everEdited;
}

// ── Dirty-form registry ─────────────────────────────────────────
/** Mark a form as holding unsaved changes (see useUnsavedGuard). */
export function registerDirtyForm(id) {
  dirtyForms.add(id);
}
/** Clear a form's unsaved-changes flag. */
export function clearDirtyForm(id) {
  dirtyForms.delete(id);
}
/** True if any registered form currently has unsaved changes. */
export function hasUnsavedWork() {
  return dirtyForms.size > 0;
}

// beforeunload guard — warns before an accidental tab close or
// browser-level reload while a registered form is dirty.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (dirtyForms.size === 0) return;
    e.preventDefault();
    e.returnValue = ''; // required for the prompt in some browsers
  });
}

// ── Update-available state ──────────────────────────────────────
/** True once a new deploy has been detected. */
export function isUpdateAvailable() {
  return updateAvailable;
}
/** Subscribe to update-available changes. Returns an unsubscribe fn. */
export function subscribeUpdate(cb) {
  updateListeners.add(cb);
  return () => updateListeners.delete(cb);
}
function notifyUpdate() {
  for (const cb of updateListeners) {
    try { cb(updateAvailable); } catch { /* a bad listener must not break others */ }
  }
}
/** Flag that a new build exists and surface the banner. */
export function markUpdateAvailable() {
  if (updateAvailable) return;
  updateAvailable = true;
  notifyUpdate();
}

// ── The single reload chokepoint ────────────────────────────────
/**
 * Called by every stale-deploy recovery path INSTEAD of
 * window.location.reload(). Reloads only when it is provably safe.
 * Returns true if it actually triggered a reload.
 */
export function requestAppReload(reason) {
  // A new build clearly exists — surface the banner either way.
  markUpdateAvailable();

  // Never reload out from under unsaved work.
  if (everEdited || dirtyForms.size > 0) return false;

  // Loop guard: if we already reloaded once this session and the
  // import is STILL failing, it isn't a stale deploy (network down,
  // CDN issue) — stop reloading and let the banner/notice stand.
  let pending = null;
  try { pending = sessionStorage.getItem('chunk-reload-pending'); } catch { /* sessionStorage unavailable */ }
  if (pending) return false;
  try {
    sessionStorage.setItem('chunk-reload-pending', '1');
    if (reason) sessionStorage.setItem('wx-reload-reason', String(reason));
  } catch { /* sessionStorage unavailable */ }

  window.location.reload();
  return true;
}

/** Clear the one-shot reload loop guard — call after a clean load. */
export function clearReloadGuard() {
  try { sessionStorage.removeItem('chunk-reload-pending'); } catch { /* noop */ }
}

/** User clicked "Reload" in the banner — intentional, always allowed. */
export function reloadNow() {
  if (typeof window !== 'undefined') window.location.reload();
}

// ── Proactive new-deploy detection ──────────────────────────────
// The entry script the running tab booted with. After a redeploy
// the freshly-served index.html points at a different hash.
const BOOT_ENTRY = (() => {
  if (typeof document === 'undefined') return null;
  const s = document.querySelector('script[src*="/assets/index-"]');
  return s ? s.getAttribute('src') : null;
})();

async function checkForUpdate() {
  if (updateAvailable || !BOOT_ENTRY) return;
  try {
    const res = await fetch('/', { cache: 'no-store' });
    if (!res.ok) return;
    const html = await res.text();
    const m = html.match(/\/assets\/index-[\w-]+\.js/);
    if (m && m[0] !== BOOT_ENTRY) markUpdateAvailable();
  } catch { /* offline / transient — try again next tick */ }
}

let pollStarted = false;
/**
 * Poll for a new deployment so users see the calm "update available"
 * banner before they ever hit a broken chunk. Production only.
 */
export function startUpdatePolling(intervalMs = 3 * 60 * 1000) {
  if (pollStarted || typeof window === 'undefined') return;
  if (import.meta.env && import.meta.env.DEV) return;
  pollStarted = true;
  const timer = setInterval(() => {
    if (updateAvailable) { clearInterval(timer); return; }
    if (document.visibilityState === 'visible') checkForUpdate();
  }, intervalMs);
  // Also check the moment the tab is refocused — catches a deploy
  // that landed while the tab was in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}
