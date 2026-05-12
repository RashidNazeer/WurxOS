import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getIncentives, getMostRecentPriorPlan,
  listIncentivesMonth, listUsersByRoles,
  updateIncentivesProgress, savePlan,
  verifyIncentives, notifyIncentiveEmployee,
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
function calcBreakdown(rec) {
  const incTotal    = (rec.incentives || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal    = (rec.bonuses    || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const incAchieved = (rec.incentives || []).filter(i => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonAchieved = (rec.bonuses    || []).filter(b => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const basic       = Number(rec.basicSalary) || 0;
  return { basic, incTotal, bonTotal, incAchieved, bonAchieved, total: basic + incAchieved + bonAchieved };
}

function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}

// ── Edit Row (own progress) ───────────────────────────────────────────────────
function EditRow({ item, cat, onChange }) {
  const achieved = item.achievedValue ?? '';
  const target   = item.targetValue   ?? '';
  const sfx      = itemSuffix(item);
  const p        = pct(achieved, target);
  const done     = p >= 90;
  return (
    <div className="rounded-3 p-3 mb-2" style={{ background: done ? '#f0fdf4' : '#fafafa', border: `1.5px solid ${done ? '#b7dfc4' : '#e9ecef'}` }}>
      <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
        <div>
          <div className="fw-semibold small">{item.text || '—'}</div>
          <div className="text-muted" style={{ fontSize: '0.7rem' }}>+{(Number(item.amount) || 0).toLocaleString()} PKR</div>
        </div>
        <span className="badge rounded-pill flex-shrink-0" style={{ fontSize: '0.6rem', background: done ? '#e6f4ea' : '#fff3e0', color: done ? '#198754' : '#fd7e14' }}>
          {done ? '✓ Completed' : `${p}%`}
        </span>
      </div>
      <div className="row g-2">
        <div className="col-5">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Target</label>
          <div className="input-group input-group-sm">
            <input type="number" className="form-control" min="0" value={target}
              onChange={e => onChange(cat, item.id, 'targetValue', e.target.value)} />
            {sfx && <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sfx}</span>}
          </div>
        </div>
        <div className="col-5">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Achieved</label>
          <div className="input-group input-group-sm">
            <input type="number" className="form-control" min="0" value={achieved}
              onChange={e => onChange(cat, item.id, 'achievedValue', e.target.value)} />
            {sfx && <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sfx}</span>}
          </div>
        </div>
        <div className="col-2">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Unit</label>
          <input type="text" className="form-control form-control-sm" placeholder="%" maxLength={6}
            value={sfx} onChange={e => onChange(cat, item.id, 'suffix', e.target.value)}
            style={{ textAlign: 'center', fontSize: '0.78rem' }} />
        </div>
      </div>
    </div>
  );
}

function EditOwnModal({ record, items, onClose, onSaved }) {
  // v2 auth shim
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;
  const [editItems, setEditItems] = useState({
    incentives: items.incentives.map(i => ({ ...i })),
    bonuses:    items.bonuses.map(b => ({ ...b })),
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  function handleChange(cat, itemId, field, value) {
    setEditItems(prev => ({
      ...prev,
      [cat]: prev[cat].map(it => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        const p = pct(field === 'achievedValue' ? value : updated.achievedValue, field === 'targetValue' ? value : updated.targetValue);
        return { ...updated, completed: p >= 90 };
      }),
    }));
  }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const myName = userProfile?.displayName || currentUser.displayName || currentUser.email?.split('@')[0] || 'OL';
      await updateIncentivesProgress({
        rowId: record.id,
        incentives: editItems.incentives.map(i => ({
          id: i.id, text: i.text, amount: i.amount,
          targetValue: Number(i.targetValue) || 0, achievedValue: Number(i.achievedValue) || 0,
          suffix: itemSuffix(i),
          completed: i.completed || false,
          completedBy: i.completed ? (i.completedBy || myName) : null,
        })),
        bonuses: editItems.bonuses.map(b => ({
          id: b.id, text: b.text, amount: b.amount,
          targetValue: Number(b.targetValue) || 0, achievedValue: Number(b.achievedValue) || 0,
          suffix: itemSuffix(b),
          completed: b.completed || false,
          completedBy: b.completed ? (b.completedBy || myName) : null,
        })),
      });
      onSaved(editItems);
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
              <p className="text-muted small mb-0">Update your target & achieved values</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          {editItems.incentives.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {editItems.incentives.map(i => <EditRow key={i.id} item={i} cat="incentives" onChange={handleChange} />)}
            </div>
          )}
          {editItems.bonuses.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {editItems.bonuses.map(b => <EditRow key={b.id} item={b} cat="bonuses" onChange={handleChange} />)}
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

// ── User Details Modal (OL viewing an APC/IPC, with edit/toggle/verify) ──────
function UserDetailsModal({ rec, user, onClose, onToggleItem, onVerify, onUnverify, verifying }) {
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState({ incentives: [], bonuses: [] });

  // Reset edit state whenever the record changes (different user or fresh data)
  useEffect(() => {
    if (rec) {
      setEditItems({
        incentives: (rec.incentives || []).map(i => ({ ...i })),
        bonuses:    (rec.bonuses    || []).map(b => ({ ...b })),
      });
    }
    setEditMode(false);
  }, [rec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rec) return null;
  const { basic, incTotal, bonTotal, incAchieved, bonAchieved } = calcBreakdown(rec);
  const allItems = [...(rec.incentives || []), ...(rec.bonuses || [])];
  const completed = allItems.filter(i => i.completed).length;

  function handleEditChange(cat, itemId, field, value) {
    setEditItems(prev => ({
      ...prev,
      [cat]: prev[cat].map(it => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        const p = pct(field === 'achievedValue' ? value : updated.achievedValue, field === 'targetValue' ? value : updated.targetValue);
        return { ...updated, completed: p >= 90 };
      }),
    }));
  }

  function diffSummary() {
    const changes = [];
    for (const cat of ['incentives', 'bonuses']) {
      const orig = rec[cat] || [];
      for (const edited of editItems[cat]) {
        const o = orig.find(x => x.id === edited.id);
        if (!o) continue;
        const oT = Number(o.targetValue) || 0, eT = Number(edited.targetValue) || 0;
        const oA = Number(o.achievedValue) || 0, eA = Number(edited.achievedValue) || 0;
        if (oT !== eT || oA !== eA) {
          changes.push({ id: edited.id, text: edited.text, fromTarget: oT, toTarget: eT, fromAchieved: oA, toAchieved: eA });
        }
      }
    }
    return changes;
  }

  function ItemDetail({ item, category }) {
    const p = pct(item.achievedValue, item.targetValue);
    const unitSfx = itemSuffix(item);
    const fmtN = n => Number(n || 0).toLocaleString();
    return (
      <div className="rounded-3 p-2 mb-2" style={{ background: item.completed ? '#f0fdf4' : '#fafafa', border: `1px solid ${item.completed ? '#b7dfc4' : '#e9ecef'}` }}>
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="small fw-semibold">{item.text || '—'}</div>
            <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>+{fmtN(item.amount)} PKR</div>
            {item.targetValue > 0 && (
              <div className="d-flex flex-wrap gap-3 mt-1" style={{ fontSize: '0.82rem' }}>
                <span><span className="text-muted">Target:</span> <span className="fw-semibold" style={{ color: '#1e293b' }}>{fmtN(item.targetValue)}{unitSfx}</span></span>
                {item.achievedValue != null && (
                  <span>
                    <span className="text-muted">Achieved:</span>{' '}
                    <span className="fw-semibold" style={{ color: item.completed ? '#15803d' : '#0f172a' }}>
                      {fmtN(item.achievedValue)}{unitSfx}
                    </span>
                    <span className="ms-1" style={{ color: item.completed ? '#16a34a' : '#475569', fontWeight: 600 }}>({p}%)</span>
                  </span>
                )}
              </div>
            )}
            {item.completedBy && (
              <div style={{ fontSize: '0.68rem', color: '#198754', marginTop: 4 }}>
                <i className="bi bi-person-check me-1" />Marked by {item.completedBy}
              </div>
            )}
          </div>
          <div className="d-flex align-items-center gap-1 flex-shrink-0">
            <span className="badge rounded-pill" style={{ fontSize: '0.6rem', background: item.completed ? '#e6f4ea' : '#f3f4f6', color: item.completed ? '#198754' : '#6c757d' }}>
              {item.completed ? '✓ Done' : `${p}%`}
            </span>
            <button className="btn btn-sm btn-link p-0" style={{ fontSize: '0.7rem', color: item.completed ? '#dc3545' : '#198754' }}
              onClick={() => onToggleItem(rec, category, item.id, !item.completed)}
              title={item.completed ? 'Mark incomplete' : 'Mark complete'}>
              <i className={`bi ${item.completed ? 'bi-x-circle' : 'bi-check-circle'}`} />
            </button>
          </div>
        </div>
        {item.targetValue > 0 && (
          <div className="mt-2">
            <div className="rounded-pill overflow-hidden" style={{ height: 4, background: '#e9ecef' }}>
              <div className="h-100 rounded-pill" style={{ width: `${p}%`, background: item.completed ? '#198754' : '#0d6efd', transition: 'width 0.3s' }} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-0">{user?.userName || user?.displayName} — Details</h6>
              <p className="text-muted small mb-0 d-flex align-items-center gap-2 flex-wrap">
                <span>{getMonthLabel(rec.month)} · {completed}/{allItems.length} completed</span>
                {rec.ghosted && rec.sourceMonth && (
                  <span className="badge rounded-pill" style={{ background: '#dbeafe', color: '#1e40af', fontSize: '0.6rem', fontWeight: 600 }}
                    title={`Plan carried forward from ${getMonthLabel(rec.sourceMonth)}; will be saved as a new doc on first edit/verify.`}>
                    <i className="bi bi-arrow-down-circle me-1" />Carried from {getMonthLabel(rec.sourceMonth)}
                  </span>
                )}
              </p>
            </div>
            <div className="d-flex align-items-center gap-1">
              {!rec.verified && !editMode && (
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.72rem' }}
                  onClick={() => setEditMode(true)}
                  title="Edit Target/Achieved values">
                  <i className="bi bi-pencil" /> Edit
                </button>
              )}
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
                style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
              </button>
            </div>
          </div>

          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8f9fa', border: '1px solid #e9ecef' }}>
            <div className="d-flex justify-content-between small">
              <span className="text-muted">Basic Salary</span>
              <span className="fw-medium">{basic.toLocaleString()} PKR</span>
            </div>
            <div className="d-flex justify-content-between small">
              <span className="text-muted">Incentives Earned</span>
              <span className="fw-medium text-success">+{incAchieved.toLocaleString()} / {incTotal.toLocaleString()} PKR</span>
            </div>
            <div className="d-flex justify-content-between small">
              <span className="text-muted">Bonuses Earned</span>
              <span className="fw-medium text-primary">+{bonAchieved.toLocaleString()} / {bonTotal.toLocaleString()} PKR</span>
            </div>
            <div className="d-flex justify-content-between fw-bold pt-2 mt-2" style={{ borderTop: '1.5px solid #dee2e6' }}>
              <span>Total Earned</span>
              <span>{(basic + incAchieved + bonAchieved).toLocaleString()} PKR</span>
            </div>
          </div>

          {editMode && (
            <div className="alert d-flex align-items-start gap-2 py-2 mb-3"
              style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, color: '#78350f', fontSize: '0.78rem' }}>
              <i className="bi bi-info-circle-fill flex-shrink-0 mt-1" />
              <div>Edit Target / Achieved values below. Saving will verify the record and notify {user?.userName || user?.displayName} of the changes.</div>
            </div>
          )}

          {(rec.incentives || []).length > 0 && (
            <div className="mb-3">
              <p className="text-muted small fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {(editMode ? editItems.incentives : rec.incentives).map(i =>
                editMode
                  ? <EditRow key={i.id} item={i} cat="incentives" onChange={handleEditChange} />
                  : <ItemDetail key={i.id} item={i} category="incentives" />
              )}
            </div>
          )}
          {(rec.bonuses || []).length > 0 && (
            <div className="mb-3">
              <p className="text-muted small fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {(editMode ? editItems.bonuses : rec.bonuses).map(b =>
                editMode
                  ? <EditRow key={b.id} item={b} cat="bonuses" onChange={handleEditChange} />
                  : <ItemDetail key={b.id} item={b} category="bonuses" />
              )}
            </div>
          )}

          <div className="d-flex gap-2 justify-content-end mt-3">
            {editMode ? (
              <>
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setEditMode(false)} disabled={verifying === rec.id}>
                  Cancel edits
                </button>
                <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1"
                  onClick={() => onVerify(rec, { editedItems: editItems, changes: diffSummary() })}
                  disabled={verifying === rec.id}>
                  {verifying === rec.id ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-patch-check-fill" /> Save & Verify</>}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Close</button>
                {!rec.verified && (
                  <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1"
                    onClick={() => onVerify(rec)} disabled={verifying === rec.id}>
                    {verifying === rec.id ? <><span className="spinner-border spinner-border-sm" /> Verifying…</> : <><i className="bi bi-patch-check-fill" /> Verify</>}
                  </button>
                )}
                {rec.verified && (
                  <>
                    <span className="badge rounded-pill px-3 py-2 d-inline-flex align-items-center gap-1"
                      style={{ background: '#e6f4ea', color: '#15803d', border: '1px solid #bbf7d0', fontSize: '0.75rem' }}>
                      <i className="bi bi-patch-check-fill" /> Verified
                    </span>
                    <button className="btn btn-sm btn-outline-warning px-3 d-inline-flex align-items-center gap-1"
                      onClick={() => onUnverify(rec)} disabled={verifying === rec.id}
                      title="Mark as unverified and notify the user">
                      {verifying === rec.id ? <><span className="spinner-border spinner-border-sm" /> Working…</> : <><i className="bi bi-arrow-counterclockwise" /> Mark Unverified</>}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function OLIncentivesPage() {
  // v2 auth shim
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;
  const currentMonth = getCurrentMonth();

  // Filters live in the URL so back-navigation from the form preserves them.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab          = searchParams.get('tab') || 'apcs';
  const month        = searchParams.get('month') || currentMonth;
  const search       = searchParams.get('q') || '';
  const filterStatus = searchParams.get('status') || '';
  const filterTeam   = searchParams.get('team') || '';
  function patchUrl(updates) {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  }
  const setTab          = v => patchUrl({ tab: v === 'apcs' ? '' : v });
  const setMonth        = v => patchUrl({ month: v === currentMonth ? '' : v });
  const setSearch       = v => patchUrl({ q: v });
  const setFilterStatus = v => patchUrl({ status: v });
  const setFilterTeam   = v => patchUrl({ team: v });

  // Own incentives state
  const [myRecord, setMyRecord] = useState(null);
  const [myItems, setMyItems] = useState({ incentives: [], bonuses: [] });
  const [showEditOwn, setShowEditOwn] = useState(false);

  // APC/IPC management state
  const [allUsers, setAllUsers] = useState([]); // both APCs and IPCs
  const [records, setRecords] = useState({}); // userId → incentive doc
  const [loading, setLoading] = useState(true);
  const [detailsTarget, setDetailsTarget] = useState(null);
  const [verifying, setVerifying] = useState(null);

  // Search + filters (apcs/ipcs tabs)
  // (search/filterStatus/filterTeam now derived from URL above)

  useEffect(() => {
    if (!currentUser) return;
    async function load() {
      setLoading(true);

      // 1. Load OL's own incentive record
      const myRec = await getIncentives(currentUser.uid, month);
      if (myRec) {
        setMyRecord(myRec);
        setMyItems({
          incentives: (myRec.incentives || []).map(i => ({ ...i, achievedValue: i.achievedValue ?? '', targetValue: i.targetValue ?? '', suffix: itemSuffix(i) })),
          bonuses:    (myRec.bonuses    || []).map(b => ({ ...b, achievedValue: b.achievedValue ?? '', targetValue: b.targetValue ?? '', suffix: itemSuffix(b) })),
        });
      } else {
        setMyRecord(null);
        setMyItems({ incentives: [], bonuses: [] });
      }

      // 2. Load ALL APCs and IPCs (across the entire office)
      const teamList = await listUsersByRoles(['apc', 'ipc']);
      setAllUsers(teamList);

      // 3. Load all incentive records for the selected month
      const incList = await listIncentivesMonth(month);
      const map = {};
      incList.forEach((data) => {
        const uid = data.userId;
        if (!uid) return;
        if (data.userRole === 'apc' || data.userRole === 'ipc') {
          map[uid] = data;
        }
      });

      // 3b. Auto carry-forward: for users without a plan this month,
      // fall back to their most recent prior plan and synthesise a
      // ghost record (no doc yet) with achieved/completed reset.
      const missing = teamList.filter(u => !map[u.id]);
      await Promise.all(missing.map(async (u) => {
        try {
          const prior = await getMostRecentPriorPlan(u.id, month);
          if (!prior) return;
          map[u.id] = {
            ...prior,
            id: `ghost:${u.id}`,
            _ghost: true,
            ghosted: true,
            sourceMonth: prior.month,
            month,
            verified: false, verifiedAt: null, verifiedBy: null, verifiedByName: null, verifiedByRole: null,
            payoutCleared: false, payoutClearedAt: null, payoutClearedBy: null,
            incentives: (prior.incentives || []).map(i => ({ ...i, completed: false, achievedValue: 0, completedBy: null })),
            bonuses:    (prior.bonuses    || []).map(b => ({ ...b, completed: false, achievedValue: 0, completedBy: null })),
          };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('Carry-forward lookup failed for', u.id, err);
        }
      }));

      setRecords(map);
      setLoading(false);
    }
    load();
  }, [currentUser?.uid, month]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Materialise a ghost (carried-over) record into a real row.
  // Returns the rec with a real id assigned. Updates local state too.
  async function materializeGhost(rec) {
    if (!rec.ghosted) return rec;
    const userKey = rec.userId;
    const saved = await savePlan({
      id: null,
      userId: userKey,
      month,
      basicSalary: rec.basicSalary || 0,
      incentives: rec.incentives || [],
      bonuses:    rec.bonuses    || [],
    });
    const live = { ...rec, ...saved, id: saved.id, ghosted: false, _ghost: false, carriedFrom: rec.sourceMonth || null };
    setRecords(prev => ({ ...prev, [userKey]: live }));
    return live;
  }

  const apcs = allUsers.filter(u => !u.userType || u.userType === 'apc');
  const ipcs = allUsers.filter(u => u.userType === 'ipc');
  const baseList = tab === 'apcs' ? apcs : tab === 'ipcs' ? ipcs : [];

  // Apply search + filters before rendering and for stats
  const list = baseList.filter(u => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = `${u.userName || ''} ${u.email || ''} ${u.ownerName || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filterTeam && u.ownerId !== filterTeam) return false;
    const rec = records[u.id];
    if (filterStatus === 'no_plan' && rec) return false;
    if (filterStatus === 'has_plan' && !rec) return false;
    if (filterStatus === 'verified' && !rec?.verified) return false;
    if (filterStatus === 'unverified' && (!rec || rec.verified)) return false;
    return true;
  });

  // Team options for filter dropdown (unique TLs across the visible base list)
  const teamOptions = Array.from(
    baseList.reduce((m, u) => { if (u.ownerId) m.set(u.ownerId, u.ownerName || 'Team Lead'); return m; }, new Map())
  ).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  const hasFilters = !!(search || filterStatus || filterTeam);
  const clearFilters = () => { setSearch(''); setFilterStatus(''); setFilterTeam(''); };

  async function handleToggleItem(recArg, category, itemId, newCompleted) {
    const live = await materializeGhost(recArg);
    const updated = { ...live, [category]: live[category].map(i => i.id === itemId ? { ...i, completed: newCompleted, completedBy: newCompleted ? 'OL' : null } : i) };
    await updateIncentivesProgress({
      rowId: live.id,
      incentives: updated.incentives,
      bonuses:    updated.bonuses,
    });
    const key = live.userId;
    setRecords(prev => ({ ...prev, [key]: updated }));
    setDetailsTarget(prev => prev ? { ...prev, rec: updated } : prev);
  }

  async function handleVerify(recArg, editsPayload = null) {
    setVerifying(recArg.id);
    try {
      const rec = await materializeGhost(recArg);
      const myName = userProfile?.displayName || currentUser?.displayName || 'Operation Lead';

      // If OL adjusted any items inline, persist them first.
      const changes = editsPayload?.changes || [];
      let savedRec = rec;
      if (editsPayload?.editedItems && changes.length > 0) {
        const sanitize = (arr) => arr.map(i => ({
          id: i.id, text: i.text, amount: i.amount,
          targetValue: Number(i.targetValue) || 0,
          achievedValue: Number(i.achievedValue) || 0,
          suffix: itemSuffix(i),
          completed: !!i.completed,
          completedBy: i.completed ? (i.completedBy || myName) : null,
        }));
        savedRec = await updateIncentivesProgress({
          rowId: rec.id,
          incentives: sanitize(editsPayload.editedItems.incentives),
          bonuses:    sanitize(editsPayload.editedItems.bonuses),
        });
      }

      // Flip verified via the SECURITY DEFINER RPC. The server stamps
      // verified_by + verified_at and emits a notification to the user.
      await verifyIncentives(rec.id, true);

      const key = rec.userId;
      const updatedRec = {
        ...savedRec,
        verified: true,
        verifiedByName: myName,
        verifiedByRole: 'ol',
      };
      setRecords(prev => ({ ...prev, [key]: updatedRec }));

      setDetailsTarget(null);
    } finally { setVerifying(null); }
  }

  async function handleUnverify(rec) {
    if (rec.ghosted) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Mark ${rec.userName || 'this user'}'s incentives as unverified for ${getMonthLabel(rec.month)}? They will be notified.`)) return;
    setVerifying(rec.id);
    try {
      // inc_verify(rec.id, false) un-verifies and resets payout_cleared
      // server-side. v2 RPC does NOT push a notification on unverify
      // by default, so we follow up with notifyIncentiveEmployee to
      // emit a "your incentives have been updated" ping. v1's body
      // text differed; close enough for parity since the action is
      // surfaced in the notifications list anyway.
      await verifyIncentives(rec.id, false);
      try { await notifyIncentiveEmployee(rec.id); } catch { /* non-fatal */ }
      const key = rec.userId;
      setRecords(prev => ({ ...prev, [key]: { ...rec, verified: false, verifiedByName: null, verifiedByRole: null, payoutCleared: false } }));
      setDetailsTarget(null);
    } finally { setVerifying(null); }
  }

  function handleSavedOwn(updatedItems) {
    setMyItems(updatedItems);
    setShowEditOwn(false);
  }

  // Stats for selected tab (APC or IPC)
  const totalPayout   = list.reduce((s, u) => { const r = records[u.id]; return r ? s + calcBreakdown(r).total : s; }, 0);
  const recordsCount  = list.filter(u => records[u.id]).length;
  const verifiedCount = list.filter(u => records[u.id]?.verified).length;

  // ── Combined payout snapshot (APCs + IPCs cumulative) ─────────────────────
  const combinedStats = (() => {
    const teamUsers = [...apcs, ...ipcs];
    let totalBase = 0, incEarned = 0, incPotential = 0, bonEarned = 0, bonPotential = 0;
    let withPlans = 0, fullyAchieved = 0, partial = 0, noneEarned = 0, noPlan = 0;
    for (const u of teamUsers) {
      const r = records[u.id];
      if (!r) { noPlan++; continue; }
      withPlans++;
      const incs = r.incentives || [];
      const bons = r.bonuses    || [];
      totalBase    += Number(r.basicSalary) || 0;
      const ip     = incs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const ie     = incs.filter(i => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const bp     = bons.reduce((s, b) => s + (Number(b.amount) || 0), 0);
      const be     = bons.filter(b => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
      incPotential += ip; incEarned += ie;
      bonPotential += bp; bonEarned += be;

      // Achievement bucket — based on incentive items only
      const incCount = incs.length;
      const completedInc = incs.filter(i => i.completed).length;
      if (incCount === 0)              partial++;        // no incentive items defined → counts as partial / N/A
      else if (completedInc === 0)     noneEarned++;
      else if (completedInc === incCount) fullyAchieved++;
      else                             partial++;
    }
    const totalPayout = totalBase + incEarned + bonEarned;
    return {
      teamSize: teamUsers.length, withPlans, noPlan,
      totalBase, incEarned, incPotential, bonEarned, bonPotential, totalPayout,
      fullyAchieved, partial, noneEarned,
    };
  })();

  // My incentives summary
  const myAllItems     = [...myItems.incentives, ...myItems.bonuses];
  const myCompleted    = myAllItems.filter(i => i.completed);
  const myEarned       = myCompleted.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const myPotential    = myAllItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const myBasic        = Number(myRecord?.basicSalary) || 0;
  const myTotalEarned  = myBasic + myEarned;
  const myCompletionPct = myAllItems.length > 0 ? Math.round((myCompleted.length / myAllItems.length) * 100) : 0;
  const myName = userProfile?.displayName || currentUser?.displayName || 'Operation Lead';

  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-3 mb-4">
        <div>
          <h5 className="fw-bold mb-1">Incentives & Bonuses</h5>
          <p className="text-muted mb-0" style={{ fontSize: '0.82rem' }}>
            <i className="bi bi-calendar3 me-1" />{getMonthLabel(month)}
          </p>
        </div>
        <input type="month" className="form-control form-control-sm"
          value={month} onChange={e => setMonth(e.target.value)}
          style={{ width: 160, fontSize: '0.8rem', borderRadius: 8 }} />
      </div>

      {/* Combined payout snapshot — cumulative APC + IPC */}
      {!loading && combinedStats.teamSize > 0 && (
        <CombinedPayoutSnapshot stats={combinedStats} monthLabel={getMonthLabel(month)} />
      )}

      {/* Tabs */}
      <div className="d-flex gap-1 mb-4" style={{ borderBottom: '2px solid #e9ecef' }}>
        {[
          { key: 'apcs', label: 'APC Incentives', icon: 'bi-people' },
          { key: 'ipcs', label: 'IPC Incentives', icon: 'bi-people-fill' },
          { key: 'my',   label: 'My Incentives',  icon: 'bi-person' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
            style={{
              borderRadius: '8px 8px 0 0', fontWeight: 600, fontSize: '0.78rem',
              background: tab === t.key ? '#1a1a2e' : 'transparent',
              color: tab === t.key ? '#fff' : '#6c757d',
              border: 'none', marginBottom: -2,
            }}>
            <i className={`bi ${t.icon}`} />{t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2">
          <span className="spinner-border spinner-border-sm" /> Loading…
        </div>
      ) : tab === 'my' ? (
        /* ── My Incentives Tab ── */
        !myRecord ? (
          <div className="text-center py-5 rounded-4" style={{ border: '2px dashed var(--border-subtle)', background: 'var(--surface-1)', maxWidth: 600 }}>
            <div className="rounded-circle d-flex align-items-center justify-content-center mx-auto mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
              <i className="bi bi-trophy text-muted" style={{ fontSize: '1.8rem', opacity: 0.55 }} />
            </div>
            <p className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No incentive plan yet</p>
            <p className="text-muted small mb-0">No plan has been set for {getMonthLabel(month)}.</p>
          </div>
        ) : (
          <div style={{ maxWidth: 600 }}>
            <div className="card border-0 shadow-sm" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: myRecord.verified ? 'linear-gradient(90deg,#198754,#51cf66)' : 'linear-gradient(90deg,#fd7e14,#ffa94d)' }} />
              <div className="p-3 d-flex align-items-center gap-3" style={{ background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' }}>
                <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
                  style={{ width: 42, height: 42, background: 'rgba(255,255,255,0.15)', fontSize: '0.85rem' }}>
                  {myName.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-grow-1">
                  <div className="fw-bold">{myName}</div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.7 }}>{getMonthLabel(month)} · Operation Lead</div>
                </div>
                {myRecord.verified && (
                  <span className="badge rounded-pill" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.62rem' }}>
                    <i className="bi bi-patch-check-fill me-1" />Boss Verified
                  </span>
                )}
              </div>
              <div className="card-body p-3">
                <div className="d-flex flex-column gap-1 mb-3" style={{ fontSize: '0.82rem' }}>
                  <div className="d-flex justify-content-between"><span className="text-muted">Basic Salary</span><span className="fw-medium">{myBasic.toLocaleString()} PKR</span></div>
                  <div className="d-flex justify-content-between"><span className="text-muted">Earned ({myCompleted.length}/{myAllItems.length} items)</span><span className="fw-medium text-success">+{myEarned.toLocaleString()} PKR</span></div>
                  <div className="d-flex justify-content-between fw-bold pt-2 mt-1" style={{ borderTop: '1.5px solid #dee2e6', fontSize: '0.9rem' }}>
                    <span>Total Earned</span><span>{myTotalEarned.toLocaleString()} PKR</span>
                  </div>
                  <div className="text-muted text-end" style={{ fontSize: '0.68rem' }}>Potential: {(myBasic + myPotential).toLocaleString()} PKR</div>
                </div>
                <div className="mb-3">
                  <div className="d-flex justify-content-between mb-1" style={{ fontSize: '0.7rem' }}>
                    <span className="text-muted">Completion</span>
                    <span className="fw-semibold">{myCompleted.length}/{myAllItems.length} ({myCompletionPct}%)</span>
                  </div>
                  <div className="rounded-pill overflow-hidden" style={{ height: 6, background: '#e9ecef' }}>
                    <div className="h-100 rounded-pill" style={{ width: `${myCompletionPct}%`, background: myCompletionPct === 100 ? '#198754' : '#0d6efd', transition: 'width 0.4s' }} />
                  </div>
                </div>
                {!myRecord.payoutCleared && (
                  <button className="btn btn-sm btn-dark w-100 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.78rem' }} onClick={() => setShowEditOwn(true)}>
                    <i className="bi bi-pencil" /> Edit Progress
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      ) : (
        /* ── APC/IPC Management Tab ── */
        <>
          {recordsCount > 0 && (
            <div className="d-flex gap-2 flex-wrap mb-3">
              {[
                { label: 'Total Payout', value: `${totalPayout.toLocaleString()} PKR`, bg: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' },
                { label: 'With Plans',   value: `${recordsCount} / ${list.length}`,    bg: '#e8f0fe', color: '#0d6efd' },
                { label: 'Verified',     value: `${verifiedCount} / ${recordsCount}`,  bg: '#e6f4ea', color: '#198754' },
              ].map(s => (
                <div key={s.label} className="rounded-3 px-3 py-2 text-center" style={{ background: s.bg, color: s.color, minWidth: 110 }}>
                  <div style={{ fontSize: '0.6rem', opacity: 0.7, letterSpacing: 1, textTransform: 'uppercase' }}>{s.label}</div>
                  <div className="fw-bold" style={{ fontSize: '1rem' }}>{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Search + filters */}
          {baseList.length > 0 && (
            <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
              <div className="position-relative flex-grow-1" style={{ minWidth: 200, maxWidth: 320 }}>
                <i className="bi bi-search position-absolute text-muted"
                  style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
                <input type="text" className="form-control form-control-sm"
                  placeholder={`Search ${tab === 'apcs' ? 'APCs' : 'IPCs'}…`}
                  style={{ paddingLeft: 28, borderRadius: 8 }}
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <select className="form-select form-select-sm"
                value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                style={{ width: 160, borderRadius: 8 }}>
                <option value="">All Statuses</option>
                <option value="no_plan">No Plan</option>
                <option value="has_plan">With Plan</option>
                <option value="verified">Verified</option>
                <option value="unverified">Unverified</option>
              </select>
              {teamOptions.length > 0 && (
                <select className="form-select form-select-sm"
                  value={filterTeam} onChange={e => setFilterTeam(e.target.value)}
                  style={{ width: 180, borderRadius: 8 }}>
                  <option value="">All Teams</option>
                  {teamOptions.map(t => (
                    <option key={t.id} value={t.id}>Team {t.name}</option>
                  ))}
                </select>
              )}
              {hasFilters && (
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={clearFilters}>
                  <i className="bi bi-x-circle" /> Clear
                </button>
              )}
              <span className="text-muted small ms-auto" style={{ fontSize: '0.75rem' }}>
                {list.length} of {baseList.length}
              </span>
            </div>
          )}

          {list.length === 0 ? (
            <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 12 }}>
              <i className="bi bi-people text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
              <p className="text-muted mt-3 mb-0">
                {hasFilters
                  ? `No ${tab === 'apcs' ? 'APCs' : 'IPCs'} match your filters.`
                  : `No ${tab === 'apcs' ? 'APCs' : 'IPCs'} in the office yet.`}
              </p>
            </div>
          ) : (
            <div className="row g-3">
              {list.map(user => {
                const rec = records[user.id];
                const hasData = Boolean(rec);
                const brands = (user.assignedBrands || []).map(b => b.name);
                const totalItems = hasData ? (rec.incentives || []).length + (rec.bonuses || []).length : 0;
                const completedItems = hasData ? (rec.incentives || []).filter(i => i.completed).length + (rec.bonuses || []).filter(b => b.completed).length : 0;
                const breakdown = hasData ? calcBreakdown(rec) : null;
                return (
                  <div key={user.id} className="col-md-6 col-xl-4">
                    <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, overflow: 'hidden' }}>
                      <div style={{ height: 4, background: hasData ? (rec.verified ? 'linear-gradient(90deg,#198754,#51cf66)' : 'linear-gradient(90deg,#fd7e14,#ffa94d)') : '#dee2e6' }} />
                      <div className="card-body p-3">
                        <div className="d-flex align-items-center gap-2 mb-2">
                          <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                            style={{ width: 36, height: 36, background: '#1a1a2e', fontSize: '0.75rem' }}>
                            {(user.userName || '?').slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-grow-1 min-width-0">
                            <div className="fw-semibold text-truncate small">{user.userName}</div>
                            <div className="text-muted text-truncate" style={{ fontSize: '0.68rem' }}>
                              {user.ownerName ? `Under ${user.ownerName}` : user.email}
                            </div>
                          </div>
                          {hasData && rec.verified && (
                            <span className="badge rounded-pill" title="Verified" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.58rem' }}>
                              <i className="bi bi-patch-check-fill" />
                            </span>
                          )}
                          {hasData && rec.ghosted && (
                            <span className="badge rounded-pill" title={`Carried over from ${getMonthLabel(rec.sourceMonth)}`}
                              style={{ background: '#dbeafe', color: '#1e40af', fontSize: '0.58rem', fontWeight: 600 }}>
                              <i className="bi bi-arrow-down-circle" /> Carried
                            </span>
                          )}
                        </div>

                        {brands.length > 0 && (
                          <div className="d-flex flex-wrap gap-1 mb-2">
                            {brands.slice(0, 3).map((b, i) => (
                              <span key={i} className="badge" style={{ background: '#f3f4f6', color: '#495057', fontSize: '0.6rem', fontWeight: 500 }}>{b}</span>
                            ))}
                            {brands.length > 3 && <span className="badge" style={{ background: '#f3f4f6', color: '#9ca3af', fontSize: '0.6rem' }}>+{brands.length - 3}</span>}
                          </div>
                        )}

                        {hasData ? (
                          <>
                            <div className="rounded-3 p-2 mb-2" style={{ background: '#f8f9fa' }}>
                              <div className="d-flex justify-content-between" style={{ fontSize: '0.7rem' }}>
                                <span className="text-muted">Total Payout</span>
                                <span className="fw-bold text-dark">{breakdown.total.toLocaleString()} PKR</span>
                              </div>
                              <div className="d-flex justify-content-between" style={{ fontSize: '0.65rem' }}>
                                <span className="text-muted">Items</span>
                                <span className="text-muted">{completedItems}/{totalItems} done</span>
                              </div>
                            </div>
                            <div className="d-flex gap-1">
                              <button className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                                style={{ border: '1.5px solid #dee2e6', borderRadius: 8, background: '#fff', color: '#495057', fontSize: '0.7rem' }}
                                onClick={() => setDetailsTarget({ user, rec })}>
                                <i className="bi bi-eye" /> Details
                              </button>
                              <Link to={`/incentives/edit/${user.id}?month=${encodeURIComponent(month)}`} className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1 btn-dark"
                                style={{ borderRadius: 8, fontSize: '0.7rem' }}>
                                <i className="bi bi-pencil" /> Edit Plan
                              </Link>
                            </div>
                          </>
                        ) : (
                          <Link to={`/incentives/edit/${user.id}?month=${encodeURIComponent(month)}`} className="btn btn-sm btn-outline-dark w-100 d-inline-flex align-items-center justify-content-center gap-1"
                            style={{ borderRadius: 8, fontSize: '0.72rem' }}>
                            <i className="bi bi-plus-lg" /> Create Plan
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {detailsTarget && (
        <UserDetailsModal
          rec={detailsTarget.rec}
          user={detailsTarget.user}
          onClose={() => setDetailsTarget(null)}
          onToggleItem={handleToggleItem}
          onVerify={handleVerify}
          onUnverify={handleUnverify}
          verifying={verifying}
        />
      )}
      {showEditOwn && myRecord && (
        <EditOwnModal record={myRecord} items={myItems} onClose={() => setShowEditOwn(false)} onSaved={handleSavedOwn} />
      )}
    </div>
  );
}

// ── Combined payout snapshot block (APCs + IPCs cumulative) ─────────────────
function CombinedPayoutSnapshot({ stats: s, monthLabel }) {
  const fmt = n => Number(n || 0).toLocaleString();
  const pkr = n => fmt(n) + ' PKR';
  const total = s.totalPayout || 1;
  const basePct = (s.totalBase    / total) * 100;
  const incPct  = (s.incEarned    / total) * 100;
  const bonPct  = (s.bonEarned    / total) * 100;

  const achTotal = Math.max(1, s.fullyAchieved + s.partial + s.noneEarned);
  const fullPct  = (s.fullyAchieved / achTotal) * 100;
  const partPct  = (s.partial       / achTotal) * 100;
  const nonePct  = (s.noneEarned    / achTotal) * 100;

  const incPotentialPct = s.incPotential > 0 ? Math.round((s.incEarned / s.incPotential) * 100) : 0;
  const bonPotentialPct = s.bonPotential > 0 ? Math.round((s.bonEarned / s.bonPotential) * 100) : 0;

  return (
    <div className="rounded-3 mb-4 p-3" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#0f172a' }}>Combined payout · {monthLabel}</div>
          <div className="text-muted" style={{ fontSize: '0.72rem' }}>
            Cumulative across {s.teamSize} member{s.teamSize === 1 ? '' : 's'} ({s.withPlans} with plans, {s.noPlan} without)
          </div>
        </div>
        <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
          style={{ background: '#0f172a', color: '#fff', fontSize: '0.78rem', fontWeight: 700 }}>
          <i className="bi bi-cash-coin" /> {pkr(s.totalPayout)}
        </span>
      </div>

      {/* 4 KPI tiles */}
      <div className="row g-2 mb-3">
        <div className="col-6 col-lg-3">
          <KpiTile label="Base Salary" value={pkr(s.totalBase)} sub={s.withPlans + ' members on payroll'} dot="#64748b" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Incentives Earned" value={pkr(s.incEarned)}
            sub={'of ' + pkr(s.incPotential) + ' (' + incPotentialPct + '%)'} dot="#16a34a" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Bonuses Earned" value={pkr(s.bonEarned)}
            sub={'of ' + pkr(s.bonPotential) + ' (' + bonPotentialPct + '%)'} dot="#3b82f6" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Total Payout" value={pkr(s.totalPayout)} sub="base + incentives + bonuses" dot="#0f172a" prominent />
        </div>
      </div>

      {/* Stacked breakdown — payout composition */}
      <div className="mb-3">
        <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.78rem' }}>
          <span className="text-muted fw-semibold">Payout composition</span>
          <span className="text-muted">{pkr(s.totalPayout)} total</span>
        </div>
        <div className="rounded-pill d-flex overflow-hidden" style={{ height: 16, background: '#f1f5f9' }}>
          {basePct > 0 && <div title={'Base ' + pkr(s.totalBase)} style={{ width: basePct + '%', background: '#64748b', transition: 'width .3s' }} />}
          {incPct > 0  && <div title={'Incentives ' + pkr(s.incEarned)} style={{ width: incPct  + '%', background: '#16a34a', transition: 'width .3s' }} />}
          {bonPct > 0  && <div title={'Bonuses ' + pkr(s.bonEarned)}    style={{ width: bonPct  + '%', background: '#3b82f6', transition: 'width .3s' }} />}
        </div>
        <div className="d-flex flex-wrap gap-3 mt-2" style={{ fontSize: '0.78rem' }}>
          <Legend color="#64748b" label="Base" value={pkr(s.totalBase)} />
          <Legend color="#16a34a" label="Incentives" value={pkr(s.incEarned)} />
          <Legend color="#3b82f6" label="Bonuses" value={pkr(s.bonEarned)} />
        </div>
      </div>

      {/* Achievement breakdown */}
      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
        <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.78rem' }}>
          <span className="text-muted fw-semibold">Incentive achievement</span>
          <span className="text-muted">{s.fullyAchieved + s.partial} of {s.fullyAchieved + s.partial + s.noneEarned} earned something</span>
        </div>
        <div className="rounded-pill d-flex overflow-hidden" style={{ height: 16, background: '#f1f5f9' }}>
          {fullPct > 0 && <div title={'Fully achieved: ' + s.fullyAchieved} style={{ width: fullPct + '%', background: '#16a34a', transition: 'width .3s' }} />}
          {partPct > 0 && <div title={'Partial: ' + s.partial}              style={{ width: partPct + '%', background: '#fbbf24', transition: 'width .3s' }} />}
          {nonePct > 0 && <div title={'Nothing earned: ' + s.noneEarned}    style={{ width: nonePct + '%', background: '#cbd5e1', transition: 'width .3s' }} />}
        </div>
        <div className="d-flex flex-wrap gap-3 mt-2" style={{ fontSize: '0.78rem' }}>
          <Legend color="#16a34a" label="Fully achieved" value={s.fullyAchieved} />
          <Legend color="#fbbf24" label="Partial"        value={s.partial} />
          <Legend color="#cbd5e1" label="Nothing earned" value={s.noneEarned} />
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, sub, dot, prominent }) {
  return (
    <div className="rounded-3 h-100 p-3" style={{
      background: prominent ? '#0f172a' : '#f8fafc',
      border: prominent ? '1px solid #0f172a' : '1px solid #e2e8f0',
      color: prominent ? '#fff' : '#0f172a',
    }}>
      <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: prominent ? 'rgba(255,255,255,0.7)' : '#64748b' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        {label}
      </div>
      <div className="fw-bold" style={{ fontSize: '1.05rem', letterSpacing: '-0.01em', lineHeight: 1.15, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', marginTop: 2, color: prominent ? 'rgba(255,255,255,0.6)' : '#64748b' }}>{sub}</div>}
    </div>
  );
}

function Legend({ color, label, value }) {
  return (
    <div className="d-flex align-items-center gap-2">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ color: '#475569' }}>{label}</span>
      <span className="fw-bold" style={{ color: '#0f172a' }}>{value}</span>
    </div>
  );
}
