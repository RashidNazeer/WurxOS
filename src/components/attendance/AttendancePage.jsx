import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import ClockWidget from './ClockWidget';
import {
  onTeamToday, onAllToday, onPendingApprovals, onActiveRecord,
  onPendingEditClockOutRequests,
  getTeamAndSelfHistory, getAllHistory, getUserHistory,
  approveClockOut, rejectClockOut,
  approveEditClockIn, rejectEditClockIn,
  approveEditClockOut, rejectEditClockOut,
  calcTimes, fmtDuration, fmtTime, exportToCSV,
  getEffectiveStatus, forceCloseSession,
  getAdjustmentsForMonth, createAttendanceAdjustment,
  updateAttendanceAdjustment, deleteAttendanceAdjustment,
  computeMonthlyDays, missedWeekdayDatesFor, bulkMarkMissedAsPresent,
  // v2-only helpers replacing v1's inline Firestore reads:
  listApprovedLeaveDatesForMonth, fetchRosterMonth,
  listExpectedMembers, getLeaveQuotaDefault, setLeaveQuotaDefault,
  scanLeaveQuotaConflicts,
  expandLeaveWeekdays,
} from '../../lib/attendanceApi';
import { listHolidayDatesForMonth } from '../../lib/holidaysApi';

const ROLE_OPTIONS = [
  { key: 'tl',   label: 'Team Lead' },
  { key: 'pctl', label: 'Paid Collab TL' },
  { key: 'ol',   label: 'Operation Lead' },
  { key: 'apc',  label: 'APC' },
  { key: 'ipc',  label: 'IPC' },
];

/**
 * Build a multi-line tooltip showing each break's start → end + duration.
 * Used as the `title` attribute on the team-today break cell so OL/TL/Boss
 * can hover to see when each break was taken. (v1 commit d0906fe)
 */
function breaksTooltip(breaks) {
  if (!Array.isArray(breaks) || breaks.length === 0) return '';
  return breaks.map((b, i) => {
    const start = b.start ? fmtTime(b.start) : '?';
    const end   = b.end   ? fmtTime(b.end)   : 'ongoing';
    const dur = b.start && b.end
      ? fmtDuration((b.end.toMillis ? b.end.toMillis() : new Date(b.end).getTime())
                    - (b.start.toMillis ? b.start.toMillis() : new Date(b.start).getTime()))
      : '—';
    return `Break ${i + 1}: ${start} → ${end}  (${dur})`;
  }).join('\n');
}

/**
 * BreakDetailsModal — opens when OL/TL/Boss clicks the break cell on the
 * team-today table. Shows a row per break with start, end, duration, and
 * the total. (v1 commit d0906fe)
 */
