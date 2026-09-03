import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  getIncentives, updateIncentivesProgress, autoComplete, fmtUnitValue,
} from '../../lib/incentivesApi';
import BrandChip from './BrandChip';
import CommissionNote from './CommissionNote';
import InactiveBrandsNotice from './InactiveBrandsNotice';

function getMonthLabel(ym) {
  const [year, month] = ym.split('-');
  return new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function pct(achieved, target) {
  if (!target || target <= 0) return 0;
  return Math.min(Math.round((Number(achieved) / Number(target)) * 100), 100);
}

// Free-form suffix with backward-compat for legacy `unit: 'percent'` docs.
function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}

// Marker for incentive items whose Achieved is auto-filled from attendance.
function AttendanceBadge() {
  return (
    <span className="badge rounded-pill" title="Auto-filled from monthly attendance %"
      style={{ fontSize: '0.55rem', background: '#dbeafe', color: '#1e40af', fontWeight: 600 }}>
      <i className="bi bi-calendar-check me-1" />Auto
    </span>
  );
}

function calcBreakdown(rec) {
  const incTotal         = (rec.incentives || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal         = (rec.bonuses   || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const incAchieved      = (rec.incentives || []).filter(i => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonAchieved      = (rec.bonuses   || []).filter(b => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const basic            = Number(rec.basicSalary) || 0;
  const totalPotential   = basic + incTotal + bonTotal;
  const totalAchieved    = basic + incAchieved + bonAchieved;
  return { basic, incTotal, bonTotal, incAchieved, bonAchieved, totalPotential, totalAchieved, total: totalAchieved };
}

// ── Edit row used inside the progress modal ──────────────────────────────────

// A TL may only edit "Achieved" on their own progress — the Target is set by the
// Boss and is read-only (a TL must not lower their own target to pass it). Mirrors
// the APC page (ApcIncentivesPage EditItemRow). Save also re-reads the target from
// the original record so a tampered client can't persist a changed target either.
function EditProgressRow({ item, cat, onChange, month }) {
  const isAtt    = item.source === 'attendance';
  // GMV-Max achieved comes from Brand Analytics (mig 317) — not typed here.
  const isGmvMax = item.source === 'gmv_max';
  // Commission tier (mig 333) — target, achieved and the money are all derived.
  const isComm   = item.source === 'commission_tier';
  const isAuto   = isAtt || isGmvMax || isComm;
  const achieved = item.achievedValue ?? '';
  const target   = isAtt ? 100 : (item.targetValue ?? '');
  const sfx      = itemSuffix(item);
  const p        = pct(achieved, target);          // display % only (rounded, capped 100)
  // single rule: raw ratio >= 0.9 — but a commission line only earns at the
  // real goal, so showing "Completed" at 90% would promise money that is not coming.
  const done     = isComm ? !!item.completed
                          : autoComplete({ ...item, achievedValue: achieved, targetValue: target });
  return (
    <div className="rounded-3 p-3 mb-2" style={{ background: done ? '#f0fdf4' : (isAuto ? '#eff6ff' : '#fafafa'), border: `1.5px solid ${done ? '#b7dfc4' : (isAuto ? '#bfdbfe' : '#e9ecef')}` }}>
      <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
        <div>
          <div className="fw-semibold small">{item.text || '—'}</div>
          {item.brandName && <div className="mt-1 mb-1"><BrandChip name={item.brandName} /></div>}
          <div className="text-muted" style={{ fontSize: '0.7rem' }}>+{(Number(item.amount) || 0).toLocaleString()} PKR</div>
        </div>
        <div className="d-flex align-items-center gap-1 flex-shrink-0">
          {isAtt && <AttendanceBadge />}
          <span className="badge rounded-pill" style={{ fontSize: '0.6rem', background: done ? '#e6f4ea' : '#fff3e0', color: done ? '#198754' : '#fd7e14' }}>
            {done ? '✓ Completed' : `${p}%`}
          </span>
        </div>
      </div>
      <div className="row g-2">
        <div className="col-6">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>
            Target <span className="text-muted" style={{ fontSize: '0.6rem' }}>(set by Boss · read-only)</span>
          </label>
          <div className="input-group input-group-sm">
            <input type="text" className="form-control"
              value={target !== '' ? fmtUnitValue(target, sfx) : '—'}
              readOnly disabled style={{ background: '#f1f5f9', cursor: 'not-allowed' }} />
            <span className="input-group-text" style={{ fontSize: '0.7rem', background: '#f1f5f9' }}>
              <i className="bi bi-lock-fill" style={{ fontSize: '0.7rem', color: '#94a3b8' }} />
            </span>
          </div>
        </div>
        <div className="col-6">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Achieved{isAuto && <span className="text-muted"> (auto{isGmvMax ? ' · Brand Analytics' : isComm ? ' · set by your Operations Lead' : ''})</span>}</label>
          <div className="input-group input-group-sm">
            <input type="number" className="form-control" min="0" value={achieved}
              onChange={e => onChange(cat, item.id, 'achievedValue', e.target.value)}
              readOnly={isAuto} disabled={isAuto} style={isAuto ? { background: '#eef2f7', cursor: 'not-allowed' } : undefined} />
            {sfx && <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sfx}</span>}
          </div>
        </div>
      </div>
      {isAtt && (
        <div className="mt-2" style={{ fontSize: '0.66rem', color: '#1e40af' }}>
          <i className="bi bi-calendar-check me-1" />Filled automatically from this month's attendance %.
        </div>
      )}
      {isGmvMax && (
        <div className="mt-2" style={{ fontSize: '0.66rem', color: '#1e40af' }}>
          <i className="bi bi-graph-up-arrow me-1" />
          Achieved comes from this brand's GMV in Brand Analytics — no need to type it.
        </div>
      )}
      {isComm && (
        <div className="mt-2" style={{ fontSize: '0.66rem', color: '#166534' }}>
          <i className="bi bi-percent me-1" />
          <CommissionNote item={item} month={month} />
        </div>
      )}
    </div>
  );
}

// ── TL Edit Own Progress Modal ───────────────────────────────────────────────

function EditProgressModal({ record, onClose, onSaved }) {
  // v2 auth shim
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;
  const [items, setItems] = useState({
    incentives: (record.incentives || []).map(i => ({ ...i })),
    bonuses:    (record.bonuses    || []).map(b => ({ ...b })),
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  function handleChange(cat, itemId, field, value) {
    setItems(prev => ({
      ...prev,
      [cat]: prev[cat].map(it => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        return { ...updated, completed: autoComplete(updated) };
      }),
    }));
  }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const myName = userProfile?.displayName || currentUser.displayName || currentUser.email?.split('@')[0] || 'User';
      // A TL may only edit `achievedValue` + `completed`. Preserve every Boss-set
      // field (text, amount, targetValue, suffix, source) by re-reading from the
      // ORIGINAL record — so a lowered target can never be persisted, even if the
      // client state were tampered. Mirrors ApcIncentivesPage.handleSave.
      const origInc = new Map((record.incentives || []).map(i => [i.id, i]));
      const origBon = new Map((record.bonuses    || []).map(b => [b.id, b]));
      const mapItem = (it, orig) => {
        const o = orig.get(it.id) || {};
        const isAtt = o.source === 'attendance';
        // commission_tier belongs here too: its benchmark and achieved are set by
        // an OL, so an APC/TL progress save must write back what was already
        // there rather than whatever arrived in the payload.
        const isAuto = isAtt || o.source === 'gmv_max' || o.source === 'commission_tier';
        return {
          id: it.id, text: o.text, amount: o.amount,
          targetValue:   isAtt ? 100 : (Number(o.targetValue) || 0),
          achievedValue: isAuto ? (Number(o.achievedValue) || 0) : (Number(it.achievedValue) || 0),
          suffix:        isAtt ? '%' : itemSuffix(o),
          completed:     isAtt ? !!o.completed : (it.completed || false),
          completedBy:   isAtt ? (o.completedBy || null) : (it.completed ? (o.completedBy || myName) : null),
          ...(o.source ? { source: o.source } : {}),
          // Preserve the hard brand link — a progress edit must never strip it.
          ...(o.brandId ? { brandId: o.brandId, brandName: o.brandName || null } : {}),
          // Same reason as brandId above: a fixed-field rebuild drops what it does not name.
          ...(o.commissionPct != null ? { commissionPct: Number(o.commissionPct) || 0 } : {}),
        };
      };
      await updateIncentivesProgress({
        rowId: record.id,
        incentives: items.incentives.map(i => mapItem(i, origInc)),
        bonuses:    items.bonuses.map(b => mapItem(b, origBon)),
      });
      onSaved(items);
    } catch { setError('Failed to save.'); } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0">Edit My Progress</h6>
              <p className="text-muted small mb-0">Update your achieved values — targets are set by the Boss</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          {items.incentives.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {items.incentives.map(i => <EditProgressRow key={i.id} item={i} cat="incentives" onChange={handleChange} month={record?.month} />)}
            </div>
          )}
          {items.bonuses.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {items.bonuses.map(b => <EditProgressRow key={b.id} item={b} cat="bonuses" onChange={handleChange} month={record?.month} />)}
            </div>
          )}
          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save Progress</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function IncentivesPage() {
  // v2 auth shim
  const { user, profile, refreshProfile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  // eslint-disable-next-line no-unused-vars
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;

  useEffect(() => { if (refreshProfile) refreshProfile(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const [myRec,   setMyRec]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [showEditProgress, setShowEditProgress] = useState(false);

  const currentMonth = getCurrentMonth();
  const [myMonth, setMyMonth] = useState(currentMonth);
  const fromName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Team Lead';

  useEffect(() => {
    if (!currentUser) return;
    async function load() {
      setLoading(true);
      const rec = await getIncentives(currentUser.uid, myMonth);
      setMyRec(rec || null);
      setLoading(false);
    }
    load();
  }, [currentUser?.uid, myMonth]);  // eslint-disable-line react-hooks/exhaustive-deps

  function handleMyProgressSaved(updatedItems) {
    setMyRec(prev => prev ? { ...prev, incentives: updatedItems.incentives, bonuses: updatedItems.bonuses } : prev);
    setShowEditProgress(false);
  }

  // My incentives summary
  const myItems       = myRec ? [...(myRec.incentives || []), ...(myRec.bonuses || [])] : [];
  const myCompleted   = myItems.filter(i => i.completed);
  const myEarned      = myCompleted.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const myPotential   = myItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const myBasic       = Number(myRec?.basicSalary) || 0;
  const myCompletionPct = myItems.length > 0 ? Math.round((myCompleted.length / myItems.length) * 100) : 0;

  return (
    <div>
      {/* Header */}
      <div className="mb-4">
        <h5 className="fw-bold mb-0">My Incentives & Bonuses</h5>
        <p className="text-muted small mb-0">{getMonthLabel(currentMonth)}</p>
      </div>

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2">
          <span className="spinner-border spinner-border-sm" /> Loading…
        </div>
      ) : (
        <>
        <div className="d-flex align-items-center gap-2 mb-3" style={{ maxWidth: 600 }}>
          <label className="text-muted small fw-semibold mb-0" style={{ whiteSpace: 'nowrap' }}>Month:</label>
          <input type="month" className="form-control form-control-sm" style={{ maxWidth: 200 }}
            value={myMonth} onChange={e => setMyMonth(e.target.value)} />
          {myMonth !== currentMonth && (
            <button className="btn btn-sm btn-outline-secondary" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}
              onClick={() => setMyMonth(currentMonth)}>Current</button>
          )}
        </div>
        {!myRec ? (
          <div className="text-center py-5 rounded-4" style={{ border: '2px dashed var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="rounded-circle d-flex align-items-center justify-content-center mx-auto mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
              <i className="bi bi-trophy text-muted" style={{ fontSize: '1.8rem', opacity: 0.55 }} />
            </div>
            <p className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No incentive plan yet</p>
            <p className="text-muted small mb-0">No plan has been set for {getMonthLabel(myMonth)}.</p>
            <p className="text-muted small mb-0">The boss will set up your incentives.</p>
          </div>
        ) : (
          <div style={{ maxWidth: 600 }}>
            <div className="card border-0 shadow-sm" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: myRec.verified ? 'linear-gradient(90deg,#198754,#51cf66)' : 'linear-gradient(90deg,#fd7e14,#ffa94d)' }} />
              <div className="p-3 d-flex align-items-center gap-3" style={{ background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' }}>
                <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
                  style={{ width: 42, height: 42, background: 'rgba(255,255,255,0.15)', fontSize: '0.85rem' }}>
                  {(currentUser?.displayName || '?').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-grow-1">
                  <div className="fw-bold">{currentUser?.displayName || fromName}</div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.7 }}>{getMonthLabel(myMonth)} · Team Lead</div>
                </div>
                <div className="d-flex flex-column align-items-end gap-1">
                  {myRec.verified && (
                    <span className="badge rounded-pill" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.62rem' }}>
                      <i className="bi bi-patch-check-fill me-1" />{myRec.verifiedByName ? `Verified by ${myRec.verifiedByName}` : 'Verified'}
                    </span>
                  )}
                  {myRec.payoutCleared && (
                    <span className="badge rounded-pill" style={{ background: '#d1e7dd', color: '#0f5132', fontSize: '0.62rem' }}>
                      <i className="bi bi-cash-stack me-1" />Payout Cleared
                    </span>
                  )}
                </div>
              </div>
              <div className="card-body p-3">
                <div className="d-flex flex-column gap-1 mb-3" style={{ fontSize: '0.82rem' }}>
                  <div className="d-flex justify-content-between"><span className="text-muted">Basic Salary</span><span className="fw-medium">{myBasic.toLocaleString()} PKR</span></div>
                  <div className="d-flex justify-content-between"><span className="text-muted">Earned ({myCompleted.length}/{myItems.length} items)</span><span className="fw-medium text-success">+{myEarned.toLocaleString()} PKR</span></div>
                  <div className="d-flex justify-content-between fw-bold pt-2 mt-1" style={{ borderTop: '1.5px solid #dee2e6', fontSize: '0.9rem' }}>
                    <span>Total Earned</span><span>{(myBasic + myEarned).toLocaleString()} PKR</span>
                  </div>
                  <div className="text-muted text-end" style={{ fontSize: '0.68rem' }}>Potential: {(myBasic + myPotential).toLocaleString()} PKR</div>
                </div>
                <div className="mb-3">
                  <div className="d-flex justify-content-between mb-1" style={{ fontSize: '0.7rem' }}>
                    <span className="text-muted">Completion</span>
                    <span className="fw-semibold">{myCompleted.length}/{myItems.length} ({myCompletionPct}%)</span>
                  </div>
                  <div className="rounded-pill overflow-hidden" style={{ height: 6, background: '#e9ecef' }}>
                    <div className="h-100 rounded-pill" style={{ width: `${myCompletionPct}%`, background: myCompletionPct === 100 ? '#198754' : '#0d6efd', transition: 'width 0.4s' }} />
                  </div>
                </div>
                <p className="text-muted mb-3" style={{ fontSize: '0.68rem' }}>
                  * Most items auto-complete at ≥90% progress. A Commission Based Tier line is the exception — it pays a percentage of whatever the brand earns above its benchmark, and nothing at or below it. Final salary is verified by the boss.
                </p>
                {!myRec.payoutCleared && (
                  <div className="d-flex gap-2">
                    <button className="btn btn-sm btn-dark flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                      style={{ borderRadius: 8, fontSize: '0.78rem' }} onClick={() => setShowEditProgress(true)}>
                      <i className="bi bi-pencil" /> Edit Progress
                    </button>
                  </div>
                )}
              </div>
            </div>
            <InactiveBrandsNotice userId={currentUser?.uid} role={profile?.role} />
          </div>
        )}

        </>
      )}


      {showEditProgress && myRec && (
        <EditProgressModal
          record={myRec}
          onClose={() => setShowEditProgress(false)}
          onSaved={handleMyProgressSaved}
        />
      )}
    </div>
  );
}
