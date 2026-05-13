import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  clockIn, clockOut, startBreak, endBreak,
  requestClockOut, onActiveRecord,
  calcTimes, fmtDuration, fmtDurationLive, fmtTime,
  requestEditClockIn, editClockInDirect,
  getUnacknowledgedAutoCloses, acknowledgeAutoClose,
  requestEditClockOut, editClockOutDirect, getEffectiveStatus,
  getUserHistory,
  isOverReminder, hasFreshStillWorkingAck, markStillWorking,
  checkApcDailyTasks, setAutoClockOut as apiSetAutoClockOut,
  setAutoClockOutNote as apiSetAutoClockOutNote,
} from '../../lib/attendanceApi';
import { getNowDate } from '../../lib/serverTime';

const LOCATIONS = [
  { key: 'bahria',   label: 'Bahria Office',    icon: 'bi-building',  color: '#2563eb' },
  { key: 'lakecity', label: 'Lake City Office', icon: 'bi-buildings', color: '#7c3aed' },
  { key: 'wfh',      label: 'Work From Home',   icon: 'bi-house-door', color: '#16a34a' },
];

// All attendance display + editing is locked to Pakistan time
// regardless of the viewer's laptop TZ. Without this, an OL working
// from the US sees their team's "6:37 PM" as "6:37 AM" and the edit
// picker's validator interprets their typed "6:37 PM" as
// 6:37 PM in their LOCAL zone (e.g. US), which then crosses midnight
// UTC and shows up as "in the future" relative to the current PKT
// moment. Two helpers:
//   * toPktLocalInput(Date) → "YYYY-MM-DDTHH:MM" rendered in PKT,
//     suitable as the value/min/max of a <input type="datetime-local">.
//   * fromPktLocalInput(str) → Date object for the moment represented
//     by that string interpreted as Pakistan time.
function toPktLocalInput(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (k) => parts.find((p) => p.type === k)?.value || '00';
  // en-CA can return '24' for midnight hour — fold to '00'.
  let hh = get('hour');
  if (hh === '24') hh = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}`;
}
function fromPktLocalInput(str) {
  // "YYYY-MM-DDTHH:MM" interpreted as Pakistan time. PKT is UTC+5,
  // no DST, so a fixed offset is correct.
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str);
  if (!m) return null;
  // Build the UTC moment by subtracting 5h.
  return new Date(Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]) - 5, Number(m[5]),
  ));
}

function statusColor(s) {
  if (s === 'clocked-in')       return '#16a34a';
  if (s === 'on-break')         return '#f59e0b';
  if (s === 'pending-approval') return '#3b82f6';
  if (s === 'clocked-out')      return '#64748b';
  if (s === 'auto-closed')      return '#dc2626';
  return '#94a3b8';
}
function statusLabel(s) {
  if (s === 'clocked-in')       return 'Working';
  if (s === 'on-break')         return 'On Break';
  if (s === 'pending-approval') return 'Awaiting Approval';
  if (s === 'clocked-out')      return 'Clocked Out';
  if (s === 'auto-closed')      return 'Auto-closed';
  return 'Not Clocked In';
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Live analog clock — SVG, hands move every second based on `now`
 * ───────────────────────────────────────────────────────────────────────────── */
function AnalogClock({ now, accent = '#16a34a', size = 200 }) {
  // Hands point at Pakistan time so the analog dial agrees with the
  // digital display and the attendance records.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const pn = (k) => Number(parts.find((p) => p.type === k)?.value || '0');
  let h24 = pn('hour'); if (h24 === 24) h24 = 0;
  const h = h24 % 12;
  const m = pn('minute');
  const s = pn('second');

  const hourDeg   = (h * 30) + (m * 0.5);
  const minuteDeg = (m * 6)  + (s * 0.1);
  const secondDeg = s * 6;

  const cx = size / 2;
  const cy = size / 2;
  const r  = size / 2 - 4;

  // Tick marks (12 hours)
  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const deg = i * 6;
    const isHour = i % 5 === 0;
    const inner = isHour ? r - 10 : r - 5;
    const outer = r - 2;
    const rad = (deg - 90) * (Math.PI / 180);
    const x1 = cx + inner * Math.cos(rad);
    const y1 = cy + inner * Math.sin(rad);
    const x2 = cx + outer * Math.cos(rad);
    const y2 = cy + outer * Math.sin(rad);
    ticks.push(
      <line
        key={i}
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={isHour ? '#1e293b' : '#cbd5e1'}
        strokeWidth={isHour ? 2 : 1}
        strokeLinecap="round"
      />
    );
  }

  // Hour numerals (12, 3, 6, 9)
  const numerals = [];
  const positions = [
    { n: 12, a: 0 },
    { n: 3,  a: 90 },
    { n: 6,  a: 180 },
    { n: 9,  a: 270 },
  ];
  positions.forEach(p => {
    const rad = (p.a - 90) * (Math.PI / 180);
    const x = cx + (r - 22) * Math.cos(rad);
    const y = cy + (r - 22) * Math.sin(rad);
    numerals.push(
      <text
        key={p.n}
        x={x} y={y}
        fontSize={14}
        fontWeight={700}
        fill="#475569"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {p.n}
      </text>
    );
  });

  return (
    <svg width={size} height={size} style={{ display: 'block' }}>
      <defs>
        <radialGradient id="clockFace" cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stopColor="#ffffff" />
          <stop offset="85%" stopColor="#f8fafc" />
          <stop offset="100%" stopColor="#e2e8f0" />
        </radialGradient>
        <filter id="clockShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#0f172a" floodOpacity="0.15" />
        </filter>
      </defs>

      {/* Outer bezel */}
      <circle cx={cx} cy={cy} r={r + 2} fill="#1e293b" filter="url(#clockShadow)" />
      {/* Face */}
      <circle cx={cx} cy={cy} r={r} fill="url(#clockFace)" stroke="#cbd5e1" strokeWidth="1" />

      {ticks}
      {numerals}

      {/* Hour hand */}
      <line
        x1={cx} y1={cy}
        x2={cx} y2={cy - r * 0.5}
        stroke="#1e293b"
        strokeWidth="5"
        strokeLinecap="round"
        transform={`rotate(${hourDeg} ${cx} ${cy})`}
        style={{ transition: 'transform 0.4s cubic-bezier(.4,2.2,.6,1)' }}
      />
      {/* Minute hand */}
      <line
        x1={cx} y1={cy}
        x2={cx} y2={cy - r * 0.72}
        stroke="#334155"
        strokeWidth="3.5"
        strokeLinecap="round"
        transform={`rotate(${minuteDeg} ${cx} ${cy})`}
        style={{ transition: 'transform 0.4s cubic-bezier(.4,2.2,.6,1)' }}
      />
      {/* Second hand */}
      <line
        x1={cx} y1={cy + 8}
        x2={cx} y2={cy - r * 0.82}
        stroke={accent}
        strokeWidth="1.8"
        strokeLinecap="round"
        transform={`rotate(${secondDeg} ${cx} ${cy})`}
        style={{ transition: 'transform 0.15s cubic-bezier(.4,2.5,.6,1)' }}
      />

      {/* Center cap */}
      <circle cx={cx} cy={cy} r="5" fill="#1e293b" />
      <circle cx={cx} cy={cy} r="2" fill={accent} />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Main Clock Widget
 * ───────────────────────────────────────────────────────────────────────────── */
export default function ClockWidget() {
  // v1 returned { currentUser, userRole, apcProfile } from useAuth.
  // v2 returns { user, profile }; map to v1's shape with a shim so
  // the ported markup keeps using the v1 names. apcProfile.ownerId
  // ↔ profile.reports_to. apcProfile.ownerName is fetched on demand
  // via the optional ownerName state below.
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

  // All hooks below assume currentUser exists. The page that mounts
  // this widget hides it for Boss/OL/Developer roles, so non-clocking
  // users won't even see it. The early-return at the END of the
  // component (just before the JSX) handles the auth-not-ready case
  // without breaking the rules-of-hooks.
  const _uid = currentUser?.uid;
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [showClockIn, setShowClockIn] = useState(false);
  const [showClockOut, setShowClockOut] = useState(false);
  const [clockOutNote, setClockOutNote] = useState('');
  const [taskError, setTaskError] = useState('');
  const [now, setNow] = useState(() => getNowDate());
  const [showEditClockIn, setShowEditClockIn] = useState(false);
  const [editTime, setEditTime] = useState('');
  const [editReason, setEditReason] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const isApcOrIpc = userRole === 'apc' || userRole === 'ipc';
  const isTL = userRole === 'tl';
  const ownerId = apcProfile?.ownerId || null;
  const ownerName = apcProfile?.ownerName || '';
  const userName = currentUser?.displayName || apcProfile?.userName || currentUser?.email?.split('@')[0] || '';
  const [tlStatus, setTlStatus] = useState(null);
  const [tlAutoNote, setTlAutoNote] = useState('');
  const [autoClockOutEnabled, setAutoClockOutEnabled] = useState(false);
  const [autoClockOutNote, setAutoClockOutNote] = useState('');

  // Unacknowledged auto-closes (shown as banner with OK / Adjust)
  const [autoClosedItems, setAutoClosedItems] = useState([]);
  const [adjustTarget, setAdjustTarget] = useState(null); // record being adjusted

  // Week / streak / overtime — computed from last 14 days of history
  const [weekStats, setWeekStats] = useState({ weekMs: 0, streak: 0, overtimeMs: 0 });
  const WEEKLY_TARGET_MS = 40 * 60 * 60 * 1000;   // 40h
  const DAILY_TARGET_MS  = 8 * 60 * 60 * 1000;    // 8h

  // Refetch whenever the active record changes (clock-in / out / break)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const now = new Date();
        const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const end = ymd(now);
        const startDt = new Date(now);
        startDt.setDate(startDt.getDate() - 29);  // 30-day window
        const start = ymd(startDt);
        const records = await getUserHistory(currentUser.uid, start, end);
        if (!alive) return;

        // This week (Mon → Sun containing today)
        const today = new Date(now); today.setHours(0, 0, 0, 0);
        const day = today.getDay();   // Sun=0..Sat=6
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - ((day + 6) % 7));
        const weekStartKey = ymd(weekStart);
        let weekMs = 0;
        records.forEach(r => {
          if (r.date >= weekStartKey && r.date <= end) {
            const t = calcTimes(r);
            weekMs += t.totalWorkMs || 0;
          }
        });

        // Streak — consecutive days with a record, walking back from today
        const dateSet = new Set(records.map(r => r.date));
        let streak = 0;
        for (let i = 0; i < 30; i++) {
          const d = new Date(today); d.setDate(d.getDate() - i);
          if (dateSet.has(ymd(d))) streak++;
          else if (i === 0) continue; // today may not be logged yet — don't break on zero
          else break;
        }

        const overtimeMs = Math.max(0, weekMs - WEEKLY_TARGET_MS);
        setWeekStats({ weekMs, streak, overtimeMs });
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser.uid, record?.status, record?.clockIn, record?.clockOut]);

  // On mount: fetch any legacy unacknowledged auto-closes (older records that
  // were auto-closed before the no-auto-close policy). New stale sessions are
  // handled live via the recovery modal below.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const items = await getUnacknowledgedAutoCloses(currentUser.uid);
        if (alive) setAutoClosedItems(items);
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
  }, [currentUser.uid]);

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
          if (wasLoading) console.warn('[ClockWidget] watchdog: forcing loading=false after 5s');
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

  // Tick every second for the live clock + work timer
  useEffect(() => {
    const i = setInterval(() => setNow(getNowDate()), 1000);
    return () => clearInterval(i);
  }, []);

  // Soft reminder banner only — past the 9h threshold the user gets a
  // non-blocking "still working?" nudge they can acknowledge. There is NO
  // auto-popup recovery modal: stale sessions stay open and the user (or
  // their OL/Boss via Force Close) decides when to clock out. Removed
  // because the recovery popup kept reopening every time the user
  // navigated back to the Attendance page (state was reset on remount),
  // which made it impossible to dismiss without an actual clock-out.
  const [reminderDismissed, setReminderDismissed] = useState(false);
  const [savingStillWorking, setSavingStillWorking] = useState(false);
  const showReminderBanner = !!record
    && record.status !== 'clocked-out'
    && isOverReminder(record)
    && !hasFreshStillWorkingAck(record)
    && !reminderDismissed;

  // Reset the dismissed flag whenever the active record changes (new session).
  useEffect(() => { setReminderDismissed(false); }, [record?.id]);

  async function handleStillWorking() {
    if (!record?.id) return;
    setSavingStillWorking(true);
    try { await markStillWorking(record.id); }
    catch { /* non-fatal — user can dismiss banner manually */ }
    finally {
      setSavingStillWorking(false);
      setReminderDismissed(true);
    }
  }

  const times = record ? calcTimes(record) : { totalWorkMs: 0, totalBreakMs: 0 };
  const effStatus = getEffectiveStatus(record);
  const sc = statusColor(effStatus);

  async function handleAcknowledgeAutoClose(id) {
    await acknowledgeAutoClose(id);
    setAutoClosedItems(items => items.filter(i => i.id !== id));
  }

  async function handleAdjustSubmit(attendanceId, newClockOutMs, reason) {
    if (isApcOrIpc) {
      await requestEditClockOut({
        userId: currentUser.uid, attendanceId, requestedClockOutMs: newClockOutMs,
        reason, ownerId, userName,
      });
    } else {
      await editClockOutDirect(attendanceId, newClockOutMs);
    }
    setAutoClosedItems(items => items.filter(i => i.id !== attendanceId));
    setAdjustTarget(null);
  }

  // Formatted digital clock strings — locked to Pakistan time so the
  // big display agrees with everywhere else in the attendance UI.
  const pktParts = useMemo(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (k) => parts.find((p) => p.type === k)?.value || '00';
    let h = get('hour');
    if (h === '24') h = '00';
    return { hh: h, mm: get('minute'), ss: get('second') };
  }, [now]);
  const hh = pktParts.hh;
  const mm = pktParts.mm;
  const ss = pktParts.ss;
  const dateStr = useMemo(() => {
    const opts = {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Asia/Karachi',
    };
    return now.toLocaleDateString('en-US', opts);
  }, [now]);

  const locInfo = LOCATIONS.find(l => l.key === record?.location);

  async function handleClockIn(location) {
    setAction('clockin');
    try {
      await clockIn({
        userId: currentUser.uid, userName, userRole,
        userEmail: currentUser.email || '',
        ownerId, location,
      });
      setShowClockIn(false);
      // Force-refresh — realtime can be flaky and we never want the user
      // to see stale state after their own action.
      refetchRecord();
    } catch (err) { setTaskError(err.message); }
    setAction('');
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

  async function handleSubmitEditClockIn() {
    setEditError('');
    if (!editTime) { setEditError('Please pick a time.'); return; }
    // Interpret the picker value as Pakistan time so a viewer on a
    // non-PKT laptop picking "6:37 PM" gets 6:37 PM in PKT, not their
    // local 6:37 PM. The DB stores UTC so this just shifts the moment.
    const picked = fromPktLocalInput(editTime);
    if (!picked || isNaN(picked.getTime())) { setEditError('Invalid time.'); return; }
    const pickedMs = picked.getTime();
    const nowMs = Date.now();
    // Shift-aware window. WurxCrew runs 4pm–12am and 6pm–2am night
    // shifts, so a user editing at 1am should still be able to set
    // their clock-in to 6pm of the previous calendar day. Rules:
    //   * never in the FUTURE (real absolute future)
    //   * within the last 18 hours so the night-shift case works
    //     end-to-end (clock-in 6pm + ~8h shift + grace = 18h is plenty)
    //   * if a record already exists, also allow up to 18h BEFORE
    //     the recorded clock_in so a TL/Boss editing the old entry
    //     isn't restricted to the current 18h window
    const minMs = nowMs - 18 * 60 * 60 * 1000;
    if (pickedMs > nowMs) {
      setEditError('Clock-in time cannot be in the future.');
      return;
    }
    if (pickedMs < minMs) {
      setEditError('Clock-in time must be within the last 18 hours (covers night shifts spanning midnight).');
      return;
    }
    if (!editReason.trim() && isApcOrIpc) { setEditError('Please add a short reason.'); return; }

    setEditSaving(true);
    try {
      if (isApcOrIpc) {
        await requestEditClockIn({
          userId: currentUser.uid,
          attendanceId: record.id,
          requestedClockInMs: pickedMs,
          reason: editReason.trim(),
          ownerId,
          userName,
        });
      } else {
        // TL / OL / Boss: directly apply without approval
        await editClockInDirect(record.id, pickedMs);
      }
      setShowEditClockIn(false);
      setEditTime('');
      setEditReason('');
      refetchRecord();
    } catch (err) {
      setEditError(err.message || 'Failed to submit edit request.');
    }
    setEditSaving(false);
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

  const isClockedOut = !record || record.status === 'clocked-out';

  // Auth not resolved yet — render nothing rather than crash.
  if (!currentUser) return null;

  return (
    <>
      <style>{`
        @keyframes attPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.92); } }
        .att-digit { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; }
        .att-colon { opacity: 0.35; animation: attColon 1s steps(2) infinite; }
        @keyframes attColon { 50% { opacity: 1; } }
        .att-clock-card { background: #fff; color: #0f172a; }
        .att-clock-hero { background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%); }
        [data-theme="dark"] .att-clock-card { background: #121212 !important; color: #ffffff; }
        [data-theme="dark"] .att-clock-hero { background: linear-gradient(135deg, #1a1a1a 0%, #161b2a 100%) !important; }
        [data-theme="dark"] .att-clock-card .att-digit { color: #ffffff !important; }

        .att-primary-btn {
          width: 100%; padding: 18px 22px; border-radius: 16px; border: none;
          display: flex; align-items: center; justify-content: space-between;
          font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em;
          color: white; transition: all 0.15s; cursor: pointer;
        }
        .att-primary-btn:disabled { opacity: 0.55; cursor: not-allowed; }
        .att-primary-btn i { font-size: 1.3rem; }
        .att-primary-in  { background: #16a34a; }
        .att-primary-in:hover:not(:disabled) { background: #15803d; transform: translateY(-1px); }
        .att-primary-out { background: #ef4444; }
        .att-primary-out:hover:not(:disabled) { background: #dc2626; transform: translateY(-1px); }

        .att-secondary-btn {
          width: 100%; padding: 10px; border-radius: 12px; border: 1px solid #e2e8f0;
          background: #f8fafc; color: #334155;
          font-size: 0.82rem; font-weight: 600;
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          transition: all 0.15s; cursor: pointer;
        }
        .att-secondary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .att-secondary-btn:hover:not(:disabled) { background: #f1f5f9; }

        .att-today-card {
          background: #0f172a; color: #f8fafc; border-radius: 22px;
          padding: 22px; height: 100%; display: flex; flex-direction: column;
        }
        .att-today-card .att-today-label {
          font-size: 0.62rem; font-weight: 700; letter-spacing: 0.12em;
          text-transform: uppercase; color: rgba(248,250,252,0.55); margin-bottom: 4px;
        }
        .att-today-card h4 { color: #fff; font-weight: 700; margin-bottom: 18px; font-size: 1.35rem; }
        .att-today-card .att-digit { color: #fff; }
        .att-today-progress { background: rgba(255,255,255,0.08); border-radius: 999px; height: 6px; overflow: hidden; }
        .att-today-progress-fill { height: 100%; background: linear-gradient(90deg, #f5d5a8, #d4a574); transition: width 0.4s; }
        .att-today-stat-col {
          flex: 1; text-align: left;
        }
        .att-today-stat-col .l {
          font-size: 0.56rem; font-weight: 700; letter-spacing: 0.1em;
          text-transform: uppercase; color: rgba(248,250,252,0.4);
        }
        .att-today-stat-col .v {
          font-size: 1.1rem; font-weight: 700; color: #fff; margin-top: 2px;
          font-variant-numeric: tabular-nums;
        }
      `}</style>

      {/* Still-working reminder — non-blocking nudge once a session is past
          the 9h mark. Auto-close was retired per the new policy, so this is
          how the user confirms they're still on the clock vs. forgot. */}
      {showReminderBanner && (
        <div className="mb-3 rounded-3 d-flex align-items-start gap-2 p-3"
          style={{ background: '#fff7ed', border: '1px solid #fed7aa', color: '#7c2d12' }}>
          <i className="bi bi-clock-history flex-shrink-0 mt-1" style={{ fontSize: '1.1rem', color: '#ea580c' }} />
          <div className="flex-grow-1">
            <div className="fw-bold" style={{ fontSize: '0.88rem' }}>
              You've been clocked in for {fmtDuration(times.totalWorkMs + times.totalBreakMs)}.
            </div>
            <div style={{ fontSize: '0.78rem' }}>
              Still working? Tap to confirm — we'll snooze this reminder for a few hours.
            </div>
          </div>
          <div className="d-flex gap-2 flex-shrink-0">
            <button className="btn btn-sm btn-outline-secondary" onClick={() => setReminderDismissed(true)}>
              Dismiss
            </button>
            <button className="btn btn-sm btn-warning text-white d-inline-flex align-items-center gap-1"
              onClick={handleStillWorking} disabled={savingStillWorking}>
              {savingStillWorking ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Yes, still working</>}
            </button>
          </div>
        </div>
      )}

      {/* Unacknowledged auto-closes banner */}
      {autoClosedItems.length > 0 && (
        <div className="mb-3">
          {autoClosedItems.map(item => (
            <AutoClosedBanner key={item.id} record={item}
              onOK={() => handleAcknowledgeAutoClose(item.id)}
              onAdjust={() => setAdjustTarget(item)} />
          ))}
        </div>
      )}

      {adjustTarget && (
        <AdjustClockOutModal
          record={adjustTarget}
          isApcOrIpc={isApcOrIpc}
          onCancel={() => setAdjustTarget(null)}
          onSubmit={(newMs, reason) => handleAdjustSubmit(adjustTarget.id, newMs, reason)} />
      )}

      {/* ── Greeting ─────────────────────────────────────────────────────── */}
      <div className="mb-3">
        <h2 className="fw-bold mb-1" style={{ fontSize: '2.4rem', letterSpacing: '-0.02em', color: '#0f172a' }}>
          {greetingPrefix()}, {firstName(userName)}.
        </h2>
        <p className="text-muted mb-0" style={{ fontSize: '0.92rem' }}>{greetingSubtitle(effStatus, record, times)}</p>
      </div>

      <div className="row g-3">
        {/* ── Left: big white clock card ───────────────────────────────── */}
        <div className="col-lg-8">
          <div className="card border-0 shadow-sm att-clock-card h-100" style={{ borderRadius: 22, overflow: 'hidden' }}>
            <div style={{ height: 4, background: sc }} />
            <div className="p-4">
              <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
                <div className="text-muted" style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  Current Time · {dateStr}
                </div>
                {!loading && !isClockedOut && (
                  <div className="d-inline-flex align-items-center gap-2"
                    style={{ background: `${sc}15`, color: sc, padding: '4px 10px', borderRadius: 999, fontSize: '0.66rem', fontWeight: 700, border: `1px solid ${sc}30` }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, display: 'inline-block', animation: 'attPulse 1.8s ease-in-out infinite' }} />
                    {statusLabel(effStatus)}
                  </div>
                )}
              </div>

              {/* Big digital clock — HH:MM black, SS lighter */}
              <div className="att-digit fw-bold" style={{
                fontSize: 'clamp(4rem, 10vw, 7rem)', lineHeight: 0.95,
                letterSpacing: '-0.03em', color: '#0f172a',
              }}>
                {hh}<span className="att-colon">:</span>{mm}<span style={{ color: '#cbd5e1' }}>:{ss}</span>
              </div>

              {locInfo && !isClockedOut && (
                <div className="d-inline-flex align-items-center gap-1 mt-3"
                  style={{ background: `${locInfo.color}10`, color: locInfo.color, padding: '4px 11px', borderRadius: 999, fontSize: '0.68rem', fontWeight: 600, border: `1px solid ${locInfo.color}25` }}>
                  <i className={`bi ${locInfo.icon}`} style={{ fontSize: '0.62rem' }} />{locInfo.label}
                </div>
              )}

              <hr style={{ margin: '22px 0', borderColor: '#e2e8f0' }} />

              {loading ? (
                <div className="text-center py-4"><div className="spinner-border spinner-border-sm text-primary" /></div>
              ) : (
                <>
                  {/* 3-column session stats */}
                  <div className="row g-0 mb-3">
                    <div className="col-4">
                      <div style={{ fontSize: '0.58rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Last Clock-In</div>
                      <div className="att-digit fw-bold" style={{ fontSize: '1.5rem', color: '#0f172a', marginTop: 2 }}>
                        {record?.clockIn ? fmtTime(record.clockIn) : '—'}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.66rem' }}>
                        {record?.clockIn ? (isClockedOut ? `Last shift ended at ${fmtTime(record.clockOut)}` : 'Started today') : 'Not started yet'}
                      </div>
                    </div>
                    <div className="col-4">
                      <div style={{ fontSize: '0.58rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Session</div>
                      <div className="att-digit fw-bold" style={{ fontSize: '1.5rem', color: isClockedOut ? '#94a3b8' : '#16a34a', marginTop: 2 }}>
                        {isClockedOut ? '—' : fmtDurationLive(times.totalWorkMs)}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.66rem' }}>
                        {isClockedOut ? 'Not on the clock' : 'Live elapsed timer'}
                      </div>
                    </div>
                    <div className="col-4">
                      <div style={{ fontSize: '0.58rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Breaks Today</div>
                      <div className="att-digit fw-bold" style={{ fontSize: '1.5rem', color: times.totalBreakMs > 0 ? '#f59e0b' : '#0f172a', marginTop: 2 }}>
                        {times.totalBreakMs > 0 ? fmtDuration(times.totalBreakMs) : '0m'}
                      </div>
                      <div className="text-muted" style={{ fontSize: '0.66rem' }}>
                        {times.totalBreakMs > 0 ? 'Accumulated today' : 'None yet'}
                      </div>
                    </div>
                  </div>

                  {/* ── Primary action ── */}
                  {isClockedOut ? (
                    showClockIn ? (
                      <div className="d-flex flex-column gap-2">
                        <div className="text-muted small fw-semibold mb-1" style={{ fontSize: '0.72rem' }}>Where are you working from?</div>
                        {LOCATIONS.map(loc => (
                          <button key={loc.key}
                            className="btn d-flex align-items-center gap-2 px-3 py-2"
                            style={{ border: `2px solid ${loc.color}25`, borderRadius: 12, background: '#fff', transition: 'all 0.15s' }}
                            onClick={() => handleClockIn(loc.key)}
                            disabled={action === 'clockin'}
                            onMouseEnter={e => { e.currentTarget.style.background = `${loc.color}08`; e.currentTarget.style.borderColor = loc.color; }}
                            onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = `${loc.color}25`; }}>
                            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 30, height: 30, background: `${loc.color}15` }}>
                              <i className={`bi ${loc.icon}`} style={{ color: loc.color, fontSize: '0.95rem' }} />
                            </div>
                            <span className="fw-semibold" style={{ fontSize: '0.86rem', color: '#0f172a' }}>{loc.label}</span>
                          </button>
                        ))}
                        <button className="btn btn-sm btn-link text-muted mt-1" style={{ fontSize: '0.72rem', textDecoration: 'none' }} onClick={() => setShowClockIn(false)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="att-primary-btn att-primary-in" onClick={() => setShowClockIn(true)} disabled={!!action}>
                        <span>Clock in</span>
                        <i className="bi bi-arrow-right" />
                      </button>
                    )
                  ) : (
                    record.status !== 'pending-approval' && (
                      <button className="att-primary-btn att-primary-out" onClick={handleClockOut} disabled={!!action || record.status === 'on-break'}>
                        <span>Clock out</span>
                        <i className="bi bi-arrow-right" />
                      </button>
                    )
                  )}

                  {/* ── Secondary action row (breaks / edit) ── */}
                  {!isClockedOut && record.status !== 'pending-approval' && (
                    <div className="row g-2 mt-2">
                      <div className="col-sm-4">
                        <button className="att-secondary-btn" onClick={handleBreak} disabled={!!action}
                          style={{ background: record.status === 'on-break' ? '#fef3c7' : '#f8fafc', borderColor: record.status === 'on-break' ? '#fde68a' : '#e2e8f0', color: record.status === 'on-break' ? '#92400e' : '#334155' }}>
                          <i className={`bi ${record.status === 'on-break' ? 'bi-play-fill' : 'bi-cup-hot'}`} />
                          {record.status === 'on-break' ? 'End break' : 'Take break'}
                        </button>
                      </div>
                      <div className="col-sm-4">
                        <button className="att-secondary-btn" disabled
                          title="Lunch break (not yet implemented)">
                          <span role="img" aria-label="lunch">🍱</span> Lunch
                        </button>
                      </div>
                      <div className="col-sm-4">
                        <button className="att-secondary-btn"
                          onClick={() => {
                            const d = record.clockIn?.toDate ? record.clockIn.toDate() : new Date(record.clockIn);
                            // Pre-fill the picker in Pakistan time so a
                            // user on a non-PKT laptop still sees their
                            // shift's real moment (Asia/Karachi is the
                            // canonical zone for attendance).
                            setEditTime(toPktLocalInput(d));
                            setEditReason(''); setEditError('');
                            setShowEditClockIn(true);
                          }}>
                          <i className="bi bi-pencil-square" /> Edit time
                        </button>
                      </div>
                    </div>
                  )}

                  {!loading && (
                    <div className="text-center text-muted mt-3" style={{ fontSize: '0.68rem' }}>
                      Press <kbd style={{ background: '#e2e8f0', padding: '1px 6px', borderRadius: 4, fontSize: '0.65rem' }}>Space</kbd> to clock in/out · <kbd style={{ background: '#e2e8f0', padding: '1px 6px', borderRadius: 4, fontSize: '0.65rem' }}>B</kbd> for break
                    </div>
                  )}

                  {/* ── Inline banners (edit request, TL auto-clockout, APC TL status, rejection) ── */}
                  {(() => {
                    const editReq = record?.editClockInRequest;
                    if (editReq && editReq.status === 'pending') {
                      return (
                        <div className="rounded-3 p-2 mt-3 d-flex align-items-center gap-2" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                          <div className="spinner-border spinner-border-sm text-primary" style={{ width: 14, height: 14 }} />
                          <span style={{ fontSize: '0.74rem', color: '#1d4ed8', fontWeight: 600, flex: 1 }}>Clock-in edit request waiting for approval</span>
                        </div>
                      );
                    }
                    if (editReq && editReq.status === 'rejected' && !isClockedOut) {
                      return (
                        <div className="mt-3" style={{ fontSize: '0.68rem', color: '#dc2626', fontWeight: 600 }}>
                          <i className="bi bi-x-circle-fill me-1" />Last edit request rejected
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {isTL && record?.status === 'clocked-in' && (
                    <div className="rounded-3 p-3 mt-3"
                      style={{ background: autoClockOutEnabled ? '#fffbeb' : '#f8fafc', border: `1px solid ${autoClockOutEnabled ? '#fde68a' : '#e2e8f0'}`, transition: 'all 0.15s' }}>
                      <div className="d-flex align-items-center gap-2" style={{ cursor: 'pointer' }} onClick={handleToggleAutoClockOut}>
                        <input type="checkbox" className="form-check-input flex-shrink-0" checked={autoClockOutEnabled} readOnly style={{ cursor: 'pointer' }} />
                        <span className="small fw-semibold" style={{ color: autoClockOutEnabled ? '#d97706' : '#64748b' }}>
                          <i className="bi bi-clock-history me-1" />Allow team to clock out without approval
                        </span>
                      </div>
                      {autoClockOutEnabled && (
                        <div className="mt-2">
                          <input type="text" className="form-control form-control-sm"
                            placeholder="Note for your team (e.g. I'm traveling today)..."
                            value={autoClockOutNote} onChange={e => setAutoClockOutNote(e.target.value)} onBlur={handleSaveAutoNote}
                            style={{ borderRadius: 8, fontSize: '0.78rem' }} />
                        </div>
                      )}
                    </div>
                  )}

                  {isApcOrIpc && record?.status === 'clocked-in' && tlStatus === 'not_clocked_in' && (
                    <div className="rounded-3 p-3 mt-3 d-flex align-items-center gap-2" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                      <i className="bi bi-info-circle-fill" style={{ color: '#16a34a' }} />
                      <span style={{ fontSize: '0.78rem', color: '#166534', fontWeight: 600 }}>Team lead is not clocked in today. You can clock out directly.</span>
                    </div>
                  )}
                  {isApcOrIpc && record?.status === 'clocked-in' && tlStatus === 'auto_clockout' && (
                    <div className="rounded-3 p-3 mt-3" style={{ background: '#fffbeb', border: '1px solid #fde68a' }}>
                      <div className="d-flex align-items-center gap-2 mb-1">
                        <i className="bi bi-clock-history" style={{ color: '#d97706' }} />
                        <span style={{ fontSize: '0.78rem', color: '#92400e', fontWeight: 600 }}>Auto clock-out enabled by team lead</span>
                      </div>
                      {tlAutoNote && <p className="mb-0 small" style={{ color: '#92400e' }}>{tlAutoNote}</p>}
                    </div>
                  )}

                  {record?.status === 'pending-approval' && (
                    <div className="rounded-3 p-3 mt-3 d-flex align-items-center gap-2" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                      <div className="spinner-border spinner-border-sm text-primary" />
                      <span style={{ fontSize: '0.78rem', color: '#1d4ed8', fontWeight: 600 }}>Waiting for team lead approval…</span>
                    </div>
                  )}

                  {record?.approvalStatus === 'rejected' && record?.status === 'clocked-in' && (
                    <div className="rounded-3 p-3 mt-3" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                      <div className="d-flex align-items-center gap-2 mb-1">
                        <i className="bi bi-x-circle-fill text-danger" />
                        <span style={{ fontSize: '0.78rem', color: '#b91c1c', fontWeight: 700 }}>Clock-out Rejected</span>
                      </div>
                      {record.rejectionReason && <p className="mb-2 small" style={{ color: '#991b1b' }}>{record.rejectionReason}</p>}
                      <p className="mb-0" style={{ fontSize: '0.7rem', color: '#b91c1c' }}>Please complete the required work and request clock-out again.</p>
                    </div>
                  )}

                  {taskError && (
                    <div className="rounded-3 p-3 mt-3 d-flex align-items-start gap-2" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
                      <i className="bi bi-exclamation-triangle-fill text-danger flex-shrink-0" />
                      <div style={{ flex: 1 }}>
                        <span className="small fw-semibold text-danger">{taskError}</span>
                        <button className="btn btn-sm btn-link text-danger p-0 ms-2" style={{ fontSize: '0.72rem' }} onClick={() => setTaskError('')}>Dismiss</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Right: dark stats card ───────────────────────────────────── */}
        <div className="col-lg-4">
          <TodayStatsCard
            isClockedOut={isClockedOut}
            loading={loading}
            times={times}
            weekStats={weekStats}
            dailyTargetMs={DAILY_TARGET_MS}
            weeklyTargetMs={WEEKLY_TARGET_MS}
            effStatus={effStatus}
          />
        </div>
      </div>

      {/* Edit clock-in modal */}
      {showEditClockIn && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1071, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }} onClick={() => !editSaving && setShowEditClockIn(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 16 }}>
            <div className="card-body p-4">
              <h6 className="fw-bold mb-1 d-flex align-items-center gap-2">
                <i className="bi bi-pencil-square" style={{ color: '#3b82f6' }} />
                {isApcOrIpc ? 'Request Clock-In Edit' : 'Edit Clock-In Time'}
              </h6>
              <p className="text-muted small mb-3" style={{ fontSize: '0.76rem' }}>
                {isApcOrIpc
                  ? 'Your team lead will review this request. Your Work Time will update automatically once approved.'
                  : 'Adjust your clock-in time for today. Work totals will recalculate instantly.'}
              </p>

              <div className="mb-3">
                <label className="form-label small fw-semibold" style={{ fontSize: '0.74rem' }}>
                  Correct clock-in time
                </label>
                <input
                  type="datetime-local"
                  className="form-control form-control-sm"
                  value={editTime}
                  onChange={e => setEditTime(e.target.value)}
                  // max + min both rendered in Pakistan time so the
                  // datepicker shows valid options for a PKT-locked
                  // shift regardless of the viewer's laptop timezone.
                  max={toPktLocalInput(new Date())}
                  min={toPktLocalInput(new Date(Date.now() - 18 * 60 * 60 * 1000))}
                />
                <div className="text-muted mt-1" style={{ fontSize: '0.66rem' }}>
                  Current: {fmtTime(record?.clockIn)} (Pakistan time) · pick any time
                  within the last 18 hours
                </div>
              </div>

              {isApcOrIpc && (
                <div className="mb-3">
                  <label className="form-label small fw-semibold" style={{ fontSize: '0.74rem' }}>
                    Reason
                  </label>
                  <textarea
                    className="form-control form-control-sm"
                    rows={2}
                    value={editReason}
                    onChange={e => setEditReason(e.target.value)}
                    placeholder="e.g. I was working but forgot to clock in until now…"
                  />
                </div>
              )}

              {editError && (
                <div className="small mb-2" style={{ color: '#dc2626', fontWeight: 500 }}>
                  <i className="bi bi-exclamation-triangle-fill me-1" />{editError}
                </div>
              )}

              <div className="d-flex gap-2 justify-content-end">
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setShowEditClockIn(false)} disabled={editSaving}>Cancel</button>
                <button
                  className="btn btn-sm btn-primary px-4 d-inline-flex align-items-center gap-1"
                  onClick={handleSubmitEditClockIn}
                  disabled={editSaving}
                >
                  {editSaving ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-send" />}
                  {isApcOrIpc ? 'Send Request' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Clock-out request modal */}
      {showClockOut && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)' }} onClick={() => setShowClockOut(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 420, zIndex: 1, borderRadius: 16 }}>
            <div className="card-body p-4">
              <h6 className="fw-bold mb-1">Request Clock Out</h6>
              <p className="text-muted small mb-3">Your team lead will be notified for approval.</p>
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
                  className="btn btn-sm btn-dark px-4 d-inline-flex align-items-center gap-1"
                  onClick={handleRequestClockOut}
                  disabled={action === 'clockout'}
                >
                  {action === 'clockout' ? <span className="spinner-border spinner-border-sm" /> : <i className="bi bi-send" />}
                  Send Request
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── Helpers used in the new layout ──────────────────────────────────────── */

function greetingPrefix() {
  const h = getNowDate().getHours();
  if (h < 5)  return 'Hello';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstName(full) {
  if (!full) return 'there';
  return String(full).trim().split(/\s+/)[0] || 'there';
}

function greetingSubtitle(effStatus, record, times) {
  if (!record) return 'Tap Clock in to start your day.';
  if (effStatus === 'clocked-in')   return `You're on the clock since ${fmtTime(record.clockIn)}.`;
  if (effStatus === 'on-break')     return 'You are on a break right now.';
  if (effStatus === 'pending-approval') return 'Clock-out request pending approval.';
  if (effStatus === 'auto-closed')  return 'Your last shift was auto-closed after 8 hours.';
  if (effStatus === 'clocked-out') {
    const worked = fmtDuration(times?.totalWorkMs || 0);
    return `Tap Clock in to start your day. Your last shift ended at ${fmtTime(record.clockOut)} — clean ${worked}.`;
  }
  return 'Tap Clock in to start your day.';
}

/* ── Right-hand dark "TODAY" stats card ──────────────────────────────────── */

function TodayStatsCard({ isClockedOut, loading, times, weekStats, dailyTargetMs, weeklyTargetMs, effStatus }) {
  const loggedMs = times?.totalWorkMs || 0;
  const pct = Math.min(100, Math.round((loggedMs / dailyTargetMs) * 100));
  const fmtHm = (ms) => {
    const mins = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${String(m).padStart(2, '0')}m`;
  };
  const fmtHmShort = (ms) => {
    const mins = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
  };

  let heading;
  if (loading) heading = 'Loading…';
  else if (effStatus === 'clocked-in')       heading = "You're on the clock.";
  else if (effStatus === 'on-break')         heading = "You're on a break.";
  else if (effStatus === 'pending-approval') heading = 'Waiting for approval.';
  else if (effStatus === 'auto-closed')      heading = 'Auto-closed shift.';
  else                                       heading = 'Off the clock.';

  return (
    <div className="att-today-card">
      <div className="att-today-label">Today</div>
      <h4>{heading}</h4>

      <div className="mb-1">
        <span className="att-digit fw-bold" style={{ fontSize: '2.6rem', lineHeight: 1 }}>
          {Math.floor(loggedMs / 3600000)}<span style={{ fontSize: '1.1rem', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>h</span>{' '}
          {String(Math.floor((loggedMs % 3600000) / 60000)).padStart(2, '0')}<span style={{ fontSize: '1.1rem', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>m</span>
        </span>
      </div>
      <div style={{ fontSize: '0.74rem', color: 'rgba(248,250,252,0.6)' }}>
        logged of {fmtHm(dailyTargetMs)} target
      </div>

      <div className="mt-3 mb-4">
        <div className="d-flex justify-content-between align-items-center mb-1" style={{ fontSize: '0.62rem', color: 'rgba(248,250,252,0.5)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          <span>Progress</span>
          <span>{pct}%</span>
        </div>
        <div className="att-today-progress">
          <div className="att-today-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-auto d-flex gap-2">
        <div className="att-today-stat-col">
          <div className="l">This week</div>
          <div className="v">{fmtHmShort(weekStats.weekMs)}</div>
        </div>
        <div className="att-today-stat-col">
          <div className="l">Streak</div>
          <div className="v">{weekStats.streak}d</div>
        </div>
        <div className="att-today-stat-col">
          <div className="l">Overtime</div>
          <div className="v" style={{ color: weekStats.overtimeMs > 0 ? '#f5d5a8' : '#fff' }}>
            {weekStats.overtimeMs > 0 ? `+${fmtHmShort(weekStats.overtimeMs)}` : '0:00'}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBlock({ label, value, color, icon, live }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '12px 8px' }}>
      <div
        className="d-inline-flex align-items-center justify-content-center rounded-circle mb-1 position-relative"
        style={{ width: 22, height: 22, background: `${color}15` }}
      >
        <i className={`bi ${icon}`} style={{ fontSize: '0.7rem', color }} />
        {live && (
          <span
            style={{
              position: 'absolute', top: -1, right: -1,
              width: 6, height: 6, borderRadius: '50%',
              background: color, boxShadow: `0 0 0 2px #fff`,
              animation: 'attPulse 1.4s ease-in-out infinite',
            }}
          />
        )}
      </div>
      <div style={{ fontSize: '0.54rem', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
      <div
        className="att-digit fw-bold"
        style={{ fontSize: live ? '1.1rem' : '1rem', color, marginTop: 1 }}
      >
        {value}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Auto-closed banner (shown on return if user forgot to clock out)
 * ───────────────────────────────────────────────────────────────────────────── */
function AutoClosedBanner({ record, onOK, onAdjust }) {
  const clockOutStr = fmtTime(record.clockOut);
  const dateStr = formatDateForBanner(record.date);
  const hasPendingEdit = record.editClockOutRequest?.status === 'pending';
  return (
    <div className="d-flex align-items-start gap-3 p-3 mb-2"
      style={{
        background: '#fef2f2', border: '1px solid #fecaca',
        borderRadius: 12,
      }}>
      <div className="flex-shrink-0 rounded-circle d-flex align-items-center justify-content-center"
        style={{ width: 36, height: 36, background: '#fee2e2' }}>
        <i className="bi bi-exclamation-triangle-fill" style={{ color: '#dc2626' }} />
      </div>
      <div className="flex-grow-1">
        <div className="fw-bold mb-1" style={{ color: '#991b1b', fontSize: '0.86rem' }}>
          You forgot to clock out on {dateStr}
        </div>
        <div className="small" style={{ color: '#7f1d1d', fontSize: '0.78rem' }}>
          We auto-closed your shift at <strong>{clockOutStr}</strong> (8h cap applied).
          {hasPendingEdit
            ? ' Your adjustment request is awaiting TL approval.'
            : ' Tap Adjust if you actually stopped earlier.'}
        </div>
      </div>
      {!hasPendingEdit && (
        <div className="d-flex gap-2 flex-shrink-0">
          <button className="btn btn-sm btn-outline-danger"
            style={{ borderRadius: 8, fontSize: '0.76rem' }}
            onClick={onAdjust}>Adjust</button>
          <button className="btn btn-sm btn-danger"
            style={{ borderRadius: 8, fontSize: '0.76rem' }}
            onClick={onOK}>OK</button>
        </div>
      )}
    </div>
  );
}

function formatDateForBanner(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Adjust clock-out modal
 * ───────────────────────────────────────────────────────────────────────────── */
function AdjustClockOutModal({ record, isApcOrIpc, onCancel, onSubmit }) {
  // Live "you forgot" recovery (still open) vs legacy auto-closed adjustment
  const isLiveRecovery = !record.clockOut && !record.autoClosed;
  const clockInMs = record.clockIn?.toMillis ? record.clockIn.toMillis() : new Date(record.clockIn).getTime();
  // Cap at min(now, clockIn + 16h). Auto-close is gone — overtime is fine —
  // but we still want a sane upper bound so a 30-day-old forgotten record
  // can't be patched to a clock-out tomorrow.
  const HARD_CAP_MS = 16 * 60 * 60 * 1000;
  const maxMs = Math.min(Date.now(), clockInMs + HARD_CAP_MS);
  const [timeVal, setTimeVal] = useState(() => {
    // Default: 8h after clock-in (typical end of one shift), capped at maxMs.
    const target = Math.min(clockInMs + 8 * 60 * 60 * 1000, maxMs - 60 * 1000);
    const d = new Date(target);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    setError('');
    const [hh, mm] = timeVal.split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) { setError('Pick a valid time.'); return; }
    // Build target ms on the same date as the clock-in
    const clockInDate = new Date(clockInMs);
    const candidate = new Date(clockInDate);
    candidate.setHours(hh, mm, 0, 0);
    let candidateMs = candidate.getTime();
    // If candidate is before clockIn, assume next-day clock-out (cross-midnight shift)
    if (candidateMs <= clockInMs) candidateMs += 24 * 60 * 60 * 1000;
    if (candidateMs > maxMs) {
      setError(isLiveRecovery
        ? 'Time must be no more than 16 hours after clock-in (and not in the future).'
        : 'Must be earlier than the 16-hour cap.');
      return;
    }
    if (isApcOrIpc && !reason.trim()) { setError('Please add a reason for your TL.'); return; }
    try {
      setSaving(true);
      await onSubmit(candidateMs, reason.trim());
    } catch (err) {
      setError(err.message || 'Failed to submit.');
      setSaving(false);
    }
  }

  const clockInStr = fmtTime(record.clockIn);
  const clockInDateStr = (() => {
    const d = new Date(clockInMs);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  })();
  const elapsedHours = ((Date.now() - clockInMs) / 3600000);
  const closedAtStr = record.clockOut ? fmtTime(record.clockOut) : null;
  const titleText = isLiveRecovery ? 'Looks like you forgot to clock out' : 'Adjust clock-out';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={saving ? undefined : onCancel} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <h6 className="fw-bold mb-0"><i className="bi bi-clock-history me-2" style={{ color: '#dc2626' }} />{titleText}</h6>
            <button className="btn btn-sm btn-light rounded-circle" onClick={onCancel} disabled={saving}
              style={{ width: 32, height: 32 }}>
              <i className="bi bi-x-lg" />
            </button>
          </div>
          <p className="text-muted small mb-3" style={{ fontSize: '0.78rem' }}>
            Clock-in was at <strong>{clockInStr}</strong> on <strong>{clockInDateStr}</strong>
            {isLiveRecovery && elapsedHours >= 1 && (
              <> ({elapsedHours.toFixed(1)}h ago)</>
            )}.
            {isLiveRecovery
              ? ' Pick when you actually stopped working — your TL will see this for approval.'
              : <> Auto-closed at <strong>{closedAtStr}</strong>. Enter the time you actually stopped working.</>}
          </p>
          <div className="mb-3">
            <label className="small text-muted d-block mb-1" style={{ fontSize: '0.72rem', fontWeight: 600 }}>Actual clock-out time</label>
            <input type="time" className="form-control form-control-sm"
              style={{ borderRadius: 8 }} value={timeVal} onChange={e => setTimeVal(e.target.value)} />
          </div>
          {isApcOrIpc && (
            <div className="mb-3">
              <label className="small text-muted d-block mb-1" style={{ fontSize: '0.72rem', fontWeight: 600 }}>Reason (for your TL)</label>
              <textarea className="form-control form-control-sm" rows="2"
                style={{ borderRadius: 8, fontSize: '0.82rem' }}
                placeholder="Why you forgot to clock out…"
                value={reason} onChange={e => setReason(e.target.value)} />
            </div>
          )}
          {error && <div className="alert alert-danger py-2 small mb-3" style={{ fontSize: '0.78rem' }}>{error}</div>}
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onCancel} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-4" onClick={handleSubmit} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm me-1" />Saving…</> : (isApcOrIpc ? 'Submit to TL' : 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
