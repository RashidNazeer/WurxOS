import { useEffect, useMemo, useState } from 'react';
import {
  setUserSalary, getHistoryFor, formatPKR, yearsCompletedSince,
} from '../../lib/salariesApi';
import { XIcon, AlertIcon, CheckIcon, StarIcon } from '../common/Icon';

// Boss-only modal. Two modes implied by `currentSalary`:
//   • Set initial salary  — currentSalary is null/undefined
//   • Review / increment  — currentSalary is set
//
// Server-side guard set_user_salary RLS enforces Boss-only writes.
// We still gate the visible call-to-action behind the prop `canEdit`
// so non-Boss visitors of this modal (if any) can't see the Save
// button at all.
export default function SalaryReviewModal({
  user,            // { id, display_name, role, start_date, avatar_url, email }
  currentSalary,   // number | null
  canEdit,         // bool — render Save button only when true
  onClose,
  onSaved,
}) {
  const isInitial = currentSalary == null;

  const [changeReason, setChangeReason] = useState(isInitial ? 'initial_seed' : 'annual_increment');
  const [incrementPct, setIncrementPct] = useState(isInitial ? '' : '20');
  const [absoluteAmount, setAbsoluteAmount] = useState(isInitial ? '' : String(currentSalary ?? ''));
  // Track whether the user typed in the % field last or the amount
  // field last, so the live preview math reflects their intent.
  const [editingMode, setEditingMode] = useState(isInitial ? 'amount' : 'pct');
  const [bossNotes, setBossNotes] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Prior history — last 5 changes, newest first.
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    setHistoryLoading(true);
    getHistoryFor(user.id)
      .then((rows) => { if (!cancelled) setHistory(rows.slice(0, 5)); })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id]);

  // Derived preview: when editing percent, derive amount; when editing
  // amount, derive percent. Stays in sync regardless of which field
  // the Boss last touched.
  const previewAmount = useMemo(() => {
    if (isInitial) return Number(absoluteAmount) || 0;
    const cur = Number(currentSalary) || 0;
    if (editingMode === 'pct') {
      const pct = Number(incrementPct);
      if (!Number.isFinite(pct)) return cur;
      return Math.round(cur * (1 + pct / 100));
    }
    return Number(absoluteAmount) || cur;
  }, [isInitial, currentSalary, editingMode, incrementPct, absoluteAmount]);

  const derivedPct = useMemo(() => {
    if (isInitial || !currentSalary) return null;
    const cur = Number(currentSalary);
    if (!cur) return null;
    return ((previewAmount - cur) / cur) * 100;
  }, [isInitial, currentSalary, previewAmount]);

  const yearsCompleted = useMemo(
    () => yearsCompletedSince(user?.start_date),
    [user?.start_date]
  );

  function handlePctChange(v) {
    setEditingMode('pct');
    setIncrementPct(v);
  }
  function handleAmountChange(v) {
    setEditingMode('amount');
    setAbsoluteAmount(v);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    const amt = Number(previewAmount);
    if (!Number.isFinite(amt) || amt < 0) return setError('New salary must be a non-negative number.');
    if (!effectiveFrom) return setError('Effective date is required.');
    if (!isInitial && currentSalary != null && amt === Number(currentSalary)) {
      return setError('No change — new amount is the same as the current salary.');
    }

    setSaving(true);
    try {
      await setUserSalary(user.id, {
        newAmount: amt,
        changeReason,
        incrementPct: derivedPct != null ? Number(derivedPct.toFixed(2)) : null,
        bossNotes: bossNotes.trim() || null,
        effectiveFrom,
      });
      onSaved?.();
    } catch (err) {
      setError(err.message || 'Failed to save salary.');
    } finally {
      setSaving(false);
    }
  }

  const initials = (user.display_name || user.email || '?')
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
        <form onSubmit={handleSave}>
          <div className="wx-modal-header">
            <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 32, height: 32, borderRadius: 'var(--radius-md)',
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'grid', placeItems: 'center', flex: '0 0 auto',
              }}>
                <StarIcon width="16" height="16" />
              </span>
              {isInitial ? 'Set initial salary' : 'Salary review'}
            </div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>

          <div className="wx-modal-body">
            {error && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                <AlertIcon width="16" height="16" /> <span>{error}</span>
              </div>
            )}

            {/* Employee summary card */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: 12,
              border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
              background: 'var(--surface-2)', marginBottom: 16,
            }}>
              <div className="wx-user-avatar" style={{ width: 44, height: 44, fontSize: 16 }}>
                {user.avatar_url
                  ? <img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
                  : initials}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                  {user.display_name || user.email}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {(user.role || '').toUpperCase()}
                  {user.start_date && (
                    <> · Hired {user.start_date} · {yearsCompleted} {yearsCompleted === 1 ? 'year' : 'years'} completed</>
                  )}
                  {!user.start_date && (
                    <> · Hire date not set</>
                  )}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current</div>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
                  {isInitial ? 'Not set' : formatPKR(currentSalary)}
                </div>
              </div>
            </div>

            {/* Reason dropdown */}
            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Reason</label>
              <select
                className="wx-input"
                value={changeReason}
                onChange={(e) => setChangeReason(e.target.value)}
                disabled={saving}
              >
                {isInitial && <option value="initial_seed">Initial salary</option>}
                <option value="annual_increment">Annual increment</option>
                <option value="promotion">Promotion</option>
                <option value="adjustment">Adjustment</option>
                <option value="correction">Correction</option>
              </select>
            </div>

            {/* Increment % + new amount — paired live editors */}
            <div style={{ display: 'grid', gridTemplateColumns: isInitial ? '1fr' : '1fr 1fr', gap: 12, marginBottom: 14 }}>
              {!isInitial && (
                <div>
                  <label className="wx-label">Increment %</label>
                  <input
                    type="number"
                    className="wx-input"
                    value={incrementPct}
                    onChange={(e) => handlePctChange(e.target.value)}
                    disabled={saving}
                    step="0.1"
                    placeholder="20"
                  />
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                    Company default 20%. Negative for decrement.
                  </div>
                </div>
              )}
              <div>
                <label className="wx-label">{isInitial ? 'Starting salary (PKR)' : 'New salary (PKR)'}</label>
                <input
                  type="number"
                  className="wx-input"
                  value={editingMode === 'amount' || isInitial ? absoluteAmount : String(previewAmount)}
                  onChange={(e) => handleAmountChange(e.target.value)}
                  disabled={saving}
                  step="100"
                  min="0"
                  required
                  placeholder="50000"
                />
                {!isInitial && derivedPct != null && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                    Δ {derivedPct >= 0 ? '+' : ''}{derivedPct.toFixed(1)}% · {formatPKR(currentSalary)} → {formatPKR(previewAmount)}
                  </div>
                )}
              </div>
            </div>

            {/* Effective from */}
            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Effective from</label>
              <input
                type="date"
                className="wx-input"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                disabled={saving}
                required
              />
            </div>

            {/* Boss notes */}
            <div style={{ marginBottom: 16 }}>
              <label className="wx-label">Notes (visible to the employee)</label>
              <textarea
                className="wx-input"
                rows={3}
                value={bossNotes}
                onChange={(e) => setBossNotes(e.target.value)}
                disabled={saving}
                placeholder={isInitial
                  ? 'e.g. "Starting salary for new hire."'
                  : 'e.g. "Excellent performance throughout the year — annual revision."'}
                style={{ resize: 'vertical' }}
              />
            </div>

            {/* Prior changes */}
            <div style={{ paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Recent salary changes
              </div>
              {historyLoading ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  <span className="wx-spinner" /> Loading…
                </div>
              ) : history.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  No prior changes recorded.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {history.map((h) => (
                    <HistoryRow key={h.id} h={h} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {canEdit && (
              <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
                {saving ? <><span className="wx-spinner" /> Saving…</> : (
                  <><CheckIcon width="14" height="14" /> {isInitial ? 'Set salary' : 'Apply increment'}</>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function HistoryRow({ h }) {
  const reasonLabel = REASON_LABELS[h.changeReason] || h.changeReason;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '110px 1fr auto',
      gap: 10, alignItems: 'center',
      padding: '8px 10px', borderRadius: 'var(--radius-sm)',
      background: 'var(--surface-2)',
    }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
        {h.effectiveFrom}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)', minWidth: 0 }}>
        <span style={{ fontWeight: 600 }}>{reasonLabel}</span>
        {h.previousAmount != null && (
          <> · {formatPKR(h.previousAmount)} → {formatPKR(h.newAmount)}</>
        )}
        {h.previousAmount == null && (
          <> · {formatPKR(h.newAmount)}</>
        )}
        {h.incrementPct != null && (
          <span style={{ color: h.incrementPct >= 0 ? 'var(--success)' : 'var(--danger)', marginLeft: 6, fontWeight: 600 }}>
            ({h.incrementPct >= 0 ? '+' : ''}{Number(h.incrementPct).toFixed(1)}%)
          </span>
        )}
        {h.bossNotes && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
            “{h.bossNotes}”
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
        by {h.changedByUser?.displayName || '—'}
      </div>
    </div>
  );
}

const REASON_LABELS = {
  initial_seed:     'Initial',
  annual_increment: 'Annual increment',
  promotion:        'Promotion',
  adjustment:       'Adjustment',
  correction:       'Correction',
};
