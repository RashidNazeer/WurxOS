// Global hand-off for the report leave-guard.
//
// The on-form hook (useReportLeaveGuard) catches <a href> link clicks
// (sidebar menu, etc.) itself. But a few places navigate PROGRAMMATICALLY
// via navigate() from a <button> — the Topbar settings gear, a notification
// jump, global search. Those can't be caught by a click-on-anchor listener,
// so they ask this singleton whether a dirty report form wants to intercept.
//
// Only one report form is mounted at a time, so a single slot is enough.

let active = null; // (proceed: () => void) => void   — shows the modal

/** Called by the hook while the form is dirty. */
export function setReportLeaveGuard(fn) { active = fn; }

/** Called by the hook on cleanup (only clears if still ours). */
export function clearReportLeaveGuard(fn) { if (active === fn) active = null; }

/**
 * Programmatic navigators call this. If a dirty report form is mounted it
 * intercepts (shows the Save-as-draft modal, runs `proceed` on "leave") and
 * returns true. Otherwise returns false and the caller should navigate normally.
 */
export function maybeGuardLeave(proceed) {
  if (active) { active(proceed); return true; }
  return false;
}
