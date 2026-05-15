import React from 'react';

/**
 * Shared month navigator for the leave pages — ‹ Month YYYY › with a
 * "Today" shortcut. Used by both the Boss queue and the per-user
 * leave page so the month-scoping UX is identical everywhere.
 *
 * Months are passed around as 'YYYY-MM' strings. Next is disabled at
 * the current month so the view can't drift into the future.
 */
export default function MonthNavigator({ label, isCurrent, onPrev, onNext, onReset }) {
  return (
    <div className="d-inline-flex align-items-center gap-2">
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary px-2"
        style={{ borderRadius: 8 }}
        onClick={onPrev}
        title="Previous month"
      >
        <i className="bi bi-chevron-left" />
      </button>
      <span
        className="d-inline-flex align-items-center justify-content-center gap-2 fw-semibold px-3 py-1 rounded-2"
        style={{ background: '#f3f4f6', fontSize: '0.82rem', minWidth: 170, color: '#1a1a2e' }}
      >
        <i className="bi bi-calendar3" style={{ fontSize: '0.78rem' }} />
        {label}
      </span>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary px-2"
        style={{ borderRadius: 8 }}
        onClick={onNext}
        disabled={isCurrent}
        title={isCurrent ? 'Already at the current month' : 'Next month'}
      >
        <i className="bi bi-chevron-right" />
      </button>
      {!isCurrent && (
        <button
          type="button"
          className="btn btn-sm btn-outline-primary px-2"
          style={{ borderRadius: 8, fontSize: '0.74rem' }}
          onClick={onReset}
          title="Jump back to the current month"
        >
          Today
        </button>
      )}
    </div>
  );
}

// ── 'YYYY-MM' month-string helpers ────────────────────────────────────

/** Current month as 'YYYY-MM'. */
export function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Friendly label, e.g. 'April 2026'. */
export function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** Step a 'YYYY-MM' string by ±N months. */
export function stepMonthStr(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
