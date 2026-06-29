import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  subscribeLeaves,
  getMyLeaveQuota,
  submitLeaveV1,
  withdrawLeave,
  teamApproveLeave,
  teamRejectLeave,
  getActiveBoss,
} from '../../lib/leaveApi';
import { listHolidaysInRange, analyzeLeaveRange } from '../../lib/holidaysApi';
import MonthNavigator, { currentMonthStr, monthLabel, stepMonthStr } from './MonthNavigator';

// ── Config ────────────────────────────────────────────────────────────────────

const REQUEST_CATEGORIES = [
  { value: 'leave',      label: 'Leave Request',  icon: 'bi-calendar-x',    color: 'var(--danger)',  bg: 'var(--danger-soft)' },
  { value: 'wfh',        label: 'Work From Home', icon: 'bi-house',         color: 'var(--info)',    bg: 'var(--info-soft)' },
  { value: 'half_leave', label: 'Half Leave',     icon: 'bi-clock-history', color: 'var(--warning)', bg: 'var(--warning-soft)' },
  { value: 'other',      label: 'Other',          icon: 'bi-three-dots',    color: 'var(--purple)', bg: 'var(--purple-soft)' },
];

const LEAVE_TYPES = [
  { value: 'medical',   label: 'Medical Leave',   icon: 'bi-heart-pulse',         quotaKey: 'medical' },
  { value: 'emergency', label: 'Emergency Leave', icon: 'bi-exclamation-octagon', quotaKey: 'emergency' },
];

const STATUS_CFG = {
  pending_tl:   { label: 'Pending TL',   color: 'var(--warning)', bg: 'var(--warning-soft)', icon: 'bi-hourglass-split' },
  pending_pctl: { label: 'Pending PCTL', color: 'var(--warning)', bg: 'var(--warning-soft)', icon: 'bi-hourglass-split' },
  pending_ol:   { label: 'Pending OL',   color: 'var(--warning)', bg: 'var(--warning-soft)', icon: 'bi-hourglass-split' },
  pending_boss: { label: 'Pending Boss', color: 'var(--purple)', bg: 'var(--purple-soft)', icon: 'bi-hourglass-split' },
  approved:     { label: 'Approved',     color: 'var(--success)', bg: 'var(--success-soft)', icon: 'bi-check-circle-fill' },
  rejected:     { label: 'Rejected',     color: 'var(--danger)',  bg: 'var(--danger-soft)',  icon: 'bi-x-circle-fill' },
  withdrawn:    { label: 'Withdrawn',    color: 'var(--text-secondary)', bg: 'var(--surface-2)', icon: 'bi-arrow-counterclockwise' },
};

function getCatCfg(val) { return REQUEST_CATEGORIES.find(c => c.value === val) || REQUEST_CATEGORIES[0]; }
function getStCfg(val)  { return STATUS_CFG[val] || STATUS_CFG.pending_tl; }

function formatDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Count working days (Mon-Fri) in an inclusive range. Sat + Sun are
// always off so they don't count against the quota and they don't
// inflate the day label on the request card. Server-side
// _leave_working_days() uses the same rule.
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

function getRequestTitle(r) {
  if (r.category === 'leave') { const lt = LEAVE_TYPES.find(l => l.value === r.leaveType); return lt ? lt.label : 'Leave Request'; }
  if (r.category === 'other') return r.otherTitle || 'Other Request';
  return getCatCfg(r.category).label;
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start, end };
}

function isInCurrentMonth(r) {
  const { start, end } = getCurrentMonthRange();
  const reqStart = new Date(r.startDate + 'T00:00:00');
  return reqStart >= start && reqStart <= end;
}

function computeRemainingQuota(leaveQuota, requests) {
  if (!leaveQuota) return null;
  const used = { medical: 0, emergency: 0, wfh: 0 };
  requests.forEach(r => {
    if (r.status === 'rejected' || r.status === 'withdrawn') return;
    if (!isInCurrentMonth(r)) return;
    const days = countDays(r.startDate, r.endDate);
    if (r.category === 'leave' && r.leaveType) {
      if (r.leaveType === 'emergency') used.emergency += days;
      else if (r.leaveType === 'medical' || r.leaveType === 'medical_emergency') used.medical += days;
    }
    if (r.category === 'wfh') used.wfh += days;
    if (r.category === 'half_leave') used.medical += 0.5;
  });
  return {
    medical:   Math.max(0, (leaveQuota.medical   || 0) - used.medical),
    emergency: Math.max(0, (leaveQuota.emergency || 0) - used.emergency),
    wfh:       Math.max(0, (leaveQuota.wfh       || 0) - used.wfh),
  };
}

// ── Confirm Submit Modal — always shown before submission ─────────────────────

