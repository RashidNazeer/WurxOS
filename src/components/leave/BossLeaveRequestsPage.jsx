import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  subscribeLeaves,
  teamApproveLeave,
  teamRejectLeave,
  bossPaidOverride,
} from '../../lib/leaveApi';
import { supabase } from '../../lib/supabase';

const REQUEST_CATEGORIES = [
  { value: 'leave',      label: 'Leave Request',  icon: 'bi-calendar-x',    color: '#dc3545', bg: '#fff0f0' },
  { value: 'wfh',        label: 'Work From Home', icon: 'bi-house',         color: '#0d6efd', bg: '#e8f0fe' },
  { value: 'half_leave', label: 'Half Leave',     icon: 'bi-clock-history', color: '#fd7e14', bg: '#fff3e0' },
  { value: 'other',      label: 'Other',          icon: 'bi-three-dots',    color: '#6610f2', bg: '#f0ebff' },
];

const LEAVE_TYPES = { medical: 'Medical', emergency: 'Emergency', medical_emergency: 'Medical' };
const ROLE_LABELS = { tl: 'Team Lead', ol: 'Operation Lead', apc: 'APC' };

function getCatCfg(val) { return REQUEST_CATEGORIES.find(c => c.value === val) || REQUEST_CATEGORIES[0]; }
// Working-day count (Mon-Fri only). See LeaveRequestPage for rationale.
function countDays(start, end) {
  if (!start || !end) return 0;
  const s = new Date(`${start}T00:00:00`);
  const e = new Date(`${end}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return 0;
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}
function formatDate(ts) { if (!ts) return '—'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatDateTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function getRequestTitle(r) {
  if (r.category === 'leave') return LEAVE_TYPES[r.leaveType] ? `${LEAVE_TYPES[r.leaveType]} Leave` : 'Leave Request';
  if (r.category === 'other') return r.otherTitle || 'Other Request';
  return getCatCfg(r.category).label;
}

const STATUS_CFG = {
  pending_tl:   { label: 'Pending TL',   color: '#fd7e14', bg: '#fff3e0', icon: 'bi-hourglass-split' },
  pending_ol:   { label: 'Pending OL',   color: '#fd7e14', bg: '#fff3e0', icon: 'bi-hourglass-split' },
  pending_boss: { label: 'Pending You',  color: '#6610f2', bg: '#f0ebff', icon: 'bi-hourglass-split' },
  approved:     { label: 'Approved',     color: '#198754', bg: '#e6f4ea', icon: 'bi-check-circle-fill' },
  rejected:     { label: 'Rejected',     color: '#dc3545', bg: '#fff0f0', icon: 'bi-x-circle-fill' },
};
function getStCfg(val) { return STATUS_CFG[val] || STATUS_CFG.pending_boss; }

// ── Reject Modal ──────────────────────────────────────────────────────────────

function RejectModal({ request, onConfirm, onCancel, saving }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  if (!request) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onCancel} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#fff0f0' }}>
              <i className="bi bi-x-circle text-danger" style={{ fontSize: '1rem' }} />
            </div>
            <div>
              <p className="fw-semibold mb-0 small">Reject Request</p>
              <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>{getRequestTitle(request)} by {request.requesterName}</p>
            </div>
          </div>
          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Reason for rejection <span className="text-danger">*</span></label>
            <textarea className="form-control" rows={3} placeholder="Provide a reason…" value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onCancel} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-danger px-3 d-inline-flex align-items-center gap-1" disabled={saving}
              onClick={() => { if (!reason.trim()) { setError('Reason is required.'); return; } onConfirm(reason.trim()); }}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Rejecting…</> : <><i className="bi bi-x-circle" /> Reject</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Approve Modal ─────────────────────────────────────────────────────────────

function ApproveModal({ request, onConfirm, onCancel, saving, userQuota, paidOverrideCount }) {
  if (!request) return null;
  const catCfg = getCatCfg(request.category);
  const days = countDays(request.startDate, request.endDate);
  const hasUnpaid = (request.unpaidDays || 0) > 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onCancel} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 480, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#e6f4ea' }}>
              <i className="bi bi-check-circle text-success" style={{ fontSize: '1rem' }} />
            </div>
            <div>
              <p className="fw-semibold mb-0 small">Approve Request</p>
              <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>{getRequestTitle(request)} by {request.requesterName}</p>
            </div>
          </div>

          <div className="rounded-2 p-3 mb-3" style={{ background: '#f8f9fa', border: '1px solid #e9ecef' }}>
            <div className="d-flex align-items-center gap-2 mb-1">
              <i className={`bi ${catCfg.icon}`} style={{ color: catCfg.color }} />
              <span className="fw-semibold small">{getRequestTitle(request)}</span>
              {request.bossOverrideToPaid ? (
                <>
                  <span className="badge bg-success" style={{ fontSize: '0.6rem' }}>Paid</span>
                  <span className="badge" style={{ background: '#e8f0fe', color: '#0d6efd', fontSize: '0.6rem' }}>Boss Override</span>
                </>
              ) : (
                <>
                  {request.unpaidDays > 0 && request.paidDays > 0 && <span className="badge bg-warning text-dark" style={{ fontSize: '0.6rem' }}>{request.paidDays}d paid · {request.unpaidDays}d unpaid</span>}
                  {request.unpaidDays > 0 && !request.paidDays && <span className="badge bg-warning text-dark" style={{ fontSize: '0.6rem' }}>Unpaid ({request.unpaidDays}d)</span>}
                  {(!request.unpaidDays || request.unpaidDays === 0) && <span className="badge bg-success" style={{ fontSize: '0.6rem' }}>Paid</span>}
                </>
              )}
            </div>
            <div className="text-muted small">{request.startDate} — {request.endDate} · {days} day{days > 1 ? 's' : ''}</div>
            <div className="text-muted small mt-1">{request.reason}</div>
          </div>

          {request.intermediateApproval && (request.intermediateApproval.status === 'approved' || request.intermediateApproval.status === 'forwarded') && (
            <div className="d-flex align-items-center gap-2 rounded-2 p-2 mb-3" style={{ background: '#e6f4ea', border: '1px solid #b7dfc4' }}>
              <i className="bi bi-check-circle-fill text-success" style={{ fontSize: '0.75rem' }} />
              <span className="small">
                {request.intermediateApproval.forwardToBoss ? 'Forwarded' : 'Approved'} by <strong>{request.intermediateApproval.approverName}</strong>
                {request.intermediateApproval.approverRole && ` (${ROLE_LABELS[request.intermediateApproval.approverRole] || request.intermediateApproval.approverRole})`}
                {request.intermediateApproval.resolvedAt && (
                  <span className="text-muted" style={{ marginLeft: 6 }}>
                    · {(() => {
                      const ts = request.intermediateApproval.resolvedAt;
                      const d = ts.toDate ? ts.toDate() : new Date(ts);
                      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
                    })()}
                  </span>
                )}
              </span>
            </div>
          )}

          {userQuota && (
            <div className="rounded-2 p-2 mb-3" style={{ background: '#f0f1f5', border: '1px solid #dee2e6' }}>
              <div className="small fw-semibold text-muted mb-1" style={{ fontSize: '0.68rem' }}>User's Remaining Paid Quota (this month)</div>
              <div className="d-flex flex-wrap gap-2">
                {[
                  { label: 'Medical',   key: 'medical',   color: '#dc3545' },
                  { label: 'Emergency', key: 'emergency', color: '#fd7e14' },
                  { label: 'WFH',       key: 'wfh',       color: '#0d6efd' },
                ].map(q => (
                  <span key={q.key} className="d-inline-flex align-items-center gap-1 rounded-pill px-2" style={{ background: `${q.color}10`, border: `1px solid ${q.color}25`, fontSize: '0.65rem', fontWeight: 600, color: q.color, lineHeight: '20px' }}>
                    {q.label}: {userQuota[q.key] ?? '—'}
                  </span>
                ))}
              </div>
            </div>
          )}

          {hasUnpaid && paidOverrideCount > 0 && (
            <div className="rounded-2 p-2 mb-3" style={{ background: '#e8f0fe', border: '1px solid #c5d5ff' }}>
              <div className="d-flex align-items-center gap-2">
                <i className="bi bi-info-circle text-primary" style={{ fontSize: '0.75rem' }} />
                <span className="small">You have already approved <strong>{paidOverrideCount}</strong> unpaid request{paidOverrideCount !== 1 ? 's' : ''} as paid for <strong>{request.requesterName}</strong> this month.</span>
              </div>
            </div>
          )}

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onCancel} disabled={saving}>Cancel</button>
            {hasUnpaid ? (
              <>
                <button className="btn btn-sm btn-warning px-3 d-inline-flex align-items-center gap-1 text-dark" onClick={() => onConfirm(false)} disabled={saving}>
                  {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-x-circle" />} Approve as Unpaid
                </button>
                <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1" onClick={() => onConfirm(true)} disabled={saving}>
                  {saving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-check-circle" />} Approve as Paid
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1" onClick={() => onConfirm(false)} disabled={saving}>
                {saving ? <><span className="spinner-border spinner-border-sm" /> Approving…</> : <><i className="bi bi-check-circle" /> Approve</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BossLeaveRequestsPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const [requests, setRequests] = useState([]);
  const [loading, setLoading]   = useState(true);

  const [activeTab,      setActiveTab]      = useState('pending');
  const [search,         setSearch]         = useState('');
  const [filterCategory, setFilterCategory] = useState('');

  const [rejectTarget,      setRejectTarget]      = useState(null);
  const [approveTarget,     setApproveTarget]     = useState(null);
  const [approveQuota,      setApproveQuota]      = useState(null);
  const [paidOverrideCount, setPaidOverrideCount] = useState(0);
  const [actionSaving,      setActionSaving]      = useState(false);

  useEffect(() => {
    // Safety: force loading=false after 8s if subscribeLeaves never
    // delivers (e.g., realtime channel stuck).
    const safetyTimer = setTimeout(() => setLoading(false), 8000);
    const unsub = subscribeLeaves((rows) => {
      setRequests(rows);
      setLoading(false);
      clearTimeout(safetyTimer);
    });
    return () => {
      clearTimeout(safetyTimer);
      unsub();
    };
  }, []);

  // When opening Approve modal, fetch the user's REMAINING quota
  // (raw monthly - already used) so Boss can see what's left.
  async function openApproveModal(r) {
    setApproveTarget(r);
    setApproveQuota(null);
    setPaidOverrideCount(0);
    try {
      // Raw monthly quota from profiles
      const { data: prof } = await supabase
        .from('profiles')
        .select('leave_quota')
        .eq('id', r.requestedBy)
        .maybeSingle();
      const DEFAULT = { medical: 1, emergency: 1, wfh: 2 };
      const rawQuota = prof?.leave_quota || DEFAULT;

      // Compute used in current month from the in-memory requests list
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const used = { medical: 0, emergency: 0, wfh: 0 };
      requests.forEach(req => {
        if (req.requestedBy !== r.requestedBy) return;
        if (req.status === 'rejected' || req.status === 'withdrawn') return;
        const rs = new Date(req.startDate + 'T00:00:00');
        if (rs < monthStart || rs > monthEnd) return;
        const days = countDays(req.startDate, req.endDate);
        if (req.category === 'leave' && req.leaveType) {
          if (req.leaveType === 'emergency') used.emergency += days;
          else if (req.leaveType === 'medical' || req.leaveType === 'medical_emergency') used.medical += days;
        }
        if (req.category === 'wfh') used.wfh += days;
        if (req.category === 'half_leave') used.medical += 0.5;
      });

      const isNew = rawQuota.medical != null || rawQuota.emergency != null;
      const medQ = isNew ? (rawQuota.medical   ?? 1) : 1;
      const emQ  = isNew ? (rawQuota.emergency ?? 1) : 1;
      const wfQ  = isNew ? (rawQuota.wfh       ?? 2) : 2;
      setApproveQuota({
        medical:   Math.max(0, medQ - used.medical),
        emergency: Math.max(0, emQ - used.emergency),
        wfh:       Math.max(0, wfQ - used.wfh),
      });

      // Count this user's prior unpaid → paid overrides this month
      const count = requests.filter(req => {
        if (req.requestedBy !== r.requestedBy) return false;
        if (!req.bossOverrideToPaid) return false;
        const rs = new Date(req.startDate + 'T00:00:00');
        return rs >= monthStart && rs <= monthEnd;
      }).length;
      setPaidOverrideCount(count);
    } catch { /* ignore */ }
  }

  async function handleApprove(overrideToPaid) {
    if (!approveTarget) return;
    setActionSaving(true);
    try {
      // Step 1: approve at boss level (decideLeave with action='approve').
      // This appends to decisions[] and flips status to 'approved'.
      await teamApproveLeave(approveTarget.id, { forwardToBoss: false });

      // Step 2: if Boss is overriding unpaid → paid, flip paid_override.
      if (overrideToPaid && (approveTarget.unpaidDays || 0) > 0) {
        await bossPaidOverride(approveTarget.id, true, 'Boss approved unpaid days as paid');
      }
      setApproveTarget(null);
    } catch (e) {
      alert('Failed to approve: ' + (e.message || 'unknown'));
    } finally { setActionSaving(false); }
  }

  async function handleReject(reason) {
    if (!rejectTarget) return;
    setActionSaving(true);
    try {
      await teamRejectLeave(rejectTarget.id, reason);
      setRejectTarget(null);
    } catch (e) {
      alert('Failed to reject: ' + (e.message || 'unknown'));
    } finally { setActionSaving(false); }
  }

  const stats = useMemo(() => ({
    pending:  requests.filter(r => r.status === 'pending_boss').length,
    approved: requests.filter(r => r.status === 'approved').length,
    rejected: requests.filter(r => r.status === 'rejected').length,
    all:      requests.length,
  }), [requests]);

  const currentMonthLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const unpaidSummary = useMemo(() => {
    // All unpaid (non-overridden, non-rejected, non-withdrawn) requests
    // — not month-scoped. A request from a prior month that wasn't
    // overridden is still pending deduction. Per-user aggregation
    // with a month-by-month breakdown so the payroll-runner can see
    // both the total and which periods the days come from.
    const map = {};
    requests.forEach(r => {
      if (r.status === 'rejected' || r.status === 'withdrawn') return;
      // Skip Boss-overridden requests — these have unpaid_days > 0 in
      // the DB but Boss flipped paid_override=true, so they're
      // effectively paid and should not count toward the deduction.
      if (r.bossOverrideToPaid) return;
      const ud = r.unpaidDays || 0;
      if (ud <= 0) return;
      const key = r.requestedBy;
      if (!map[key]) map[key] = { name: r.requesterName, email: r.requesterEmail, role: r.requesterRole, days: 0, byMonth: {} };
      map[key].days += ud;
      const ym = (r.startDate || '').slice(0, 7); // 'YYYY-MM'
      if (ym) map[key].byMonth[ym] = (map[key].byMonth[ym] || 0) + ud;
    });
    return Object.values(map).sort((a, b) => b.days - a.days);
  }, [requests]);

  const filtered = useMemo(() => {
    return requests.filter(r => {
      if (activeTab === 'pending' && r.status !== 'pending_boss') return false;
      if (activeTab === 'approved' && r.status !== 'approved') return false;
      if (activeTab === 'rejected' && r.status !== 'rejected') return false;
      if (activeTab === 'all') { /* show everything */ }
      if (activeTab === 'unpaid' && (!(r.unpaidDays > 0) || r.status === 'rejected')) return false;
      if (filterCategory && r.category !== filterCategory) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(r.requesterName || '').toLowerCase().includes(q) && !(r.requesterEmail || '').toLowerCase().includes(q) && !(r.reason || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [requests, activeTab, filterCategory, search]);

  function generateReport() {
    const rows = [['Name', 'Email', 'Role', 'Category', 'Leave Type', 'Start', 'End', 'Days', 'Paid Days', 'Unpaid Days', 'Reason', 'Status', 'Approved By', 'Reject Reason', 'Submitted']];
    requests.forEach(r => {
      const days = countDays(r.startDate, r.endDate);
      const approvedBy = r.intermediateApproval?.approverName ? `${r.intermediateApproval.approverName}${r.bossApproval ? ' + Boss' : ''}` : (r.bossApproval ? 'Boss' : '');
      const rejectReason = r.bossApproval?.rejectReason || r.intermediateApproval?.rejectReason || '';
      rows.push([
        r.requesterName, r.requesterEmail, ROLE_LABELS[r.requesterRole] || '',
        getCatCfg(r.category).label, r.leaveType ? (LEAVE_TYPES[r.leaveType] || '') : '',
        r.startDate, r.endDate, days, r.paidDays || days, r.unpaidDays || 0,
        `"${(r.reason || '').replace(/"/g, '""')}"`, r.status, approvedBy,
        `"${rejectReason.replace(/"/g, '""')}"`, formatDate(r.createdAt),
      ]);
    });
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `leave-requests-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-4">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
            <i className="bi bi-file-earmark-text" style={{ fontSize: '1.15rem' }} />
            Leave & WFH Requests
          </h5>
          <p className="text-muted small mb-0">Review, approve, and track all employee requests · Quotas reset monthly</p>
        </div>
        <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.78rem' }} onClick={generateReport} disabled={requests.length === 0}>
          <i className="bi bi-download" style={{ fontSize: '0.72rem' }} /> Export CSV
        </button>
      </div>

      <div className="d-flex gap-2 mb-4 flex-wrap">
        {[
          { key: 'pending',  label: 'Pending',  count: stats.pending,  color: '#6610f2', bg: '#f0ebff' },
          { key: 'approved', label: 'Approved', count: stats.approved, color: '#198754', bg: '#e6f4ea' },
          { key: 'rejected', label: 'Rejected', count: stats.rejected, color: '#dc3545', bg: '#fff0f0' },
          { key: 'unpaid',   label: 'Unpaid',   count: unpaidSummary.reduce((s, u) => s + u.days, 0), color: '#fd7e14', bg: '#fff3e0' },
          { key: 'all',      label: 'All',      count: stats.all,      color: '#495057', bg: '#f3f4f6' },
        ].map(tab => (
          <button key={tab.key} className="d-flex align-items-center gap-2 px-3 py-2 rounded-2 border-0"
            style={{ background: activeTab === tab.key ? tab.color : tab.bg, color: activeTab === tab.key ? '#fff' : tab.color, fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer', transition: 'all 0.15s' }}
            onClick={() => setActiveTab(tab.key)}>
            {tab.label}
            <span className="rounded-pill px-2" style={{ background: activeTab === tab.key ? 'rgba(255,255,255,0.25)' : `${tab.color}20`, color: activeTab === tab.key ? '#fff' : tab.color, fontSize: '0.68rem', fontWeight: 700, lineHeight: '18px' }}>
              {tab.key === 'unpaid' ? `${tab.count}d` : tab.count}
            </span>
          </button>
        ))}
      </div>

      {activeTab === 'unpaid' && unpaidSummary.length > 0 && (
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12, borderLeft: '4px solid #fd7e14' }}>
          <div className="card-body p-3">
            <div className="d-flex align-items-center gap-2 mb-2">
              <i className="bi bi-exclamation-triangle text-warning" />
              <span className="fw-semibold small">Unpaid Leave Summary — pending salary deduction</span>
            </div>
            <table className="table table-sm mb-0" style={{ fontSize: '0.78rem' }}>
              <thead>
                <tr style={{ color: '#9ca3af' }}>
                  <th>Employee</th>
                  <th>Role</th>
                  <th>Unpaid Days</th>
                  <th>Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {unpaidSummary.map((u, i) => {
                  const months = Object.entries(u.byMonth || {})
                    .sort(([a], [b]) => b.localeCompare(a));
                  return (
                    <tr key={i}>
                      <td><span className="fw-medium">{u.name}</span> <span className="text-muted">· {u.email}</span></td>
                      <td>{ROLE_LABELS[u.role] || u.role}</td>
                      <td><span className="badge bg-warning text-dark">{u.days} day{u.days > 1 ? 's' : ''}</span></td>
                      <td>
                        <div className="d-flex flex-wrap gap-1" style={{ fontSize: '0.7rem' }}>
                          {months.map(([ym, d]) => {
                            const [yy, mm] = ym.split('-').map(Number);
                            const label = new Date(yy, mm - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
                            return (
                              <span key={ym} className="badge" style={{ background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', fontWeight: 500 }}>
                                {label}: {d}d
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab !== 'unpaid' && (
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
          <div className="card-body p-3">
            <div className="d-flex flex-wrap gap-2 align-items-center">
              <div className="position-relative" style={{ flex: '1 1 200px', minWidth: 180 }}>
                <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
                <input type="text" className="form-control form-control-sm" placeholder="Search by name, email, reason…" style={{ paddingLeft: 30, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 160 }} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                <option value="">All Categories</option>
                {REQUEST_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              {(search || filterCategory) && (
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.75rem' }} onClick={() => { setSearch(''); setFilterCategory(''); }}>
                  <i className="bi bi-x-circle" /> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : filtered.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16, background: '#fff' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: '#f0f1f5' }}>
            <i className="bi bi-file-earmark-text text-muted" style={{ fontSize: '1.6rem', opacity: 0.35 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No {activeTab === 'all' ? '' : activeTab} requests</p>
          <p className="text-muted small mb-0">{activeTab === 'pending' ? 'All caught up!' : 'Nothing here yet.'}</p>
        </div>
      ) : (
        <div className="d-flex flex-column gap-3">
          {filtered.map(r => {
            const catCfg = getCatCfg(r.category);
            const stCfg = getStCfg(r.status);
            const title = getRequestTitle(r);
            const days = countDays(r.startDate, r.endDate);

            return (
              <div key={r.id} className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: `4px solid ${catCfg.color}` }}>
                <div className="card-body p-3">
                  <div className="d-flex align-items-start justify-content-between">
                    <div className="d-flex gap-3 flex-grow-1">
                      <div className="rounded-circle d-flex align-items-center justify-content-center fw-semibold text-white flex-shrink-0"
                        style={{ width: 38, height: 38, background: 'linear-gradient(135deg,#3b82f6,#1d4ed8)', fontSize: '0.65rem' }}>
                        {(r.requesterName || '?').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-grow-1">
                        <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                          <span className="fw-semibold small">{r.requesterName}</span>
                          <span className="badge rounded-pill" style={{ background: `${catCfg.color}15`, color: catCfg.color, fontSize: '0.63rem', fontWeight: 600 }}>
                            <i className={`bi ${catCfg.icon} me-1`} style={{ fontSize: '0.56rem' }} />{catCfg.label}
                          </span>
                          {r.requesterRole && <span className="text-muted" style={{ fontSize: '0.66rem' }}>{ROLE_LABELS[r.requesterRole] || r.requesterRole}</span>}
                          {r.bossOverrideToPaid ? (
                            // Boss-overridden requests are effectively paid;
                            // suppress the original Unpaid badge so the row
                            // doesn't read as "Unpaid + Override to Paid"
                            // (confusing — looks contradictory).
                            <span className="badge" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.58rem' }}>Paid</span>
                          ) : (
                            <>
                              {r.unpaidDays > 0 && r.paidDays > 0 && <span className="badge bg-warning text-dark" style={{ fontSize: '0.58rem' }}>{r.paidDays}d paid · {r.unpaidDays}d unpaid</span>}
                              {r.unpaidDays > 0 && !r.paidDays && <span className="badge bg-warning text-dark" style={{ fontSize: '0.58rem' }}>Unpaid ({r.unpaidDays}d)</span>}
                              {(!r.unpaidDays || r.unpaidDays === 0) && <span className="badge" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.58rem' }}>Paid</span>}
                            </>
                          )}
                          {r.bossOverrideToPaid && <span className="badge" style={{ background: '#e8f0fe', color: '#0d6efd', fontSize: '0.58rem' }}>Boss Override to Paid</span>}
                        </div>
                        <div className="fw-medium small mb-1">{title}</div>
                        <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                          <i className="bi bi-calendar3 me-1" />{r.startDate} — {r.endDate} · {days} day{days > 1 ? 's' : ''}
                        </div>
                        <p className="text-muted mb-0 mt-1" style={{ fontSize: '0.76rem' }}>{r.reason}</p>

                        {r.intermediateApproval && (() => {
                          const it = r.intermediateApproval;
                          // forwarded + approved both render as positive (green).
                          // See LeaveRequestPage.jsx for the same fix.
                          const isApproved  = it.status === 'approved';
                          const isForwarded = it.status === 'forwarded' || it.forwardToBoss;
                          const isPositive  = isApproved || isForwarded;
                          if (!isPositive && r.status?.startsWith('pending')) return null;
                          const verb = isForwarded ? 'Forwarded' : (isApproved ? 'Approved' : 'Rejected');
                          const when = formatDateTime(it.resolvedAt);
                          return (
                            <div className="mt-2 d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                              style={{ background: isPositive ? '#e6f4ea' : '#fff0f0', fontSize: '0.65rem', fontWeight: 500 }}>
                              <i className={`bi ${isPositive ? 'bi-check-circle text-success' : 'bi-x-circle text-danger'}`} style={{ fontSize: '0.58rem' }} />
                              {verb} by {it.approverName}
                              {when && <span style={{ opacity: 0.7, marginLeft: 4 }}>· {when}</span>}
                            </div>
                          );
                        })()}

                        {r.bossApproval && (() => {
                          const ba = r.bossApproval;
                          const isApproved = ba.status === 'approved' || (!ba.status && r.status === 'approved');
                          const verb = isApproved ? 'Approved' : 'Rejected';
                          const when = formatDateTime(ba.resolvedAt);
                          return (
                            <div className="mt-2 d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                              style={{ background: isApproved ? '#e6f4ea' : '#fff0f0', fontSize: '0.65rem', fontWeight: 500, marginLeft: 4 }}>
                              <i className={`bi ${isApproved ? 'bi-shield-check text-success' : 'bi-x-circle text-danger'}`} style={{ fontSize: '0.58rem' }} />
                              Boss: {verb}{ba.approverName ? ` by ${ba.approverName}` : ''}
                              {when && <span style={{ opacity: 0.7, marginLeft: 4 }}>· {when}</span>}
                            </div>
                          );
                        })()}

                        {r.bossApproval?.rejectReason && (
                          <div className="mt-2 rounded-2 p-2" style={{ background: '#fff0f0', border: '1px solid #f5c0c0' }}>
                            <span className="small fw-semibold text-danger"><i className="bi bi-x-circle me-1" />Your Rejection:</span>
                            <span className="small text-muted ms-1">{r.bossApproval.rejectReason}</span>
                          </div>
                        )}

                        <div className="text-muted mt-1" style={{ fontSize: '0.65rem' }}>Submitted {formatDate(r.createdAt)}</div>
                      </div>
                    </div>

                    <div className="d-flex flex-column align-items-end gap-2 flex-shrink-0 ms-3">
                      <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1" style={{ background: stCfg.bg, color: stCfg.color, fontSize: '0.68rem', fontWeight: 600 }}>
                        <i className={`bi ${stCfg.icon}`} style={{ fontSize: '0.58rem' }} />{stCfg.label}
                      </span>
                      {r.status === 'pending_boss' && (
                        <div className="d-flex gap-1">
                          <button className="btn btn-sm btn-outline-success d-inline-flex align-items-center gap-1 px-2"
                            style={{ fontSize: '0.7rem', borderRadius: 6 }} onClick={() => openApproveModal(r)}>
                            <i className="bi bi-check" /> Approve
                          </button>
                          <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 px-2"
                            style={{ fontSize: '0.7rem', borderRadius: 6 }} onClick={() => setRejectTarget(r)}>
                            <i className="bi bi-x" /> Reject
                          </button>
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

      <ApproveModal request={approveTarget} onConfirm={handleApprove} onCancel={() => setApproveTarget(null)} saving={actionSaving} userQuota={approveQuota} paidOverrideCount={paidOverrideCount} />
      <RejectModal request={rejectTarget} onConfirm={handleReject} onCancel={() => setRejectTarget(null)} saving={actionSaving} />
    </div>
  );
}
