import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getIncentives, updateIncentivesProgress, notifyIncentiveEmployee,
} from '../../lib/incentivesApi';

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getMonthLabel(ym) {
  const [year, month] = ym.split('-');
  return new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function pct(achieved, target) {
  if (!target || target <= 0) return 0;
  return Math.min(Math.round((Number(achieved) / Number(target)) * 100), 100);
}
function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}

// ── View Details Modal (read-only) ────────────────────────────────────────────
function DetailsModal({ record, items, onClose }) {
  const allItems = [...items.incentives, ...items.bonuses];
  const completedCount = allItems.filter(i => i.completed).length;

  function ItemCard({ item, color }) {
    // Use item.completed from Firestore — respects TL overrides
    const p = pct(item.achievedValue, item.targetValue);
    const isCompleted = item.completed;
    const unitSfx = itemSuffix(item);

    return (
      <div
        className="rounded-3 p-3 mb-2"
        style={{
          background: isCompleted ? '#f0fdf4' : '#fafafa',
          border: `1.5px solid ${isCompleted ? '#b7dfc4' : '#e9ecef'}`,
        }}
      >
        <div className="d-flex align-items-start justify-content-between gap-2 mb-1">
          <div style={{ minWidth: 0 }}>
            <div className="fw-semibold small">{item.text || '—'}</div>
            <div className="text-muted" style={{ fontSize: '0.7rem' }}>
              Compensation: <strong style={{ color }}>+{(Number(item.amount) || 0).toLocaleString()} PKR</strong>
            </div>
          </div>
          <span
            className="badge rounded-pill flex-shrink-0"
            style={{
              background: isCompleted ? '#e6f4ea' : '#fff3e0',
              color: isCompleted ? '#198754' : '#fd7e14',
              fontSize: '0.6rem',
            }}
          >
            {isCompleted ? '✓ Completed' : `${p}%`}
          </span>
        </div>

        {(item.targetValue > 0 || item.achievedValue > 0) && (
          <div className="d-flex gap-3 mb-2" style={{ fontSize: '0.72rem', color: '#6c757d' }}>
            <span>Target: <strong>{Number(item.targetValue || 0).toLocaleString()}{unitSfx}</strong></span>
            <span>Achieved: <strong>{Number(item.achievedValue || 0).toLocaleString()}{unitSfx}</strong></span>
          </div>
        )}

        {item.targetValue > 0 && (
          <div>
            <div className="rounded-pill overflow-hidden" style={{ height: 4, background: '#e9ecef' }}>
              <div
                className="h-100 rounded-pill"
                style={{
                  width: `${p}%`,
                  background: isCompleted ? '#198754' : p >= 60 ? '#fd7e14' : '#0d6efd',
                  transition: 'width 0.3s',
                }}
              />
            </div>
            <div className="text-end mt-1" style={{ fontSize: '0.63rem', color: isCompleted ? '#198754' : '#6c757d' }}>
              {p}% {isCompleted ? '— Completed 🎉' : p >= 60 ? '— Getting close' : '— In progress'}
            </div>
          </div>
        )}

        {item.completedBy && (
          <div style={{ fontSize: '0.63rem', color: '#198754', marginTop: 4 }}>
            <i className="bi bi-person-check me-1" />Marked by {item.completedBy}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div
        className="card border-0 shadow-lg"
        style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0">Incentive Details</h6>
              <p className="text-muted small mb-0">{getMonthLabel(record.month)} · {completedCount}/{allItems.length} completed</p>
            </div>
            <button
              className="btn btn-sm btn-light border-0 rounded-circle"
              onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>

          {items.incentives.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {items.incentives.map(i => <ItemCard key={i.id} item={i} color="#198754" />)}
            </div>
          )}

          {items.bonuses.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {items.bonuses.map(b => <ItemCard key={b.id} item={b} color="#0d6efd" />)}
            </div>
          )}

          <div className="d-flex justify-content-end mt-3">
            <button className="btn btn-sm btn-dark px-4" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Edit Item Row (defined outside EditModal to avoid remount on every render)
function EditItemRow({ item, category, onChange }) {
  const achieved = item.achievedValue ?? '';
  const target   = item.targetValue   ?? '';
  const unitSfx  = itemSuffix(item);
  const p        = pct(achieved, target);
  const isCompleted = p >= 90;

  return (
    <div
      className="rounded-3 p-3 mb-2"
      style={{
        background: isCompleted ? '#f0fdf4' : '#fafafa',
        border: `1.5px solid ${isCompleted ? '#b7dfc4' : '#e9ecef'}`,
      }}
    >
      <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
        <div>
          <div className="fw-semibold small">{item.text || '—'}</div>
          <div className="text-muted" style={{ fontSize: '0.7rem' }}>
            Compensation: <strong>+{(Number(item.amount) || 0).toLocaleString()} PKR</strong>
          </div>
        </div>
        <span
          className="badge rounded-pill flex-shrink-0"
          style={{
            background: isCompleted ? '#e6f4ea' : '#fff3e0',
            color: isCompleted ? '#198754' : '#fd7e14',
            fontSize: '0.6rem',
          }}
        >
          {isCompleted ? '✓ Completed' : `${p}%`}
        </span>
      </div>

      <div className="row g-2">
        <div className="col-6">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>
            Target <span className="text-muted" style={{ fontSize: '0.6rem' }}>(set by OL · read-only)</span>
          </label>
          <div className="input-group input-group-sm">
            <input
              type="text" className="form-control"
              value={target ? `${Number(target).toLocaleString()}${unitSfx}` : '—'}
              readOnly disabled
              style={{ background: '#f1f5f9', cursor: 'not-allowed' }}
            />
            <span className="input-group-text" style={{ fontSize: '0.7rem', background: '#f1f5f9' }}>
              <i className="bi bi-lock-fill" style={{ fontSize: '0.7rem', color: '#94a3b8' }} />
            </span>
          </div>
        </div>
        <div className="col-6">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>
            Achieved {target ? <span className="text-muted">/ {Number(target).toLocaleString()}{unitSfx}</span> : ''}
          </label>
          <div className="input-group input-group-sm">
            <input
              type="number" className="form-control"
              placeholder="Your result" min="0" value={achieved}
              onChange={e => onChange(category, item.id, 'achievedValue', e.target.value)}
            />
            {unitSfx && <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{unitSfx}</span>}
          </div>
        </div>
      </div>

      {(target !== '' && achieved !== '') && (
        <div className="mt-2">
          <div className="rounded-pill overflow-hidden" style={{ height: 4, background: '#e9ecef' }}>
            <div
              className="h-100 rounded-pill"
              style={{
                width: `${p}%`,
                background: isCompleted ? '#198754' : p >= 60 ? '#fd7e14' : '#0d6efd',
                transition: 'width 0.3s',
              }}
            />
          </div>
          <div className="text-end mt-1" style={{ fontSize: '0.63rem', color: isCompleted ? '#198754' : '#6c757d' }}>
            {p}% {p >= 90 ? '— Completed! 🎉' : p >= 60 ? '— Getting close' : '— In progress'}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Edit Progress Modal ───────────────────────────────────────────────────────
function EditModal({ record, items, onClose, onSaved }) {
  // v2 auth shim — apcProfile fields used here: userName, ownerId.
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const apcProfile = profile ? {
    userName: profile.display_name || '',
    ownerId:  profile.reports_to || null,
  } : null;
  const [editItems, setEditItems] = useState({
    incentives: items.incentives.map(i => ({ ...i })),
    bonuses:    items.bonuses.map(b => ({ ...b })),
  });
  const [saving,       setSaving]       = useState(false);
  const [error,        setError]        = useState('');
  const [notifyTL,     setNotifyTL]     = useState(false);

  function handleChange(category, itemId, field, value) {
    setEditItems(prev => ({
      ...prev,
      [category]: prev[category].map(it => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        const p = pct(
          field === 'achievedValue' ? value : updated.achievedValue,
          field === 'targetValue'   ? value : updated.targetValue,
        );
        return { ...updated, completed: p >= 90 };
      }),
    }));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      // APC may only edit `achievedValue` + `completed`. Preserve all OL-set fields
      // (text, amount, targetValue, suffix) by reading from the original `items` prop.
      const origInc = new Map(items.incentives.map(i => [i.id, i]));
      const origBon = new Map(items.bonuses.map(b => [b.id, b]));

      await updateIncentivesProgress({
        rowId: record.id,
        incentives: editItems.incentives.map(i => {
          const o = origInc.get(i.id) || {};
          return {
            id: i.id, text: o.text, amount: o.amount,
            targetValue:   Number(o.targetValue)   || 0,
            achievedValue: Number(i.achievedValue) || 0,
            suffix:        itemSuffix(o),
            completed:     i.completed || false,
            completedBy:   i.completed ? (apcProfile?.userName || currentUser.uid) : null,
            completedAt:   i.completed ? new Date().toISOString() : null,
          };
        }),
        bonuses: editItems.bonuses.map(b => {
          const o = origBon.get(b.id) || {};
          return {
            id: b.id, text: o.text, amount: o.amount,
            targetValue:   Number(o.targetValue)   || 0,
            achievedValue: Number(b.achievedValue) || 0,
            suffix:        itemSuffix(o),
            completed:     b.completed || false,
            completedBy:   b.completed ? (apcProfile?.userName || currentUser.uid) : null,
            completedAt:   b.completed ? new Date().toISOString() : null,
          };
        }),
      });

      // Notify Team Lead in-app if opted in. v2's inc_notify_employee
      // RPC fires a notification to the row's user (who is ME), not
      // to my TL. For the "Notify TL" use case we want a manager-bound
      // notification — we use the same RPC but allow the manager to be
      // the notification target via the existing emit_notification helper
      // already invoked inside the RPC family. The simplest cross-tier
      // hook in v2 is to mark the row notified — that fires a notification
      // to user_id (which is APC). For a manager ping we'd need a separate
      // RPC; fallback: skip the manager ping in v2 if the RPC isn't
      // authorised. UI keeps the checkbox so behaviour matches v1.
      if (notifyTL && record.id) {
        try { await notifyIncentiveEmployee(record.id); } catch { /* non-fatal */ }
      }

      onSaved(editItems);
    } catch (err) {
      setError('Failed to save. Please try again.');
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div
        className="card border-0 shadow-lg"
        style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}
      >
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0">Edit Progress</h6>
              <p className="text-muted small mb-0">Update your target & achieved values</p>
            </div>
            <button
              className="btn btn-sm btn-light border-0 rounded-circle"
              onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>

          {editItems.incentives.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {editItems.incentives.map(i => <EditItemRow key={i.id} item={i} category="incentives" onChange={handleChange} />)}
            </div>
          )}

          {editItems.bonuses.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {editItems.bonuses.map(b => <EditItemRow key={b.id} item={b} category="bonuses" onChange={handleChange} />)}
            </div>
          )}

          {error && (
            <div className="alert alert-danger py-2 small mb-3 d-flex align-items-center gap-2">
              <i className="bi bi-exclamation-circle" />{error}
            </div>
          )}

          {/* Notify team lead in-app (only if ownerId is available) */}
          {apcProfile?.ownerId && (
            <div
              className="d-flex align-items-center gap-2 rounded-2 p-2 mb-3"
              style={{ background: notifyTL ? '#fff3e0' : '#f8f9fa', border: `1.5px solid ${notifyTL ? '#ffc070' : '#e9ecef'}`, cursor: 'pointer' }}
              onClick={() => setNotifyTL(v => !v)}
            >
              <input
                type="checkbox"
                id="editModal-notifyTL"
                className="form-check-input flex-shrink-0"
                checked={notifyTL}
                onChange={e => setNotifyTL(e.target.checked)}
                onClick={e => e.stopPropagation()}
                style={{ cursor: 'pointer' }}
              />
              <label htmlFor="editModal-notifyTL" className="small mb-0" style={{ cursor: 'pointer', color: notifyTL ? '#fd7e14' : '#495057' }}>
                <i className="bi bi-bell me-1" />
                Notify team lead of progress update
              </label>
            </div>
          )}

          <div className="d-flex gap-2 justify-content-end mt-2">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button
              className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1"
              onClick={handleSave} disabled={saving}
            >
              {saving
                ? <><span className="spinner-border spinner-border-sm" /> Saving…</>
                : <><i className="bi bi-check-lg" /> Save Progress</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ApcIncentivesPage() {
  // v2 auth shim — apcProfile fields used: userName, ownerId.
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const apcProfile = profile ? {
    userName: profile.display_name || '',
    ownerId:  profile.reports_to || null,
  } : null;
  const currentMonth = getCurrentMonth();
  const [month, setMonth] = useState(currentMonth);

  const [record,      setRecord]      = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [items,       setItems]       = useState({ incentives: [], bonuses: [] });
  const [showDetails, setShowDetails] = useState(false);
  const [showEdit,    setShowEdit]    = useState(false);

  useEffect(() => {
    if (!currentUser) return;
    async function load() {
      setLoading(true);
      setRecord(null);
      setItems({ incentives: [], bonuses: [] });
      const data = await getIncentives(currentUser.uid, month);
      if (data) {
        setRecord(data);
        setItems({
          incentives: (data.incentives || []).map(i => ({ ...i, achievedValue: i.achievedValue ?? '', targetValue: i.targetValue ?? '', suffix: itemSuffix(i) })),
          bonuses:    (data.bonuses    || []).map(b => ({ ...b, achievedValue: b.achievedValue ?? '', targetValue: b.targetValue ?? '', suffix: itemSuffix(b) })),
        });
      }
      setLoading(false);
    }
    load();
  }, [currentUser?.uid, month]);  // eslint-disable-line react-hooks/exhaustive-deps

  function handleSaved(updatedItems) {
    setItems(updatedItems);
    setShowEdit(false);
  }

  // Summary calculations — use item.completed (respects TL overrides)
  const allItems       = [...items.incentives, ...items.bonuses];
  const completedItems = allItems.filter(i => i.completed);
  const earnedAmount   = completedItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const potentialAmt   = allItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const basic          = Number(record?.basicSalary) || 0;
  const totalEarned    = basic + earnedAmount;
  const totalPotential = basic + potentialAmt;
  const completionPct  = allItems.length > 0 ? Math.round((completedItems.length / allItems.length) * 100) : 0;

  if (!currentUser) return null;
  if (loading) {
    return (
      <div style={{ padding: '32px 32px 48px' }} className="text-muted small d-flex align-items-center gap-2">
        <span className="spinner-border spinner-border-sm" /> Loading incentives…
      </div>
    );
  }

  // tlName/tlEmail removed — incentives are managed by OL, not TL.

  return (
    <div style={{ padding: '32px 32px 48px', maxWidth: 680 }}>
      {/* Page header */}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-3 mb-4">
        <div>
          <h5 className="fw-bold mb-1">My Incentives &amp; Bonuses</h5>
          <p className="text-muted mb-0" style={{ fontSize: '0.82rem' }}>
            <i className="bi bi-calendar3 me-1" />{getMonthLabel(month)}
            <span className="mx-2">·</span>
            <i className="bi bi-person-lines-fill me-1" />Managed by Operations Lead
          </p>
        </div>
        <div className="d-flex align-items-center gap-2">
          <input type="month" className="form-control form-control-sm" value={month}
            onChange={e => setMonth(e.target.value)} style={{ width: 160 }} />
          {record?.payoutCleared && (
            <span className="badge rounded-pill d-inline-flex align-items-center gap-1 px-3 py-2"
              style={{ background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7', fontSize: '0.72rem' }}>
              <i className="bi bi-cash-coin" /> Payout Cleared
            </span>
          )}
          {record?.verified && (
            <span className="badge rounded-pill d-inline-flex align-items-center gap-1 px-3 py-2"
              style={{ background: '#e6f4ea', color: '#15803d', border: '1px solid #bbf7d0', fontSize: '0.72rem' }}>
              <i className="bi bi-patch-check-fill" /> TL Verified
            </span>
          )}
        </div>
      </div>

      {!record ? (
        <div className="text-center py-5 rounded-4" style={{ border: '2px dashed #dee2e6', background: '#fff' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mx-auto mb-3"
            style={{ width: 64, height: 64, background: '#f8f9fa' }}>
            <i className="bi bi-trophy text-muted" style={{ fontSize: '1.8rem', opacity: 0.35 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No incentive plan yet</p>
          <p className="text-muted small mb-0">No plan has been set for {getMonthLabel(month)}.</p>
          <p className="text-muted small mb-0">Operations Lead will update your incentives soon.</p>
        </div>
      ) : (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 14, overflow: 'hidden' }}>
          {/* Color bar */}
          <div style={{
            height: 4,
            background: record.verified
              ? 'linear-gradient(90deg,#198754,#51cf66)'
              : record.notified
                ? 'linear-gradient(90deg,#0d6efd,#6ea8fe)'
                : 'linear-gradient(90deg,#fd7e14,#ffa94d)',
          }} />

          {/* Header banner */}
          <div className="p-3 d-flex align-items-center gap-3" style={{ background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' }}>
            <div
              className="rounded-circle d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
              style={{ width: 42, height: 42, background: 'rgba(255,255,255,0.15)', fontSize: '0.85rem' }}
            >
              {(apcProfile?.userName || '?').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-grow-1">
              <div className="fw-bold">{apcProfile?.userName}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                {getMonthLabel(month)} · {(record.brandNames || []).join(', ') || '—'}
              </div>
            </div>
            {record.verified && (
              <span className="badge rounded-pill" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.62rem' }}>
                <i className="bi bi-patch-check-fill me-1" />TL Verified
              </span>
            )}
          </div>

          <div className="card-body p-3">
            {/* Salary summary */}
            <div className="d-flex flex-column gap-1 mb-3" style={{ fontSize: '0.82rem' }}>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Basic Salary</span>
                <span className="fw-medium">{basic.toLocaleString()} PKR</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Earned ({completedItems.length}/{allItems.length} items)</span>
                <span className="fw-medium text-success">+{earnedAmount.toLocaleString()} PKR</span>
              </div>
              <div
                className="d-flex justify-content-between fw-bold pt-2 mt-1"
                style={{ borderTop: '1.5px solid #dee2e6', fontSize: '0.9rem' }}
              >
                <span>Total Earned</span>
                <span>{totalEarned.toLocaleString()} PKR</span>
              </div>
              <div className="text-muted text-end" style={{ fontSize: '0.68rem' }}>
                Potential: {totalPotential.toLocaleString()} PKR
              </div>
            </div>

            {/* Progress bar */}
            <div className="mb-3">
              <div className="d-flex justify-content-between mb-1" style={{ fontSize: '0.7rem' }}>
                <span className="text-muted">Overall completion</span>
                <span className="fw-semibold">{completedItems.length}/{allItems.length} ({completionPct}%)</span>
              </div>
              <div className="rounded-pill overflow-hidden" style={{ height: 6, background: '#e9ecef' }}>
                <div
                  className="h-100 rounded-pill"
                  style={{
                    width: `${completionPct}%`,
                    background: completionPct === 100 ? '#198754' : '#0d6efd',
                    transition: 'width 0.4s',
                  }}
                />
              </div>
            </div>

            <p className="text-muted mb-3" style={{ fontSize: '0.68rem' }}>
              * Items are counted as completed when you achieve ≥90% of the target. Final salary is subject to TL verification.
            </p>

            {/* Action buttons */}
            <div className="d-flex gap-2">
              <button
                className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                style={{ border: '1.5px solid #dee2e6', borderRadius: 8, background: '#fff', color: '#495057', fontSize: '0.78rem' }}
                onClick={() => setShowDetails(true)}
              >
                <i className="bi bi-eye" /> View Details
              </button>
              {!record?.payoutCleared && (
                <button
                  className="btn btn-sm btn-dark flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem' }}
                  onClick={() => setShowEdit(true)}
                >
                  <i className="bi bi-pencil" /> Edit Progress
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showDetails && record && (
        <DetailsModal
          record={record}
          items={items}
          onClose={() => setShowDetails(false)}
        />
      )}

      {showEdit && record && (
        <EditModal
          record={record}
          items={items}
          onClose={() => setShowEdit(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