function ConfirmSubmitModal({ data, remainingQuota, onConfirm, onCancel, paidOverrideCount }) {
  const catCfg = getCatCfg(data.category);
  const days = countDays(data.startDate, data.endDate);
  const title = data.category === 'leave'
    ? (LEAVE_TYPES.find(l => l.value === data.leaveType)?.label || 'Leave Request')
    : data.category === 'other' ? (data.otherTitle || 'Other') : catCfg.label;

  let quotaKey = null;
  let remaining = null;
  let paidDays = days;
  let unpaidDays = 0;
  let effectiveDays = days;

  if (data.category === 'half_leave') effectiveDays = 0.5;

  if (data.category === 'leave' && data.leaveType && remainingQuota) {
    quotaKey = data.leaveType;
    remaining = remainingQuota[quotaKey];
    paidDays = Math.min(effectiveDays, remaining);
    unpaidDays = Math.max(0, effectiveDays - remaining);
  } else if (data.category === 'wfh' && remainingQuota) {
    quotaKey = 'wfh';
    remaining = remainingQuota.wfh;
    paidDays = Math.min(effectiveDays, remaining);
    unpaidDays = Math.max(0, effectiveDays - remaining);
  } else if (data.category === 'half_leave' && remainingQuota) {
    quotaKey = 'medical';
    remaining = remainingQuota.medical;
    paidDays = remaining >= 0.5 ? 0.5 : 0;
    unpaidDays = remaining >= 0.5 ? 0 : 0.5;
  }
  if (data.category === 'other') { paidDays = 0; unpaidDays = days; }

  const allPaid = unpaidDays === 0;
  const allUnpaid = paidDays === 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onCancel} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: catCfg.bg }}>
              <i className={`bi ${catCfg.icon}`} style={{ color: catCfg.color, fontSize: '1rem' }} />
            </div>
            <div>
              <p className="fw-semibold mb-0 small">Confirm Submission</p>
              <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>{title} · {data.startDate} — {data.endDate}</p>
            </div>
          </div>

          {data.category !== 'other' && remainingQuota && (
            <>
              <div className="rounded-2 p-2 mb-3" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-subtle)' }}>
                <div className="d-flex justify-content-between align-items-center mb-1">
                  <span className="small text-muted">Requested</span>
                  <span className="fw-semibold small">{effectiveDays} day{effectiveDays !== 1 ? 's' : ''}</span>
                </div>
                <div className="d-flex justify-content-between align-items-center mb-1">
                  <span className="small text-muted">Paid (from monthly quota)</span>
                  <span className="fw-semibold small text-success">{paidDays} day{paidDays !== 1 ? 's' : ''}</span>
                </div>
                {unpaidDays > 0 && (
                  <div className="d-flex justify-content-between align-items-center">
                    <span className="small text-muted">Unpaid</span>
                    <span className="fw-semibold small text-warning">{unpaidDays} day{unpaidDays !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>
              <div className="rounded-2 p-2 mb-3 d-flex align-items-center gap-2" style={{
                background: allPaid ? 'var(--success-soft)' : allUnpaid ? 'var(--warning-soft)' : 'var(--warning-soft)',
                border: `1px solid ${allPaid ? 'color-mix(in srgb, var(--success) 35%, transparent)' : allUnpaid ? 'color-mix(in srgb, var(--warning) 35%, transparent)' : 'color-mix(in srgb, var(--warning) 35%, transparent)'}`,
              }}>
                <i className={`bi ${allPaid ? 'bi-check-circle-fill text-success' : 'bi-info-circle text-warning'}`} style={{ fontSize: '0.85rem' }} />
                <span className="small">
                  {allPaid && 'This will be fully paid time off.'}
                  {!allPaid && allUnpaid && 'No paid quota remaining — entire request is unpaid time off.'}
                  {!allPaid && !allUnpaid && `Quota covers ${paidDays} day${paidDays !== 1 ? 's' : ''}; the remaining ${unpaidDays} day${unpaidDays !== 1 ? 's' : ''} ${unpaidDays === 1 ? 'is' : 'are'} unpaid.`}
                </span>
              </div>
              {!allPaid && (
                <div className="rounded-2 p-2 mb-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                  <div className="d-flex align-items-center gap-2">
                    <i className="bi bi-shield-check" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }} />
                    <span className="small text-muted">Boss may approve unpaid days as paid retroactively.</span>
                  </div>
                </div>
              )}
            </>
          )}

          {!allPaid && paidOverrideCount > 0 && (
            <div className="rounded-2 p-2 mb-3" style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)' }}>
              <div className="d-flex align-items-center gap-2">
                <i className="bi bi-info-circle text-primary" style={{ fontSize: '0.75rem' }} />
                <span className="small">Boss has approved <strong>{paidOverrideCount}</strong> of your past unpaid request{paidOverrideCount !== 1 ? 's' : ''} as paid this month.</span>
              </div>
            </div>
          )}

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onCancel}>Cancel</button>
            <button className="btn btn-sm px-3 d-inline-flex align-items-center gap-1"
              style={{ background: allPaid ? catCfg.color : 'var(--warning)', color: '#fff', border: 'none' }}
              onClick={() => onConfirm({ paidDays, unpaidDays })}>
              <i className="bi bi-send" /> {allPaid ? 'Submit Request' : allUnpaid ? 'Submit as Unpaid' : 'Submit Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── New Request Modal ─────────────────────────────────────────────────────────

function NewRequestModal({ onClose, onSubmit, saving, remainingQuota, paidOverrideCount }) {
  const [category,    setCategory]    = useState('leave');
  const [leaveType,   setLeaveType]   = useState('medical');
  const [otherTitle,  setOtherTitle]  = useState('');
  const [startDate,   setStartDate]   = useState('');
  const [endDate,     setEndDate]     = useState('');
  const [reason,      setReason]      = useState('');
  const [error,       setError]       = useState('');
  const [pendingData, setPendingData] = useState(null);
  const [holidaysInRange, setHolidaysInRange] = useState([]);

  // Fetch any company holidays that overlap the selected range so the
  // preview can show "X days include Eid Holidays" without the user
  // having to know which dates are blocked.
  useEffect(() => {
    let cancelled = false;
    if (!startDate || !endDate || endDate < startDate) {
      setHolidaysInRange([]);
      return undefined;
    }
    listHolidaysInRange(startDate, endDate)
      .then((rows) => { if (!cancelled) setHolidaysInRange(rows); })
      .catch(() => { if (!cancelled) setHolidaysInRange([]); });
    return () => { cancelled = true; };
  }, [startDate, endDate]);

  const rangeBreakdown = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return null;
    return analyzeLeaveRange(startDate, endDate, holidaysInRange);
  }, [startDate, endDate, holidaysInRange]);

  function validate() {
    if (category === 'other' && !otherTitle.trim()) return 'Please specify what you need.';
    if (!startDate) return 'Start date is required.';
    if (!endDate) return 'End date is required.';
    if (new Date(endDate) < new Date(startDate)) return 'End date must be after start date.';
    if (!reason.trim()) return 'Please provide a reason.';
    return null;
  }

  function handleSubmit(e) {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }
    setError('');
    setPendingData({
      category, leaveType: category === 'leave' ? leaveType : null,
      otherTitle: category === 'other' ? otherTitle.trim() : null,
      startDate, endDate, reason: reason.trim(),
    });
  }

  function handleConfirm({ paidDays, unpaidDays }) {
    setPendingData(null);
    onSubmit({ ...pendingData, paidDays, unpaidDays, isPaidTimeOff: unpaidDays === 0 });
  }

  const catCfg = getCatCfg(category);

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 1050, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
        <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, zIndex: 1, borderRadius: 16, maxHeight: '92vh', overflowY: 'auto' }}>
          <div className="card-body p-4">
            <div className="d-flex align-items-center justify-content-between mb-4">
              <div>
                <h6 className="fw-bold mb-0">New Request</h6>
                <p className="text-muted small mb-0">Submit a request for approval</p>
              </div>
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
                style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              {error && <div className="alert alert-danger py-2 small mb-3 d-flex align-items-center gap-2"><i className="bi bi-exclamation-circle flex-shrink-0" />{error}</div>}

              <div className="mb-3">
                <label className="form-label small fw-semibold">Request Type</label>
                <div className="d-flex gap-2 flex-wrap">
                  {REQUEST_CATEGORIES.map(cat => (
                    <button key={cat.value} type="button" onClick={() => setCategory(cat.value)}
                      className="d-inline-flex align-items-center gap-1 rounded-pill border"
                      style={{
                        fontSize: '0.78rem', fontWeight: 600, padding: '5px 12px',
                        background: category === cat.value ? cat.color : cat.bg,
                        color: category === cat.value ? '#fff' : cat.color,
                        borderColor: category === cat.value ? cat.color : `color-mix(in srgb, ${cat.color} 35%, transparent)`,
                        cursor: 'pointer', transition: 'all 0.12s',
                      }}>
                      <i className={`bi ${cat.icon}`} style={{ fontSize: '0.72rem' }} />{cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {category === 'leave' && (
                <div className="mb-3">
                  <label className="form-label small fw-semibold">Leave Type</label>
                  <div className="d-flex gap-2 flex-wrap">
                    {LEAVE_TYPES.map(lt => {
                      const remaining = remainingQuota?.[lt.quotaKey];
                      const isZero = remaining != null && remaining <= 0;
                      return (
                        <button key={lt.value} type="button" onClick={() => setLeaveType(lt.value)}
                          className="d-inline-flex align-items-center gap-1 rounded-2 border"
                          style={{
                            fontSize: '0.78rem', fontWeight: 500, padding: '6px 12px',
                            background: leaveType === lt.value ? 'var(--accent)' : 'var(--surface-0)',
                            color: leaveType === lt.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                            borderColor: leaveType === lt.value ? 'var(--accent)' : 'var(--border-subtle)',
                            cursor: 'pointer', transition: 'all 0.12s',
                          }}>
                          <i className={`bi ${lt.icon}`} style={{ fontSize: '0.72rem' }} />
                          {lt.label}
                          {remaining != null && (
                            <span style={{ fontSize: '0.65rem', marginLeft: 4, color: leaveType === lt.value ? (isZero ? 'var(--danger)' : 'var(--on-accent)') : (isZero ? 'var(--danger)' : 'var(--text-secondary)') }}>
                              ({remaining})
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {remainingQuota && (
                    <div className="text-muted mt-1" style={{ fontSize: '0.7rem' }}>Numbers in parentheses = remaining paid days this month (resets monthly)</div>
                  )}
                  {remainingQuota && remainingQuota[leaveType] <= 0 && (
                    <div className="mt-1 d-flex align-items-center gap-1" style={{ fontSize: '0.72rem', color: 'var(--danger)' }}>
                      <i className="bi bi-exclamation-triangle" /> No paid days remaining — this will be unpaid time off
                    </div>
                  )}
                </div>
              )}

              {category === 'wfh' && remainingQuota && remainingQuota.wfh <= 0 && (
                <div className="alert alert-warning py-2 small mb-3 d-flex align-items-center gap-2">
                  <i className="bi bi-exclamation-triangle" /> No paid WFH days remaining — this will be unpaid
                </div>
              )}

              {category === 'other' && (
                <div className="mb-3">
                  <label className="form-label small fw-semibold">What do you need? <span className="text-danger">*</span></label>
                  <input type="text" className="form-control form-control-sm" placeholder="e.g. Early dismissal, Schedule change…"
                    value={otherTitle} onChange={e => setOtherTitle(e.target.value)} />
                </div>
              )}

              <div className="row g-3 mb-3">
                <div className="col-6">
                  <label className="form-label small fw-semibold">Start Date <span className="text-danger">*</span></label>
                  <input type="date" className="form-control form-control-sm" value={startDate} onChange={e => setStartDate(e.target.value)} />
                </div>
                <div className="col-6">
                  <label className="form-label small fw-semibold">End Date <span className="text-danger">*</span></label>
                  <input type="date" className="form-control form-control-sm" value={endDate} onChange={e => setEndDate(e.target.value)} />
                </div>
              </div>

              {rangeBreakdown && rangeBreakdown.calendarDays > 0 && (
                <div className="mb-3 rounded-3 p-3" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-subtle)' }}>
                  <div className="d-flex justify-content-between align-items-center mb-2">
                    <span className="fw-semibold" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                      <i className="bi bi-calendar-week me-1" />
                      Range breakdown
                    </span>
                    <span className="rounded-pill px-2 py-1" style={{
                      fontSize: '0.72rem', fontWeight: 700,
                      background: rangeBreakdown.actualDays > 0 ? 'var(--warning-soft)' : 'var(--success-soft)',
                      color:      rangeBreakdown.actualDays > 0 ? 'var(--warning)' : 'var(--success)',
                    }}>
                      {rangeBreakdown.actualDays} actual day{rangeBreakdown.actualDays === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="d-flex flex-column gap-1" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    <div className="d-flex justify-content-between">
                      <span>Calendar days</span>
                      <strong>{rangeBreakdown.calendarDays}</strong>
                    </div>
                    {rangeBreakdown.weekendDays > 0 && (
                      <div className="d-flex justify-content-between">
                        <span>Weekends (Sat / Sun)</span>
                        <span style={{ color: 'var(--text-secondary)' }}>− {rangeBreakdown.weekendDays}</span>
                      </div>
                    )}
                    {rangeBreakdown.holidayDays > 0 && (
                      <div className="d-flex justify-content-between">
                        <span>
                          Company holidays
                          {rangeBreakdown.holidayLabels.length > 0 && (
                            <span style={{ color: 'var(--purple)', marginLeft: 4 }}>
                              ({rangeBreakdown.holidayLabels.join(', ')})
                            </span>
                          )}
                        </span>
                        <span style={{ color: 'var(--purple)' }}>− {rangeBreakdown.holidayDays}</span>
                      </div>
                    )}
                    <div className="d-flex justify-content-between pt-1 mt-1" style={{ borderTop: '1px dashed var(--border-default)', fontWeight: 700, color: 'var(--text-primary)' }}>
                      <span>Charged to your quota</span>
                      <span>{rangeBreakdown.actualDays}</span>
                    </div>
                  </div>
                  {(rangeBreakdown.weekendDays > 0 || rangeBreakdown.holidayDays > 0) && (
                    <div className="text-muted mt-2" style={{ fontSize: '0.68rem' }}>
                      Weekends and company holidays don't count against your leave quota.
                    </div>
                  )}
                </div>
              )}

              <div className="mb-4">
                <label className="form-label small fw-semibold">Reason <span className="text-danger">*</span></label>
                <textarea className="form-control" rows={3} placeholder="Provide a reason…" value={reason} onChange={e => setReason(e.target.value)} />
              </div>

              <div className="d-flex gap-2 justify-content-end">
                <button type="button" className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
                <button type="submit" className="btn btn-sm px-3 d-inline-flex align-items-center gap-1" style={{ background: catCfg.color, color: '#fff', border: 'none' }} disabled={saving}>
                  {saving ? <><span className="spinner-border spinner-border-sm" />Submitting…</> : <><i className="bi bi-send" />Submit Request</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {pendingData && (
        <ConfirmSubmitModal
          data={pendingData}
          remainingQuota={remainingQuota}
          onConfirm={handleConfirm}
          onCancel={() => setPendingData(null)}
          paidOverrideCount={paidOverrideCount}
        />
      )}
    </>
  );
}

// ── Approve Modal (for TL/OL reviewing team requests) ─────────────────────────

function ApproveTeamModal({ request, onConfirm, onCancel, saving, approverRole }) {
  const [forwardToBoss, setForwardToBoss] = useState(false);
  if (!request) return null;
  const catCfg = getCatCfg(request.category);
  const days = countDays(request.startDate, request.endDate);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onCancel} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--success-soft)' }}>
              <i className="bi bi-check-circle text-success" style={{ fontSize: '1rem' }} />
            </div>
            <div>
              <p className="fw-semibold mb-0 small">Approve Request</p>
              <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>{getRequestTitle(request)} by {request.requesterName}</p>
            </div>
          </div>

          <div className="rounded-2 p-3 mb-3" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-subtle)' }}>
            <div className="d-flex align-items-center gap-2 mb-1">
              <i className={`bi ${catCfg.icon}`} style={{ color: catCfg.color }} />
              <span className="fw-semibold small">{getRequestTitle(request)}</span>
              {request.bossOverrideToPaid ? (
                <span className="badge" style={{ background: 'var(--info-soft)', color: 'var(--info)', fontSize: '0.6rem' }}>Paid · Boss Override</span>
              ) : (
                <>
                  {request.unpaidDays > 0 && request.paidDays > 0 && <span className="badge bg-warning text-dark" style={{ fontSize: '0.6rem' }}>{request.paidDays}d paid · {request.unpaidDays}d unpaid</span>}
                  {request.unpaidDays > 0 && !request.paidDays && <span className="badge bg-warning text-dark" style={{ fontSize: '0.6rem' }}>Unpaid ({request.unpaidDays}d)</span>}
                </>
              )}
            </div>
            <div className="text-muted small">{request.startDate} — {request.endDate} · {days} day{days > 1 ? 's' : ''}</div>
            <div className="text-muted small mt-1">{request.reason}</div>
          </div>

          <div
            className="d-flex align-items-center gap-2 rounded-2 p-2 mb-4"
            style={{ background: forwardToBoss ? 'var(--purple-soft)' : 'var(--surface-0)', border: `1.5px solid ${forwardToBoss ? 'color-mix(in srgb, var(--purple) 40%, transparent)' : 'var(--border-subtle)'}`, cursor: 'pointer', transition: 'all 0.15s' }}
            onClick={() => setForwardToBoss(v => !v)}
          >
            <input type="checkbox" className="form-check-input flex-shrink-0" checked={forwardToBoss}
              onChange={e => setForwardToBoss(e.target.checked)} onClick={e => e.stopPropagation()} style={{ cursor: 'pointer' }} />
            <span className="small" style={{ cursor: 'pointer', color: forwardToBoss ? 'var(--purple)' : 'var(--text-secondary)' }}>
              <i className="bi bi-arrow-up-circle me-1" />
              Forward to Boss for final approval
            </span>
          </div>

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onCancel} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1" onClick={() => onConfirm(forwardToBoss)} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Approving…</> : <><i className="bi bi-check-circle" /> Approve</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RejectTeamModal({ request, onConfirm, onCancel, saving }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  if (!request) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onCancel} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--danger-soft)' }}>
              <i className="bi bi-x-circle text-danger" style={{ fontSize: '1rem' }} />
            </div>
            <div>
              <p className="fw-semibold mb-0 small">Reject Request</p>
              <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>{getRequestTitle(request)} by {request.requesterName}</p>
            </div>
          </div>
          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Reason <span className="text-danger">*</span></label>
            <textarea className="form-control" rows={3} placeholder="Provide a rejection reason…" value={reason} onChange={e => setReason(e.target.value)} />
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

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LeaveRequestPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '', ownerId: profile?.owner_id || null } : null;
  const effectiveRole = userRole === 'tl' ? 'tl'
    : userRole === 'pctl' ? 'pctl'
    : userRole === 'ol' ? 'ol'
    : userRole === 'boss' ? 'boss'
    : (apcProfile ? 'apc' : (userRole || 'tl'));
  const isApc  = effectiveRole === 'apc';
  const isTL   = effectiveRole === 'tl';
  const isPCTL = effectiveRole === 'pctl';
  const isOL   = effectiveRole === 'ol';
  const isBoss = effectiveRole === 'boss';
  // PCTL reviews their IPC team's leave the same way a TL reviews
  // their APC team's. Without this flag PCTL would never see the
  // Team tab or get an Approve button on an IPC's pending request.
  const canReviewTeam = isTL || isPCTL || isOL;

  const [activeTab,  setActiveTab]  = useState('my');
  // Month scope shared by the My + Team tabs (default: current month).
  const [viewMonth,  setViewMonth]  = useState(currentMonthStr);
  const [allLeaves, setAllLeaves]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showModal, setShowModal]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [leaveQuota, setLeaveQuota] = useState(null);
  const [filterStatus, setFilterStatus]     = useState('');
  const [search,       setSearch]           = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [dateFrom,     setDateFrom]         = useState('');
  const [dateTo,       setDateTo]           = useState('');

  const [approveTarget, setApproveTarget]       = useState(null);
  const [rejectTarget,  setRejectTarget]        = useState(null);
  const [actionSaving,  setActionSaving]        = useState(false);
  // Race-proof in-flight guard. React batches setState so two clicks
  // on the Approve button fired in the same tick can both call the
  // RPC before `actionSaving=true` takes effect. The ref is set
  // synchronously so the second click bails immediately.
  const submittingRef = useRef(false);
  // Errors from the leave_decide RPC that mean "the action you wanted
  // already happened" — usually because realtime + a double-click
  // raced. Treat them as silent success: close the modal, refresh.
  function isAlreadyResolvedError(msg) {
    if (!msg) return false;
    const s = String(msg);
    return /request already decided/i.test(s)
      || /not authorized to decide this request/i.test(s)
      || /already at top of approval chain/i.test(s);
  }
  const [teamFilter, setTeamFilter]             = useState('pending');
  const [teamSearch, setTeamSearch]             = useState('');
  const [teamFilterCategory, setTeamFilterCategory] = useState('');
  const [teamDateFrom, setTeamDateFrom]         = useState('');
  const [teamDateTo, setTeamDateTo]             = useState('');
  const [teamPendingStage, setTeamPendingStage] = useState('');
  const [teamRequesterRole, setTeamRequesterRole] = useState('');

  // Active Boss profile — drives the "Forwarded to <Boss>" label
  // shown to viewers who aren't the forwarder or the Boss themselves.
  const [bossInfo, setBossInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getActiveBoss().then((b) => { if (!cancelled) setBossInfo(b); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Company holidays that overlap visible request ranges. Used by the
  // card breakdown so an approver can see "calendar 9 - weekend 2 -
  // holiday 1 = 6 actual leave days" before deciding. One fetch covers
  // a wide window around today so cards for upcoming + recent requests
  // all hit the same in-memory list.
  const [companyHolidays, setCompanyHolidays] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const to   = new Date(today.getFullYear(), today.getMonth() + 6, 0);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    listHolidaysInRange(ymd(from), ymd(to))
      .then((rows) => { if (!cancelled) setCompanyHolidays(rows); })
      .catch(() => { if (!cancelled) setCompanyHolidays([]); });
    return () => { cancelled = true; };
  }, []);

  const fromName = isApc
    ? (apcProfile?.userName || currentUser?.displayName || currentUser?.email?.split('@')[0] || 'APC')
    : (currentUser?.displayName || currentUser?.email?.split('@')[0] || 'User');

  // RLS-scoped subscribe pulls everything the user is allowed to see
  // (own + team if TL, all if OL/Boss). We split into my/team in memo.
  //
  // CRITICAL: depend on `currentUser?.uid` (stable string), NOT
  // `currentUser` (a new object identity every render). The previous
  // [currentUser] dep made this effect tear down and re-subscribe on
  // every render — including renders triggered by setAllLeaves itself
  // — keeping the page in a perpetual "loading" state and never
  // delivering data to the UI.
  const uid = currentUser?.uid;
  useEffect(() => {
    if (!uid) return;
    // Safety: force loading=false after 8s even if subscribeLeaves
    // somehow never delivers the first onChange (network hang).
    const safetyTimer = setTimeout(() => setLoading(false), 8000);
    const unsub = subscribeLeaves((rows) => {
      setAllLeaves(rows);
      setLoading(false);
      clearTimeout(safetyTimer);
    });
    return () => {
      clearTimeout(safetyTimer);
      unsub();
    };
  }, [uid]);

  // Quota
  useEffect(() => {
    if (!uid) return;
    (async () => {
      try {
        const q = await getMyLeaveQuota(uid);
        setLeaveQuota(q);
      } catch { /* ignore */ }
    })();
  }, [uid]);

  const myRequests   = useMemo(() => allLeaves.filter(r => r.requestedBy === currentUser?.uid), [allLeaves, currentUser]);
  const teamRequests = useMemo(() => {
    if (!canReviewTeam) return [];
    return allLeaves.filter(r => r.requestedBy !== currentUser?.uid);
  }, [allLeaves, canReviewTeam, currentUser]);

  // Month-scoped views — both tabs only show requests whose leave
  // start date falls in the selected month.
  const viewMonthLabel = monthLabel(viewMonth);
  const isCurrentMonth = viewMonth === currentMonthStr();
  const monthMyRequests = useMemo(
    () => myRequests.filter(r => r.startDate && r.startDate.slice(0, 7) === viewMonth),
    [myRequests, viewMonth],
  );
  const monthTeamRequests = useMemo(
    () => teamRequests.filter(r => r.startDate && r.startDate.slice(0, 7) === viewMonth),
    [teamRequests, viewMonth],
  );

  const remainingQuota = useMemo(() => computeRemainingQuota(leaveQuota, myRequests), [leaveQuota, myRequests]);

  const myPaidOverrideCount = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return myRequests.filter(r => {
      if (!r.bossOverrideToPaid) return false;
      const rs = new Date(r.startDate + 'T00:00:00');
      return rs >= monthStart && rs <= monthEnd;
    }).length;
  }, [myRequests]);

  async function handleSubmit(data) {
    setSaving(true);
    try {
      await submitLeaveV1(data);
      setShowModal(false);
    } catch (e) {
      alert(e.message || 'Failed to submit');
    } finally { setSaving(false); }
  }

  async function handleWithdraw(req) {
    const ok = window.confirm(
      `Withdraw this ${getRequestTitle(req)}?\n\n` +
      `${req.startDate} → ${req.endDate}\n\n` +
      `Your quota will be restored. This cannot be undone.`
    );
    if (!ok) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setActionSaving(true);
    try {
      await withdrawLeave(req.id);
    } catch (e) {
      if (isAlreadyResolvedError(e.message)) {
        // Already withdrawn / decided — quietly succeed.
      } else {
        alert('Failed to withdraw: ' + (e.message || 'unknown error'));
      }
    } finally {
      submittingRef.current = false;
      setActionSaving(false);
    }
  }

  async function handleTeamApprove(forwardToBoss) {
    if (!approveTarget) return;
    if (submittingRef.current) return; // race-proof against double-click
    submittingRef.current = true;
    // DIAGNOSTIC — log exactly what the UI is dispatching so we can
    // correlate click → action when the server returns 'not authorized'
    // or the result lands as something the user didn't expect.
    // eslint-disable-next-line no-console
    console.log('[handleTeamApprove] click', {
      requestId: approveTarget.id,
      forwardToBoss,
      derivedAction: forwardToBoss ? 'forward' : 'approve',
      currentRequesterRole: approveTarget.requesterRole || approveTarget.requester?.role,
      currentLevel: approveTarget.currentLevel,
      currentStatus: approveTarget.status,
    });
    setActionSaving(true);
    try {
      await teamApproveLeave(approveTarget.id, { forwardToBoss });
      setApproveTarget(null);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[handleTeamApprove] failed', { requestId: approveTarget.id, forwardToBoss, error: e });
      if (isAlreadyResolvedError(e.message)) {
        // First click already succeeded; realtime will refresh the
        // list. Close the modal silently instead of scaring the user.
        setApproveTarget(null);
      } else {
        alert('Failed to approve: ' + (e.message || 'unknown'));
      }
    } finally {
      submittingRef.current = false;
      setActionSaving(false);
    }
  }

  async function handleTeamReject(reason) {
    if (!rejectTarget) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setActionSaving(true);
    try {
      await teamRejectLeave(rejectTarget.id, reason);
      setRejectTarget(null);
    } catch (e) {
      if (isAlreadyResolvedError(e.message)) {
        setRejectTarget(null);
      } else {
        alert('Failed to reject: ' + (e.message || 'unknown'));
      }
    } finally {
      submittingRef.current = false;
      setActionSaving(false);
    }
  }

  function applyFilters(list, { statusFilter, searchVal, catFilter, fromDate, toDate, isPendingCheck, pendingStage, requesterRoleFilter }) {
    return list.filter(r => {
      if (statusFilter) {
        if (isPendingCheck && statusFilter === 'pending') {
          if (!r.status.startsWith('pending')) return false;
        } else if (statusFilter === 'pending') {
          if (isOL) {
            if (!r.status.startsWith('pending')) return false;
          } else {
            const ps = isPCTL ? 'pending_pctl' : 'pending_tl';
            if (r.status !== ps) return false;
          }
        } else if (statusFilter === 'approved') {
          if (isOL) {
            if (r.status !== 'approved') return false;
          } else if (r.status !== 'approved' && r.status !== 'pending_boss') return false;
        } else if (statusFilter === 'rejected') {
          if (r.status !== 'rejected') return false;
        }
      }
      if (pendingStage && r.status !== pendingStage) return false;
      if (requesterRoleFilter && r.requesterRole !== requesterRoleFilter) return false;
      if (catFilter && r.category !== catFilter) return false;
      if (fromDate && r.startDate < fromDate) return false;
      if (toDate && r.startDate > toDate) return false;
      if (searchVal) {
        const q = searchVal.toLowerCase();
        const title = getRequestTitle(r).toLowerCase();
        if (!title.includes(q) && !(r.reason || '').toLowerCase().includes(q) &&
            !(r.requesterName || '').toLowerCase().includes(q) && !(r.startDate || '').includes(q)) return false;
      }
      return true;
    });
  }

  // Pending requests must NEVER be hidden behind month navigation — a
  // future-dated request (e.g. submitted in June for July 1st) still needs
  // action now, and the reviewer is on the current month. So when the active
  // status filter is "pending", source from the ALL-MONTHS list; approved /
  // rejected stay month-scoped (browsing history by month is intended).
  const myFiltered = useMemo(() => {
    const base = filterStatus === 'pending' ? myRequests : monthMyRequests;
    return applyFilters(base, { statusFilter: filterStatus, searchVal: search, catFilter: filterCategory, fromDate: dateFrom, toDate: dateTo, isPendingCheck: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthMyRequests, myRequests, filterStatus, search, filterCategory, dateFrom, dateTo]);

  const teamFiltered = useMemo(() => {
    const base = teamFilter === 'pending' ? teamRequests : monthTeamRequests;
    return applyFilters(base, {
      statusFilter: teamFilter, searchVal: teamSearch, catFilter: teamFilterCategory,
      fromDate: teamDateFrom, toDate: teamDateTo, isPendingCheck: false,
      pendingStage: teamPendingStage, requesterRoleFilter: teamRequesterRole,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthTeamRequests, teamRequests, teamFilter, teamSearch, teamFilterCategory, teamDateFrom, teamDateTo, teamPendingStage, teamRequesterRole]);

  // Pending count spans ALL months (a future-dated pending request still
  // needs action); approved/rejected counts stay month-scoped to match the
  // month-navigated history view.
  const myStats = useMemo(() => ({
    total: monthMyRequests.length,
    pending: myRequests.filter(r => r.status.startsWith('pending')).length,
    approved: monthMyRequests.filter(r => r.status === 'approved').length,
    rejected: monthMyRequests.filter(r => r.status === 'rejected').length,
  }), [monthMyRequests, myRequests]);

  // Count only requests waiting at THIS user's level. TL acts on
  // pending_tl; OL acts on pending_ol. Requests already forwarded to
  // Boss (pending_boss) shouldn't inflate the OL's queue badge.
  // Spans all months so a future request shows up in the tab badge.
  const teamPendingCount = useMemo(() => {
    if (isOL)   return teamRequests.filter(r => r.status === 'pending_ol').length;
    if (isPCTL) return teamRequests.filter(r => r.status === 'pending_pctl').length;
    return teamRequests.filter(r => r.status === 'pending_tl').length;
  }, [teamRequests, isOL, isPCTL]);

  function renderRequestCard(r, showActions = false) {
    const catCfg = getCatCfg(r.category);
    const stCfg = getStCfg(r.status);
    const title = getRequestTitle(r);
    const days = countDays(r.startDate, r.endDate);
    // Same breakdown the new-request form preview shows. Tells the
    // approver at a glance how many of the calendar days are weekend /
    // holiday vs. actual leave being granted.
    const overlapping = (companyHolidays || []).filter((h) =>
      h.startDate && h.endDate && r.startDate && r.endDate
      && h.startDate <= r.endDate && h.endDate >= r.startDate,
    );
    const breakdown = analyzeLeaveRange(r.startDate, r.endDate, overlapping);
    const hasReduction = breakdown.weekendDays > 0 || breakdown.holidayDays > 0;

    return (
      <div key={r.id} className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: `4px solid ${catCfg.color}` }}>
        <div className="card-body p-3">
          <div className="d-flex align-items-start justify-content-between">
            <div className="d-flex gap-3 flex-grow-1">
              {showActions && (
                <div className="rounded-circle d-flex align-items-center justify-content-center fw-semibold text-white flex-shrink-0"
                  style={{ width: 36, height: 36, background: 'linear-gradient(135deg,#3b82f6,#1d4ed8)', fontSize: '0.6rem' }}>
                  {(r.requesterName || '?').slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="flex-grow-1">
                <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
                  {showActions && <span className="fw-semibold small">{r.requesterName}</span>}
                  <div className="d-flex align-items-center gap-1">
                    <div className="rounded-2 d-inline-flex align-items-center justify-content-center" style={{ width: 22, height: 22, background: catCfg.bg }}>
                      <i className={`bi ${catCfg.icon}`} style={{ fontSize: '0.65rem', color: catCfg.color }} />
                    </div>
                    <span className="fw-medium small">{title}</span>
                  </div>
                  {r.bossOverrideToPaid ? (
                    // Boss-overridden = effectively paid. Suppress
                    // the Unpaid badge to avoid contradicting the
                    // "Boss Override to Paid" pill rendered elsewhere.
                    <span className="badge" style={{ background: 'var(--info-soft)', color: 'var(--info)', fontSize: '0.58rem' }}>Paid · Boss Override</span>
                  ) : (
                    <>
                      {r.unpaidDays > 0 && r.paidDays > 0 && (
                        <span className="badge bg-warning text-dark" style={{ fontSize: '0.58rem' }}>{r.paidDays}d paid · {r.unpaidDays}d unpaid</span>
                      )}
                      {r.unpaidDays > 0 && (!r.paidDays || r.paidDays === 0) && (
                        <span className="badge bg-warning text-dark" style={{ fontSize: '0.58rem' }}>Unpaid ({r.unpaidDays}d)</span>
                      )}
                    </>
                  )}
                </div>
                <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                  <i className="bi bi-calendar3 me-1" />{r.startDate} — {r.endDate} · {days} day{days > 1 ? 's' : ''}
                </div>
                {hasReduction && (
                  <div
                    className="d-inline-flex flex-wrap align-items-center gap-1 mt-1 rounded-2 px-2 py-1"
                    style={{ background: 'var(--surface-0)', border: '1px solid var(--border-subtle)', fontSize: '0.66rem', color: 'var(--text-secondary)' }}
                  >
                    <span>
                      <strong style={{ color: 'var(--text-primary)' }}>{breakdown.actualDays}</strong> actual
                    </span>
                    {breakdown.weekendDays > 0 && (
                      <>
                        <span style={{ color: 'var(--text-muted)' }}>·</span>
                        <span>
                          <strong>{breakdown.weekendDays}</strong> weekend
                        </span>
                      </>
                    )}
                    {breakdown.holidayDays > 0 && (
                      <>
                        <span style={{ color: 'var(--text-muted)' }}>·</span>
                        <span style={{ color: 'var(--purple)' }}>
                          <strong>{breakdown.holidayDays}</strong> holiday
                          {breakdown.holidayLabels.length > 0 && (
                            <span style={{ marginLeft: 3, opacity: 0.8 }}>
                              ({breakdown.holidayLabels.join(', ')})
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </div>
                )}
                <p className="text-muted small mb-1 mt-1">{r.reason}</p>

                {/* Approval audit trail — shows TL/OL stage and Boss stage,
                    each with approver name + decision timestamp. Both are
                    rendered when the request was forwarded through both
                    stages (TL → Boss); single stage requests show one pill. */}
                {r.intermediateApproval && (() => {
                  const it = r.intermediateApproval;
                  const isApproved  = it.status === 'approved';
                  const isForwarded = it.status === 'forwarded' || it.forwardToBoss;
                  const isPositive  = isApproved || isForwarded;
                  // Defensive: stale 'rejected' on a pending request — hide.
                  if (!isPositive && r.status?.startsWith('pending')) return null;
                  const when = formatDateTime(it.resolvedAt);

                  // Audience-aware label:
                  //   Forwarded:
                  //     * Boss (the recipient) → "Forwarded by [forwarder]"
                  //                              (Boss needs to know who acted)
                  //     * everyone else        → "Forwarded to [Boss name]"
                  //                              (the relevant fact is who's
                  //                              sitting on the decision now —
                  //                              the forwarder is incidental)
                  //   Approved/Rejected:
                  //     * always "Approved/Rejected by [approver]" — these
                  //       are final decisions; the actor is the point.
                  let label;
                  if (isForwarded) {
                    if (isBoss) {
                      label = `Forwarded by ${it.approverName}`;
                    } else {
                      label = `Forwarded to ${bossInfo?.display_name || 'Boss'}`;
                    }
                  } else if (isApproved) {
                    label = `Approved by ${it.approverName}`;
                  } else {
                    label = `Rejected by ${it.approverName}`;
                  }
                  return (
                    <div className="mt-1 d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                      style={{ background: isPositive ? 'var(--success-soft)' : 'var(--danger-soft)', fontSize: '0.65rem', fontWeight: 500 }}>
                      <i className={`bi ${isPositive ? 'bi-check-circle text-success' : 'bi-x-circle text-danger'}`} style={{ fontSize: '0.58rem' }} />
                      {label}
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
                    <div className="mt-1 d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                      style={{ background: isApproved ? 'var(--success-soft)' : 'var(--danger-soft)', fontSize: '0.65rem', fontWeight: 500, marginLeft: 4 }}>
                      <i className={`bi ${isApproved ? 'bi-shield-check text-success' : 'bi-x-circle text-danger'}`} style={{ fontSize: '0.58rem' }} />
                      Boss: {verb}{ba.approverName ? ` by ${ba.approverName}` : ''}
                      {when && <span style={{ opacity: 0.7, marginLeft: 4 }}>· {when}</span>}
                    </div>
                  );
                })()}

                {r.status === 'rejected' && r.intermediateApproval?.rejectReason && (
                  <div className="mt-2 rounded-2 p-2" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
                    <span className="small fw-semibold text-danger"><i className="bi bi-x-circle me-1" />Rejection:</span>
                    <span className="small text-muted ms-1">{r.intermediateApproval.rejectReason}</span>
                  </div>
                )}
                {r.status === 'rejected' && r.bossApproval?.rejectReason && (
                  <div className="mt-2 rounded-2 p-2" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
                    <span className="small fw-semibold text-danger"><i className="bi bi-x-circle me-1" />Boss Rejection:</span>
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
              {showActions && (
                // Only show Approve/Reject when it's actually THIS user's
                // turn in the chain. TL acts on pending_tl; OL acts on
                // pending_ol. Anything past their level (pending_boss /
                // approved / rejected) hides the buttons — which is why
                // the OL was previously able to click Approve on requests
                // already forwarded to Boss and get "not authorized".
                (isTL && r.status === 'pending_tl') ||
                (isPCTL && r.status === 'pending_pctl') ||
                (isOL && r.status === 'pending_ol')
              ) && (
                <div className="d-flex gap-1">
                  <button className="btn btn-sm btn-outline-success d-inline-flex align-items-center gap-1 px-2"
                    style={{ fontSize: '0.7rem', borderRadius: 6 }} onClick={() => setApproveTarget(r)}>
                    <i className="bi bi-check" /> Approve
                  </button>
                  <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 px-2"
                    style={{ fontSize: '0.7rem', borderRadius: 6 }} onClick={() => setRejectTarget(r)}>
                    <i className="bi bi-x" /> Reject
                  </button>
                </div>
              )}
              {!showActions && (r.status?.startsWith('pending') || r.status === 'rejected') && (
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 px-2"
                  style={{ fontSize: '0.7rem', borderRadius: 6 }}
                  onClick={() => handleWithdraw(r)} disabled={actionSaving}
                  title="Withdraw this request and restore your quota">
                  <i className="bi bi-arrow-counterclockwise" /> Withdraw
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-file-earmark-text" style={{ fontSize: '1.15rem' }} />
            Requests
          </h5>
          <p className="text-muted small mb-0">Submit and manage leave, WFH, and other requests</p>
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <MonthNavigator
            label={viewMonthLabel}
            isCurrent={isCurrentMonth}
            onPrev={() => setViewMonth(m => stepMonthStr(m, -1))}
            onNext={() => setViewMonth(m => stepMonthStr(m, 1))}
            onReset={() => setViewMonth(currentMonthStr())}
          />
          <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.8rem' }} onClick={() => setShowModal(true)}>
            <i className="bi bi-plus-lg" style={{ fontSize: '0.72rem' }} /> New Request
          </button>
        </div>
      </div>

      {canReviewTeam && (
        <div className="d-flex gap-2 mb-4">
          <button className={`btn btn-sm ${activeTab === 'my' ? 'btn-dark' : 'btn-outline-secondary'}`}
            style={{ borderRadius: 8, fontSize: '0.8rem' }} onClick={() => setActiveTab('my')}>
            My Requests
          </button>
          <button className={`btn btn-sm ${activeTab === 'team' ? 'btn-dark' : 'btn-outline-secondary'} d-inline-flex align-items-center gap-1`}
            style={{ borderRadius: 8, fontSize: '0.8rem' }} onClick={() => setActiveTab('team')}>
            {isOL ? 'All Requests' : 'Team Requests'}
            {teamPendingCount > 0 && <span className="badge bg-warning text-dark rounded-pill" style={{ fontSize: '0.62rem' }}>{teamPendingCount}</span>}
          </button>
        </div>
      )}

      {activeTab === 'my' && (
        <>
          {remainingQuota && (
            <div className="d-flex flex-wrap gap-2 mb-4">
              {[
                { label: 'Medical',   value: remainingQuota.medical,   total: leaveQuota?.medical   ?? 1, color: 'var(--danger)' },
                { label: 'Emergency', value: remainingQuota.emergency, total: leaveQuota?.emergency ?? 1, color: 'var(--warning)' },
                { label: 'WFH',       value: remainingQuota.wfh,       total: leaveQuota?.wfh       ?? 2, color: 'var(--info)' },
              ].map(q => (
                <div key={q.label} className="rounded-2 px-3 py-2" style={{ background: `color-mix(in srgb, ${q.color} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${q.color} 22%, transparent)` }}>
                  <div style={{ fontSize: '0.62rem', color: q.color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{q.label}</div>
                  <div className="d-flex align-items-baseline gap-1">
                    <span className="fw-bold" style={{ fontSize: '1.05rem', color: q.color }}>{q.value}</span>
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>/ {q.total} mo.</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && (
            <div className="d-flex flex-wrap gap-2 mb-3">
              {[
                { label: 'All',      value: '',         count: myStats.total,    color: 'var(--accent)', activeText: 'var(--on-accent)', bg: 'var(--surface-2)', border: 'var(--border-subtle)' },
                { label: 'Pending',  value: 'pending',  count: myStats.pending,  color: 'var(--warning)', activeText: '#fff', bg: 'var(--warning-soft)', border: 'color-mix(in srgb, var(--warning) 35%, transparent)' },
                { label: 'Approved', value: 'approved', count: myStats.approved, color: 'var(--success)', activeText: '#fff', bg: 'var(--success-soft)', border: 'color-mix(in srgb, var(--success) 35%, transparent)' },
                { label: 'Rejected', value: 'rejected', count: myStats.rejected, color: 'var(--danger)', activeText: '#fff', bg: 'var(--danger-soft)', border: 'color-mix(in srgb, var(--danger) 35%, transparent)' },
              ].map(s => (
                <div key={s.label} className="d-flex align-items-center gap-2 px-3 py-2 rounded-2"
                  style={{ background: filterStatus === s.value ? s.color : s.bg, border: `1px solid ${filterStatus === s.value ? s.color : s.border}`, cursor: 'pointer', transition: 'all 0.15s' }}
                  onClick={() => setFilterStatus(filterStatus === s.value ? '' : s.value)}>
                  <span className="fw-bold" style={{ color: filterStatus === s.value ? s.activeText : s.color, fontSize: '1.05rem', lineHeight: 1 }}>{s.count}</span>
                  <span style={{ fontSize: '0.7rem', color: filterStatus === s.value ? s.activeText : s.color, opacity: 0.75, fontWeight: 500 }}>{s.label}</span>
                </div>
              ))}
            </div>
          )}

          {!loading && myRequests.length > 0 && (
            <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
              <div className="card-body p-3">
                <div className="d-flex flex-wrap gap-2 align-items-center">
                  <div className="position-relative" style={{ flex: '1 1 180px', minWidth: 160 }}>
                    <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
                    <input type="text" className="form-control form-control-sm" placeholder="Search requests…"
                      style={{ paddingLeft: 30, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
                  </div>
                  <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 140 }}
                    value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
                    <option value="">All Categories</option>
                    {REQUEST_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <div className="d-flex align-items-center gap-1">
                    <span className="text-muted" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>From</span>
                    <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8, width: 'auto' }}
                      value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                  </div>
                  <div className="d-flex align-items-center gap-1">
                    <span className="text-muted" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>To</span>
                    <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8, width: 'auto' }}
                      value={dateTo} onChange={e => setDateTo(e.target.value)} />
                  </div>
                  {(search || filterCategory || dateFrom || dateTo) && (
                    <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                      style={{ borderRadius: 8, fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                      onClick={() => { setSearch(''); setFilterCategory(''); setDateFrom(''); setDateTo(''); }}>
                      <i className="bi bi-x-circle" /> Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
          ) : myFiltered.length === 0 ? (
            <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 16, background: 'var(--surface-1)' }}>
              <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
                <i className="bi bi-file-earmark-text text-muted" style={{ fontSize: '1.6rem', opacity: 0.55 }} />
              </div>
              <p className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{filterStatus === 'pending' ? 'No pending requests' : (filterStatus || search || filterCategory || dateFrom || dateTo) ? 'No matching requests' : `No requests for ${viewMonthLabel}`}</p>
              <p className="text-muted small mb-0">{filterStatus === 'pending' ? "You're all caught up." : (filterStatus || search || filterCategory || dateFrom || dateTo) ? 'Try adjusting your filters.' : 'Try another month, or submit a new request.'}</p>
            </div>
          ) : (
            <div className="d-flex flex-column gap-3">{myFiltered.map(r => renderRequestCard(r, false))}</div>
          )}
        </>
      )}

      {activeTab === 'team' && canReviewTeam && (
        <>
          <div className="d-flex gap-2 mb-3">
            {['pending', 'approved', 'rejected'].map(t => (
              <button key={t} className={`btn btn-sm ${teamFilter === t ? 'btn-dark' : 'btn-outline-secondary'}`}
                style={{ borderRadius: 8, fontSize: '0.78rem', textTransform: 'capitalize' }} onClick={() => setTeamFilter(t)}>
                {t}
              </button>
            ))}
          </div>

          {/* Pending spans all months so future-dated requests (e.g. a July
              request reviewed in June) are never hidden by the month navigator. */}
          {teamFilter === 'pending' && (
            <div className="d-flex align-items-center gap-2 mb-3 rounded-2 px-3 py-2"
              style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 30%, transparent)', fontSize: '0.74rem', color: 'var(--info)' }}>
              <i className="bi bi-info-circle" />
              <span>Showing all pending requests across every month — including future-dated ones — so nothing waiting on you is hidden.</span>
            </div>
          )}

          {!loading && teamRequests.length > 0 && (
            <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
              <div className="card-body p-3">
                <div className="d-flex flex-wrap gap-2 align-items-center">
                  <div className="position-relative" style={{ flex: '1 1 180px', minWidth: 160 }}>
                    <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
                    <input type="text" className="form-control form-control-sm" placeholder="Search by name, reason…"
                      style={{ paddingLeft: 30, borderRadius: 8 }} value={teamSearch} onChange={e => setTeamSearch(e.target.value)} />
                  </div>
                  <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 140 }}
                    value={teamFilterCategory} onChange={e => setTeamFilterCategory(e.target.value)}>
                    <option value="">All Categories</option>
                    {REQUEST_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  {isOL && (
                    <>
                      <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 150 }}
                        value={teamPendingStage} onChange={e => setTeamPendingStage(e.target.value)}
                        title="Filter by pending stage">
                        <option value="">All Stages</option>
                        <option value="pending_tl">Pending TL</option>
                        <option value="pending_ol">Pending OL</option>
                        <option value="pending_boss">Pending Boss</option>
                      </select>
                      <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 140 }}
                        value={teamRequesterRole} onChange={e => setTeamRequesterRole(e.target.value)}
                        title="Filter by requester role">
                        <option value="">All Roles</option>
                        <option value="apc">APC</option>
                        <option value="ipc">IPC</option>
                        <option value="tl">TL</option>
                        <option value="pctl">PCTL</option>
                      </select>
                    </>
                  )}
                  <div className="d-flex align-items-center gap-1">
                    <span className="text-muted" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>From</span>
                    <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8, width: 'auto' }}
                      value={teamDateFrom} onChange={e => setTeamDateFrom(e.target.value)} />
                  </div>
                  <div className="d-flex align-items-center gap-1">
                    <span className="text-muted" style={{ fontSize: '0.72rem', whiteSpace: 'nowrap' }}>To</span>
                    <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8, width: 'auto' }}
                      value={teamDateTo} onChange={e => setTeamDateTo(e.target.value)} />
                  </div>
                  {(teamSearch || teamFilterCategory || teamDateFrom || teamDateTo || teamPendingStage || teamRequesterRole) && (
                    <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                      style={{ borderRadius: 8, fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                      onClick={() => { setTeamSearch(''); setTeamFilterCategory(''); setTeamDateFrom(''); setTeamDateTo(''); setTeamPendingStage(''); setTeamRequesterRole(''); }}>
                      <i className="bi bi-x-circle" /> Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
          ) : teamFiltered.length === 0 ? (
            <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 16, background: 'var(--surface-1)' }}>
              <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
                <i className="bi bi-file-earmark-text text-muted" style={{ fontSize: '1.6rem', opacity: 0.35 }} />
              </div>
              <p className="fw-semibold text-dark mb-1">
                {teamFilter === 'pending' ? 'No pending team requests' : `No ${teamFilter} team requests for ${viewMonthLabel}`}
              </p>
              <p className="text-muted small mb-0">{(teamSearch || teamFilterCategory || teamDateFrom || teamDateTo) ? 'Try adjusting your filters.' : teamFilter === 'pending' ? "You're all caught up." : 'Try another month from the navigator above.'}</p>
            </div>
          ) : (
            <div className="d-flex flex-column gap-3">{teamFiltered.map(r => renderRequestCard(r, true))}</div>
          )}
        </>
      )}

      {showModal && <NewRequestModal onClose={() => setShowModal(false)} onSubmit={handleSubmit} saving={saving} remainingQuota={remainingQuota} paidOverrideCount={myPaidOverrideCount} />}
      <ApproveTeamModal request={approveTarget} onConfirm={handleTeamApprove} onCancel={() => setApproveTarget(null)} saving={actionSaving} approverRole={userRole} />
      <RejectTeamModal request={rejectTarget} onConfirm={handleTeamReject} onCancel={() => setRejectTarget(null)} saving={actionSaving} />
    </div>
  );
}