function BreakDetailsModal({ record, onClose }) {
  if (!record) return null;
  const breaks = record.breaks || [];
  const total = breaks.reduce((sum, b) => {
    if (!b.start) return sum;
    const a = b.start.toMillis ? b.start.toMillis() : new Date(b.start).getTime();
    const z = b.end ? (b.end.toMillis ? b.end.toMillis() : new Date(b.end).getTime()) : Date.now();
    return sum + Math.max(0, z - a);
  }, 0);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 14 }}>
        <div className="card-header bg-white border-0 pt-4 pb-2 px-4 d-flex align-items-center justify-content-between" style={{ borderRadius: '14px 14px 0 0' }}>
          <div>
            <h6 className="fw-bold mb-0">
              <i className="bi bi-cup-hot-fill me-2" style={{ color: '#f59e0b' }} />
              Break details
            </h6>
            <p className="text-muted small mb-0">{record.userName} · {record.date}</p>
          </div>
          <button className="btn btn-sm btn-light border-0 px-2" onClick={onClose}><i className="bi bi-x-lg" /></button>
        </div>
        <div className="card-body px-4 pb-4 pt-2">
          {breaks.length === 0 ? (
            <div className="text-center py-3 text-muted small">No breaks taken.</div>
          ) : (
            <>
              <table className="table table-sm align-middle mb-3">
                <thead>
                  <tr style={{ fontSize: '0.7rem', color: '#64748b' }}>
                    <th className="border-0 ps-0">#</th>
                    <th className="border-0">Start</th>
                    <th className="border-0">End</th>
                    <th className="border-0 text-end pe-0">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {breaks.map((b, i) => {
                    const ongoing = !b.end;
                    const start = b.start ? fmtTime(b.start) : '—';
                    const end = b.end ? fmtTime(b.end) : <span className="text-warning fw-semibold">Ongoing</span>;
                    const dur = b.start
                      ? fmtDuration(((b.end?.toMillis ? b.end.toMillis() : (b.end ? new Date(b.end).getTime() : Date.now()))
                                    - (b.start.toMillis ? b.start.toMillis() : new Date(b.start).getTime())))
                      : '—';
                    return (
                      <tr key={i} style={ongoing ? { background: '#fffbeb' } : undefined}>
                        <td className="ps-0 fw-semibold text-muted small">{i + 1}</td>
                        <td className="small fw-medium">{start}</td>
                        <td className="small fw-medium">{end}</td>
                        <td className="text-end pe-0 fw-semibold small" style={{ color: ongoing ? '#d97706' : '#0f172a' }}>{dur}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="d-flex justify-content-between align-items-center rounded-3 px-3 py-2"
                style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
                <span className="small fw-semibold" style={{ color: '#92400e' }}>
                  <i className="bi bi-cup-hot me-1" />Total break time
                </span>
                <span className="fw-bold" style={{ color: '#92400e' }}>{fmtDuration(total)}</span>
              </div>
            </>
          )}
          <div className="d-flex justify-content-end mt-3">
            <button className="btn btn-sm btn-dark px-3" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Personal monthly attendance summary ────────────────────────────────────
function MyMonthlyAttendance({ userId, displayName }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth(); // 0-based
        const monthStart = new Date(year, month, 1);
        const monthEnd   = new Date(year, month + 1, 0);
        const pad = n => String(n).padStart(2, '0');
        const startStr = `${year}-${pad(month + 1)}-01`;
        const endStr   = `${year}-${pad(month + 1)}-${pad(monthEnd.getDate())}`;

        // Days elapsed in the month — this is the denominator.
        // Current month: today (inclusive). Past month: full month.
        // Using elapsed days (not the full month) prevents the score
        // from claiming credit for tomorrow's weekend / a future
        // holiday / a future approved-leave day before they happen.
        const isCurrentMonth = (now.getFullYear() === year && now.getMonth() === month);
        const cutoffDate = isCurrentMonth ? new Date(year, month, now.getDate()) : monthEnd;
        const cutoffYmd  = `${cutoffDate.getFullYear()}-${pad(cutoffDate.getMonth() + 1)}-${pad(cutoffDate.getDate())}`;
        const workingDays = cutoffDate.getDate();
        // Past-only weekend set — only Sat/Sun dates that have
        // already elapsed get the auto-credit.
        const weekendDates = new Set();
        for (let d = new Date(monthStart); d <= cutoffDate; d.setDate(d.getDate() + 1)) {
          const dow = d.getDay();
          if (dow === 0 || dow === 6) {
            weekendDates.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
          }
        }

        // Attendance for this user
        const history = await getUserHistory(userId, startStr, endStr);
        const presentDates = new Set();
        let totalWorkMs = 0;
        history.forEach(r => {
          if (r.clockIn) presentDates.add(r.date);
          totalWorkMs += calcTimes(r).totalWorkMs || 0;
        });

        // Manager-applied manual adjustments (source-of-truth for the
        // displayed Days count) for this month.
        const monthStrKey = `${year}-${pad(month + 1)}`;
        let adjustments = [];
        try {
          adjustments = (await getAdjustmentsForMonth(monthStrKey)).filter(a => a.userId === userId);
        } catch { /* non-fatal — fall back to actual */ }

        // Company holidays in the month — clipped to past so a
        // future holiday doesn't pre-credit the score today.
        let holidaySetAll = new Set();
        try { holidaySetAll = await listHolidayDatesForMonth(monthStrKey); }
        catch { /* non-fatal */ }
        const holidaySet = new Set([...holidaySetAll].filter(d => d <= cutoffYmd));

        // Approved leaves overlapping this month, expanded day-by-
        // day (Mon-Fri only). WFH is excluded (remote work is not
        // an absence); holidays are excluded so they don't double-
        // count against the separate holiday tally. Past-only too.
        let leaveDatesAll = new Set();
        try {
          leaveDatesAll = await listApprovedLeaveDatesForMonth(userId, monthStrKey, { holidaySet: holidaySetAll });
        } catch { /* non-fatal */ }
        const leaveDates = new Set([...leaveDatesAll].filter(d => d <= cutoffYmd));

        // Effective present days = union of actual present dates and any
        // dates manually marked by Boss/OL. Same math as the Roster tab.
        const effectiveSet = new Set(presentDates);
        adjustments.forEach(a => { if (a.date) effectiveSet.add(a.date); });
        const effectivePresent = effectiveSet.size;

        // A day is "covered" if the user clocked in, was on approved
        // leave, it was a company holiday, OR it was a weekend.
        // Set-union (not a sum) so a day that falls into more than
        // one bucket is counted once. This matches the Performance
        // attendance score so the two views never disagree.
        const accountedDates = new Set([
          ...effectiveSet, ...leaveDates, ...holidaySet, ...weekendDates,
        ]);
        // "Missed" = past days that aren't covered — weekends and
        // holidays are always covered so a missed day can only be a
        // weekday the user was expected to clock in on and didn't.
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let missed = 0;
        for (let d = new Date(monthStart); d <= monthEnd && d < today; d.setDate(d.getDate() + 1)) {
          const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
          if (!accountedDates.has(ds)) missed++;
        }

        if (!cancelled) {
          setStats({
            workingDays,
            presentDays: effectivePresent,
            actualPresentDays: presentDates.size,
            hasOverride: adjustments.length > 0,
            leaveDays: leaveDates.size,
            holidayDays: holidaySet.size,
            weekendDays: weekendDates.size,
            accountedDays: accountedDates.size,
            missedDays: missed,
            totalWorkMs,
            monthLabel: now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
          });
          setLoading(false);
        }
      } catch (e) {
        console.warn('MyMonthlyAttendance load error:', e);
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading || !stats) {
    return (
      <div className="rounded-3 mb-3 p-3 d-flex align-items-center gap-2 text-muted"
        style={{ background: '#fff', border: '1px solid #e2e8f0', fontSize: '0.82rem' }}>
        <span className="spinner-border spinner-border-sm" /> Loading your monthly attendance…
      </div>
    );
  }

  const pct = stats.workingDays > 0 ? Math.round((stats.accountedDays / stats.workingDays) * 100) : 0;
  const hrsTotal = Math.floor(stats.totalWorkMs / 3600000);
  const minsTotal = Math.floor((stats.totalWorkMs % 3600000) / 60000);

  return (
    <div className="rounded-3 mb-3 p-3" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#0f172a' }}>
            My attendance · {stats.monthLabel}
          </div>
          <div className="text-muted" style={{ fontSize: '0.72rem' }}>
            {displayName ? displayName + ' · ' : ''}{stats.workingDays} days this month
            {stats.weekendDays > 0 && <> · {stats.weekendDays} weekend{stats.weekendDays === 1 ? '' : ' days'}</>}
            {stats.holidayDays > 0 && <> · {stats.holidayDays} company holiday{stats.holidayDays === 1 ? '' : 's'}</>}
          </div>
        </div>
        <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
          style={{ background: pct >= 80 ? '#f0fdf4' : pct >= 50 ? '#fff7ed' : '#fef2f2',
                   color:      pct >= 80 ? '#15803d' : pct >= 50 ? '#c2410c' : '#dc2626',
                   fontSize: '0.78rem', fontWeight: 700 }}>
          <i className="bi bi-check2-circle" /> {stats.accountedDays} / {stats.workingDays} days · {pct}%
        </span>
      </div>

      <div className="row g-2 mb-2">
        <MyAttTile dot="#16a34a" label="Days present"
          value={stats.presentDays}
          sub={stats.hasOverride && stats.actualPresentDays !== stats.presentDays
            ? `actual ${stats.actualPresentDays} · manager-adjusted`
            : 'clocked in'} />
        <MyAttTile dot="#3b82f6" label="Days on leave" value={stats.leaveDays}    sub="approved" />
        <MyAttTile dot="#dc2626" label="Days missed"   value={stats.missedDays}   sub="past weekdays not covered" />
        <MyAttTile dot="#0f172a" label="Hours worked"  value={`${hrsTotal}h ${minsTotal}m`} sub="this month" prominent />
      </div>

      {/* Stacked progress bar */}
      <div className="rounded-pill d-flex overflow-hidden" style={{ height: 10, background: '#f1f5f9' }}>
        {stats.presentDays > 0 && (
          <div title={`Present: ${stats.presentDays} days`}
            style={{ width: `${(stats.presentDays / stats.workingDays) * 100}%`, background: '#16a34a' }} />
        )}
        {(() => {
          // Leave + holidays that aren't already covered by a clock-in.
          const onlyOff = Math.max(0, stats.accountedDays - stats.presentDays);
          if (onlyOff === 0) return null;
          const label = stats.holidayDays > 0
            ? `Approved leave + company holidays: ${onlyOff} days`
            : `Approved leave: ${onlyOff} days`;
          return (
            <div title={label}
              style={{ width: `${(onlyOff / stats.workingDays) * 100}%`, background: '#3b82f6' }} />
          );
        })()}
      </div>
    </div>
  );
}

function MyAttTile({ dot, label, value, sub, prominent }) {
  return (
    <div className="col-6 col-lg-3">
      <div className="rounded-3 h-100 p-3" style={{
        background: prominent ? '#0f172a' : '#f8fafc',
        border: prominent ? '1px solid #0f172a' : '1px solid #e2e8f0',
        color: prominent ? '#fff' : '#0f172a',
      }}>
        <div className="d-flex align-items-center gap-2"
          style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                   color: prominent ? 'rgba(255,255,255,0.7)' : '#64748b' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
          {label}
        </div>
        <div className="fw-bold" style={{ fontSize: '1.1rem', letterSpacing: '-0.01em', lineHeight: 1.15, marginTop: 6 }}>{value}</div>
        {sub && <div style={{ fontSize: '0.7rem', marginTop: 2, color: prominent ? 'rgba(255,255,255,0.6)' : '#64748b' }}>{sub}</div>}
      </div>
    </div>
  );
}

function DayLegend({ color, label }) {
  return (
    <span className="d-inline-flex align-items-center gap-1" style={{ color: '#475569' }}>
      <span className="rounded-1" style={{ width: 9, height: 9, background: color, border: `1px solid ${color}` }} />
      {label}
    </span>
  );
}

function statusColor(s) {
  if (s === 'clocked-in') return '#16a34a';
  if (s === 'on-break') return '#f59e0b';
  if (s === 'pending-approval') return '#3b82f6';
  if (s === 'auto-closed') return '#dc2626';
  return '#94a3b8';
}

function statusLabel(s) {
  if (s === 'clocked-in') return 'Working';
  if (s === 'on-break') return 'On Break';
  if (s === 'pending-approval') return 'Pending';
  if (s === 'clocked-out') return 'Done';
  if (s === 'auto-closed') return 'Auto-closed';
  return '—';
}

// Format a YYYY-MM-DD date string from a Firestore Timestamp / Date / millis
function dateStrOf(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Render a Firestore time as "9:25 AM" with the calendar date always shown
// underneath ("May 1") so every row in the history table looks consistent and
// cross-midnight night shifts are unambiguous. The date turns red when it
// differs from the row's date (i.e. clock-out crossed into the next day).
function TimeWithDate({ ts, rowDate }) {
  if (!ts) return <>—</>;
  const ds = dateStrOf(ts);
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const monthDay = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const sameDay = !rowDate || !ds || ds === rowDate;
  return (
    <>
      {fmtTime(ts)}
      <div style={{ fontSize: '0.62rem', fontWeight: 600, color: sameDay ? '#94a3b8' : '#dc2626' }}>
        {sameDay ? monthDay : <><i className="bi bi-arrow-right-short" />{monthDay}</>}
      </div>
    </>
  );
}

function locLabel(l) {
  if (l === 'wfh') return 'WFH';
  if (l === 'bahria') return 'Bahria';
  if (l === 'lakecity') return 'Lake City';
  return l || '—';
}

function getMonthRange(monthStr) {
  // monthStr = "YYYY-MM"
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

/* ── Approval Modal ──────────────────────────────────────────────────────── */
function ApprovalModal({ record, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState('');
  const { user } = useAuth();
  const approverId = user?.id;

  async function handleApprove() {
    setSaving('approve');
    try { await approveClockOut(record.id, approverId); onDone(); }
    finally { setSaving(''); }
  }
  async function handleReject() {
    setSaving('reject');
    try { await rejectClockOut(record.id, approverId, reason); onDone(); }
    finally { setSaving(''); }
  }

  const times = calcTimes(record);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 16 }}>
        <div className="card-body p-4">
          <h6 className="fw-bold mb-3"><i className="bi bi-clock-history me-2 text-primary" />Clock-Out Request</h6>

          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
            <div className="d-flex align-items-center gap-2 mb-2">
              <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white"
                style={{ width: 36, height: 36, background: '#3b82f6', fontSize: '0.65rem' }}>
                {(record.userName || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="fw-semibold" style={{ fontSize: '0.88rem' }}>{record.userName}</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>{record.userRole?.toUpperCase()} · {locLabel(record.location)}</div>
              </div>
            </div>
            <div className="d-flex gap-3" style={{ fontSize: '0.75rem' }}>
              <span><strong>Clock in:</strong> {fmtTime(record.clockIn)}</span>
              <span><strong>Worked:</strong> {fmtDuration(times.totalWorkMs)}</span>
              <span><strong>Breaks:</strong> {fmtDuration(times.totalBreakMs)}</span>
            </div>
          </div>

          {record.clockOutNote && (
            <div className="rounded-3 p-3 mb-3" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
              <div className="fw-semibold small mb-1" style={{ color: '#2563eb' }}>Work Summary</div>
              <p className="mb-0" style={{ fontSize: '0.82rem', color: '#1e40af' }}>{record.clockOutNote}</p>
            </div>
          )}

          <div className="mb-3">
            <label className="form-label small fw-semibold">Rejection reason (optional)</label>
            <input type="text" className="form-control form-control-sm" placeholder="e.g. Tasks not completed..."
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
            <button className="btn btn-sm btn-outline-danger px-3 d-inline-flex align-items-center gap-1" onClick={handleReject} disabled={!!saving}>
              {saving === 'reject' ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-x-lg" />}Reject
            </button>
            <button className="btn btn-sm btn-success px-4 d-inline-flex align-items-center gap-1" onClick={handleApprove} disabled={!!saving}>
              {saving === 'approve' ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-check-lg" />}Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Edit-Clock-In Approval Modal ─────────────────────────────────────────── */
function EditRequestModal({ record, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState('');
  const { user } = useAuth();
  const approverId = user?.id;

  const req = record.editClockInRequest || {};
  const oldTime = record.clockIn;
  const newTime = req.requestedClockIn;

  async function handleApprove() {
    setSaving('approve');
    try { await approveEditClockIn(record.id, approverId); onDone(); }
    finally { setSaving(''); }
  }
  async function handleReject() {
    setSaving('reject');
    try { await rejectEditClockIn(record.id, approverId, reason); onDone(); }
    finally { setSaving(''); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 16 }}>
        <div className="card-body p-4">
          <h6 className="fw-bold mb-3"><i className="bi bi-pencil-square me-2 text-primary" />Clock-In Edit Request</h6>

          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
            <div className="d-flex align-items-center gap-2 mb-3">
              <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white"
                style={{ width: 36, height: 36, background: '#3b82f6', fontSize: '0.65rem' }}>
                {(record.userName || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="fw-semibold" style={{ fontSize: '0.88rem' }}>{record.userName}</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>{record.userRole?.toUpperCase()} · {locLabel(record.location)}</div>
              </div>
            </div>

            <div className="d-flex align-items-center gap-3" style={{ fontSize: '0.78rem' }}>
              <div style={{ flex: 1 }}>
                <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Current</div>
                <div className="fw-bold" style={{ color: '#64748b', textDecoration: 'line-through' }}>{fmtTime(oldTime)}</div>
              </div>
              <i className="bi bi-arrow-right text-muted" />
              <div style={{ flex: 1, textAlign: 'right' }}>
                <div style={{ fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#2563eb' }}>Requested</div>
                <div className="fw-bold" style={{ color: '#2563eb' }}>{fmtTime(newTime)}</div>
              </div>
            </div>
          </div>

          {req.reason && (
            <div className="rounded-3 p-3 mb-3" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
              <div className="fw-semibold small mb-1" style={{ color: '#2563eb' }}>Reason</div>
              <p className="mb-0" style={{ fontSize: '0.82rem', color: '#1e40af' }}>{req.reason}</p>
            </div>
          )}

          <div className="mb-3">
            <label className="form-label small fw-semibold">Rejection reason (optional)</label>
            <input type="text" className="form-control form-control-sm" placeholder="e.g. Time looks inaccurate…"
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
            <button className="btn btn-sm btn-outline-danger px-3 d-inline-flex align-items-center gap-1" onClick={handleReject} disabled={!!saving}>
              {saving === 'reject' ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-x-lg" />}Reject
            </button>
            <button className="btn btn-sm btn-success px-4 d-inline-flex align-items-center gap-1" onClick={handleApprove} disabled={!!saving}>
              {saving === 'approve' ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-check-lg" />}Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Today Timeline (individual user view) ───────────────────────────────── */
function TodayTimeline({ record }) {
  // Build a chronological list of events from the record.
  const events = useMemo(() => {
    if (!record) return [];
    const out = [];
    if (record.clockIn) {
      out.push({
        t: record.clockIn,
        type: 'clock-in',
        title: 'Clocked in',
        subtitle: locLabel(record.location),
        icon: 'bi-box-arrow-in-right',
        color: '#16a34a',
      });
    }
    (record.breaks || []).forEach((b, i) => {
      if (b.start) out.push({
        t: b.start, type: 'break-start',
        title: `Break ${i + 1} started`, subtitle: '',
        icon: 'bi-cup-hot-fill', color: '#f59e0b',
      });
      if (b.end) out.push({
        t: b.end, type: 'break-end',
        title: `Break ${i + 1} ended`, subtitle: '',
        icon: 'bi-play-fill', color: '#f59e0b',
      });
    });
    if (record.clockOutRequestedAt) {
      out.push({
        t: record.clockOutRequestedAt, type: 'request',
        title: 'Clock-out requested',
        subtitle: record.clockOutNote || 'Waiting for TL approval',
        icon: 'bi-send-fill', color: '#3b82f6',
      });
    }
    if (record.clockOut) {
      out.push({
        t: record.clockOut, type: 'clock-out',
        title: 'Clocked out',
        subtitle: record.approvalStatus === 'rejected' ? 'Rejected — ' + (record.rejectionReason || '') : '',
        icon: 'bi-box-arrow-right', color: '#64748b',
      });
    }
    return out.sort((a, b) => {
      const ta = a.t?.toMillis ? a.t.toMillis() : new Date(a.t).getTime();
      const tb = b.t?.toMillis ? b.t.toMillis() : new Date(b.t).getTime();
      return ta - tb;
    });
  }, [record]);

  const t = record ? calcTimes(record) : null;

  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 18 }}>
      <div className="card-body p-4">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div>
            <h6 className="fw-bold mb-1" style={{ color: '#0f172a' }}>
              <i className="bi bi-list-ul me-2" style={{ color: '#3b82f6' }} />
              Today's Timeline
            </h6>
            <p className="text-muted mb-0" style={{ fontSize: '0.74rem' }}>
              A live log of your activity for today.
            </p>
          </div>
          {t && (
            <div className="d-flex gap-2">
              <span className="rounded-pill px-3 py-1" style={{ background: '#f0fdf4', color: '#16a34a', fontSize: '0.68rem', fontWeight: 700, border: '1px solid #bbf7d0' }}>
                <i className="bi bi-activity me-1" />{fmtDuration(t.totalWorkMs)}
              </span>
              <span className="rounded-pill px-3 py-1" style={{ background: '#fffbeb', color: '#d97706', fontSize: '0.68rem', fontWeight: 700, border: '1px solid #fde68a' }}>
                <i className="bi bi-cup-hot me-1" />{fmtDuration(t.totalBreakMs)}
              </span>
            </div>
          )}
        </div>

        {events.length === 0 ? (
          <div className="text-center py-5" style={{ border: '2px dashed #e2e8f0', borderRadius: 12 }}>
            <i className="bi bi-hourglass text-muted" style={{ fontSize: '2rem', opacity: 0.3 }} />
            <p className="text-muted mt-2 mb-0 small">No activity yet today. Clock in to get started.</p>
          </div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 20 }}>
            {/* vertical line */}
            <div style={{ position: 'absolute', left: 9, top: 6, bottom: 6, width: 2, background: '#e2e8f0' }} />
            {events.map((ev, i) => (
              <div key={i} className="d-flex align-items-start gap-3 mb-3" style={{ position: 'relative' }}>
                <div
                  className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0"
                  style={{
                    width: 20, height: 20,
                    background: ev.color,
                    boxShadow: `0 0 0 3px ${ev.color}22`,
                    marginLeft: -20, marginTop: 2,
                    position: 'relative', zIndex: 1,
                  }}
                >
                  <i className={`bi ${ev.icon}`} style={{ fontSize: '0.6rem', color: '#fff' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="d-flex align-items-center justify-content-between gap-2 flex-wrap">
                    <span className="fw-semibold" style={{ fontSize: '0.82rem', color: '#0f172a' }}>{ev.title}</span>
                    <span className="text-muted" style={{ fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' }}>{fmtTime(ev.t)}</span>
                  </div>
                  {ev.subtitle && (
                    <div className="text-muted" style={{ fontSize: '0.7rem' }}>{ev.subtitle}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Roster tab: per-user monthly summary with manual override ─────────────── */
function RosterTab({ isBoss, isOL, currentUser, userRole, expectedMembers }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [records, setRecords] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [holidaySet, setHolidaySet] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [editTarget, setEditTarget] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);

  // Pull attendance records, adjustments, and approved leaves for the month.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [{ records: rec, leaves: lv }, adjList, hSet] = await Promise.all([
          fetchRosterMonth(month),
          getAdjustmentsForMonth(month),
          listHolidayDatesForMonth(month).catch(() => new Set()),
        ]);
        if (cancelled) return;
        setRecords(rec);
        setAdjustments(adjList);
        setLeaves(lv);
        setHolidaySet(hSet);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('roster load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [month, reloadKey]);

  // Total days in month up to today (or month end if past). Every
  // day must be "covered" — weekends, holidays and approved leaves
  // are auto-credited so only weekdays the user was expected to
  // clock in on and didn't pull the score down.
  const workingDaysInMonth = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const today = new Date();
    return (today.getFullYear() === y && today.getMonth() + 1 === m) ? today.getDate() : lastDay;
  }, [month]);
  // Set of weekend (Sat/Sun) YYYY-MM-DD strings up to the same
  // cutoff — joined into the coverage set below.
  const weekendDatesInMonth = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const today = new Date();
    const cutoff = (today.getFullYear() === y && today.getMonth() + 1 === m) ? today.getDate() : lastDay;
    const pad = (n) => String(n).padStart(2, '0');
    const out = new Set();
    for (let d = 1; d <= cutoff; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) out.add(`${y}-${pad(m)}-${pad(d)}`);
    }
    return out;
  }, [month]);
  // Inclusive cutoff "YYYY-MM-DD" — every credit-set in the rows
  // memo is filtered against this so future holidays / leaves can't
  // pre-credit a user's coverage before the day actually happens.
  const cutoffYmd = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (today.getFullYear() === y && today.getMonth() + 1 === m) {
      return `${y}-${pad(m)}-${pad(today.getDate())}`;
    }
    return `${y}-${pad(m)}-${pad(lastDay)}`;
  }, [month]);

  // Month bounds for clipping leave ranges that extend past the month edges.
  const monthBounds = useMemo(() => {
    const [yy, mm] = month.split('-').map(Number);
    const start = `${yy}-${String(mm).padStart(2, '0')}-01`;
    const lastDay = new Date(yy, mm, 0).getDate();
    const end = `${yy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end };
  }, [month]);

  // Build per-user summary
  const rows = useMemo(() => {
    const pad = n => String(n).padStart(2, '0');
    const list = expectedMembers.map(u => {
      const { actualDays, effectiveDays, adjustments: userAdj } = computeMonthlyDays(u.id, records, adjustments);
      const userRecords = records.filter(r => r.userId === u.id);
      const totalHoursMs = userRecords.reduce((sum, r) => sum + (calcTimes(r).totalWorkMs || 0), 0);
      const userLeaves = leaves.filter(l => l.requestedBy === u.id);

      // Set of dates the user clocked in this month.
      const presentDateSet = new Set();
      userRecords.forEach(r => { if (r.date && r.clockIn) presentDateSet.add(r.date); });

      // Set of every approved leave date this month — Mon-Fri only,
      // weekend/holiday dates inside the range excluded so a Fri+Mon
      // leave is 2 days not 4, and a leave overlapping Eid doesn't
      // double-charge. Used for the per-row "Leaves" tile and as part
      // of the coverage union.
      const leaveDateSet = new Set();
      userLeaves.forEach(l => {
        const days = expandLeaveWeekdays(
          l.startDate, l.endDate,
          { mStart: monthBounds.start, mEnd: monthBounds.end, holidaySet },
        );
        days.forEach((d) => leaveDateSet.add(d));
      });
      // Clip leaves and holidays to days that have actually
      // elapsed — future credits don't inflate the score.
      const pastLeaveSet = new Set([...leaveDateSet].filter((d) => d <= cutoffYmd));
      const pastHolidaySet = new Set([...holidaySet].filter((d) => d <= cutoffYmd));
      const leaveDays = pastLeaveSet.size;
      // Days where leave overlaps with a clock-in (informational; calendar
      // shows them with a small blue dot on the green tile).
      const leaveOverlapCount = [...leaveDateSet].filter(d => presentDateSet.has(d)).length;

      // Coverage = union of (effective present days, leave days, holidays)
      // — no double-counting when a leave overlaps a clock-in, and holidays
      // give credit even when the user didn't clock in.
      const presentForCoverage = new Set([
        ...presentDateSet,
        ...userAdj.map(a => a.date).filter(Boolean),
      ]);
      const coverageSet = new Set([
        ...presentForCoverage, ...pastLeaveSet, ...pastHolidaySet, ...weekendDatesInMonth,
      ]);
      const covered = coverageSet.size;
      let health = 'green';
      if (covered < workingDaysInMonth - 5) health = 'red';
      else if (covered < workingDaysInMonth - 2) health = 'yellow';
      return {
        user: u,
        actualDays,
        effectiveDays,
        leaveDays,
        leaveOverlapCount,
        coveredDays: covered,
        totalHoursMs,
        adjustments: userAdj,
        health,
        userRecords,
        userLeaves,
        leaveDateSet,
      };
    });
    let filtered = list;
    if (search) {
      const s = search.toLowerCase();
      filtered = filtered.filter(r => (r.user.name || '').toLowerCase().includes(s) || (r.user.email || '').toLowerCase().includes(s));
    }
    if (filterRole) filtered = filtered.filter(r => (r.user.role || '').toLowerCase() === filterRole);
    return filtered.sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
  }, [expectedMembers, records, adjustments, leaves, holidaySet, weekendDatesInMonth, cutoffYmd, monthBounds, workingDaysInMonth, search, filterRole]);

  function canEdit(targetUser) {
    if (isBoss) return true;
    if (isOL) {
      if (targetUser.id === currentUser.uid) return false;
      if ((targetUser.role || '').toLowerCase() === 'ol') return false;
      return true;
    }
    return false;
  }

  // Eligible bulk targets — same per-user permission rules as the per-row Adjust panel.
  const bulkTargets = useMemo(() => {
    return rows
      .filter(r => canEdit(r.user))
      .map(r => r.user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, isBoss, isOL, currentUser?.uid]);

  // Total missed days across all bulk targets (preview number on the button).
  const bulkMissedTotal = useMemo(() => {
    let n = 0;
    rows.forEach(r => {
      if (!canEdit(r.user)) return;
      n += missedWeekdayDatesFor(r.user.id, month, records, adjustments, leaves).length;
    });
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, month, records, adjustments, leaves, isBoss, isOL, currentUser?.uid]);

  return (
    <div>
      {/* Header */}
      <div className="d-flex flex-wrap gap-3 align-items-end mb-3">
        <div>
          <label className="small text-muted d-block mb-1" style={{ fontSize: '0.7rem', fontWeight: 600 }}>Month</label>
          <input type="month" className="form-control form-control-sm" value={month} onChange={e => setMonth(e.target.value)} style={{ maxWidth: 160 }} />
        </div>
        <div className="input-group input-group-sm" style={{ maxWidth: 240 }}>
          <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}><i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} /></span>
          <input type="text" className="form-control border-0" placeholder="Search name or email…" value={search} onChange={e => setSearch(e.target.value)} style={{ background: '#f1f5f9' }} />
        </div>
        <select className="form-select form-select-sm" value={filterRole} onChange={e => setFilterRole(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">All Roles</option>
          {ROLE_OPTIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        {bulkMissedTotal > 0 && (
          <button className="btn btn-sm btn-outline-primary rounded-pill px-3"
            disabled={!!bulkRunning}
            onClick={() => setBulkOpen(true)}
            style={{ fontSize: '0.72rem', fontWeight: 600 }}>
            <i className="bi bi-check2-all me-1" />
            Mark all {bulkMissedTotal} missed day{bulkMissedTotal === 1 ? '' : 's'} as present
          </button>
        )}
        <div className="ms-auto text-muted small" style={{ fontSize: '0.72rem' }}>
          Working days so far: <strong>{workingDaysInMonth}</strong> · Showing {rows.length} of {expectedMembers.length}
        </div>
      </div>

      {bulkOpen && (
        <BulkMarkConfirmModal
          monthStr={month}
          targetUsers={bulkTargets}
          monthRecords={records}
          monthAdjusts={adjustments}
          monthLeaves={leaves}
          actor={{ uid: currentUser.uid, name: currentUser.displayName || currentUser.email, role: userRole }}
          running={bulkRunning}
          progress={bulkProgress}
          onRun={async (note) => {
            setBulkRunning(true);
            setBulkProgress({ done: 0, total: 0 });
            try {
              const res = await bulkMarkMissedAsPresent({
                monthStr: month,
                targetUsers: bulkTargets,
                monthRecords: records,
                monthAdjusts: adjustments,
                monthLeaves: leaves,
                note,
                actor: { uid: currentUser.uid, name: currentUser.displayName || currentUser.email, role: userRole },
                onProgress: (p) => setBulkProgress(p),
              });
              setBulkRunning(false);
              setBulkOpen(false);
              setBulkProgress(null);
              setReloadKey(k => k + 1);
              // eslint-disable-next-line no-alert
              window.alert(`Marked ${res.adjustmentsCreated} day${res.adjustmentsCreated === 1 ? '' : 's'} present across ${res.usersTouched} user${res.usersTouched === 1 ? '' : 's'}.`);
            } catch (err) {
              setBulkRunning(false);
              // eslint-disable-next-line no-alert
              window.alert(`Bulk mark failed: ${err.message || 'unknown error'}`);
            }
          }}
          onClose={() => { if (!bulkRunning) setBulkOpen(false); }}
        />
      )}

      {loading ? (
        <div className="text-center text-muted py-5"><div className="spinner-border spinner-border-sm me-2" />Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-muted py-5">No employees match the current filter.</div>
      ) : (
        <div className="row g-3">
          {rows.map(r => {
            const editable = canEdit(r.user);
            const hasOverride = r.adjustments.length > 0;
            const healthColor = r.health === 'green' ? '#16a34a' : r.health === 'yellow' ? '#f59e0b' : '#dc2626';
            const healthBg    = r.health === 'green' ? '#f0fdf4' : r.health === 'yellow' ? '#fffbeb' : '#fef2f2';
            const healthLabel = r.health === 'green' ? 'On track' : r.health === 'yellow' ? 'Watch' : 'Behind';
            return (
              <div key={r.user.id} className="col-12 col-md-6 col-xl-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14 }}>
                  <div className="card-body p-3">
                    <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
                      <div className="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
                        <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                          style={{ width: 36, height: 36, background: '#3b82f6', fontSize: '0.7rem' }}>
                          {(r.user.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="fw-semibold text-truncate" style={{ fontSize: '0.85rem', color: '#0f172a' }}>{r.user.name}</div>
                          <div className="text-muted text-truncate" style={{ fontSize: '0.66rem' }}>
                            {(r.user.role || '').toUpperCase()}{r.user.email ? ' · ' + r.user.email : ''}
                          </div>
                        </div>
                      </div>
                      <span className="badge rounded-pill flex-shrink-0" style={{ background: healthBg, color: healthColor, border: `1px solid ${healthColor}30`, fontSize: '0.62rem' }}>
                        <span className="rounded-circle d-inline-block me-1" style={{ width: 6, height: 6, background: healthColor, verticalAlign: 'middle' }} />
                        {healthLabel}
                      </span>
                    </div>

                    <div className="d-flex gap-3 mb-2" style={{ fontSize: '0.72rem' }}>
                      <div title="Working days the user clocked in or was manually marked present (does not include leaves)">
                        <div className="text-muted" style={{ fontSize: '0.62rem', textTransform: 'uppercase', fontWeight: 600 }}>Present</div>
                        <div className="fw-bold" style={{ fontSize: '1.05rem', color: '#0f172a' }}>
                          {r.effectiveDays}
                          {hasOverride && r.actualDays !== r.effectiveDays && (
                            <span className="text-muted ms-1" style={{ fontSize: '0.66rem', fontWeight: 500 }}>
                              (actual {r.actualDays})
                            </span>
                          )}
                        </div>
                      </div>
                      <div title={`${r.leaveDays} approved medical / emergency leave day${r.leaveDays === 1 ? '' : 's'} this month (WFH days don't count here — they show as Present)`}>
                        <div className="text-muted" style={{ fontSize: '0.62rem', textTransform: 'uppercase', fontWeight: 600 }}>Leaves</div>
                        <div className="fw-bold" style={{ fontSize: '1.05rem', color: '#0f172a' }}>{r.leaveDays}</div>
                      </div>
                      <div>
                        <div className="text-muted" style={{ fontSize: '0.62rem', textTransform: 'uppercase', fontWeight: 600 }}>Hours</div>
                        <div className="fw-bold" style={{ fontSize: '1.05rem', color: '#0f172a' }}>{fmtDuration(r.totalHoursMs)}</div>
                      </div>
                    </div>

                    {hasOverride && (
                      <div className="rounded-3 px-2 py-1 mb-2" style={{ background: '#fef3c7', border: '1px solid #fde68a' }}>
                        <div className="d-flex align-items-center gap-1" style={{ fontSize: '0.65rem', color: '#92400e' }}>
                          <i className="bi bi-pencil-square" />
                          <strong>{r.adjustments.length} manual adjustment{r.adjustments.length === 1 ? '' : 's'}</strong>
                        </div>
                      </div>
                    )}

                    <div className="d-flex justify-content-between align-items-center">
                      <span className="text-muted" style={{ fontSize: '0.66rem' }}>
                        {workingDaysInMonth > 0 ? `${Math.round((r.coveredDays / workingDaysInMonth) * 100)}% of ${workingDaysInMonth} wd` : ''}
                      </span>
                      {editable ? (
                        <button className="btn btn-sm btn-outline-primary rounded-pill px-3" style={{ fontSize: '0.7rem' }}
                          onClick={() => setEditTarget(r)}>
                          <i className="bi bi-pencil me-1" />Adjust
                        </button>
                      ) : (
                        <span className="text-muted" style={{ fontSize: '0.62rem' }}>
                          <i className="bi bi-lock me-1" />No edit access
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editTarget && (
        <RosterAdjustModal
          row={editTarget}
          month={month}
          editor={{ id: currentUser.uid, name: currentUser.displayName || currentUser.email, role: userRole }}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); setReloadKey(k => k + 1); }}
        />
      )}
    </div>
  );
}

/* Bulk-confirm modal: shows the per-user breakdown of missed days that
   will be marked present, then runs the bulk job with a live progress bar. */
function BulkMarkConfirmModal({
  monthStr, targetUsers, monthRecords, monthAdjusts, monthLeaves,
  actor, running, progress, onRun, onClose,
}) {
  const [note, setNote] = useState('');
  // Per-user preview, sorted by descending missed count
  const preview = useMemo(() => {
    return targetUsers
      .map(u => ({
        user: u,
        dates: missedWeekdayDatesFor(u.id, monthStr, monthRecords, monthAdjusts, monthLeaves),
      }))
      .filter(p => p.dates.length > 0)
      .sort((a, b) => b.dates.length - a.dates.length);
  }, [targetUsers, monthStr, monthRecords, monthAdjusts, monthLeaves]);

  const totalDays = preview.reduce((n, p) => n + p.dates.length, 0);
  const monthLabel = (() => {
    const [y, m] = monthStr.split('-').map(Number);
    return new Date(y, m - 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  })();

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={running ? undefined : onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 560, zIndex: 1, borderRadius: 14, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-body p-4" style={{ overflowY: 'auto' }}>
          <div className="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-1">
                <i className="bi bi-check2-all me-2 text-primary" />
                Bulk-mark missed days as present
              </h6>
              <div className="text-muted small" style={{ fontSize: '0.74rem' }}>
                {monthLabel} · {preview.length} user{preview.length === 1 ? '' : 's'} affected · <strong>{totalDays}</strong> day{totalDays === 1 ? '' : 's'} will be marked present
              </div>
            </div>
            <button className="btn btn-sm btn-light rounded-circle" onClick={onClose} disabled={running} style={{ width: 32, height: 32 }}>
              <i className="bi bi-x-lg" />
            </button>
          </div>

          <div className="rounded-3 p-3 mb-3" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '0.78rem', color: '#1e3a8a' }}>
            <i className="bi bi-shield-check me-1" />
            Existing clock-ins, approved leaves, and previous manual adjustments will <strong>not</strong> change. Only days that are currently missed (red on the calendar) will get a manual adjustment so they count as present.
          </div>

          <div className="mb-3">
            <label className="small text-muted d-block mb-1" style={{ fontSize: '0.7rem', fontWeight: 600 }}>
              Note (optional — sent to every affected user)
            </label>
            <input type="text" className="form-control form-control-sm"
              value={note} onChange={e => setNote(e.target.value)}
              placeholder="e.g. Backfilled by manager — system glitches in this month."
              disabled={running} />
          </div>

          {running && progress && (
            <div className="mb-3">
              <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.74rem' }}>
                <span className="text-muted">Saving…</span>
                <span className="fw-semibold">{progress.done} / {progress.total}</span>
              </div>
              <div className="rounded-pill overflow-hidden" style={{ height: 6, background: '#f1f5f9' }}>
                <div className="h-100" style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`, background: 'linear-gradient(90deg,#3b82f6,#7c3aed)', transition: 'width 200ms ease' }} />
              </div>
            </div>
          )}

          <div className="text-muted small mb-2" style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase' }}>
            Breakdown ({preview.length} user{preview.length === 1 ? '' : 's'})
          </div>
          {preview.length === 0 ? (
            <div className="text-center text-muted py-3" style={{ fontSize: '0.78rem' }}>
              <i className="bi bi-check-circle text-success me-1" />
              Nothing to do — every working day is already accounted for.
            </div>
          ) : (
            <div className="d-flex flex-column gap-1" style={{ maxHeight: 280, overflowY: 'auto' }}>
              {preview.map(p => (
                <div key={p.user.id} className="d-flex align-items-center justify-content-between rounded-2 p-2"
                  style={{ background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: '0.78rem' }}>
                  <div className="text-truncate me-2" style={{ minWidth: 0 }}>
                    <span className="fw-semibold" style={{ color: '#0f172a' }}>{p.user.userName || p.user.displayName || p.user.email}</span>
                    <span className="text-muted ms-2" style={{ fontSize: '0.66rem' }}>
                      {(p.user.userType || p.user.role || 'apc').toUpperCase()}
                    </span>
                  </div>
                  <span className="rounded-pill px-2 flex-shrink-0" style={{ background: '#fee2e2', color: '#991b1b', fontSize: '0.66rem', fontWeight: 700 }}>
                    {p.dates.length} day{p.dates.length === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 pb-4 d-flex gap-2 justify-content-end">
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={running}>Cancel</button>
          <button className="btn btn-sm btn-dark px-4" onClick={() => onRun(note)} disabled={running || totalDays === 0}>
            {running
              ? <><span className="spinner-border spinner-border-sm me-1" />Working…</>
              : `Mark ${totalDays} day${totalDays === 1 ? '' : 's'} as present`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Modal: tap a missed (red) day to mark present, tap an adjusted (yellow)
   day to undo. Shift+click extends a range so a manager can mark a whole
   week at once without clicking each day. */
function RosterAdjustModal({ row, month, editor, onClose, onSaved }) {
  const [pendingDate, setPendingDate] = useState(null); // single-cell spinner
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null); // { done, total }
  const [error, setError] = useState('');
  const [defaultNote, setDefaultNote] = useState('');
  const [lastTappedDate, setLastTappedDate] = useState(null); // anchor for shift+click range

  const [y, m] = month.split('-').map(Number);
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();

  // Build per-day map. row.adjustments are now per-day records: { date, ... }
  const days_ = useMemo(() => {
    const out = [];
    // Same rule as the card / Roster / computeMonthlyDays: any date with a
    // clock-in counts as present, regardless of auto-close status. Forgetting
    // to clock out doesn't strip the day from the present set.
    const presentSet = new Set();
    (row.userRecords || []).forEach(r => {
      if (!r.date) return;
      if (r.clockIn) presentSet.add(r.date);
    });
    // Full set of approved leave dates for the month. Same set the card's
    // Leaves count is derived from, so card and calendar always agree.
    const leaveSet = row.leaveDateSet || (() => {
      const s = new Set();
      (row.userLeaves || []).forEach(l => {
        if (!l.startDate || !l.endDate) return;
        const a = new Date(l.startDate + 'T00:00:00').getTime();
        const b = new Date(l.endDate + 'T00:00:00').getTime();
        for (let t = a; t <= b; t += 86400000) {
          const d = new Date(t);
          s.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        }
      });
      return s;
    })();
    const adjMap = new Map(); // date -> adjustment doc
    (row.adjustments || []).forEach(a => { if (a.date) adjMap.set(a.date, a); });

    for (let day = 1; day <= lastDay; day++) {
      const ds = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dow = new Date(y, m - 1, day).getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isFuture = ds > today;
      // Real clock-in wins; an amber dot surfaces a redundant manual
      // adjustment on a day the user actually clocked in. WFH is no
      // longer treated as a leave so there's no leave/present overlap
      // to worry about — leaves only appear on days the user was
      // genuinely absent (medical / emergency).
      let kind = 'missed';
      if (isFuture) kind = 'future';
      else if (presentSet.has(ds)) kind = 'present';
      else if (adjMap.has(ds)) kind = 'adjusted';
      else if (leaveSet.has(ds)) kind = 'leave';
      else if (isWeekend) kind = 'weekend';
      const hasRedundantAdj = kind === 'present' && adjMap.has(ds);
      out.push({ ds, day, kind, dow, adjustment: adjMap.get(ds) || null, hasRedundantAdj });
    }
    return out;
  }, [row, y, m, lastDay, today]);

  const summary = useMemo(() => {
    const s = { present: 0, leave: 0, adjusted: 0, missed: 0, weekend: 0, future: 0 };
    days_.forEach(d => { s[d.kind] = (s[d.kind] || 0) + 1; });
    return s;
  }, [days_]);

  async function toggleDay(d, evt) {
    if (pendingDate || bulkSaving) return;
    setError('');

    // Shift+click → mark every eligible day in the range from the last
    // tapped day to this one in a single batch.
    if (evt && evt.shiftKey && lastTappedDate && lastTappedDate !== d.ds) {
      const lo = lastTappedDate < d.ds ? lastTappedDate : d.ds;
      const hi = lastTappedDate < d.ds ? d.ds : lastTappedDate;
      const targets = days_.filter(x =>
        x.ds >= lo && x.ds <= hi
        && (x.kind === 'missed' || x.kind === 'weekend')
      );
      if (targets.length === 0) return;
      setBulkSaving(true);
      setBulkProgress({ done: 0, total: targets.length });
      let failures = 0;
      for (let i = 0; i < targets.length; i++) {
        try {
          await createAttendanceAdjustment({
            userId: row.user.id,
            userName: row.user.name,
            userRole: row.user.role,
            date: targets[i].ds,
            note: defaultNote.trim(),
            addedBy: editor.id,
            addedByName: editor.name,
            addedByRole: editor.role,
          });
        } catch { failures++; }
        setBulkProgress({ done: i + 1, total: targets.length });
      }
      setBulkSaving(false);
      setBulkProgress(null);
      setLastTappedDate(d.ds);
      if (failures > 0) setError(`${failures} day${failures === 1 ? '' : 's'} could not be marked (already marked or invalid).`);
      onSaved();
      return;
    }

    // Single-day toggle (default).
    setPendingDate(d.ds);
    try {
      if (d.kind === 'adjusted' && d.adjustment) {
        await deleteAttendanceAdjustment(d.adjustment.id);
      } else if (d.kind === 'missed' || d.kind === 'weekend') {
        await createAttendanceAdjustment({
          userId: row.user.id,
          userName: row.user.name,
          userRole: row.user.role,
          date: d.ds,
          note: defaultNote.trim(),
          addedBy: editor.id,
          addedByName: editor.name,
          addedByRole: editor.role,
        });
      } else {
        setPendingDate(null);
        return; // present / leave / future — non-actionable
      }
      setLastTappedDate(d.ds);
      onSaved();
    } catch (err) {
      setError(err.message || 'Failed to save.');
    } finally {
      setPendingDate(null);
    }
  }

  // Quick action: mark every still-missed weekday in the month at once.
  async function markAllMissed() {
    if (pendingDate || bulkSaving) return;
    const targets = days_.filter(d => d.kind === 'missed');
    if (targets.length === 0) return;
    if (!window.confirm(`Mark all ${targets.length} missed day${targets.length === 1 ? '' : 's'} as present?`)) return;
    setError('');
    setBulkSaving(true);
    setBulkProgress({ done: 0, total: targets.length });
    let failures = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        await createAttendanceAdjustment({
          userId: row.user.id,
          userName: row.user.name,
          userRole: row.user.role,
          date: targets[i].ds,
          note: defaultNote.trim(),
          addedBy: editor.id,
          addedByName: editor.name,
          addedByRole: editor.role,
        });
      } catch { failures++; }
      setBulkProgress({ done: i + 1, total: targets.length });
    }
    setBulkSaving(false);
    setBulkProgress(null);
    if (failures > 0) setError(`${failures} day${failures === 1 ? '' : 's'} could not be marked.`);
    onSaved();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={pendingDate ? undefined : onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 540, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-1"><i className="bi bi-pencil-square me-2 text-primary" />Adjust attendance — {row.user.name}</h6>
              <div className="text-muted small" style={{ fontSize: '0.74rem' }}>
                {new Date(monthStart + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                {' · '}Actual: <strong>{row.actualDays}</strong>{' · '}Effective: <strong>{row.effectiveDays}</strong>
              </div>
            </div>
            <button className="btn btn-sm btn-light rounded-circle" onClick={onClose} disabled={!!pendingDate} style={{ width: 32, height: 32 }}>
              <i className="bi bi-x-lg" />
            </button>
          </div>

          {/* How-to */}
          <div className="rounded-3 p-2 mb-3 d-flex align-items-start gap-2" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: '0.74rem', color: '#1e3a8a' }}>
            <i className="bi bi-info-circle mt-1" />
            <div>
              Tap a <strong style={{ color: '#dc2626' }}>red</strong> day to mark present, tap a <strong style={{ color: '#92400e' }}>yellow</strong> day to undo.
              <strong> Shift+click</strong> a second day to mark a whole range at once.
            </div>
          </div>

          {/* Bulk actions */}
          {summary.missed > 0 && (
            <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
              <button className="btn btn-sm btn-outline-primary rounded-pill px-3"
                disabled={!!pendingDate || bulkSaving}
                onClick={markAllMissed}
                style={{ fontSize: '0.74rem' }}>
                <i className="bi bi-check2-all me-1" />
                Mark all {summary.missed} missed weekday{summary.missed === 1 ? '' : 's'} as present
              </button>
              {bulkSaving && bulkProgress && (
                <span className="text-muted" style={{ fontSize: '0.72rem' }}>
                  <span className="spinner-border spinner-border-sm me-1" style={{ width: 12, height: 12 }} />
                  {bulkProgress.done} / {bulkProgress.total} saved…
                </span>
              )}
            </div>
          )}

          {/* Optional note input — applied to whatever day you tap next */}
          <div className="mb-3">
            <label className="small text-muted d-block mb-1" style={{ fontSize: '0.68rem', fontWeight: 600 }}>
              Note (optional — shown to user, applied to new marks)
            </label>
            <input type="text" className="form-control form-control-sm"
              value={defaultNote} onChange={e => setDefaultNote(e.target.value)}
              placeholder="e.g. Worked from client site, system glitch, etc."
              disabled={!!pendingDate} />
          </div>

          {/* Calendar */}
          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
            <div className="d-flex gap-2 flex-wrap mb-2" style={{ fontSize: '0.66rem' }}>
              <DayLegend color="#16a34a" label={`Present ${summary.present}`} />
              <DayLegend color="#3b82f6" label={`Leave ${summary.leave}`} />
              <DayLegend color="#f59e0b" label={`Adjusted ${summary.adjusted}`} />
              <DayLegend color="#dc2626" label={`Missed ${summary.missed}`} />
              <DayLegend color="#cbd5e1" label={`Weekend ${summary.weekend}`} />
              {summary.future > 0 && <DayLegend color="#e2e8f0" label={`Future ${summary.future}`} />}
            </div>
            <div className="d-grid gap-1" style={{ gridTemplateColumns: 'repeat(7, 1fr)' }}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="text-muted text-center" style={{ fontSize: '0.6rem', fontWeight: 600 }}>{d}</div>
              ))}
              {Array.from({ length: new Date(y, m - 1, 1).getDay() }).map((_, i) => (
                <div key={`pad-${i}`} />
              ))}
              {days_.map(d => {
                const colors = {
                  present:  { bg: '#dcfce7', fg: '#15803d', border: '#16a34a' },
                  leave:    { bg: '#dbeafe', fg: '#1e40af', border: '#3b82f6' },
                  adjusted: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' },
                  missed:   { bg: '#fee2e2', fg: '#991b1b', border: '#dc2626' },
                  weekend:  { bg: '#f8fafc', fg: '#94a3b8', border: '#e2e8f0' },
                  future:   { bg: '#fff',    fg: '#cbd5e1', border: '#e2e8f0' },
                }[d.kind];
                const clickable = d.kind === 'missed' || d.kind === 'adjusted' || d.kind === 'weekend';
                const isPending = pendingDate === d.ds;
                const titleByKind = {
                  present: 'Present (real clock-in)',
                  leave:   'Approved leave',
                  adjusted:`Manually marked present${d.adjustment?.note ? ' · ' + d.adjustment.note : ''}`,
                  missed:  'Missed — tap to mark present',
                  weekend: 'Weekend — tap if user worked',
                  future:  'Future date',
                }[d.kind];
                const isAnchor = lastTappedDate === d.ds;
                return (
                  <button key={d.ds}
                    type="button"
                    disabled={!clickable || !!pendingDate || bulkSaving}
                    onClick={(e) => clickable && toggleDay(d, e)}
                    className="rounded-2 p-1 text-center position-relative"
                    style={{
                      background: colors.bg,
                      color: colors.fg,
                      border: `1px solid ${isAnchor ? '#0f172a' : colors.border}`,
                      boxShadow: isAnchor ? '0 0 0 2px rgba(15,23,42,0.2)' : 'none',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      cursor: clickable && !pendingDate && !bulkSaving ? 'pointer' : 'default',
                      opacity: d.kind === 'future' ? 0.5 : 1,
                    }}
                    title={`${d.ds} · ${titleByKind}${d.hasRedundantAdj ? ' · also has a manual mark (redundant)' : ''}${clickable ? ' · shift+click for range' : ''}`}>
                    {isPending ? <span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} /> : d.day}
                    {d.hasRedundantAdj && (
                      <span className="rounded-circle position-absolute"
                        style={{ width: 6, height: 6, background: '#f59e0b', top: 2, right: 2 }}
                        title="Manual mark exists for this day too — see list below to remove" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <div className="alert alert-danger py-2 small mb-2" style={{ fontSize: '0.76rem' }}>{error}</div>}

          {/* Existing adjustments list — reference + bulk delete */}
          {row.adjustments.length > 0 && (
            <div>
              <div className="text-muted small mb-2" style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase' }}>Manual marks this month</div>
              {[...row.adjustments].sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(a => (
                <div key={a.id} className="rounded-3 p-2 mb-2 d-flex align-items-center justify-content-between gap-2"
                  style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
                  <div style={{ fontSize: '0.78rem' }}>
                    <div className="fw-semibold" style={{ color: '#92400e' }}>
                      <i className="bi bi-check-circle-fill me-1" />{a.date}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.66rem' }}>
                      by {a.addedByName || 'unknown'}{a.note ? ` · ${a.note}` : ''}
                    </div>
                  </div>
                  <button className="btn btn-sm btn-outline-danger rounded-pill px-2" style={{ fontSize: '0.65rem' }}
                    onClick={() => toggleDay({ ds: a.date, kind: 'adjusted', adjustment: a })}
                    disabled={!!pendingDate}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Force-close modal (OL/Boss closing someone else's stuck session) ─────── */
function ForceCloseModal({ record, closer, onClose, onDone }) {
  const clockInMs = record.clockIn?.toMillis ? record.clockIn.toMillis() : new Date(record.clockIn).getTime();
  const HARD_CAP_MS = 16 * 60 * 60 * 1000;
  const maxMs = Math.min(Date.now(), clockInMs + HARD_CAP_MS);
  const [timeVal, setTimeVal] = useState(() => {
    // Default: 8h after clock-in (typical shift), bounded by maxMs.
    const target = Math.min(clockInMs + 8 * 60 * 60 * 1000, maxMs - 60 * 1000);
    const d = new Date(target);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const clockInDateStr = (() => {
    const d = new Date(clockInMs);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  })();
  const elapsedH = ((Date.now() - clockInMs) / 3600000);

  async function handleSubmit() {
    setError('');
    const [hh, mm] = timeVal.split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) { setError('Pick a valid time.'); return; }
    const baseDate = new Date(clockInMs);
    const candidate = new Date(baseDate);
    candidate.setHours(hh, mm, 0, 0);
    let candidateMs = candidate.getTime();
    if (candidateMs <= clockInMs) candidateMs += 24 * 60 * 60 * 1000;
    if (candidateMs > maxMs) {
      setError('Time must be no more than 16h after clock-in (and not in the future).');
      return;
    }
    try {
      setSaving(true);
      await forceCloseSession({
        attendanceId: record.id,
        newClockOutMs: candidateMs,
        closerId: closer.id,
        closerName: closer.name,
        closerRole: closer.role,
        reason: reason.trim(),
      });
      onDone();
    } catch (err) {
      setError(err.message || 'Failed to close session.');
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={saving ? undefined : onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-box-arrow-right me-2" style={{ color: '#dc2626' }} />Close session for {record.userName}</h6>
            <button className="btn btn-sm btn-light rounded-circle" onClick={onClose} disabled={saving} style={{ width: 32, height: 32 }}>
              <i className="bi bi-x-lg" />
            </button>
          </div>
          <p className="text-muted small mb-3" style={{ fontSize: '0.78rem' }}>
            Clocked in at <strong>{fmtTime(record.clockIn)}</strong> on <strong>{clockInDateStr}</strong>
            {elapsedH >= 1 && <> ({elapsedH.toFixed(1)}h ago)</>}.
            Pick when they actually stopped working — they'll be notified.
          </p>
          <div className="mb-3">
            <label className="small text-muted d-block mb-1" style={{ fontSize: '0.72rem', fontWeight: 600 }}>Clock-out time</label>
            <input type="time" className="form-control form-control-sm"
              style={{ borderRadius: 8 }} value={timeVal} onChange={e => setTimeVal(e.target.value)} />
          </div>
          <div className="mb-3">
            <label className="small text-muted d-block mb-1" style={{ fontSize: '0.72rem', fontWeight: 600 }}>Reason (optional, shown to user)</label>
            <textarea className="form-control form-control-sm" rows="2"
              style={{ borderRadius: 8, fontSize: '0.82rem' }}
              placeholder="e.g. Forgot to clock out — closing on your behalf."
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          {error && <div className="alert alert-danger py-2 small mb-3" style={{ fontSize: '0.78rem' }}>{error}</div>}
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-danger px-4" onClick={handleSubmit} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm me-1" />Closing…</> : 'Close session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */
export default function AttendancePage() {
  // v1 returned { currentUser, userRole }. v2 returns { user, profile }.
  // Shim to keep the rest of the file (2,300+ lines) reading like v1.
  const { user, profile } = useAuth();
  const currentUser = user ? {
    uid: user.id,
    email: user.email,
    displayName: profile?.display_name || '',
  } : null;
  const userRole = profile?.role || '';
  const [tab, setTab] = useState('today');
  const [todayRecords, setTodayRecords] = useState([]);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMonth, setHistoryMonth] = useState(() => new Date().toISOString().slice(0, 7));
  // Team-tab filters
  const [search, setSearch] = useState('');
  const [filterLoc, setFilterLoc] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterRole, setFilterRole] = useState('');
  // History-tab filters
  const [historySearch, setHistorySearch] = useState('');
  const [historyDay, setHistoryDay] = useState('');         // "YYYY-MM-DD" or ''
  const [historyLoc, setHistoryLoc] = useState('');
  const [historyStatus, setHistoryStatus] = useState('');
  const [historyRole, setHistoryRole] = useState('');
  const [historyMinHours, setHistoryMinHours] = useState('');
  const [approvalTarget, setApprovalTarget] = useState(null);
  const [editRequestTarget, setEditRequestTarget] = useState(null);
  const [editOutTarget, setEditOutTarget] = useState(null);
  const [forceCloseTarget, setForceCloseTarget] = useState(null);
  const [breakDetailsTarget, setBreakDetailsTarget] = useState(null);
  const [pendingEditOutRequests, setPendingEditOutRequests] = useState([]);
  const [myTodayRecord, setMyTodayRecord] = useState(null);
  const [expectedMembers, setExpectedMembers] = useState([]); // people who should be clocked in

  // Leave quota management (boss only)
  const [quotaMedical, setQuotaMedical] = useState(1);
  const [quotaEmergency, setQuotaEmergency] = useState(1);
  const [quotaWfh, setQuotaWfh] = useState(2);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaSuccess, setQuotaSuccess] = useState('');
  const [quotaError, setQuotaError] = useState('');
  const [quotaConflicts, setQuotaConflicts] = useState(null); // array of {userName, type, used, newQuota} pending confirmation

  const isBoss = userRole === 'boss';
  const isTL = userRole === 'tl' || userRole === 'pctl';
  const isOL = userRole === 'ol';

  // Effective status (working/auto-closed) depends on Date.now(), but the
  // realtime listener only fires when Firestore data changes. Without this
  // tick, a session that crossed the 14h stale threshold while the page is
  // open would keep being counted as Working in the stats/filter even though
  // each row's badge correctly re-renders as Auto-closed. Bumping this every
  // 60s invalidates the time-based memos so counts stay in sync.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const canSeeTeam = isBoss || isTL || isOL;

  // Real-time: today's records
  useEffect(() => {
    if (!canSeeTeam) { setLoading(false); return; }
    setLoading(true);
    // Boss and OL see company-wide attendance; TL/PCTL see only their team
    const unsub = (isBoss || isOL)
      ? onAllToday(records => { setTodayRecords(records); setLoading(false); })
      : onTeamToday(currentUser.uid, records => { setTodayRecords(records); setLoading(false); });
    return unsub;
  }, [currentUser.uid, isBoss, isOL, canSeeTeam]);

  // Real-time: pending approvals for TL
  useEffect(() => {
    if (!isTL) return;
    const unsub = onPendingApprovals(currentUser.uid, setPendingApprovals);
    return unsub;
  }, [currentUser.uid, isTL]);

  // Real-time: pending clock-out edit requests (adjust) for TL
  useEffect(() => {
    if (!isTL) return;
    const unsub = onPendingEditClockOutRequests(currentUser.uid, setPendingEditOutRequests);
    return unsub;
  }, [currentUser.uid, isTL]);

  // Load expected members list (for "Missing today" detection).
  // Boss/OL → everyone (users + teamUsers). TL → only their teamUsers.
  useEffect(() => {
    if (!canSeeTeam) return;
    let cancelled = false;
    async function loadExpected() {
      try {
        // v2: profiles already carries every clock-in role — no
        // separate `users` / `teamUsers` collections to merge.
        const members = await listExpectedMembers({
          uid: currentUser.uid, isBoss, isOL, isTL,
        });
        if (!cancelled) setExpectedMembers(members);
      } catch { /* ignore */ }
    }
    loadExpected();
    return () => { cancelled = true; };
  }, [canSeeTeam, isBoss, isOL, isTL, currentUser.uid]);

  // Real-time: my own today record (used by the Today Timeline for individual view)
  useEffect(() => {
    if (canSeeTeam || isBoss) return; // managers get team view instead
    const unsub = onActiveRecord(currentUser.uid, setMyTodayRecord);
    return unsub;
  }, [currentUser.uid, canSeeTeam, isBoss]);

  // History (on-demand, not real-time)
  function loadHistory() {
    setHistoryLoading(true);
    const { start, end } = getMonthRange(historyMonth);
    const load = (isBoss || isOL) ? getAllHistory(start, end)
      : canSeeTeam ? getTeamAndSelfHistory(currentUser.uid, start, end)
      : getUserHistory(currentUser.uid, start, end);
    load.then(setHistory).finally(() => setHistoryLoading(false));
  }
  useEffect(() => {
    if (tab !== 'history') return;
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, historyMonth, currentUser.uid, isBoss, isOL, canSeeTeam]);

  // Load existing global leave quota (boss only) — v2 stores it in
  // app_config[key='leave_quota_default'] and applies it via the
  // trigger added in mig 058.
  useEffect(() => {
    if (!isBoss) return;
    (async () => {
      try {
        const q = await getLeaveQuotaDefault();
        setQuotaMedical(q.medical);
        setQuotaEmergency(q.emergency);
        setQuotaWfh(q.wfh);
      } catch { /* ignore */ }
    })();
  }, [isBoss]);

  async function doSaveQuota() {
    await setLeaveQuotaDefault({
      medical: quotaMedical, emergency: quotaEmergency, wfh: quotaWfh,
    });
    setQuotaSuccess('Leave quotas updated. Existing approved leaves this month stay paid; new requests use the updated quota.');
    setQuotaConflicts(null);
  }

  async function handleSaveQuota() {
    setQuotaSaving(true); setQuotaError(''); setQuotaSuccess('');
    try {
      const newQuota = { medical: Number(quotaMedical) || 0, emergency: Number(quotaEmergency) || 0, wfh: Number(quotaWfh) || 0 };
      const conflicts = await scanLeaveQuotaConflicts(newQuota);
      if (conflicts.length > 0) {
        setQuotaConflicts(conflicts);
        setQuotaSaving(false);
        return;
      }
      await doSaveQuota();
    } catch (e) {
      setQuotaError('Failed to save quotas: ' + (e.message || ''));
    }
    setQuotaSaving(false);
  }

  async function handleConfirmSaveWithConflicts() {
    setQuotaSaving(true); setQuotaError('');
    try { await doSaveQuota(); } catch (e) { setQuotaError('Failed to save quotas: ' + (e.message || '')); }
    setQuotaSaving(false);
  }

  function handleApprovalDone() {
    setApprovalTarget(null);
  }

  // Count of people expected but with no attendance record today
  const missingMembers = useMemo(() => {
    if (expectedMembers.length === 0) return [];
    const clockedIds = new Set(todayRecords.map(r => r.userId));
    return expectedMembers
      .filter(m => !clockedIds.has(m.id))
      .map(m => ({
        // Synthetic record shape so the table can render them
        id: `missing_${m.id}`,
        userId: m.id,
        userName: m.name,
        userRole: m.role,
        userEmail: m.email,
        location: null,
        clockIn: null,
        clockOut: null,
        status: 'missing',
        __missing: true,
      }));
  }, [expectedMembers, todayRecords]);

  // Drop stale leak-through: the realtime query returns any record with an open
  // status (clocked-in / on-break / pending-approval) regardless of date so that
  // a night shift spanning midnight stays visible. The side effect is that old
  // never-closed records from earlier days also appear under "Today". Hide
  // anything whose effective status has rolled over to auto-closed AND whose
  // date isn't today.
  // todayDateStr and the memos below intentionally re-derive on every tick
  // bump so a calendar-day rollover (and stale-threshold crossings) flow
  // through to the filtered list and stat tiles without waiting for a
  // Firestore push.
  const todayDateStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const cleanedTodayRecords = useMemo(() => {
    return todayRecords.filter(r => {
      if (r.date === todayDateStr) return true;
      // Older record: only keep if it's still genuinely open (not over the 8h cap)
      return getEffectiveStatus(r) !== 'auto-closed';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayRecords, todayDateStr, tick]);

  // Filter today's records (with optional "missing" synthesis)
  const filteredToday = useMemo(() => {
    // Start with the real records
    let list = cleanedTodayRecords.slice();

    // If the user picks status="missing", REPLACE list with missing members;
    // if any other status, exclude missing synth rows entirely.
    // For "all statuses" we merge both so Boss/TL see a complete picture.
    if (filterStatus === 'missing') {
      list = missingMembers.slice();
    } else if (!filterStatus) {
      list = [...list, ...missingMembers];
    }

    if (search) {
      const s = search.toLowerCase();
      list = list.filter(r => (r.userName || '').toLowerCase().includes(s) || (r.userEmail || '').toLowerCase().includes(s));
    }
    if (filterLoc)    list = list.filter(r => r.location === filterLoc);
    if (filterStatus && filterStatus !== 'missing') list = list.filter(r => getEffectiveStatus(r) === filterStatus);
    if (filterRole)   list = list.filter(r => (r.userRole || '').toLowerCase() === filterRole);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanedTodayRecords, missingMembers, search, filterLoc, filterStatus, filterRole, tick]);

  const hasTeamFilters = !!(search || filterLoc || filterStatus || filterRole);

  // Filter history records
  const filteredHistory = useMemo(() => {
    let list = history;
    if (historyDay) list = list.filter(r => r.date === historyDay);
    if (historySearch) {
      const s = historySearch.toLowerCase();
      list = list.filter(r => (r.userName || '').toLowerCase().includes(s) || (r.userEmail || '').toLowerCase().includes(s));
    }
    if (historyLoc)    list = list.filter(r => r.location === historyLoc);
    if (historyStatus) list = list.filter(r => getEffectiveStatus(r) === historyStatus);
    if (historyRole)   list = list.filter(r => (r.userRole || '').toLowerCase() === historyRole);
    if (historyMinHours) {
      const minMs = Number(historyMinHours) * 3600000;
      if (!Number.isNaN(minMs) && minMs > 0) {
        list = list.filter(r => (calcTimes(r).totalWorkMs || 0) >= minMs);
      }
    }
    return list;
  }, [history, historyDay, historySearch, historyLoc, historyStatus, historyRole, historyMinHours]);

  const hasHistoryFilters = !!(historyDay || historySearch || historyLoc || historyStatus || historyRole || historyMinHours);
  function clearTeamFilters()    { setSearch(''); setFilterLoc(''); setFilterStatus(''); setFilterRole(''); }
  function clearHistoryFilters() { setHistorySearch(''); setHistoryDay(''); setHistoryLoc(''); setHistoryStatus(''); setHistoryRole(''); setHistoryMinHours(''); }

  // Pending clock-in edit requests (derived from todayRecords in real time)
  const pendingEditRequests = useMemo(
    () => todayRecords.filter(r => r.editClockInRequest?.status === 'pending'),
    [todayRecords]
  );

  // Stats
  const stats = useMemo(() => {
    // Use cleanedTodayRecords + effective status so the tile counts match the
    // filter results — auto-closed records that appeared via the open-status
    // leak-through don't get tallied as "Working".
    const working = cleanedTodayRecords.filter(r => getEffectiveStatus(r) === 'clocked-in').length;
    const onBreak = cleanedTodayRecords.filter(r => getEffectiveStatus(r) === 'on-break').length;
    const pending = cleanedTodayRecords.filter(r => getEffectiveStatus(r) === 'pending-approval').length;
    const done = cleanedTodayRecords.filter(r => getEffectiveStatus(r) === 'clocked-out').length;
    const wfh = cleanedTodayRecords.filter(r => r.location === 'wfh').length;
    const missing = missingMembers.length;
    return { total: cleanedTodayRecords.length, working, onBreak, pending, done, wfh, missing };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanedTodayRecords, missingMembers, tick]);

  // Auth not resolved yet — render nothing rather than crash.
  if (!currentUser) return null;

  return (
    <div>
      <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: '#0f172a' }}>Attendance</h4>
          <p className="text-muted mb-0" style={{ fontSize: '0.82rem' }}>
            {(isBoss || isOL) ? 'Company-wide attendance tracking' : canSeeTeam ? 'Your team attendance' : 'Your attendance'}
          </p>
        </div>
        <div className="d-flex gap-2">
          {(isBoss
              ? ['today', 'history', 'roster', 'quotas']
              : isOL ? ['today', 'team', 'history', 'roster']
              : canSeeTeam ? ['today', 'team', 'history']
              : ['today', 'history']
            ).map(t => (
            <button key={t} className={`btn btn-sm px-3 ${tab === t ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ borderRadius: 8, fontSize: '0.82rem', fontWeight: 600 }} onClick={() => setTab(t)}>
              {t === 'today' ? 'Today' : t === 'team' ? 'Team' : t === 'quotas' ? 'Leave Quotas' : t === 'roster' ? 'Roster' : 'History'}
            </button>
          ))}
        </div>
      </div>

      <div className="row g-4">
        {/* Top: Clock widget — centered for everyone except Boss, Today tab only.
            TL/OL/PCTL/APC/IPC all get the same focused clock experience;
            Boss doesn't clock in so it's hidden for them. */}
        {!isBoss && tab === 'today' && (
          <div className="col-12 d-flex justify-content-center">
            <div style={{ width: '100%', maxWidth: 1100 }}>
            <MyMonthlyAttendance userId={currentUser.uid} displayName={currentUser.displayName} />
            <ClockWidget />

            {/* Pending approvals for TL */}
            {isTL && (pendingApprovals.length > 0 || pendingEditRequests.length > 0 || pendingEditOutRequests.length > 0) && (
              <div className="card border-0 shadow-sm mt-3" style={{ borderRadius: 16 }}>
                <div className="card-body p-3">
                  <div className="d-flex align-items-center gap-2 mb-3">
                    <span className="rounded-circle" style={{ width: 8, height: 8, background: '#dc2626', boxShadow: '0 0 0 3px #dc262630' }} />
                    <span className="fw-bold" style={{ fontSize: '0.82rem', color: '#dc2626' }}>Pending Approvals</span>
                    <span className="badge bg-danger rounded-pill ms-auto">{pendingApprovals.length + pendingEditRequests.length + pendingEditOutRequests.length}</span>
                  </div>
                  <div className="d-flex flex-column gap-2">
                    {pendingApprovals.map(r => (
                      <div key={`co-${r.id}`} className="rounded-3 p-2 d-flex align-items-center justify-content-between"
                        style={{ background: '#fef2f2', border: '1px solid #fecaca', cursor: 'pointer' }}
                        onClick={() => setApprovalTarget(r)}>
                        <div>
                          <div className="fw-semibold d-flex align-items-center gap-1" style={{ fontSize: '0.8rem' }}>
                            <i className="bi bi-box-arrow-right" style={{ fontSize: '0.72rem', color: '#dc2626' }} />
                            {r.userName}
                          </div>
                          <div className="text-muted" style={{ fontSize: '0.65rem' }}>Clock-out · {fmtTime(r.clockIn)} · {locLabel(r.location)}</div>
                        </div>
                        <span className="badge rounded-pill" style={{ background: '#3b82f6', color: '#fff', fontSize: '0.6rem' }}>Review</span>
                      </div>
                    ))}
                    {pendingEditRequests.map(r => (
                      <div key={`ed-${r.id}`} className="rounded-3 p-2 d-flex align-items-center justify-content-between"
                        style={{ background: '#eff6ff', border: '1px solid #bfdbfe', cursor: 'pointer' }}
                        onClick={() => setEditRequestTarget(r)}>
                        <div>
                          <div className="fw-semibold d-flex align-items-center gap-1" style={{ fontSize: '0.8rem' }}>
                            <i className="bi bi-pencil-square" style={{ fontSize: '0.72rem', color: '#2563eb' }} />
                            {r.userName}
                          </div>
                          <div className="text-muted" style={{ fontSize: '0.65rem' }}>
                            Edit clock-in · {fmtTime(r.clockIn)} → {fmtTime(r.editClockInRequest?.requestedClockIn)}
                          </div>
                        </div>
                        <span className="badge rounded-pill" style={{ background: '#2563eb', color: '#fff', fontSize: '0.6rem' }}>Review</span>
                      </div>
                    ))}
                    {pendingEditOutRequests.map(r => (
                      <div key={`eo-${r.id}`} className="rounded-3 p-2 d-flex align-items-center justify-content-between"
                        style={{ background: '#fef2f2', border: '1px solid #fecaca', cursor: 'pointer' }}
                        onClick={() => setEditOutTarget(r)}>
                        <div>
                          <div className="fw-semibold d-flex align-items-center gap-1" style={{ fontSize: '0.8rem' }}>
                            <i className="bi bi-clock-history" style={{ fontSize: '0.72rem', color: '#dc2626' }} />
                            {r.userName}
                          </div>
                          <div className="text-muted" style={{ fontSize: '0.65rem' }}>
                            Adjust clock-out · {r.date} · was {fmtTime(r.clockOut)} → wants {fmtTime(r.editClockOutRequest?.requestedClockOut)}
                          </div>
                        </div>
                        <span className="badge rounded-pill" style={{ background: '#dc2626', color: '#fff', fontSize: '0.6rem' }}>Review</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>
        )}

        {/* Team view lives in its own tab for managers ('team'), or on 'today'
            for Boss (who doesn't clock in). History tab stays shared. */}
        {((tab === 'team' && canSeeTeam) || (tab === 'today' && isBoss) || tab === 'history') && (
        <div className="col-12">
          {(tab === 'team' || (tab === 'today' && isBoss)) && canSeeTeam && (
            <>
              {/* Stats */}
              <div className="d-flex gap-2 mb-3 flex-wrap">
                {[
                  { key: '',                 label: 'Total',    value: stats.total,   color: '#3b82f6', bg: '#eff6ff' },
                  { key: 'clocked-in',       label: 'Working',  value: stats.working, color: '#16a34a', bg: '#f0fdf4' },
                  { key: 'on-break',         label: 'On Break', value: stats.onBreak, color: '#f59e0b', bg: '#fffbeb' },
                  { key: 'pending-approval', label: 'Pending',  value: stats.pending, color: '#dc2626', bg: '#fef2f2' },
                  { key: 'clocked-out',      label: 'Done',     value: stats.done,    color: '#64748b', bg: '#f9fafb' },
                  { key: 'missing',          label: 'Missing',  value: stats.missing, color: '#ef4444', bg: '#fef2f2' },
                ].map(s => {
                  const active = filterStatus === s.key;
                  return (
                    <button
                      type="button"
                      key={s.label}
                      onClick={() => setFilterStatus(s.key)}
                      className="rounded-3 px-3 py-2 text-center border-0"
                      title={`Show ${s.label.toLowerCase()}`}
                      style={{
                        background: s.bg, minWidth: 78, cursor: 'pointer',
                        border: `1px solid ${s.color}${active ? '55' : '15'}`,
                        boxShadow: active ? `0 0 0 2px ${s.color}55` : 'none',
                        transition: 'box-shadow 0.15s, border-color 0.15s',
                      }}
                    >
                      <div className="fw-bold" style={{ fontSize: '1.1rem', color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: '0.55rem', color: s.color, fontWeight: 600, textTransform: 'uppercase' }}>{s.label}</div>
                    </button>
                  );
                })}
              </div>

              {/* Filters */}
              <div className="d-flex gap-2 mb-3 flex-wrap align-items-center">
                <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
                  <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}><i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} /></span>
                  <input type="text" className="form-control border-0" placeholder="Search name or email…" value={search} onChange={e => setSearch(e.target.value)} style={{ background: '#f1f5f9' }} />
                </div>
                <select className="form-select form-select-sm" value={filterLoc} onChange={e => setFilterLoc(e.target.value)} style={{ maxWidth: 150 }}>
                  <option value="">All Locations</option>
                  <option value="bahria">Bahria Office</option>
                  <option value="lakecity">Lake City Office</option>
                  <option value="wfh">WFH</option>
                </select>
                {isBoss && (
                  <select className="form-select form-select-sm" value={filterRole} onChange={e => setFilterRole(e.target.value)} style={{ maxWidth: 160 }}>
                    <option value="">All Roles</option>
                    {ROLE_OPTIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                )}
                <select className="form-select form-select-sm" value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ maxWidth: 150 }}>
                  <option value="">All Status</option>
                  <option value="clocked-in">Working</option>
                  <option value="on-break">On Break</option>
                  <option value="pending-approval">Pending</option>
                  <option value="clocked-out">Done</option>
                  <option value="missing">Not Clocked In</option>
                </select>
                {hasTeamFilters && (
                  <button className="btn btn-sm btn-link text-muted p-0 ms-1" style={{ fontSize: '0.74rem', textDecoration: 'none' }} onClick={clearTeamFilters}>
                    <i className="bi bi-x-circle me-1" />Clear filters
                  </button>
                )}
                <span className="text-muted ms-auto" style={{ fontSize: '0.72rem' }}>
                  {filteredToday.length} {filteredToday.length === 1 ? 'entry' : 'entries'}
                </span>
              </div>

              {/* Team table */}
              {loading ? (
                <div className="text-center py-4"><div className="spinner-border text-primary" /></div>
              ) : filteredToday.length === 0 ? (
                <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16 }}>
                  <i className="bi bi-people text-muted" style={{ fontSize: '2rem', opacity: 0.3 }} />
                  <p className="text-muted mt-2 mb-0">No attendance records for today.</p>
                </div>
              ) : (
                <div className="card border-0 shadow-sm" style={{ borderRadius: 16, overflow: 'hidden' }}>
                  <div className="table-responsive">
                    <table className="table table-hover mb-0 align-middle" style={{ fontSize: '0.82rem' }}>
                      <thead><tr style={{ background: '#f8f9fa' }}>
                        <th className="fw-semibold text-muted border-0 ps-3" style={{ fontSize: '0.72rem' }}>Date</th>
                        <th className="fw-semibold text-muted border-0" style={{ fontSize: '0.72rem' }}>Name</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Location</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Clock In</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Worked</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Break</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Status</th>
                        {(isTL || isBoss) && <th className="fw-semibold text-muted border-0" style={{ fontSize: '0.72rem' }}></th>}
                      </tr></thead>
                      <tbody>
                        {filteredToday.map(r => {
                          const missing = r.__missing;
                          const t = missing ? { totalWorkMs: 0, totalBreakMs: 0 } : calcTimes(r);
                          const eff = missing ? null : getEffectiveStatus(r);
                          const sc = missing ? '#ef4444' : statusColor(eff);
                          return (
                            <tr key={r.id} style={missing ? { background: '#fef9f9' } : undefined}>
                              <td className="ps-3 fw-semibold" style={missing ? { color: '#94a3b8' } : { color: '#0f172a' }}>
                                {missing ? todayDateStr : r.date}
                                {!missing && r.date !== todayDateStr && (
                                  <div className="text-muted" style={{ fontSize: '0.6rem', fontWeight: 600 }}>
                                    <i className="bi bi-arrow-down-short" />carried from
                                  </div>
                                )}
                              </td>
                              <td>
                                <div className="d-flex align-items-center gap-2">
                                  <span className="rounded-circle" style={{ width: 8, height: 8, background: sc, flexShrink: 0 }} />
                                  <div>
                                    <div className="fw-semibold" style={missing ? { color: '#94a3b8' } : undefined}>{r.userName}</div>
                                    <div className="text-muted" style={{ fontSize: '0.65rem' }}>{r.userRole?.toUpperCase()}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="text-center">
                                {missing ? <span className="text-muted" style={{ fontSize: '0.7rem' }}>—</span>
                                  : <span className="badge bg-light text-dark border" style={{ fontSize: '0.62rem' }}>{locLabel(r.location)}</span>}
                              </td>
                              <td className="text-center">{missing ? <span className="text-muted">—</span> : fmtTime(r.clockIn)}</td>
                              <td className="text-center fw-semibold" style={{ color: missing ? '#cbd5e1' : '#16a34a' }}>
                                {missing ? '—' : fmtDuration(t.totalWorkMs)}
                              </td>
                              <td className="text-center" style={{ color: missing ? '#cbd5e1' : '#f59e0b' }}>
                                {missing ? '—' : (
                                  (r.breaks || []).length > 0 ? (
                                    <button
                                      type="button"
                                      className="btn btn-link p-0 fw-semibold"
                                      style={{
                                        color: '#f59e0b',
                                        textDecoration: 'underline dotted',
                                        textDecorationThickness: '1px',
                                        textUnderlineOffset: '3px',
                                        fontSize: '0.85rem',
                                        fontWeight: 600,
                                      }}
                                      title={breaksTooltip(r.breaks)}
                                      onClick={() => setBreakDetailsTarget(r)}
                                    >
                                      {fmtDuration(t.totalBreakMs)}
                                    </button>
                                  ) : fmtDuration(t.totalBreakMs)
                                )}
                              </td>
                              <td className="text-center">
                                <span className="badge rounded-pill" style={{ background: `${sc}15`, color: sc, fontSize: '0.62rem', border: `1px solid ${sc}30` }}>
                                  {missing ? 'Not Clocked In' : statusLabel(eff)}
                                </span>
                              </td>
                              {(isTL || isBoss) && (
                                <td>
                                  {!missing && isTL && r.status === 'pending-approval' && (
                                    <button className="btn btn-sm btn-outline-primary rounded-pill px-2 me-1" style={{ fontSize: '0.65rem' }}
                                      onClick={() => setApprovalTarget(r)}>Review</button>
                                  )}
                                  {/* Force-close — Boss only in v2. OL no longer
                                      sees this button: the pg_cron job at 8h
                                      handles forgotten clock-outs automatically.
                                      Server gate (att_force_close in mig 126)
                                      also rejects OL even if a stale UI tries.
                                      Hidden when the shift is already closed
                                      (clocked-out, auto-closed, or any row that
                                      already has a clock_out timestamp). A
                                      "Close" button on an already-closed shift
                                      doesn't do anything useful and confuses
                                      the manager. */}
                                  {!missing && isBoss && eff && eff !== 'clocked-out' && eff !== 'auto-closed' && !r.clockOut && (
                                    <button className="btn btn-sm btn-outline-danger rounded-pill px-2" style={{ fontSize: '0.65rem' }}
                                      title="Close this user's session"
                                      onClick={() => setForceCloseTarget(r)}>
                                      <i className="bi bi-box-arrow-right me-1" />Close
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── History Tab ── */}
          {tab === 'history' && (
            <>
              {/* For APC/IPC: show today's timeline above the history table
                  so they can see what happened so far today in context. */}
              {!canSeeTeam && (
                <div className="mb-3">
                  <TodayTimeline record={myTodayRecord} />
                </div>
              )}
              {/* Row 1: month + day + refresh + export + count */}
              <div className="d-flex gap-2 mb-2 align-items-center flex-wrap">
                <label className="small text-muted mb-0" style={{ fontSize: '0.72rem' }}>Month</label>
                <input type="month" className="form-control form-control-sm" value={historyMonth} onChange={e => setHistoryMonth(e.target.value)} style={{ maxWidth: 160 }} />
                <label className="small text-muted mb-0 ms-1" style={{ fontSize: '0.72rem' }}>Day</label>
                <input
                  type="date"
                  className="form-control form-control-sm"
                  value={historyDay}
                  onChange={e => setHistoryDay(e.target.value)}
                  min={`${historyMonth}-01`}
                  max={(() => { const { end } = getMonthRange(historyMonth); return end; })()}
                  style={{ maxWidth: 170 }}
                  placeholder="Any day"
                />
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                  onClick={loadHistory} disabled={historyLoading} title="Reload (include today's latest)">
                  <i className="bi bi-arrow-clockwise" />Refresh
                </button>
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                  onClick={() => exportToCSV(filteredHistory)} disabled={filteredHistory.length === 0}>
                  <i className="bi bi-download" />Export CSV
                </button>
                <span className="text-muted ms-auto" style={{ fontSize: '0.72rem' }}>
                  {filteredHistory.length} of {history.length} record{history.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Row 2: granular filters */}
              <div className="d-flex gap-2 mb-3 align-items-center flex-wrap">
                <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
                  <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}><i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} /></span>
                  <input type="text" className="form-control border-0" placeholder="Search name or email…" value={historySearch} onChange={e => setHistorySearch(e.target.value)} style={{ background: '#f1f5f9' }} />
                </div>
                <select className="form-select form-select-sm" value={historyLoc} onChange={e => setHistoryLoc(e.target.value)} style={{ maxWidth: 150 }}>
                  <option value="">All Locations</option>
                  <option value="bahria">Bahria Office</option>
                  <option value="lakecity">Lake City Office</option>
                  <option value="wfh">WFH</option>
                </select>
                {isBoss && (
                  <select className="form-select form-select-sm" value={historyRole} onChange={e => setHistoryRole(e.target.value)} style={{ maxWidth: 160 }}>
                    <option value="">All Roles</option>
                    {ROLE_OPTIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </select>
                )}
                <select className="form-select form-select-sm" value={historyStatus} onChange={e => setHistoryStatus(e.target.value)} style={{ maxWidth: 150 }}>
                  <option value="">All Status</option>
                  <option value="clocked-in">Working</option>
                  <option value="on-break">On Break</option>
                  <option value="pending-approval">Pending</option>
                  <option value="clocked-out">Done</option>
                </select>
                <div className="input-group input-group-sm" style={{ maxWidth: 140 }} title="Only show days where the person worked at least N hours">
                  <span className="input-group-text border-0" style={{ background: '#f1f5f9', fontSize: '0.68rem' }}>≥ hrs</span>
                  <input
                    type="number"
                    min="0" step="0.5"
                    className="form-control border-0"
                    placeholder="0"
                    value={historyMinHours}
                    onChange={e => setHistoryMinHours(e.target.value)}
                    style={{ background: '#f1f5f9' }}
                  />
                </div>
                {hasHistoryFilters && (
                  <button className="btn btn-sm btn-link text-muted p-0" style={{ fontSize: '0.74rem', textDecoration: 'none' }} onClick={clearHistoryFilters}>
                    <i className="bi bi-x-circle me-1" />Clear filters
                  </button>
                )}
              </div>

              {historyLoading ? (
                <div className="text-center py-4"><div className="spinner-border text-primary" /></div>
              ) : filteredHistory.length === 0 ? (
                <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16 }}>
                  <i className="bi bi-calendar-x text-muted" style={{ fontSize: '2rem', opacity: 0.3 }} />
                  <p className="text-muted mt-2 mb-0">
                    {hasHistoryFilters ? 'No records match the current filters.' : 'No records for this month.'}
                  </p>
                  {hasHistoryFilters && (
                    <button className="btn btn-sm btn-outline-secondary mt-2" onClick={clearHistoryFilters}>Clear filters</button>
                  )}
                </div>
              ) : (
                <div className="card border-0 shadow-sm" style={{ borderRadius: 16, overflow: 'hidden' }}>
                  <div className="table-responsive">
                    <table className="table table-hover mb-0 align-middle" style={{ fontSize: '0.82rem' }}>
                      <thead><tr style={{ background: '#f8f9fa' }}>
                        <th className="fw-semibold text-muted border-0 ps-3" style={{ fontSize: '0.72rem' }}>Date</th>
                        {canSeeTeam && <th className="fw-semibold text-muted border-0" style={{ fontSize: '0.72rem' }}>Name</th>}
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Location</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>In</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Out</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Worked</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Break</th>
                        <th className="fw-semibold text-muted border-0 text-center" style={{ fontSize: '0.72rem' }}>Status</th>
                      </tr></thead>
                      <tbody>
                        {filteredHistory.map(r => {
                          const t = calcTimes(r);
                          const eff = getEffectiveStatus(r);
                          const sc = statusColor(eff);
                          return (
                            <tr key={r.id}>
                              <td className="ps-3 fw-semibold">{r.date}</td>
                              {canSeeTeam && <td>{r.userName} <span className="text-muted" style={{ fontSize: '0.62rem' }}>({r.userRole})</span></td>}
                              <td className="text-center"><span className="badge bg-light text-dark border" style={{ fontSize: '0.62rem' }}>{locLabel(r.location)}</span></td>
                              <td className="text-center"><TimeWithDate ts={r.clockIn} rowDate={r.date} /></td>
                              <td className="text-center">
                                <TimeWithDate ts={r.clockOut} rowDate={r.date} />
                                {r.autoClosed && (
                                  <i className="bi bi-exclamation-triangle-fill ms-1" title="Auto-closed — user forgot to clock out" style={{ color: '#dc2626', fontSize: '0.68rem' }} />
                                )}
                              </td>
                              <td className="text-center fw-semibold" style={{ color: '#16a34a' }}>{fmtDuration(t.totalWorkMs)}</td>
                              <td className="text-center" style={{ color: '#f59e0b' }}>{fmtDuration(t.totalBreakMs)}</td>
                              <td className="text-center">
                                <span className="badge rounded-pill" style={{ background: `${sc}15`, color: sc, fontSize: '0.62rem', border: `1px solid ${sc}30` }}>
                                  {statusLabel(eff)}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        )}
      </div>

      {/* Roster Tab (Boss + OL) — per-user month summary with manual override */}
      {tab === 'roster' && (isBoss || isOL) && (
        <RosterTab
          isBoss={isBoss}
          isOL={isOL}
          currentUser={currentUser}
          userRole={userRole}
          expectedMembers={expectedMembers}
        />
      )}

      {/* Leave Quotas Tab (Boss Only) */}
      {tab === 'quotas' && isBoss && (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 16, maxWidth: 520 }}>
          <div className="card-body p-4">
            <h6 className="fw-bold mb-1">Monthly Leave Quotas</h6>
            <p className="text-muted small mb-4">Set the default leave quota per month for all employees. Changes apply immediately.</p>

            {quotaSuccess && (
              <div className="alert alert-success py-2 small d-flex align-items-center gap-2 mb-3">
                <i className="bi bi-check-circle-fill" /> {quotaSuccess}
              </div>
            )}
            {quotaError && (
              <div className="alert alert-danger py-2 small d-flex align-items-center gap-2 mb-3">
                <i className="bi bi-exclamation-circle-fill" /> {quotaError}
              </div>
            )}

            {[
              { label: 'Medical Leave',  value: quotaMedical,   setter: setQuotaMedical,   icon: 'bi-heart-pulse', color: '#dc3545' },
              { label: 'Emergency Leave',value: quotaEmergency, setter: setQuotaEmergency, icon: 'bi-exclamation-octagon', color: '#fd7e14' },
              { label: 'Work From Home', value: quotaWfh,       setter: setQuotaWfh,       icon: 'bi-house',       color: '#0d6efd' },
            ].map(q => (
              <div key={q.label} className="d-flex align-items-center gap-3 mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 36, height: 36, background: `${q.color}15` }}>
                  <i className={`bi ${q.icon}`} style={{ color: q.color, fontSize: '0.9rem' }} />
                </div>
                <div className="flex-grow-1">
                  <label className="form-label small fw-semibold mb-0">{q.label}</label>
                </div>
                <div className="d-flex align-items-center gap-2" style={{ width: 120 }}>
                  <input type="number" className="form-control form-control-sm text-center" min={0} max={31}
                    value={q.value} onChange={e => q.setter(e.target.value)} style={{ width: 60 }} />
                  <span className="text-muted small">/ mo</span>
                </div>
              </div>
            ))}

            <button className="btn btn-dark btn-sm px-4 d-inline-flex align-items-center gap-1 mt-2"
              onClick={handleSaveQuota} disabled={quotaSaving}>
              {quotaSaving ? <><span className="spinner-border spinner-border-sm" /> Saving...</> : <><i className="bi bi-check-lg" /> Save Quotas</>}
            </button>
          </div>
        </div>
      )}

      {/* Quota conflict confirmation modal */}
      {quotaConflicts && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={() => setQuotaConflicts(null)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, zIndex: 1, borderRadius: 14, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div className="card-body p-4" style={{ overflowY: 'auto' }}>
              <div className="d-flex align-items-start gap-3 mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#fff3e0' }}>
                  <i className="bi bi-exclamation-triangle-fill text-warning" />
                </div>
                <div>
                  <p className="fw-semibold mb-0">Some users already exceeded the new quota</p>
                  <p className="text-muted mb-0 small">Their existing approved leaves this month stay <strong>paid</strong>. The new quota will apply to any future requests this month.</p>
                </div>
              </div>
              <div className="rounded-2 p-2 mb-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', maxHeight: 220, overflowY: 'auto' }}>
                <table className="table table-sm mb-0" style={{ fontSize: '0.78rem' }}>
                  <thead>
                    <tr><th>User</th><th>Type</th><th>Used</th><th>New quota</th></tr>
                  </thead>
                  <tbody>
                    {quotaConflicts.map((c, i) => (
                      <tr key={i}>
                        <td>{c.userName}</td>
                        <td className="text-capitalize">{c.type}</td>
                        <td><strong>{c.used}</strong></td>
                        <td>{c.newQuota}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="d-flex gap-2 justify-content-end">
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setQuotaConflicts(null)} disabled={quotaSaving}>Cancel</button>
                <button className="btn btn-sm btn-dark px-3" onClick={handleConfirmSaveWithConflicts} disabled={quotaSaving}>
                  {quotaSaving ? <><span className="spinner-border spinner-border-sm me-1" />Saving…</> : 'Save Anyway (existing stay paid)'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Approval Modal */}
      {approvalTarget && <ApprovalModal record={approvalTarget} onClose={() => setApprovalTarget(null)} onDone={handleApprovalDone} />}
      {breakDetailsTarget && <BreakDetailsModal record={breakDetailsTarget} onClose={() => setBreakDetailsTarget(null)} />}

      {/* Edit Clock-In Request Modal */}
      {editRequestTarget && (
        <EditRequestModal
          record={editRequestTarget}
          onClose={() => setEditRequestTarget(null)}
          onDone={() => setEditRequestTarget(null)}
        />
      )}

      {/* Edit Clock-Out (Adjust) Request Modal */}
      {editOutTarget && (
        <EditOutRequestModal
          record={editOutTarget}
          approverId={currentUser.uid}
          onClose={() => setEditOutTarget(null)}
          onDone={() => setEditOutTarget(null)}
        />
      )}

      {/* Manager force-close session (OL/Boss) */}
      {forceCloseTarget && (
        <ForceCloseModal
          record={forceCloseTarget}
          closer={{ id: currentUser.uid, name: currentUser.displayName || currentUser.email, role: userRole }}
          onClose={() => setForceCloseTarget(null)}
          onDone={() => setForceCloseTarget(null)}
        />
      )}
    </div>
  );
}

/* Review modal for clock-out adjust requests */
function EditOutRequestModal({ record, approverId, onClose, onDone }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const req = record.editClockOutRequest || {};

  async function handleApprove() {
    setError('');
    try {
      setSaving(true);
      await approveEditClockOut(record.id, approverId);
      onDone();
    } catch (err) { setError(err.message || 'Failed'); setSaving(false); }
  }

  async function handleReject() {
    if (!rejectReason.trim()) { setError('Please provide a reason.'); return; }
    setError('');
    try {
      setSaving(true);
      await rejectEditClockOut(record.id, approverId, rejectReason.trim());
      onDone();
    } catch (err) { setError(err.message || 'Failed'); setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={saving ? undefined : onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 480, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-clock-history me-2" style={{ color: '#dc2626' }} />Review Clock-Out Adjustment</h6>
            <button className="btn btn-sm btn-light rounded-circle" onClick={onClose} disabled={saving} style={{ width: 32, height: 32 }}>
              <i className="bi bi-x-lg" />
            </button>
          </div>
          <div className="mb-3 p-3 rounded-3" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
            <div className="fw-bold mb-1" style={{ fontSize: '0.86rem', color: '#991b1b' }}>{record.userName} · {record.date}</div>
            <div className="small mb-1" style={{ fontSize: '0.78rem' }}>
              Shift started at <strong>{fmtTime(record.clockIn)}</strong>, auto-closed at <strong>{fmtTime(record.clockOut)}</strong>.
            </div>
            <div className="small" style={{ fontSize: '0.78rem' }}>
              Requested clock-out: <strong style={{ color: '#16a34a' }}>{fmtTime(req.requestedClockOut)}</strong>
            </div>
          </div>
          {req.reason && (
            <div className="mb-3">
              <div className="small text-muted mb-1" style={{ fontSize: '0.7rem', fontWeight: 600 }}>REASON</div>
              <div className="p-2 rounded-2" style={{ background: '#f8fafc', fontSize: '0.82rem' }}>{req.reason}</div>
            </div>
          )}
          {rejecting && (
            <div className="mb-3">
              <label className="small text-muted d-block mb-1" style={{ fontSize: '0.72rem', fontWeight: 600 }}>Rejection reason</label>
              <textarea className="form-control form-control-sm" rows="2"
                style={{ borderRadius: 8, fontSize: '0.82rem' }}
                value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            </div>
          )}
          {error && <div className="alert alert-danger py-2 small mb-3" style={{ fontSize: '0.78rem' }}>{error}</div>}
          <div className="d-flex gap-2 justify-content-end">
            {!rejecting ? (
              <>
                <button className="btn btn-sm btn-outline-danger px-3" onClick={() => setRejecting(true)} disabled={saving}>Reject</button>
                <button className="btn btn-sm px-4 text-white" style={{ background: '#16a34a', border: 'none' }} onClick={handleApprove} disabled={saving}>
                  {saving ? <><span className="spinner-border spinner-border-sm me-1" />…</> : 'Approve'}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => { setRejecting(false); setError(''); }} disabled={saving}>Back</button>
                <button className="btn btn-sm btn-danger px-4" onClick={handleReject} disabled={saving}>
                  {saving ? <><span className="spinner-border spinner-border-sm me-1" />…</> : 'Reject'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
