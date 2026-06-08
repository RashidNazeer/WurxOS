/**
 * Local-storage auto-save for in-progress report forms.
 *
 * Why: an APC was typing a weekly report for an hour, the app
 * unexpectedly signed out, and the data was lost. The root cause
 * (over-eager session invalidation) is fixed in AuthContext, but
 * we still want a safety net: even an explicit sign-out, a tab
 * crash, or a Vercel deploy mid-edit shouldn't destroy work.
 *
 * Behavior:
 *   * Every 30 seconds, dump `data` to localStorage under a stable
 *     key derived from (form type, user, brand, period [, editId]).
 *   * On mount, if a draft exists for that exact key, restore it
 *     into state.
 *   * On successful save (handled by caller), clear the stored
 *     draft so we don't keep stale data forever.
 *
 * Edit mode coverage (2026-06-02):
 *   Originally autosave was gated to NEW reports only — the reasoning
 *   was "editing an existing row saves to the DB on every Save click."
 *   But Save is manual, and any of the bugs in the report-editor
 *   investigation (Brands realtime form-wipe, profile-null unmount,
 *   SW nav, etc.) destroy in-progress edits BEFORE Save fires. So
 *   autosave is now enabled for edit mode too, with the report id
 *   included in the storage key so different drafts don't collide.
 *
 * Storage shape:
 *   { savedAt: ISO timestamp, data: <form data> }
 *
 * Keys look like:
 *   'wurxos.report-draft.weekly|<uid>|<brandId>|<weekStart>'           (new)
 *   'wurxos.report-draft.weekly|<uid>|<brandId>|<weekStart>|<editId>'  (edit)
 */

import { useEffect, useRef, useCallback } from 'react';

// Auto-save cadence. 5s gives a much tighter safety net than the
// original 30s — worst-case data loss for an APC who crashes mid-
// sentence drops accordingly. localStorage writes of a typical
// report payload (10-50KB JSON) run in well under 1ms, so the
// extra writes are imperceptible. Adjusted 2026-06-02 at user
// request — see "Pending fixes -IMP.md" for the trade-off notes.
const AUTOSAVE_INTERVAL_MS = 5 * 1000;
const KEY_PREFIX = 'wurxos.report-draft.';

function buildKey(type, uid, brandId, periodStart, editId) {
  const base = `${KEY_PREFIX}${type}|${uid || 'anon'}|${brandId || 'no-brand'}|${periodStart || 'no-period'}`;
  return editId ? `${base}|${editId}` : base;
}

export function loadDraft({ type, uid, brandId, periodStart, editId }) {
  try {
    const raw = localStorage.getItem(buildKey(type, uid, brandId, periodStart, editId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft({ type, uid, brandId, periodStart, editId, data }) {
  try {
    localStorage.setItem(
      buildKey(type, uid, brandId, periodStart, editId),
      JSON.stringify({ savedAt: new Date().toISOString(), data }),
    );
  } catch {
    // Quota exceeded or storage disabled — give up silently. The
    // failure mode is "data not auto-saved", which is what we had
    // before this feature existed.
  }
}

export function clearDraft({ type, uid, brandId, periodStart, editId }) {
  try {
    localStorage.removeItem(buildKey(type, uid, brandId, periodStart, editId));
  } catch { /* noop */ }
}

/**
 * Hook: schedule periodic auto-save while the form is being edited.
 *
 * Caller passes the current `data`, the identifying fields, and an
 * `enabled` flag (typically true for new-report flows, false for
 * edits since editing an existing row already saves to the DB).
 *
 * Returns { clear } so the caller can wipe the draft after a
 * successful submit.
 */
export function useReportAutosave({ type, uid, brandId, periodStart, editId, data, enabled }) {
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    if (enabled === false) return;
    if (!uid || !brandId || !periodStart) return;
    const id = setInterval(() => {
      saveDraft({ type, uid, brandId, periodStart, editId, data: dataRef.current });
    }, AUTOSAVE_INTERVAL_MS);
    // Also save once on mount so we have something within 30s even
    // if the user does something destructive immediately.
    saveDraft({ type, uid, brandId, periodStart, editId, data: dataRef.current });
    return () => clearInterval(id);
  }, [type, uid, brandId, periodStart, editId, enabled]);

  // Save-on-change. Why: the 5s interval alone misses the early
  // window — if the editor unmounts in <5s only the empty mount
  // snapshot is in localStorage and the user sees "no saved as draft"
  // on next visit. A debounce wouldn't help because an unmount that
  // happens between keystrokes also cancels the pending timer. So we
  // just save on every `data` ref change. localStorage writes for a
  // 10-50KB report payload run in <1ms — even fast typing produces no
  // observable lag.
  useEffect(() => {
    if (enabled === false) return;
    if (!uid || !brandId || !periodStart) return;
    saveDraft({ type, uid, brandId, periodStart, editId, data: dataRef.current });
  }, [data, type, uid, brandId, periodStart, editId, enabled]);

  const clear = useCallback(() => {
    clearDraft({ type, uid, brandId, periodStart, editId });
  }, [type, uid, brandId, periodStart, editId]);

  return { clear };
}
