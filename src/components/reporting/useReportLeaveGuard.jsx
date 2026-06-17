import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { setReportLeaveGuard, clearReportLeaveGuard } from '../../lib/reportLeaveGuard';

/**
 * Navigation guard for the report forms (Weekly / Bi-Weekly / Monthly).
 *
 * Problem it solves: while creating/editing a report, clicking a sidebar
 * menu item or the "Back to reports" arrow used to navigate away instantly
 * and the in-progress data was only in localStorage — users experienced it
 * as "all my work is gone".
 *
 * While the form is dirty this guard intercepts any attempt to leave:
 *   • an internal route link (sidebar / topbar / any <a href="/…">), and
 *   • a guarded in-app action wrapped with `guardAction` (the Back arrow).
 * It shows a modal with exactly two choices — BOTH save the current state
 * as a draft first, so nothing is ever lost:
 *   • Save & leave   → persist draft, then go where they clicked.
 *   • Save & stay    → persist draft, keep the editor open.
 * The modal can ONLY be dismissed via those two buttons (no backdrop /
 * Escape dismissal), per product requirement.
 *
 * `onSaveDraft` must persist the current form state as a draft WITHOUT
 * navigating, and resolve to `false` only on a hard save failure (so we
 * don't navigate away on a failed save and lose the work).
 */
export function useReportLeaveGuard({ dirty, onSaveDraft }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(null); // { run } | null
  const [saving, setSaving] = useState(false);
  const pendingRef = useRef(null);
  useEffect(() => { pendingRef.current = pending; }, [pending]);

  // Intercept internal route-link clicks (sidebar/topbar/menus) while dirty.
  useEffect(() => {
    if (!dirty) return undefined;
    function onCapture(e) {
      // While the modal is up, swallow link clicks — the user must choose
      // Save & leave / Save & stay explicitly (no dismiss-by-clicking-away).
      if (pendingRef.current) {
        if (e.target.closest?.('a[href]')) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest?.('a[href]');
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('/')) return; // internal SPA routes only
      if (href === window.location.pathname + window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPending({ run: () => navigate(href) });
    }
    document.addEventListener('click', onCapture, true);
    return () => document.removeEventListener('click', onCapture, true);
  }, [dirty, navigate]);

  // Register a global hand-off so PROGRAMMATIC navigations (Topbar gear,
  // notifications, global search) also route through the modal while dirty.
  useEffect(() => {
    if (!dirty) return undefined;
    const fn = (proceed) => { if (!pendingRef.current) setPending({ run: proceed || (() => {}) }); };
    setReportLeaveGuard(fn);
    return () => clearReportLeaveGuard(fn);
  }, [dirty]);

  // Wrap an in-app action (e.g. the Back arrow's onCancel) so it routes
  // through the modal when there are unsaved changes.
  const guardAction = useCallback((run) => {
    if (dirty) setPending({ run: run || (() => {}) });
    else if (run) run();
  }, [dirty]);

  const onLeave = useCallback(async () => {
    setSaving(true);
    let ok = true;
    try { ok = await onSaveDraft(); } catch { ok = false; }
    setSaving(false);
    if (ok === false) return; // save failed — keep the modal open, data safe
    const run = pendingRef.current?.run;
    setPending(null);
    if (run) run();
  }, [onSaveDraft]);

  const onStay = useCallback(async () => {
    setSaving(true);
    try { await onSaveDraft(); } catch { /* staying is safe regardless */ }
    setSaving(false);
    setPending(null);
  }, [onSaveDraft]);

  const guardModal = pending ? (
    <LeaveReportModal saving={saving} onLeave={onLeave} onStay={onStay} />
  ) : null;

  return { guardModal, guardAction };
}

function LeaveReportModal({ saving, onLeave, onStay }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1080,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'rgba(15,23,42,0.55)',
    }}>
      <div className="rounded-3" style={{
        background: 'var(--surface-1)', border: '1px solid var(--border-default)',
        boxShadow: '0 24px 64px rgba(2,6,23,0.45)', maxWidth: 440, width: '100%',
        padding: '22px 22px 18px',
      }}>
        <div className="d-flex align-items-start gap-3 mb-2">
          <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
            style={{ width: 40, height: 40, background: 'var(--warning-soft)', color: 'var(--warning)' }}>
            <i className="bi bi-pencil-square" style={{ fontSize: '1.1rem' }} />
          </div>
          <div>
            <div className="fw-bold" style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>
              Leave this report?
            </div>
            <div className="text-muted" style={{ fontSize: '0.82rem', marginTop: 2 }}>
              You’re in the middle of a report. We’ll <strong>save it as a draft</strong> so nothing
              is lost — it’ll be waiting for you under Reports.
            </div>
          </div>
        </div>
        <div className="d-flex flex-column gap-2 mt-3">
          <button type="button" className="btn btn-primary d-inline-flex align-items-center justify-content-center gap-2"
            style={{ borderRadius: 10 }} disabled={saving} onClick={onLeave}>
            {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-box-arrow-right" />}
            Save &amp; leave
          </button>
          <button type="button" className="btn btn-outline-secondary d-inline-flex align-items-center justify-content-center gap-2"
            style={{ borderRadius: 10 }} disabled={saving} onClick={onStay}>
            <i className="bi bi-arrow-counterclockwise" /> Save &amp; stay here
          </button>
        </div>
      </div>
    </div>
  );
}
