// Clock-in / break / clock-out state and actions, shared by ClockWidget (the
// Attendance page) and ClockQuickControl (the Today strip). Moved verbatim out
// of ClockWidget — same rules: location picker, the APC GMV gate (fails open),
// the APC/IPC daily-tasks check before clock-out, the TL-status branch that
// turns clock-out into a request-with-note, and the onActiveRecord
// subscription with its 5 s watchdog. Each caller gets its own subscription.
//
// `modals` renders the GMV gate, the "You're clocked in" toast and the
// clock-out request modal; mount it once wherever the hook is used.
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  clockIn, clockOut, startBreak, endBreak,
  requestClockOut, onActiveRecord, resumeShift,
  checkApcDailyTasks, setAutoClockOut as apiSetAutoClockOut,
  setAutoClockOutNote as apiSetAutoClockOutNote,
} from '../../lib/attendanceApi';
import ApcGmvGateModal from './ApcGmvGateModal';
import { apcGmvStatus, submitApcGmv } from '../../lib/apcGmvApi';

export function useClockActions() {
  const { user, profile } = useAuth();
  const currentUser = user ? {
    uid: user.id,
    email: user.email,
    displayName: profile?.display_name || '',
  } : null;
  const userRole = profile?.role || '';
  const apcProfile = profile ? {
    userName:  profile.display_name || '',
    ownerId:   profile.reports_to || null,
    ownerName: profile.reports_to_name || '', // populated by the effect below
    assignedBrands: profile.assigned_brands || [], // checkApcDailyTasks queries server-side
  } : null;

  const _uid = currentUser?.uid;
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [showClockIn, setShowClockIn] = useState(false);
  const [showClockOut, setShowClockOut] = useState(false);
  const [clockOutNote, setClockOutNote] = useState('');
  const [taskError, setTaskError] = useState('');
  // APC GMV-on-clock-in gate (mig 311)
  const [showGmvGate, setShowGmvGate] = useState(false);
  const [gmvStatus, setGmvStatus] = useState(null);
  const [pendingLocation, setPendingLocation] = useState(null);
  const [clockedInToast, setClockedInToast] = useState(false);

  // Auto-dismiss the "You're clocked in" confirmation toast.
  useEffect(() => {
    if (!clockedInToast) return undefined;
    const t = setTimeout(() => setClockedInToast(false), 2800);
    return () => clearTimeout(t);
  }, [clockedInToast]);

  const isApcOrIpc = userRole === 'apc' || userRole === 'ipc';
  const isTL = userRole === 'tl';
  const ownerId = apcProfile?.ownerId || null;
  const ownerName = apcProfile?.ownerName || '';
  const userName = currentUser?.displayName || apcProfile?.userName || currentUser?.email?.split('@')[0] || '';
  const [tlStatus, setTlStatus] = useState(null);
  const [tlAutoNote, setTlAutoNote] = useState('');
  const [autoClockOutEnabled, setAutoClockOutEnabled] = useState(false);
  const [autoClockOutNote, setAutoClockOutNote] = useState('');

  // Real-time listener for active record (cross-midnight safe).
  // Defense in depth: hard 5-second watchdog flips loading=false even
  // if the subscription never delivers — never leave the user staring
  // at a permanent spinner. Plus we expose refetch() so action handlers
  // can force-refresh after clock-in/out/break without waiting for
  // realtime (which is unreliable in v2 right now).
  const recordSubRef = React.useRef(null);
  useEffect(() => {
    if (!_uid) return;
    let alive = true;
    const watchdog = setTimeout(() => {
      if (alive) {
        setLoading((wasLoading) => {
          if (wasLoading) console.warn('[useClockActions] watchdog: forcing loading=false after 5s');
          return false;
        });
      }
    }, 5000);
    const unsub = onActiveRecord(_uid, r => {
      if (!alive) return;
      setRecord(r);
      setLoading(false);
      clearTimeout(watchdog);
      if (isTL && r && r.autoClockOut !== undefined) {
        setAutoClockOutEnabled(!!r.autoClockOut);
        setAutoClockOutNote(r.autoClockOutNote || '');
      }
    });
    recordSubRef.current = unsub;
    return () => { alive = false; clearTimeout(watchdog); unsub(); };
  }, [_uid, isTL]);
  const refetchRecord = () => recordSubRef.current?.refetch?.();

  // APC/IPC: check if TL is currently clocked in
  useEffect(() => {
    if (!isApcOrIpc || !ownerId) { setTlStatus('available'); return; }
    const unsub = onActiveRecord(ownerId, (tlRecord) => {
      if (!tlRecord || tlRecord.status === 'clocked-out') {
        setTlStatus('not_clocked_in'); setTlAutoNote('');
      } else if (tlRecord.autoClockOut) {
        setTlStatus('auto_clockout'); setTlAutoNote(tlRecord.autoClockOutNote || '');
      } else {
        setTlStatus('available'); setTlAutoNote('');
      }
    });
    return unsub;
  }, [isApcOrIpc, ownerId]);

  // Low-level clock-in: write + refresh + confirmation toast. THROWS on error.
  async function performClockIn(location) {
    await clockIn({
      userId: currentUser.uid, userName, userRole,
      userEmail: currentUser.email || '',
      ownerId, location,
    });
    setShowClockIn(false);
    setShowGmvGate(false);
    setPendingLocation(null);
    // Force-refresh — realtime can be flaky and we never want the user
    // to see stale state after their own action.
    refetchRecord();
    setClockedInToast(true);
  }

  // Direct clock-in (non-gate path); swallows errors into the widget banner.
  async function doClockIn(location) {
    setAction('clockin');
    try { await performClockIn(location); }
    catch (err) { setTaskError(err.message); }
    setAction('');
  }

  async function handleClockIn(location) {
    // APC-only GMV gate BEFORE any attendance write. Fail-open if the check
    // itself errors, so a glitch never locks an APC out of clocking in.
    if (userRole === 'apc') {
      setAction('clockin'); setTaskError('');
      let st = null;
      try { st = await apcGmvStatus(); } catch { st = null; }
      setAction('');
      if (st && st.needs_entry) {
        setGmvStatus(st);
        setPendingLocation(location);
        setShowGmvGate(true);
        return;
      }
    }
    await doClockIn(location);
  }

  // The GMV modal's confirm handler: save GMV, then clock in. Errors propagate
  // to the modal so it can show them and stay open for a retry.
  async function handleGmvConfirm(payload) {
    await submitApcGmv({
      monthKey: gmvStatus.month_key,
      rangeStart: payload.rangeStart,
      rangeEnd: payload.rangeEnd,
      entries: payload.entries,
    });
    await performClockIn(pendingLocation);
  }

  async function handleBreak() {
    setAction('break');
    try {
      if (record.status === 'on-break') await endBreak(currentUser.uid);
      else await startBreak(currentUser.uid);
      refetchRecord();
    } catch (err) { setTaskError(err.message); }
    setAction('');
  }

  async function handleClockOut() {
    if (isApcOrIpc) {
      const tasksOk = await checkDailyTasks();
      if (!tasksOk) return;
      if (tlStatus === 'not_clocked_in' || tlStatus === 'auto_clockout') {
        setAction('clockout');
        try { await clockOut(currentUser.uid); refetchRecord(); } catch (err) { setTaskError(err.message); }
        setAction('');
        return;
      }
      setShowClockOut(true);
      return;
    }
    setAction('clockout');
    try { await clockOut(currentUser.uid); refetchRecord(); } catch (err) { setTaskError(err.message); }
    setAction('');
  }

  async function handleResumeShift() {
    setAction('resume');
    setTaskError('');
    try {
      await resumeShift();
      refetchRecord();
    } catch (err) {
      setTaskError(err.message || 'Could not resume the shift.');
    }
    setAction('');
  }

  async function handleRequestClockOut() {
    setAction('clockout');
    try {
      await requestClockOut({ userId: currentUser.uid, clockOutNote, ownerId, ownerName, userName });
      setShowClockOut(false);
      setClockOutNote('');
      refetchRecord();
    } catch (err) { setTaskError(err.message); }
    setAction('');
  }

  async function checkDailyTasks() {
    setTaskError('');
    try {
      const result = await checkApcDailyTasks(currentUser.uid);
      if (!result.ok) {
        setTaskError(`You have ${result.count} incomplete daily task${result.count > 1 ? 's' : ''} in ${result.brandName}. Complete all daily tasks before clocking out.`);
        return false;
      }
      return true;
    } catch {
      // Non-fatal — let the user clock out if the check itself failed.
      return true;
    }
  }

  async function handleToggleAutoClockOut() {
    if (!record) return;
    const newVal = !autoClockOutEnabled;
    setAutoClockOutEnabled(newVal);
    try {
      await apiSetAutoClockOut(currentUser.uid, newVal, autoClockOutNote);
    } catch { /* ignore */ }
  }

  async function handleSaveAutoNote() {
    if (!record) return;
    try {
      await apiSetAutoClockOutNote(currentUser.uid, autoClockOutNote);
    } catch { /* ignore */ }
  }

  const modals = (
    <>
    {/* APC GMV-on-clock-in gate */}
    {showGmvGate && gmvStatus && (
      <ApcGmvGateModal
        status={gmvStatus}
        onConfirm={handleGmvConfirm}
        onClose={() => { setShowGmvGate(false); setShowClockIn(false); setPendingLocation(null); }}
      />
    )}

    {/* "You're clocked in" confirmation toast */}
    {clockedInToast && (
      <div style={{
        position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1100,
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderRadius: 'var(--radius-md)',
        background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-lg)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600,
      }}>
        <i className="bi bi-check-circle-fill" style={{ color: 'var(--success)' }} /> You're clocked in
      </div>
    )}

    {/* Clock-out request modal */}
    {showClockOut && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(3px)' }} onClick={() => setShowClockOut(false)} />
        <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 420, zIndex: 1, borderRadius: 'var(--radius-lg)' }}>
          <div className="card-body p-4">
            <h6 className="fw-bold mb-1">Clock Out</h6>
            <p className="text-muted small mb-3">This ends your shift for today — you won't be able to clock back in until tomorrow.</p>
            <div className="mb-3">
              <label className="form-label small fw-semibold">What did you work on today?</label>
              <textarea
                className="form-control form-control-sm"
                rows={3}
                value={clockOutNote}
                onChange={e => setClockOutNote(e.target.value)}
                placeholder="Brief summary of today's work..."
              />
            </div>
            <div className="d-flex gap-2 justify-content-end">
              <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setShowClockOut(false)}>Cancel</button>
              <button
                className="btn btn-sm btn-primary px-4 d-inline-flex align-items-center gap-1"
                onClick={handleRequestClockOut}
                disabled={action === 'clockout'}
              >
                {action === 'clockout' ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-box-arrow-right" />}
                Clock Out
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );

  return {
    user, profile, record, setRecord, loading, setLoading, action, setAction, showClockIn, setShowClockIn, showClockOut, setShowClockOut, clockOutNote, setClockOutNote, taskError, setTaskError, showGmvGate, setShowGmvGate, gmvStatus, setGmvStatus, pendingLocation, setPendingLocation, clockedInToast, setClockedInToast, tlStatus, setTlStatus, tlAutoNote, setTlAutoNote, autoClockOutEnabled, setAutoClockOutEnabled, autoClockOutNote, setAutoClockOutNote, currentUser, userRole, apcProfile, _uid, isApcOrIpc, isTL, ownerId, ownerName, userName, refetchRecord, performClockIn, doClockIn, handleClockIn, handleGmvConfirm, handleBreak, handleClockOut, handleResumeShift, handleRequestClockOut, checkDailyTasks, handleToggleAutoClockOut, handleSaveAutoNote,
    modals,
  };
}

export default useClockActions;
