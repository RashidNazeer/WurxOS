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
 *   * Every 30 seconds (and on every change after a quiet beat),
 *     dump `data` to localStorage under a stable key derived from
 *     (form type, user, brand, period).
 *   * On mount, if the form is new (no editReportId) and a draft
 *     exists for that exact key, restore it into state.
 *   * On successful save (handled by caller), clear the stored
 *     draft so we don't keep stale data forever.
 *
 * Storage shape:
 *   { savedAt: ISO timestamp, data: <form data> }
 *
 * Keys look like:
 *   'wurxos.report-draft.weekly|<uid>|<brandId>|<weekStart>'
 */

import { useEffect, useRef, useCallback } from 'react';

const AUTOSAVE_INTERVAL_MS = 30 * 1000;
const KEY_PREFIX = 'wurxos.report-draft.';

function buildKey(type, uid, brandId, periodStart) {
  return `${KEY_PREFIX}${type}|${uid || 'anon'}|${brandId || 'no-brand'}|${periodStart || 'no-period'}`;
}

export function loadDraft({ type, uid, brandId, periodStart }) {
  try {
    const raw = localStorage.getItem(buildKey(type, uid, brandId, periodStart));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft({ type, uid, brandId, periodStart, data }) {
  try {
    localStorage.setItem(
      buildKey(type, uid, brandId, periodStart),
      JSON.stringify({ savedAt: new Date().toISOString(), data }),
    );
  } catch {
    // Quota exceeded or storage disabled — give up silently. The
    // failure mode is "data not auto-saved", which is what we had
    // before this feature existed.
  }
}

export function clearDraft({ type, uid, brandId, periodStart }) {
  try {
    localStorage.removeItem(buildKey(type, uid, brandId, periodStart));
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
export function useReportAutosave({ type, uid, brandId, periodStart, data, enabled }) {
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    if (!enabled) return;
    if (!uid || !brandId || !periodStart) return;
    const id = setInterval(() => {
      saveDraft({ type, uid, brandId, periodStart, data: dataRef.current });
    }, AUTOSAVE_INTERVAL_MS);
    // Also save once on mount so we have something within 30s even
    // if the user does something destructive immediately.
    saveDraft({ type, uid, brandId, periodStart, data: dataRef.current });
    return () => clearInterval(id);
  }, [type, uid, brandId, periodStart, enabled]);

  const clear = useCallback(() => {
    clearDraft({ type, uid, brandId, periodStart });
  }, [type, uid, brandId, periodStart]);

  return { clear };
}
