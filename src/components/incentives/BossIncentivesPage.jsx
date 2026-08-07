import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listIncentivesMonth, listUsersByRoles,
  verifyIncentives, clearIncentivePayout,
  resetAndRoll, fmtUnitValue,
} from '../../lib/incentivesApi';
import BrandChip from './BrandChip';
import InactiveBrandsNotice from './InactiveBrandsNotice';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getMonthLabel(ym) {
  if (!ym) return '';
  const [year, month] = ym.split('-');
  return new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function getNextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m); // m is 1-based so this gives next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
  if (!rec) return { basic: 0, incTotal: 0, bonTotal: 0, incAchieved: 0, bonAchieved: 0, totalPotential: 0, totalAchieved: 0 };
  const incTotal    = (rec.incentives || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal    = (rec.bonuses || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const incAchieved = (rec.incentives || []).filter(i => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonAchieved = (rec.bonuses || []).filter(b => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const basic       = Number(rec.basicSalary) || 0;
  return { basic, incTotal, bonTotal, incAchieved, bonAchieved, totalPotential: basic + incTotal + bonTotal, totalAchieved: basic + incAchieved + bonAchieved };
}
function uid4() { return Math.random().toString(36).slice(2, 10); }

const TABS = [
  { key: 'apcs', label: 'APCs',            icon: 'bi-person-lines-fill' },
  { key: 'tls',  label: 'Team Leads',      icon: 'bi-person-badge' },
  { key: 'ols',  label: 'Operation Leads',  icon: 'bi-person-workspace' },
];

// ── Details Modal ────────────────────────────────────────────────────────────

function DetailsModal({ rec, userName, onClose }) {
  if (!rec) return null;
  const { basic, incAchieved, bonAchieved, incTotal, bonTotal, totalPotential, totalAchieved } = calcBreakdown(rec);
  const allItems  = [...(rec.incentives || []), ...(rec.bonuses || [])];
  const completed = allItems.filter(i => i.completed).length;

  function Item({ item }) {
    const p = pct(item.achievedValue, item.targetValue);
    const unitSfx = itemSuffix(item);
    return (
      <div className="rounded-3 p-2 mb-2" style={{ background: item.completed ? '#f0fdf4' : '#fafafa', border: `1px solid ${item.completed ? '#b7dfc4' : '#e9ecef'}` }}>
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div>
            <div className="small fw-semibold">{item.text || '—'}</div>
            {item.brandName && <div className="mt-1 mb-1"><BrandChip name={item.brandName} /></div>}
            <div className="text-muted" style={{ fontSize: '0.68rem' }}>
              +{(Number(item.amount) || 0).toLocaleString()} PKR
              {item.targetValue > 0 && <span className="ms-2">· Target: {fmtUnitValue(item.targetValue, unitSfx)}</span>}
              {item.achievedValue > 0 && <span className="ms-2">· Achieved: {fmtUnitValue(item.achievedValue, unitSfx)} ({p}%)</span>}
            </div>
            {item.completedBy && <div style={{ fontSize: '0.63rem', color: '#198754' }}><i className="bi bi-person-check me-1" />Marked by {item.completedBy}</div>}
          </div>
          <div className="d-flex align-items-center gap-1 flex-shrink-0">
            {item.source === 'attendance' && <AttendanceBadge />}
            <span className="badge rounded-pill" style={{ fontSize: '0.6rem', background: item.completed ? '#e6f4ea' : '#f3f4f6', color: item.completed ? '#198754' : '#6c757d' }}>
              {item.completed ? '✓ Done' : `${p}%`}
            </span>
          </div>
        </div>
        {item.targetValue > 0 && (
          <div className="mt-1">
            <div className="rounded-pill overflow-hidden" style={{ height: 3, background: '#e9ecef' }}>
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
              <h6 className="fw-bold mb-0">{userName} — Details</h6>
              <p className="text-muted small mb-0">{getMonthLabel(rec.month)} · {completed}/{allItems.length} completed</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>

          {(rec.incentives || []).length > 0 && (
            <div className="mb-3">
              <p className="text-muted small fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {rec.incentives.map(i => <Item key={i.id} item={i} />)}
            </div>
          )}
          {(rec.bonuses || []).length > 0 && (
            <div className="mb-3">
              <p className="text-muted small fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {rec.bonuses.map(b => <Item key={b.id} item={b} />)}
            </div>
          )}

          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8f9fa', fontSize: '0.8rem' }}>
            <div className="d-flex justify-content-between mb-1"><span className="text-muted">Basic</span><span>{basic.toLocaleString()} PKR</span></div>
            <div className="d-flex justify-content-between mb-1"><span className="text-muted">Incentives earned</span><span className="text-success">+{incAchieved.toLocaleString()} / {incTotal.toLocaleString()} PKR</span></div>
            <div className="d-flex justify-content-between mb-2"><span className="text-muted">Bonuses earned</span><span className="text-primary">+{bonAchieved.toLocaleString()} / {bonTotal.toLocaleString()} PKR</span></div>
            <div className="d-flex justify-content-between fw-bold pt-2" style={{ borderTop: '1px dashed #dee2e6' }}>
              <span>Payable</span><span>{totalAchieved.toLocaleString()} PKR</span>
            </div>
            <div className="text-muted text-end mt-1" style={{ fontSize: '0.68rem' }}>Potential: {totalPotential.toLocaleString()} PKR</div>
          </div>

          <InactiveBrandsNotice userId={rec?.user_id} />

          <div className="d-flex justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Reset Confirm Modal ──────────────────────────────────────────────────────

function ResetModal({ defaultSource, defaultTarget, recordCount, onConfirm, onClose, resetting }) {
  const [sourceMonth, setSourceMonth] = useState(defaultSource);
  const [targetMonth, setTargetMonth] = useState(defaultTarget);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 480, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#fff3e0' }}>
              <i className="bi bi-arrow-repeat" style={{ fontSize: '1.1rem', color: '#fd7e14' }} />
            </div>
            <div>
              <h6 className="fw-bold mb-1">Clear Payouts & Reset</h6>
              <p className="text-muted small mb-0">
                Mark payouts as cleared for a month and create next month's incentives with zero progress.
              </p>
            </div>
          </div>

          <div className="d-flex flex-column gap-3 mb-3">
            <div>
              <label className="form-label small fw-semibold mb-1">Clearing payouts for</label>
              <input type="month" className="form-control form-control-sm" value={sourceMonth}
                onChange={e => setSourceMonth(e.target.value)} />
              <div className="text-muted mt-1" style={{ fontSize: '0.68rem' }}>
                All {recordCount} record(s) for {getMonthLabel(sourceMonth)} will be marked as <strong>Payout Cleared</strong>
              </div>
            </div>
            <div>
              <label className="form-label small fw-semibold mb-1">Next salary month</label>
              <input type="month" className="form-control form-control-sm" value={targetMonth}
                onChange={e => setTargetMonth(e.target.value)} />
              <div className="text-muted mt-1" style={{ fontSize: '0.68rem' }}>
                New records for {getMonthLabel(targetMonth)} will be created with same structure, zero progress
              </div>
            </div>
          </div>

          <div className="rounded-2 p-2 mb-3" style={{ background: '#f8f9fa', fontSize: '0.75rem' }}>
            {[
              `${getMonthLabel(sourceMonth)} payouts marked as cleared (read-only for users)`,
              `${getMonthLabel(targetMonth)} records created with same structure`,
              'Progress, verification, and payout status reset to zero',
            ].map((t, i) => (
              <div key={i} className="d-flex align-items-center gap-2 mb-1">
                <i className="bi bi-check-circle text-success" style={{ fontSize: '0.7rem' }} /><span>{t}</span>
              </div>
            ))}
          </div>

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={resetting}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1"
              onClick={() => onConfirm(sourceMonth, targetMonth)} disabled={resetting || sourceMonth === targetMonth}>
              {resetting ? <><span className="spinner-border spinner-border-sm" /> Resetting…</> : <><i className="bi bi-arrow-repeat" /> Clear & Reset</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Clear Payout Confirm Modal ──────────────────────────────────────────────

function ClearPayoutConfirmModal({ userName, roleTab, onConfirm, onClose, clearing }) {
  const verifier = (roleTab === 'apcs' || roleTab === 'ipcs') ? 'OL' : 'Boss';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#fff3e0' }}>
              <i className="bi bi-exclamation-triangle" style={{ fontSize: '1.1rem', color: '#fd7e14' }} />
            </div>
            <div>
              <h6 className="fw-bold mb-1">Clear payout for {userName}?</h6>
              <p className="text-muted small mb-0">
                This record has <strong>not been verified</strong> by {verifier} yet. Are you sure you want to clear the payout?
              </p>
            </div>
          </div>
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={clearing}>Cancel</button>
            <button className="btn btn-sm btn-warning px-3 d-inline-flex align-items-center gap-1" onClick={onConfirm} disabled={clearing}>
              {clearing ? <><span className="spinner-border spinner-border-sm" /> Clearing…</> : <><i className="bi bi-cash-stack" /> Clear Anyway</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function BossIncentivesPage() {
  // v2 auth shim
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const navigate = useNavigate();

  const [month,        setMonth]        = useState(getCurrentMonth());
  const [tab,          setTab]          = useState('apcs');
  const [allUsers,     setAllUsers]     = useState({ apcs: [], tls: [], ols: [] });
  const [records,      setRecords]      = useState({});  // userId → record
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showDetails,  setShowDetails]  = useState(null);
  const [showReset,    setShowReset]    = useState(false);
  const [verifying,    setVerifying]    = useState(null);
  const [clearing,     setClearing]     = useState(null);
  const [resetting,    setResetting]    = useState(false);
  const [confirmClear, setConfirmClear] = useState(null); // { userId, userName } or null

  const isCurrentMonth = month === getCurrentMonth();

  // ── Load Data ──
  useEffect(() => {
    async function load() {
      setLoading(true);
      const [tls, ols, apcs, incList] = await Promise.all([
        listUsersByRoles(['tl', 'pctl']),
        listUsersByRoles(['ol']),
        listUsersByRoles(['apc', 'ipc']),
        listIncentivesMonth(month),
      ]);
      setAllUsers({ tls, ols, apcs });
      const map = {};
      incList.forEach((data) => {
        const uid = data.userId;
        if (uid) map[uid] = data;
      });
      setRecords(map);
      setLoading(false);
    }
    load();
  }, [month]);

  // ── Actions ──
  async function handleVerify(userId) {
    setVerifying(userId);
    try {
      const rec = records[userId];
      if (!rec) return;
      // inc_verify RPC stamps verified_by + verified_at + emits notification.
      await verifyIncentives(rec.id, true);
      setRecords(prev => ({ ...prev, [userId]: { ...prev[userId], verified: true, verifiedBy: currentUser.uid } }));
    } finally { setVerifying(null); }
  }

  async function handleClearPayout(userId) {
    setClearing(userId);
    try {
      const rec = records[userId];
      if (!rec) return;
      // inc_clear_payout RPC requires verified=true (server-side).
      await clearIncentivePayout(rec.id, true);
      setRecords(prev => ({ ...prev, [userId]: { ...prev[userId], payoutCleared: true } }));
    } finally { setClearing(null); }
  }

  async function handleReset(sourceMonth, targetMonth) {
    setResetting(true);
    try {
      // v2: inc_reset_and_roll RPC (Boss-only) does both halves —
      // marks every source row payout_cleared (skips unverified
      // unless force_clear=true) and creates target-month rows
      // carrying over basic_salary + items with achievedValue=0.
      // We pass force_clear=true to match v1's behaviour (which
      // cleared ALL source rows regardless of verified status).
      await resetAndRoll({ sourceMonth, targetMonth, forceClear: true });

      // Navigate to the target month so the user sees the new plans.
      setMonth(targetMonth);
      setShowReset(false);
    } finally { setResetting(false); }
  }

  // ── Filtered list for current tab ──
  const users = allUsers[tab] || [];
  const filtered = useMemo(() => {
    let list = users.map(u => {
      const name = u.displayName || u.userName || u.email || '—';
      return { ...u, name, rec: records[u.id] };
    });
    if (search) { const s = search.toLowerCase(); list = list.filter(u => u.name.toLowerCase().includes(s)); }
    if (statusFilter === 'verified')   list = list.filter(u => u.rec?.verified);
    if (statusFilter === 'unverified') list = list.filter(u => u.rec && !u.rec.verified);
    if (statusFilter === 'cleared')    list = list.filter(u => u.rec?.payoutCleared);
    if (statusFilter === 'pending')    list = list.filter(u => u.rec && !u.rec.payoutCleared);
    if (statusFilter === 'no_record')  list = list.filter(u => !u.rec);
    return list;
  }, [users, records, search, statusFilter]);

  // ── Stats ──
  const tabRecords    = users.filter(u => records[u.id]).map(u => records[u.id]);
  const totalPayout   = tabRecords.reduce((s, r) => s + calcBreakdown(r).totalAchieved, 0);
  const verifiedCount = tabRecords.filter(r => r.verified).length;
  const clearedCount  = tabRecords.filter(r => r.payoutCleared).length;
  const allRecCount   = Object.keys(records).length;

  // ── Combined payout snapshot (cumulative across APCs + TLs + OLs) ──
  const combinedStats = (() => {
    const everyone = [...(allUsers.apcs || []), ...(allUsers.tls || []), ...(allUsers.ols || [])];
    let totalBase = 0, incEarned = 0, incPotential = 0, bonEarned = 0, bonPotential = 0;
    let withPlans = 0, fullyAchieved = 0, partial = 0, noneEarned = 0, noPlan = 0;
    for (const u of everyone) {
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

      const incCount = incs.length;
      const completedInc = incs.filter(i => i.completed).length;
      if (incCount === 0)                  partial++;
      else if (completedInc === 0)         noneEarned++;
      else if (completedInc === incCount)  fullyAchieved++;
      else                                  partial++;
    }
    return {
      teamSize: everyone.length, withPlans, noPlan,
      totalBase, incEarned, incPotential, bonEarned, bonPotential,
      totalPayout: totalBase + incEarned + bonEarned,
      fullyAchieved, partial, noneEarned,
    };
  })();

  function getTLName(apc) {
    if (!apc.ownerId) return '—';
    const tl = allUsers.tls.find(t => t.id === apc.ownerId);
    return tl ? (tl.displayName || tl.email) : '—';
  }

  // ── Render ──
  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h5 className="fw-bold mb-0">Incentives Management</h5>
          <p className="text-muted small mb-0">Manage structures, verify progress, and clear payouts</p>
        </div>
        <div className="d-flex align-items-center gap-2">
          <input type="month" className="form-control form-control-sm" value={month}
            onChange={e => setMonth(e.target.value)} style={{ width: 170 }} />
          {allRecCount > 0 && (
            <button className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1"
              onClick={() => setShowReset(true)}>
              <i className="bi bi-arrow-repeat" /> Clear & Reset
            </button>
          )}
        </div>
      </div>

      {/* History banner */}
      {!isCurrentMonth && (
        <div className="alert py-2 d-flex align-items-center gap-2 mb-3"
          style={{ background: '#fff3e0', border: '1px solid #ffe0b2', borderRadius: 10, fontSize: '0.78rem', color: '#e65100' }}>
          <i className="bi bi-clock-history" />
          Viewing history for <strong>{getMonthLabel(month)}</strong>
          <button className="btn btn-sm btn-link text-decoration-none p-0 ms-auto" style={{ color: '#e65100', fontSize: '0.75rem' }}
            onClick={() => setMonth(getCurrentMonth())}>
            Back to current month
          </button>
        </div>
      )}

      {/* Combined payout snapshot — cumulative APCs + TLs + OLs */}
      {!loading && combinedStats.teamSize > 0 && (
        <CombinedPayoutSnapshot stats={combinedStats} monthLabel={getMonthLabel(month)} />
      )}

      {/* Tabs */}
      <div className="d-flex gap-1 mb-3" style={{ borderBottom: '2px solid #e9ecef' }}>
        {TABS.map(t => (
          <button key={t.key}
            onClick={() => { setTab(t.key); setSearch(''); setStatusFilter('all'); }}
            className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
            style={{
              borderRadius: '8px 8px 0 0', fontWeight: 600, fontSize: '0.78rem',
              background: tab === t.key ? '#1a1a2e' : 'transparent',
              color: tab === t.key ? '#fff' : '#6c757d',
              border: 'none', marginBottom: -2,
              borderBottom: tab === t.key ? '2px solid #1a1a2e' : '2px solid transparent',
            }}>
            <i className={`bi ${t.icon}`} /> {t.label}
            <span className="badge bg-light text-dark ms-1" style={{ fontSize: '0.55rem' }}>{(allUsers[t.key] || []).length}</span>
          </button>
        ))}
      </div>

      {/* Stats strip */}
      {!loading && tabRecords.length > 0 && (
        <div className="d-flex gap-2 flex-wrap mb-3">
          {[
            { label: 'Total Payout',    value: `${totalPayout.toLocaleString()} PKR`, bg: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' },
            { label: 'Records',          value: `${tabRecords.length} / ${users.length}`, bg: '#f3f4f6', color: '#495057' },
            { label: 'Verified',         value: `${verifiedCount} / ${tabRecords.length}`, bg: '#e6f4ea', color: '#198754' },
            { label: 'Payouts Cleared',  value: `${clearedCount} / ${tabRecords.length}`, bg: '#e8f0fe', color: '#0d6efd' },
          ].map(s => (
            <div key={s.label} className="rounded-3 px-3 py-2 text-center" style={{ background: s.bg, color: s.color, minWidth: 110 }}>
              <div style={{ fontSize: '0.58rem', opacity: 0.7, letterSpacing: 1, textTransform: 'uppercase' }}>{s.label}</div>
              <div className="fw-bold" style={{ fontSize: '0.95rem' }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      {!loading && users.length > 0 && (
        <div className="d-flex gap-2 mb-3 flex-wrap">
          <input type="text" className="form-control form-control-sm" placeholder="Search by name…"
            value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
          <select className="form-select form-select-sm" value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="all">All statuses</option>
            <option value="verified">Verified</option>
            <option value="unverified">Unverified</option>
            <option value="cleared">Payout Cleared</option>
            <option value="pending">Payout Pending</option>
            <option value="no_record">No Record</option>
          </select>
        </div>
      )}

      {/* Cards */}
      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2">
          <span className="spinner-border spinner-border-sm" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 12 }}>
          <i className="bi bi-inbox text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
          <p className="text-muted mt-3 mb-0">
            {search || statusFilter !== 'all' ? 'No matching results.' : `No ${TABS.find(t => t.key === tab)?.label} found.`}
          </p>
        </div>
      ) : (
        <div className="row g-3">
          {filtered.map(u => {
            const rec     = u.rec;
            const hasData = Boolean(rec);
            const bd      = hasData ? calcBreakdown(rec) : {};
            const totalItems     = hasData ? (rec.incentives || []).length + (rec.bonuses || []).length : 0;
            const completedItems = hasData
              ? (rec.incentives || []).filter(i => i.completed).length + (rec.bonuses || []).filter(b => b.completed).length
              : 0;
            const completionPct  = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

            let barColor = '#e9ecef';
            if (hasData && rec.payoutCleared)  barColor = 'linear-gradient(90deg,#0d6efd,#6ea8fe)';
            else if (hasData && rec.verified)  barColor = 'linear-gradient(90deg,#198754,#51cf66)';
            else if (hasData)                  barColor = 'linear-gradient(90deg,#fd7e14,#ffa94d)';

            return (
              <div key={u.id} className="col-sm-6 col-lg-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, overflow: 'hidden' }}>
                  <div style={{ height: 4, background: barColor }} />
                  <div className="card-body p-3 d-flex flex-column">

                    {/* Identity + badges */}
                    <div className="d-flex align-items-start justify-content-between mb-2">
                      <div className="d-flex align-items-center gap-2">
                        <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                          style={{ width: 36, height: 36, background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', fontSize: '0.7rem' }}>
                          {u.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="fw-semibold small">{u.name}</div>
                          <div className="text-muted" style={{ fontSize: '0.65rem' }}>
                            {tab === 'apcs' ? 'APC' : tab === 'tls' ? 'Team Lead' : 'Operation Lead'}
                            {tab === 'apcs' && u.ownerId && <span className="ms-1">· TL: {getTLName(u)}</span>}
                          </div>
                        </div>
                      </div>
                      {hasData && (
                        <div className="d-flex flex-column align-items-end gap-1">
                          <span className="badge rounded-pill" style={{
                            fontSize: '0.58rem',
                            background: rec.verified ? '#e6f4ea' : '#fff3e0',
                            color: rec.verified ? '#198754' : '#fd7e14',
                          }}>
                            {rec.verified
                              ? (tab === 'apcs' || tab === 'ipcs' ? '✓ OL Verified' : '✓ Verified')
                              : (tab === 'apcs' || tab === 'ipcs' ? '○ OL Unverified' : '○ Unverified')}
                          </span>
                          <span className="badge rounded-pill" style={{
                            fontSize: '0.58rem',
                            background: rec.payoutCleared ? '#e8f0fe' : '#f3f4f6',
                            color: rec.payoutCleared ? '#0d6efd' : '#6c757d',
                          }}>
                            {rec.payoutCleared ? '✓ Payout Cleared' : '○ Payout Pending'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Brands — APCs only */}
                    {tab === 'apcs' && (
                      <div className="d-flex flex-wrap gap-1 mb-2">
                        {(u.assignedBrands || []).length > 0
                          ? u.assignedBrands.map(b => (
                              <span key={b.id || b.name} className="badge bg-light text-dark border" style={{ fontSize: '0.63rem', fontWeight: 500 }}>{b.name}</span>
                            ))
                          : <span className="text-muted" style={{ fontSize: '0.68rem' }}>No brand</span>}
                      </div>
                    )}

                    {/* Breakdown */}
                    <div className="flex-grow-1">
                      {hasData ? (
                        <>
                          <div style={{ fontSize: '0.75rem' }}>
                            <div className="d-flex justify-content-between">
                              <span className="text-muted">Basic</span>
                              <span className="fw-medium">{bd.basic.toLocaleString()} PKR</span>
                            </div>
                            <div className="d-flex justify-content-between mt-1">
                              <span className="text-muted">Incentives</span>
                              <span className="fw-medium text-success">+{bd.incAchieved.toLocaleString()} / {bd.incTotal.toLocaleString()}</span>
                            </div>
                            <div className="d-flex justify-content-between mt-1">
                              <span className="text-muted">Bonuses</span>
                              <span className="fw-medium text-primary">+{bd.bonAchieved.toLocaleString()} / {bd.bonTotal.toLocaleString()}</span>
                            </div>
                            <div className="d-flex justify-content-between mt-2 pt-2 fw-bold" style={{ borderTop: '1px dashed #dee2e6', fontSize: '0.82rem' }}>
                              <span>Payable</span>
                              <span>{bd.totalAchieved.toLocaleString()} PKR</span>
                            </div>
                          </div>
                          <div className="mt-2">
                            <div className="d-flex justify-content-between mb-1" style={{ fontSize: '0.68rem' }}>
                              <span className="text-muted">Completed</span>
                              <span className="fw-semibold">{completedItems}/{totalItems} ({completionPct}%)</span>
                            </div>
                            <div className="rounded-pill overflow-hidden" style={{ height: 5, background: '#e9ecef' }}>
                              <div className="h-100 rounded-pill"
                                style={{ width: `${completionPct}%`, background: completionPct === 100 ? '#198754' : '#0d6efd', transition: 'width 0.4s' }} />
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="rounded-2 p-2 text-center text-muted" style={{ background: '#f8f9fa', fontSize: '0.75rem' }}>
                          No data for {getMonthLabel(month)}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="mt-3 d-flex flex-column gap-2">
                      <div className="d-flex gap-2">
                        <button
                          className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                          style={{
                            background: hasData ? '#1a1a2e' : 'transparent',
                            color: hasData ? '#fff' : '#1a1a2e',
                            border: '1.5px solid #1a1a2e', borderRadius: 8, fontSize: '0.75rem',
                          }}
                          onClick={() => navigate(`/incentives/edit/${u.id}`)}>
                          <i className={`bi ${hasData ? 'bi-pencil' : 'bi-plus-lg'}`} /> {hasData ? 'Edit' : 'Add'}
                        </button>
                        {hasData && (
                          <button
                            className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                            style={{ border: '1.5px solid #dee2e6', borderRadius: 8, background: '#fff', color: '#495057', fontSize: '0.75rem' }}
                            onClick={() => setShowDetails({ rec, name: u.name })}>
                            <i className="bi bi-eye" /> Details
                          </button>
                        )}
                      </div>

                      {hasData && (
                        <div className="d-flex gap-2">
                          {/* Verify — boss verifies TLs and OLs only; APCs/IPCs verified by Operation Leads */}
                          {tab !== 'apcs' && tab !== 'ipcs' && (
                            !rec.verified ? (
                              <button
                                className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                                style={{ background: '#fff3e0', color: '#fd7e14', border: '1.5px solid #ffc070', borderRadius: 8, fontSize: '0.75rem' }}
                                onClick={() => handleVerify(u.id)} disabled={verifying === u.id}>
                                {verifying === u.id ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-patch-check" /> Verify</>}
                              </button>
                            ) : (
                              <div className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                                style={{ background: '#e6f4ea', color: '#198754', border: '1.5px solid #b7dfc4', borderRadius: 8, fontSize: '0.75rem', cursor: 'default' }}>
                                <i className="bi bi-patch-check-fill" /> Verified
                              </div>
                            )
                          )}

                          {/* Clear payout */}
                          {!rec.payoutCleared ? (
                            <button
                              className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: '#e8f0fe', color: '#0d6efd', border: '1.5px solid #b6d4fe', borderRadius: 8, fontSize: '0.75rem' }}
                              onClick={() => rec.verified ? handleClearPayout(u.id) : setConfirmClear({ userId: u.id, userName: u.name })}
                              disabled={clearing === u.id}>
                              {clearing === u.id ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-cash-stack" /> Clear Payout</>}
                            </button>
                          ) : (
                            <div className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: '#e6f4ea', color: '#198754', border: '1.5px solid #b7dfc4', borderRadius: 8, fontSize: '0.75rem', cursor: 'default' }}>
                              <i className="bi bi-check-circle-fill" /> Cleared
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showDetails && <DetailsModal rec={showDetails.rec} userName={showDetails.name} onClose={() => setShowDetails(null)} />}
      {showReset && (
        <ResetModal
          defaultSource={month} defaultTarget={getNextMonth(month)} recordCount={allRecCount}
          onConfirm={handleReset} onClose={() => setShowReset(false)} resetting={resetting}
        />
      )}
      {confirmClear && (
        <ClearPayoutConfirmModal
          userName={confirmClear.userName}
          roleTab={tab}
          onConfirm={async () => { await handleClearPayout(confirmClear.userId); setConfirmClear(null); }}
          onClose={() => setConfirmClear(null)}
          clearing={clearing === confirmClear.userId}
        />
      )}
    </div>
  );
}

// ── Combined payout snapshot block (APCs + TLs + OLs cumulative) ────────────
function CombinedPayoutSnapshot({ stats: s, monthLabel }) {
  const fmt = n => Number(n || 0).toLocaleString();
  const pkr = n => fmt(n) + ' PKR';
  const total = s.totalPayout || 1;
  const basePct = (s.totalBase / total) * 100;
  const incPct  = (s.incEarned / total) * 100;
  const bonPct  = (s.bonEarned / total) * 100;

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
