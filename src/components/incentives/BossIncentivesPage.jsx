import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { formatPKR } from '../../lib/format';
import { Avatar, Button, ProgressBar } from '../ui';
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
      style={{ fontSize: '0.55rem', background: 'var(--info-soft)', color: 'var(--info-text)', fontWeight: 600 }}>
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
  { key: 'ams',  label: 'Ads Managers',    icon: 'bi-megaphone' },
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
      <div className="rounded-3 p-2 mb-2" style={{ background: item.completed ? 'var(--success-soft)' : 'var(--surface-2)', border: `1px solid ${item.completed ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'var(--border-subtle)'}` }}>
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div>
            <div className="small fw-semibold">{item.text || '—'}</div>
            {item.brandName && <div className="mt-1 mb-1"><BrandChip name={item.brandName} /></div>}
            <div className="text-muted" style={{ fontSize: '0.68rem' }}>
              +{formatPKR((Number(item.amount) || 0))}
              {item.targetValue > 0 && <span className="ms-2">· Target: {fmtUnitValue(item.targetValue, unitSfx)}</span>}
              {item.achievedValue > 0 && <span className="ms-2">· Achieved: {fmtUnitValue(item.achievedValue, unitSfx)} ({p}%)</span>}
            </div>
            {item.completedBy && <div style={{ fontSize: '0.63rem', color: 'var(--success-text)' }}><i className="bi bi-person-check me-1" />Marked by {item.completedBy}</div>}
          </div>
          <div className="d-flex align-items-center gap-1 flex-shrink-0">
            {item.source === 'attendance' && <AttendanceBadge />}
            <span className="badge rounded-pill" style={{ fontSize: '0.6rem', background: item.completed ? 'var(--success-soft)' : 'var(--surface-2)', color: item.completed ? 'var(--success-text)' : 'var(--text-muted)' }}>
              {item.completed ? '✓ Done' : `${p}%`}
            </span>
          </div>
        </div>
        {item.targetValue > 0 && (
          <div className="mt-1">
            <ProgressBar size="sm" value={p} tone={item.completed ? 'success' : 'info'} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, zIndex: 1, borderRadius: 'var(--radius-lg)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-0">{userName} — Details</h6>
              <p className="text-muted small mb-0">{getMonthLabel(rec.month)} · {completed}/{allItems.length} completed</p>
            </div>
            <Button variant="ghost" size="sm" iconOnly aria-label="Close" onClick={onClose}><i className="bi bi-x-lg" /></Button>
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
                <i className="bi bi-trophy me-1 text-info" />Bonuses
              </p>
              {rec.bonuses.map(b => <Item key={b.id} item={b} />)}
            </div>
          )}

          <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--surface-2)', fontSize: '0.8rem' }}>
            <div className="d-flex justify-content-between mb-1"><span className="text-muted">Basic</span><span>{formatPKR(basic)}</span></div>
            <div className="d-flex justify-content-between mb-1"><span className="text-muted">Incentives earned</span><span className="text-success">+{formatPKR(incAchieved)} / {formatPKR(incTotal)}</span></div>
            <div className="d-flex justify-content-between mb-2"><span className="text-muted">Bonuses earned</span><span className="text-info">+{formatPKR(bonAchieved)} / {formatPKR(bonTotal)}</span></div>
            <div className="d-flex justify-content-between fw-bold pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
              <span>Payable</span><span>{formatPKR(totalAchieved)}</span>
            </div>
            <div className="text-muted text-end mt-1" style={{ fontSize: '0.68rem' }}>Potential: {formatPKR(totalPotential)}</div>
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
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 480, zIndex: 1, borderRadius: 'var(--radius-lg)' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--warning-soft)' }}>
              <i className="bi bi-arrow-repeat" style={{ fontSize: '1.1rem', color: 'var(--warning-text)' }} />
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

          <div className="rounded-2 p-2 mb-3" style={{ background: 'var(--surface-2)', fontSize: '0.75rem' }}>
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
            <button className="btn btn-sm btn-primary px-3 d-inline-flex align-items-center gap-1"
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
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 'var(--radius-lg)' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--warning-soft)' }}>
              <i className="bi bi-exclamation-triangle" style={{ fontSize: '1.1rem', color: 'var(--warning-text)' }} />
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
  const [allUsers,     setAllUsers]     = useState({ apcs: [], tls: [], ols: [], ams: [] });
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
      const [tls, ols, apcs, ams, incList] = await Promise.all([
        listUsersByRoles(['tl', 'pctl']),
        listUsersByRoles(['ol']),
        listUsersByRoles(['apc', 'ipc']),
        listUsersByRoles(['ads_manager']),
        listIncentivesMonth(month),
      ]);
      setAllUsers({ tls, ols, apcs, ams });
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
    const everyone = [...(allUsers.apcs || []), ...(allUsers.tls || []), ...(allUsers.ols || []), ...(allUsers.ams || [])];
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
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', borderRadius: 'var(--radius-md)', fontSize: '0.78rem', color: 'var(--warning-text)' }}>
          <i className="bi bi-clock-history" />
          Viewing history for <strong>{getMonthLabel(month)}</strong>
          <button className="btn btn-sm btn-link text-decoration-none p-0 ms-auto" style={{ color: 'var(--warning-text)', fontSize: '0.75rem' }}
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
      <div className="d-flex gap-1 mb-3" style={{ borderBottom: '2px solid var(--border-subtle)' }}>
        {TABS.map(t => (
          <button key={t.key}
            onClick={() => { setTab(t.key); setSearch(''); setStatusFilter('all'); }}
            className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
            style={{
              borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0', fontWeight: 600, fontSize: '0.78rem',
              background: tab === t.key ? 'var(--accent-soft)' : 'transparent',
              color: tab === t.key ? 'var(--accent-text)' : 'var(--text-muted)',
              border: 'none', marginBottom: -2,
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
            }}>
            <i className={`bi ${t.icon}`} /> {t.label}
            <span className="badge ms-1" style={{ fontSize: '0.55rem', background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>{(allUsers[t.key] || []).length}</span>
          </button>
        ))}
      </div>

      {/* Stats strip */}
      {!loading && tabRecords.length > 0 && (
        <div className="d-flex gap-2 flex-wrap mb-3">
          {[
            { label: 'Total Payout',    value: `${formatPKR(totalPayout)}`, bg: 'var(--spotlight-bg)', color: 'var(--spotlight-fg)' },
            { label: 'Records',          value: `${tabRecords.length} / ${users.length}`, bg: 'var(--surface-2)', color: 'var(--text-secondary)' },
            { label: 'Verified',         value: `${verifiedCount} / ${tabRecords.length}`, bg: 'var(--success-soft)', color: 'var(--success-text)' },
            { label: 'Payouts Cleared',  value: `${clearedCount} / ${tabRecords.length}`, bg: 'var(--info-soft)', color: 'var(--info-text)' },
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
        <div className="text-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
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

            let barColor = 'var(--surface-3)';
            if (hasData && rec.payoutCleared)  barColor = 'var(--info)';
            else if (hasData && rec.verified)  barColor = 'var(--success)';
            else if (hasData)                  barColor = 'var(--warning)';

            return (
              <div key={u.id} className="col-sm-6 col-lg-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                  <div style={{ height: 4, background: barColor }} />
                  <div className="card-body p-3 d-flex flex-column">

                    {/* Identity + badges */}
                    <div className="d-flex align-items-start justify-content-between mb-2">
                      <div className="d-flex align-items-center gap-2">
                        <Avatar name={u.name} toneKey={u.id} size={36} />
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
                            background: rec.verified ? 'var(--success-soft)' : 'var(--warning-soft)',
                            color: rec.verified ? 'var(--success-text)' : 'var(--warning-text)',
                          }}>
                            {rec.verified
                              ? (tab === 'apcs' || tab === 'ipcs' ? '✓ OL Verified' : '✓ Verified')
                              : (tab === 'apcs' || tab === 'ipcs' ? '○ OL Unverified' : '○ Unverified')}
                          </span>
                          <span className="badge rounded-pill" style={{
                            fontSize: '0.58rem',
                            background: rec.payoutCleared ? 'var(--info-soft)' : 'var(--surface-2)',
                            color: rec.payoutCleared ? 'var(--info-text)' : 'var(--text-muted)',
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
                              <span key={b.id || b.name} className="badge border" style={{ fontSize: '0.63rem', fontWeight: 500, background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>{b.name}</span>
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
                              <span className="fw-medium">{formatPKR(bd.basic)}</span>
                            </div>
                            <div className="d-flex justify-content-between mt-1">
                              <span className="text-muted">Incentives</span>
                              <span className="fw-medium text-success">+{formatPKR(bd.incAchieved)} / {formatPKR(bd.incTotal)}</span>
                            </div>
                            <div className="d-flex justify-content-between mt-1">
                              <span className="text-muted">Bonuses</span>
                              <span className="fw-medium text-info">+{formatPKR(bd.bonAchieved)} / {formatPKR(bd.bonTotal)}</span>
                            </div>
                            <div className="d-flex justify-content-between mt-2 pt-2 fw-bold" style={{ borderTop: '1px dashed var(--border-subtle)', fontSize: '0.82rem' }}>
                              <span>Payable</span>
                              <span>{formatPKR(bd.totalAchieved)}</span>
                            </div>
                          </div>
                          <div className="mt-2">
                            <div className="d-flex justify-content-between mb-1" style={{ fontSize: '0.68rem' }}>
                              <span className="text-muted">Completed</span>
                              <span className="fw-semibold">{completedItems}/{totalItems} ({completionPct}%)</span>
                            </div>
                            <ProgressBar size="sm" value={completionPct} tone={completionPct === 100 ? 'success' : 'info'} />
                          </div>
                        </>
                      ) : (
                        <div className="rounded-2 p-2 text-center text-muted" style={{ background: 'var(--surface-2)', fontSize: '0.75rem' }}>
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
                            background: hasData ? 'var(--accent)' : 'transparent',
                            color: hasData ? 'var(--on-accent)' : 'var(--accent-text)',
                            border: '1px solid var(--accent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem',
                          }}
                          onClick={() => navigate(`/incentives/edit/${u.id}`)}>
                          <i className={`bi ${hasData ? 'bi-pencil' : 'bi-plus-lg'}`} /> {hasData ? 'Edit' : 'Add'}
                        </button>
                        {hasData && (
                          <button
                            className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                            style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-1)', color: 'var(--text-secondary)', fontSize: '0.75rem' }}
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
                                style={{ background: 'var(--warning-soft)', color: 'var(--warning-text)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}
                                onClick={() => handleVerify(u.id)} disabled={verifying === u.id}>
                                {verifying === u.id ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-patch-check" /> Verify</>}
                              </button>
                            ) : (
                              <div className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                                style={{ background: 'var(--success-soft)', color: 'var(--success-text)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', cursor: 'default' }}>
                                <i className="bi bi-patch-check-fill" /> Verified
                              </div>
                            )
                          )}

                          {/* Clear payout */}
                          {!rec.payoutCleared ? (
                            <button
                              className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: 'var(--info-soft)', color: 'var(--info-text)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}
                              onClick={() => rec.verified ? handleClearPayout(u.id) : setConfirmClear({ userId: u.id, userName: u.name })}
                              disabled={clearing === u.id}>
                              {clearing === u.id ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-cash-stack" /> Clear Payout</>}
                            </button>
                          ) : (
                            <div className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: 'var(--success-soft)', color: 'var(--success-text)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', cursor: 'default' }}>
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
  const pkr = n => formatPKR(n);
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
    <div className="rounded-3 mb-4 p-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)' }}>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>Combined payout · {monthLabel}</div>
          <div className="text-muted" style={{ fontSize: '0.72rem' }}>
            Cumulative across {s.teamSize} member{s.teamSize === 1 ? '' : 's'} ({s.withPlans} with plans, {s.noPlan} without)
          </div>
        </div>
        <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
          style={{ background: 'var(--text-primary)', color: 'var(--surface-1)', fontSize: '0.78rem', fontWeight: 700 }}>
          <i className="bi bi-cash-coin" /> {pkr(s.totalPayout)}
        </span>
      </div>

      <div className="row g-2 mb-3">
        <div className="col-6 col-lg-3">
          <KpiTile label="Base Salary" value={pkr(s.totalBase)} sub={s.withPlans + ' members on payroll'} dot="var(--text-muted)" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Incentives Earned" value={pkr(s.incEarned)}
            sub={'of ' + pkr(s.incPotential) + ' (' + incPotentialPct + '%)'} dot="var(--success)" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Bonuses Earned" value={pkr(s.bonEarned)}
            sub={'of ' + pkr(s.bonPotential) + ' (' + bonPotentialPct + '%)'} dot="var(--info)" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Total Payout" value={pkr(s.totalPayout)} sub="base + incentives + bonuses" dot="var(--text-primary)" prominent />
        </div>
      </div>

      <div className="mb-3">
        <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.78rem' }}>
          <span className="text-muted fw-semibold">Payout composition</span>
          <span className="text-muted">{pkr(s.totalPayout)} total</span>
        </div>
        <div className="rounded-pill d-flex overflow-hidden" style={{ height: 16, background: 'var(--surface-2)' }}>
          {basePct > 0 && <div title={'Base ' + pkr(s.totalBase)} style={{ width: basePct + '%', background: 'var(--text-muted)', transition: 'width var(--dur-slow) var(--ease-out)' }} />}
          {incPct > 0  && <div title={'Incentives ' + pkr(s.incEarned)} style={{ width: incPct  + '%', background: 'var(--success)', transition: 'width var(--dur-slow) var(--ease-out)' }} />}
          {bonPct > 0  && <div title={'Bonuses ' + pkr(s.bonEarned)}    style={{ width: bonPct  + '%', background: 'var(--info)', transition: 'width var(--dur-slow) var(--ease-out)' }} />}
        </div>
        <div className="d-flex flex-wrap gap-3 mt-2" style={{ fontSize: '0.78rem' }}>
          <Legend color="var(--text-muted)" label="Base" value={pkr(s.totalBase)} />
          <Legend color="var(--success-text)" label="Incentives" value={pkr(s.incEarned)} />
          <Legend color="var(--info-text)" label="Bonuses" value={pkr(s.bonEarned)} />
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
        <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.78rem' }}>
          <span className="text-muted fw-semibold">Incentive achievement</span>
          <span className="text-muted">{s.fullyAchieved + s.partial} of {s.fullyAchieved + s.partial + s.noneEarned} earned something</span>
        </div>
        <div className="rounded-pill d-flex overflow-hidden" style={{ height: 16, background: 'var(--surface-2)' }}>
          {fullPct > 0 && <div title={'Fully achieved: ' + s.fullyAchieved} style={{ width: fullPct + '%', background: 'var(--success)', transition: 'width var(--dur-slow) var(--ease-out)' }} />}
          {partPct > 0 && <div title={'Partial: ' + s.partial}              style={{ width: partPct + '%', background: 'var(--warning)', transition: 'width var(--dur-slow) var(--ease-out)' }} />}
          {nonePct > 0 && <div title={'Nothing earned: ' + s.noneEarned}    style={{ width: nonePct + '%', background: 'var(--border-strong)', transition: 'width var(--dur-slow) var(--ease-out)' }} />}
        </div>
        <div className="d-flex flex-wrap gap-3 mt-2" style={{ fontSize: '0.78rem' }}>
          <Legend color="var(--success-text)" label="Fully achieved" value={s.fullyAchieved} />
          <Legend color="var(--warning-text)" label="Partial"        value={s.partial} />
          <Legend color="var(--border-strong)" label="Nothing earned" value={s.noneEarned} />
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, sub, dot, prominent }) {
  return (
    <div className="rounded-3 h-100 p-3" style={{
      background: prominent ? 'var(--text-primary)' : 'var(--surface-2)',
      border: prominent ? '1px solid var(--text-primary)' : '1px solid var(--border-subtle)',
      color: prominent ? 'var(--surface-1)' : 'var(--text-primary)',
    }}>
      <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: prominent ? 'color-mix(in srgb, var(--surface-1) 75%, transparent)' : 'var(--text-muted)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        {label}
      </div>
      <div className="fw-bold" style={{ fontSize: '1.05rem', letterSpacing: '-0.01em', lineHeight: 1.15, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', marginTop: 2, color: prominent ? 'color-mix(in srgb, var(--surface-1) 70%, transparent)' : 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function Legend({ color, label, value }) {
  return (
    <div className="d-flex align-items-center gap-2">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="fw-bold" style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}
