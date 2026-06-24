import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  getToday, clockIn, requestClockOut, startBreak, endBreak,
  listPendingApprovals, approveClockOut, listHistory, listTeamHistory,
  requestAttendanceEdit, decideAttendanceEdit, listPendingEditRequests, fmtMs,
  markStillWorking, isOverReminder, hasFreshStillWorkingAck, needsRecoveryPrompt,
  forceCloseSession,
  listAdjustmentsForUserMonth, summarizeMonth,
} from '../../lib/attendanceApi';
import { listHolidayDatesForMonth } from '../../lib/holidaysApi';
import {
  AlertIcon, RefreshIcon, CheckIcon, XIcon, ArrowRightIcon, ClockIcon, PencilIcon,
} from '../../components/common/Icon';
import RosterTab from '../../components/attendance/RosterTab';
import '../../styles/table.css';
import '../../styles/attendance.css';

const TARGET_MS      = 8 * 3600 * 1000;          // matches the 8-hour auto-cap
const SCHEDULE_LABEL = 'Scheduled 09:00 – 17:00 · Target 8h';
const LOCAL_TZ       = Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop().replace(/_/g, ' ');

const LOCATIONS = [
  { v: 'wfh',      label: 'WFH' },
  { v: 'office',   label: 'Office' },
  { v: 'bahria',   label: 'Bahria' },
  { v: 'lakecity', label: 'Lake City' },
];
const locationLabel = (v) => LOCATIONS.find((l) => l.v === v)?.label || v || '—';

export default function AttendancePage() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const isManager = ['boss', 'ol', 'tl', 'pctl', 'developer'].includes(profile?.role);
  const isRosterManager = ['boss', 'ol', 'developer'].includes(profile?.role);
  // Boss doesn't clock in personally — they only oversee the team.
  // Default them to the Team tab and hide the Today tab entirely.
  const isBoss = profile?.role === 'boss';

  const [location, setLoc] = useState('wfh');
  const [busy, setBusy]    = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [historyRange, setHistoryRange] = useState('week'); // week | month | quarter
  const [tab, setTab]      = useState(isBoss ? 'team' : 'today'); // today | history | team
  const [teamRange, setTeamRange]   = useState('week');
  const [teamUserFilter, setTeamUserFilter] = useState('all');
  const [confirmOut, setConfirmOut] = useState(false);

  // Recovery prompt — auto-opens an edit-clock-out request when the
  // session has gone stale (>14h) or rolled into the next calendar
  // day. The "handled" ref keeps a per-session-id flag so the modal
  // does NOT reopen on every 1-second tick after the user submits or
  // dismisses; it resets once a new session id appears. Mirrors v1's
  // recoveryHandledFor fix.
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const recoveryHandledRef = useRef(null);

  // Manager force-close target — Boss/OL/Developer can close someone
  // else's stuck session from the Team tab. Holds the row to close.
  const [forceCloseTarget, setForceCloseTarget] = useState(null);
  const canForceClose = ['boss', 'ol', 'developer'].includes(profile?.role);

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['attendance', 'me', uid], queryFn: () => getToday(uid), enabled: !!uid && !isBoss },
      { queryKey: ['attendance', 'pending'], queryFn: () => listPendingApprovals(), enabled: !!uid && isManager },
      { queryKey: ['attendance', 'pending-edits'], queryFn: () => listPendingEditRequests(), enabled: !!uid && isManager },
    ],
  });
  const [meQ, pendingQ, pendingEditsQ] = results;
  const me           = meQ.data || null;
  const pending      = pendingQ.data || [];
  const pendingEdits = pendingEditsQ.data || [];
  const loading = meQ.isPending;
  const err     = localErr || results.find((r) => r.error)?.error?.message || '';

  // History — fetch last 90 days once; filter client-side by range toggle.
  // Skip for Boss since they don't have a personal attendance record.
  const { data: history = [] } = useQuery({
    queryKey: ['attendance', 'history', uid],
    queryFn: () => {
      const from = new Date(); from.setDate(from.getDate() - 90);
      return listHistory(uid, { from: from.toISOString().slice(0, 10) });
    },
    enabled: !!uid && !isBoss,
  });

  // Team history (manager) — same 90-day window, filtered client-side.
  const { data: teamHistory = [] } = useQuery({
    queryKey: ['attendance', 'team-history'],
    queryFn: () => {
      const from = new Date(); from.setDate(from.getDate() - 90);
      return listTeamHistory({ from: from.toISOString().slice(0, 10) });
    },
    enabled: !!uid && isManager && (tab === 'team' || isBoss),
  });

  const reload = () => qc.invalidateQueries({ queryKey: ['attendance'] });

  // Live tick every second so the wall clock and the session timer animate.
  const [tickN, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  // Realtime — invalidate on any attendance row change.
  useEffect(() => {
    if (!uid) return;
    const ch = supabase
      .channel(`attendance-live-${uid}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'attendance' },
        () => qc.invalidateQueries({ queryKey: ['attendance'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [uid, qc]);

  async function run(fn) {
    setBusy(true); setLocalErr('');
    try { await fn(); reload(); }
    catch (e) { setLocalErr(e.message); }
    finally { setBusy(false); }
  }

  // ---------------- Derived state ----------------
  const elapsed = useMemo(() => {
    if (!me?.clock_in) return 0;
    const end = me.clock_out ? new Date(me.clock_out) : new Date();
    return Math.max(0, end - new Date(me.clock_in)) - (me.total_break_ms || 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, tickN]);
  const breakMs   = me?.total_break_ms || 0;

  // ---- Reminder + recovery (depends on the 1s tick so they animate) ----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const showStillWorkingBanner = useMemo(
    () => !!me && isOverReminder(me) && !hasFreshStillWorkingAck(me) && !me.clock_out,
    [me, tickN],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recoveryNeeded = useMemo(() => !!me && needsRecoveryPrompt(me), [me, tickN]);

  useEffect(() => {
    if (!me?.id) { recoveryHandledRef.current = null; return; }
    if (recoveryNeeded && recoveryHandledRef.current !== me.id) {
      setRecoveryOpen(true);
    }
  }, [recoveryNeeded, me?.id]);
  const isOnBreak = me?.status === 'on-break';
  const isPending = me?.status === 'pending-approval';
  const isOut     = me?.status === 'clocked-out';
  const isIn      = me?.status === 'clocked-in';
  const notStarted = !me || (!isIn && !isOnBreak && !isPending && !isOut);

  // Live wall clock (HH:MM:SS) — seconds rendered separately so they can fade.
  const now = useMemo(() => new Date(), [tickN]);
  const wallH = String(now.getHours()).padStart(2, '0');
  const wallM = String(now.getMinutes()).padStart(2, '0');
  const wallS = String(now.getSeconds()).padStart(2, '0');

  // Banner lead-in
  const bannerText = useMemo(() => {
    if (isBoss) return 'Team attendance overview — no personal clock-in for Boss.';
    if (!history || history.length === 0 && notStarted) return 'Welcome. Tap Clock in to start your day.';
    if (isIn)        return 'You\'re on the clock. Stay focused — take a short break when you need one.';
    if (isOnBreak)   return 'On a break. The session timer pauses until you come back.';
    if (isPending)   return 'Clock-out sent for approval. You\'re almost done for today.';
    if (isOut)       return `Shift wrapped at ${fmtTime(me.clock_out)} — clean ${fmtMs(me.total_work_ms || elapsed)}.`;
    // Not started — mention last shift if any
    const last = (history || []).find((r) => r.status === 'clocked-out' && r.clock_out);
    if (last) {
      const when = relativeDay(last.date);
      return `Tap Clock in to start your day. Your last shift ended ${when} at ${fmtTime(last.clock_out)} — clean ${fmtMs(last.total_work_ms)}.`;
    }
    return 'Tap Clock in to start your day.';
  }, [history, notStarted, isIn, isOnBreak, isPending, isOut, me, elapsed, isBoss]);

  // Headline in dark card
  const todayHeadline =
    isOut      ? 'All wrapped for today.'   :
    isPending  ? 'Waiting on approval.'     :
    isOnBreak  ? 'On a break.'              :
    isIn       ? 'You\'re on the clock.'    :
                 'You\'re about to start.';

  // Week / streak / overtime from full 90-day history
  const { weekMs, streakDays, overtimeMs } = useMemo(() => {
    const byDate = new Map((history || []).map((r) => [r.date, r]));
    const todayStr = new Date().toISOString().slice(0, 10);

    // This week (Mon..Sun)
    const d = new Date();
    const dow = (d.getDay() + 6) % 7; // 0 = Monday
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - dow);
    let wMs = 0, scheduledDays = 0;
    for (let i = 0; i <= dow; i++) {
      const day = new Date(weekStart); day.setDate(weekStart.getDate() + i);
      const key = day.toISOString().slice(0, 10);
      const row = byDate.get(key);
      // count Mon–Fri as scheduled for overtime calc
      if (day.getDay() >= 1 && day.getDay() <= 5) scheduledDays++;
      if (row) {
        wMs += (row.total_work_ms || (row.clock_in && key === todayStr ? elapsed : 0) || 0);
      } else if (key === todayStr) {
        wMs += elapsed;
      }
    }

    // Streak — consecutive days (going back from most recent with work) with any worked ms
    const sorted = [...(history || [])]
      .filter((r) => (r.total_work_ms || 0) > 0 || r.clock_in)
      .sort((a, b) => b.date.localeCompare(a.date));
    let streak = 0;
    let cursor = new Date();
    // If no work today yet, start streak check at yesterday
    if (!sorted.find((r) => r.date === todayStr)) cursor.setDate(cursor.getDate() - 1);
    for (const row of sorted) {
      const key = cursor.toISOString().slice(0, 10);
      if (row.date === key) { streak++; cursor.setDate(cursor.getDate() - 1); }
      else if (row.date < key) break;
    }

    const overtime = wMs - scheduledDays * TARGET_MS;
    return { weekMs: wMs, streakDays: streak, overtimeMs: overtime };
  }, [history, elapsed]);

  // Keyboard shortcuts — Space clock-in or opens clock-out confirm, B toggles break.
  const actionsRef = useRef({});
  actionsRef.current = { isIn, isOnBreak, isOut, notStarted, busy, location, setConfirmOut, isBoss };
  useEffect(() => {
    function onKey(e) {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      const s = actionsRef.current;
      if (s.isBoss) return; // Boss doesn't clock in
      if (e.key === ' ' || e.code === 'Space') {
        if (s.busy || s.isOut) return;            // already done for today
        e.preventDefault();
        if (s.notStarted)                     run(() => clockIn(s.location));
        else if (s.isIn || s.isOnBreak)       s.setConfirmOut(true);
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        if (s.busy || s.notStarted || s.isOut) return;
        if (s.isOnBreak)  run(endBreak);
        else if (s.isIn)  run(startBreak);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* ---------- Page title (kept minimal; the hero carries the weight) ---------- */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Attendance</h1>
          <p className="page-subtitle att-banner">{bannerText}</p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={reload} disabled={loading} title="Refresh">
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* ---------- Tabs ---------- */}
      <div className="att-tabs">
        {!isBoss && (
          <button type="button"
            className={`att-tab ${tab === 'today' ? 'is-active' : ''}`}
            onClick={() => setTab('today')}>
            Today
          </button>
        )}
        {!isBoss && (
          <button type="button"
            className={`att-tab ${tab === 'history' ? 'is-active' : ''}`}
            onClick={() => setTab('history')}>
            History
          </button>
        )}
        {isManager && (
          <button type="button"
            className={`att-tab ${tab === 'team' ? 'is-active' : ''}`}
            onClick={() => setTab('team')}>
            Team
          </button>
        )}
        {isRosterManager && (
          <button type="button"
            className={`att-tab ${tab === 'roster' ? 'is-active' : ''}`}
            onClick={() => setTab('roster')}>
            Roster
          </button>
        )}
      </div>

      {tab === 'roster' && isRosterManager && <RosterTab />}

      {tab === 'today' && !isBoss && <>
      <MonthlyAttendanceWidget uid={uid} history={history} displayName={profile?.display_name} />
      {showStillWorkingBanner && (
        <div className="wx-alert" style={{
          background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
          color: 'var(--warning)',
          border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)',
          marginBottom: 12,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <ClockIcon width="14" height="14" />
          <span style={{ flex: 1 }}>
            You've been clocked in for over 9 hours. Still working, or did you forget to clock out?
          </span>
          <button
            type="button"
            className="wx-btn wx-btn-primary wx-btn-sm"
            disabled={busy}
            onClick={() => run(markStillWorking)}>
            Yes, still working
          </button>
          <button
            type="button"
            className="wx-btn wx-btn-ghost wx-btn-sm"
            onClick={() => setConfirmOut(true)}
            disabled={busy}>
            Clock out
          </button>
        </div>
      )}

      {/* ---------- Two-card hero ---------- */}
      <div className="att-dash">
        {/* ----- Left white card ----- */}
        <div className="att-dash-card">
          <div className="att-eyebrow">Current time · {LOCAL_TZ}</div>
          <div className="att-wall-clock" aria-label="current time">
            <span>{wallH}</span>
            <span className="att-wall-sep">:</span>
            <span>{wallM}</span>
            <span className="att-wall-sep att-wall-fade">:</span>
            <span className="att-wall-fade">{wallS}</span>
          </div>
          <div className="att-sched">{SCHEDULE_LABEL}</div>

          <div className="att-divider" />

          <div className="att-mini-stats">
            <MiniStat
              label="Last clock-in"
              value={me?.clock_in ? fmtTime(me.clock_in) : '—'}
              sub={me?.clock_in ? `Started ${new Date(me.clock_in).toLocaleDateString(undefined, { weekday: 'long' })}` : 'Tap the button to start'}
            />
            <MiniStat
              label="Session"
              mono
              value={isIn || isOnBreak ? fmtClock(elapsed) : '0:00:00'}
              sub={isOnBreak ? 'Paused' : isIn ? 'Live elapsed timer' : isOut ? 'Ended today' : 'Live elapsed timer'}
            />
            <MiniStat
              label="Breaks today"
              value={fmtBreakShort(breakMs)}
              sub={breakMs > 0 ? `${Math.round(breakMs / 60000)} min · ${locationLabel(me?.location)}` : 'None yet'}
            />
          </div>

          {/* Location picker — only when not started for today */}
          {notStarted && (
            <div className="att-loc-row">
              {LOCATIONS.map(({ v, label }) => (
                <button key={v} type="button"
                  className={`att-loc-chip ${location === v ? 'is-active' : ''}`}
                  onClick={() => setLoc(v)} disabled={busy}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Primary action */}
          {isOut ? (
            <div className="att-wrapped">
              <CheckIcon width="18" height="18" />
              <div>
                <div className="att-wrapped-title">Shift wrapped for today</div>
                <div className="att-wrapped-sub">
                  Clocked out at <strong>{fmtTime(me.clock_out)}</strong> · Clean <strong>{fmtMs(me.total_work_ms || elapsed)}</strong>
                </div>
              </div>
            </div>
          ) : isPending ? (
            <div className="att-primary-pending">
              <span className="att-dot-pulse" /> Waiting for approval
            </div>
          ) : (
            <button
              className={`att-primary ${isIn || isOnBreak ? 'att-primary-danger' : 'att-primary-dark'}`}
              onClick={() => {
                if (isIn || isOnBreak) setConfirmOut(true);
                else                    run(() => clockIn(location));
              }}
              disabled={busy}
            >
              <span>{isIn || isOnBreak ? 'Clock out' : 'Clock in'}</span>
              <ArrowRightIcon width="16" height="16" />
            </button>
          )}

          {/* Secondary actions */}
          <div className="att-secondary-row">
            <button
              type="button"
              className={`att-secondary ${isOnBreak ? 'is-active' : ''}`}
              disabled={busy || notStarted || isOut || isPending}
              onClick={() => run(isOnBreak ? endBreak : startBreak)}
              title={notStarted || isOut ? 'Clock in first' : 'Short break'}
            >
              <span className="att-emoji">☕</span> {isOnBreak ? 'End break' : 'Short break'}
            </button>
            <button type="button" className="att-secondary" disabled title="Coming soon">
              <span className="att-emoji">🍱</span> Lunch
            </button>
            <button type="button" className="att-secondary" disabled title="Coming soon">
              <span className="att-emoji">✈</span> Off-site
            </button>
          </div>

          <div className="att-kbd-hint">
            Press <kbd>Space</kbd> to clock in/out · <kbd>B</kbd> for break
          </div>
        </div>

        {/* ----- Right black card ----- */}
        <div className="att-dash-card att-dash-card-dark">
          <div className="att-eyebrow att-eyebrow-dark">Today</div>
          <h2 className="att-dash-heading">{todayHeadline}</h2>

          <div className="att-big-number">
            <span className="att-big-hours">{Math.floor(elapsed / 3600000)}</span>
            <span className="att-big-unit">h</span>
            <span className="att-big-mins">{String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0')}</span>
            <span className="att-big-unit">m</span>
          </div>
          <div className="att-big-sub">logged of {fmtTargetLabel(TARGET_MS)} target</div>

          <div className="att-progress-wrap">
            <div className="att-progress-row">
              <span>Progress</span>
              <span>{Math.round(Math.min(100, (elapsed / TARGET_MS) * 100))}%</span>
            </div>
            <div className="att-progress-track">
              <div
                className="att-progress-fill"
                style={{ width: `${Math.min(100, (elapsed / TARGET_MS) * 100)}%` }}
              />
            </div>
          </div>

          <div className="att-dash-stats">
            <DashStat label="This week"  value={fmtMsShort(weekMs)} />
            <DashStat label="Streak"     value={`${streakDays}d`} />
            <DashStat label="Overtime"   value={(overtimeMs >= 0 ? '+' : '-') + fmtMsShort(Math.abs(overtimeMs))} />
          </div>
        </div>
      </div>
      </>}

      {/* Manager approval queues — shown on BOTH the Today and Team tabs so a
          TL/OL finds pending clock-out + time-edit (incl. break) requests where
          they manage their team. Previously these lived only on the personal
          Today tab, so a TL looking under "Team" couldn't see a break-edit
          request waiting on them. */}
      {isManager && (tab === 'today' || tab === 'team') && (<>

      {/* ---------- Manager: pending approvals ---------- */}
      {isManager && pending.length > 0 && (
        <div className="att-section">
          <div className="att-section-header">
            <div className="att-section-title">
              Pending clock-out approvals
              <span className="att-section-count is-warn">{pending.length}</span>
            </div>
          </div>
          {pending.map((p) => (
            <div key={p.id} className="att-approval-row" style={{ gridTemplateColumns: '36px 1fr auto', alignItems: 'flex-start' }}>
              <Avatar user={p.user} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{p.user?.display_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {p.user?.role} · started {fmtTime(p.clock_in)} · {locationLabel(p.location)} ·
                  worked <strong style={{ color: 'var(--text-secondary)' }}>{fmtMs(Date.now() - new Date(p.clock_in).getTime())}</strong>
                </div>
                {p.clock_out_note && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 8, fontStyle: 'italic' }}>
                    "{p.clock_out_note}"
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="wx-btn wx-btn-primary" disabled={busy}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => run(() => approveClockOut(p.id, true))}>
                  <CheckIcon width="13" height="13" /> Approve
                </button>
                <button className="wx-btn wx-btn-ghost" disabled={busy}
                  style={{ padding: '6px 12px', fontSize: 12, color: 'var(--danger)' }}
                  onClick={() => {
                    const r = prompt('Rejection reason:');
                    if (r === null) return;
                    run(() => approveClockOut(p.id, false, r || ''));
                  }}>
                  <XIcon width="13" height="13" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Manager: pending attendance-edit requests ---------- */}
      {isManager && pendingEdits.length > 0 && (
        <div className="att-section">
          <div className="att-section-header">
            <div className="att-section-title">
              Pending time-edit requests
              <span className="att-section-count is-warn">{pendingEdits.length}</span>
            </div>
          </div>
          {pendingEdits.map((e) => (
            <div key={e.id} className="att-approval-row" style={{ gridTemplateColumns: '36px 1fr auto', alignItems: 'flex-start' }}>
              <Avatar user={e.user} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{e.user?.display_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {e.user?.role} · wants to change{' '}
                  <strong style={{ color: 'var(--text-secondary)' }}>
                    {e.field === 'clock_in' ? 'clock-in' : e.field === 'clock_out' ? 'clock-out' : 'breaks'}
                  </strong>
                  {' '}for {e.attendance?.date}
                </div>
                {/* Clock-in / Clock-out diff (single timestamp) */}
                {e.field !== 'breaks' && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {e.attendance?.[e.field] && <>from <strong>{fmtTime(e.attendance[e.field])}</strong> → </>}
                    <strong style={{ color: 'var(--accent)' }}>{fmtTime(e.requested_value)}</strong>
                  </div>
                )}
                {/* Breaks diff — show old vs new arrays side-by-side */}
                {e.field === 'breaks' && (
                  <BreaksDiff
                    oldBreaks={e.attendance?.breaks || []}
                    newBreaks={e.requested_breaks || []}
                  />
                )}
                {e.reason && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 6, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 8, fontStyle: 'italic' }}>
                    "{e.reason}"
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="wx-btn wx-btn-primary" disabled={busy}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                  onClick={() => run(() => decideAttendanceEdit({ editId: e.id, approve: true }))}>
                  <CheckIcon width="13" height="13" /> Apply
                </button>
                <button className="wx-btn wx-btn-ghost" disabled={busy}
                  style={{ padding: '6px 12px', fontSize: 12, color: 'var(--danger)' }}
                  onClick={() => {
                    const r = prompt('Rejection reason:');
                    if (r === null) return;
                    run(() => decideAttendanceEdit({ editId: e.id, approve: false, note: r || null }));
                  }}>
                  <XIcon width="13" height="13" /> Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      </>)}

      {tab === 'history' && (
        <HistorySection
          rows={history}
          range={historyRange}
          onRange={setHistoryRange}
          targetMs={TARGET_MS}
        />
      )}

      {tab === 'team' && isManager && (
        <TeamHistorySection
          rows={teamHistory}
          range={teamRange}
          onRange={setTeamRange}
          userFilter={teamUserFilter}
          onUserFilter={setTeamUserFilter}
          targetMs={TARGET_MS}
          currentUid={uid}
          canForceClose={canForceClose}
          onForceClose={setForceCloseTarget}
        />
      )}

      {confirmOut && (
        <ClockOutConfirm
          elapsed={elapsed}
          role={profile?.role}
          busy={busy}
          onCancel={() => setConfirmOut(false)}
          onConfirm={async (note) => {
            setConfirmOut(false);
            await run(() => requestClockOut(note));
          }}
        />
      )}

      {recoveryOpen && me && (
        <EditRequestModal
          row={me}
          recovery
          onClose={() => {
            recoveryHandledRef.current = me.id;
            setRecoveryOpen(false);
          }}
          onSubmitted={() => {
            recoveryHandledRef.current = me.id;
            setRecoveryOpen(false);
            reload();
          }}
        />
      )}

      {forceCloseTarget && (
        <ForceCloseModal
          row={forceCloseTarget}
          onClose={() => setForceCloseTarget(null)}
          onDone={() => {
            setForceCloseTarget(null);
            qc.invalidateQueries({ queryKey: ['attendance'] });
          }}
        />
      )}
    </>
  );
}

function ClockOutConfirm({ elapsed, role, busy, onCancel, onConfirm }) {
  const needsApproval = role === 'apc' || role === 'ipc';
  const [note, setNote] = useState('');
  return (
    <div className="wx-modal-backdrop" onClick={onCancel}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="wx-modal-header">
          <h2 className="wx-modal-title">
            <ClockIcon width="18" height="18" /> Clock out?
          </h2>
        </div>
        <div className="wx-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>
            You've worked <strong style={{ color: 'var(--text-primary)' }}>{fmtClock(elapsed)}</strong> today.
            {needsApproval
              ? ' This will send a clock-out request to your manager for approval.'
              : ' This will end your shift for today — you can\'t clock back in until tomorrow.'}
          </div>
          {needsApproval && (
            <div>
              <label className="wx-label" style={{ fontSize: 12 }}>Summary note (optional)</label>
              <textarea className="wx-input" rows={3} value={note}
                onChange={(e) => setNote(e.target.value)} disabled={busy}
                placeholder="What did you get done today? Your approver will see this."
                style={{ fontSize: 13 }} />
            </div>
          )}
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="wx-btn wx-btn-primary" onClick={() => onConfirm(note.trim() || null)} disabled={busy}
            style={{ background: '#e64a4a', borderColor: '#e64a4a' }}>
            {busy ? <><span className="wx-spinner" /> Clocking out…</> : 'Yes, clock out'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// History
// ============================================================
function HistorySection({ rows, range, onRange, targetMs }) {
  const qc = useQueryClient();
  const [editRow, setEditRow] = useState(null);
  const filtered = useMemo(() => {
    const now = new Date();
    const from = new Date(now);
    if (range === 'week')         { const dow = (now.getDay() + 6) % 7; from.setDate(now.getDate() - dow); }
    else if (range === 'month')   { from.setDate(1); }
    else if (range === 'quarter') { from.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); }
    const fromStr = from.toISOString().slice(0, 10);
    return (rows || [])
      .filter((r) => r.date >= fromStr)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [rows, range]);

  const totalWorkMs = filtered.reduce((sum, r) => sum + (r.total_work_ms || 0), 0);
  const scheduledDays = filtered.filter((r) => {
    const day = new Date(r.date).getDay();
    return day >= 1 && day <= 5;
  }).length;
  const targetTotal = scheduledDays * targetMs;
  const overtimeMs = totalWorkMs - targetTotal;

  const rangeTitle = useMemo(() => {
    if (!filtered.length) return '';
    const first = filtered[filtered.length - 1].date;
    const last  = filtered[0].date;
    return `${fmtDateShort(first)} – ${fmtDateShort(last)}, ${new Date(last).getFullYear()}`;
  }, [filtered]);

  function exportCsv() {
    const header = ['Date','Clock in','Clock out','Worked (ms)','Break (ms)','Status','Location'];
    const lines = [header.join(',')];
    filtered.forEach((r) => {
      lines.push([
        r.date,
        r.clock_in  ? new Date(r.clock_in).toISOString()  : '',
        r.clock_out ? new Date(r.clock_out).toISOString() : '',
        r.total_work_ms || 0,
        r.total_break_ms || 0,
        r.status,
        r.location || '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `attendance-${range}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="att-history">
      <div className="att-history-head">
        <div>
          <div className="att-history-title">History</div>
          <div className="att-history-sub">Your recent attendance · all times local ({LOCAL_TZ})</div>
        </div>
        <div className="att-history-actions">
          <div className="att-range-tabs">
            {['week','month','quarter'].map((k) => (
              <button key={k} type="button"
                className={`att-range-tab ${range === k ? 'is-active' : ''}`}
                onClick={() => onRange(k)}>
                {k === 'week' ? 'This week' : k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="att-export-btn" onClick={exportCsv}>
            <DownloadGlyph /> Export CSV
          </button>
        </div>
      </div>

      <div className="att-hist-table">
        <div className="att-hist-row att-hist-head-row">
          <div>Date</div>
          <div>Clock in → Out</div>
          <div>Worked</div>
          <div>Break</div>
          <div>Target</div>
          <div>Status</div>
          <div>Location</div>
        </div>

        {filtered.length === 0 ? (
          <div className="att-empty" style={{ padding: 32 }}>
            <div className="att-empty-title">No entries in this range</div>
            <div>Clock in to start building your history.</div>
          </div>
        ) : (
          filtered.map((r) => (
            <HistoryRow key={r.id} row={r} targetMs={targetMs} onRequestEdit={setEditRow} />
          ))
        )}
      </div>

      {editRow && (
        <EditRequestModal
          row={editRow}
          onClose={() => setEditRow(null)}
          onSubmitted={() => { setEditRow(null); qc.invalidateQueries({ queryKey: ['attendance'] }); }}
        />
      )}

      {filtered.length > 0 && (
        <div className="att-hist-footer">
          <div>
            Showing {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}
            {rangeTitle && <> · {range === 'week' ? 'week of ' : ''}{rangeTitle}</>}
          </div>
          <div>
            Total worked <strong>{fmtMs(totalWorkMs)}</strong> · Target <strong>{fmtMs(targetTotal)}</strong>
            {targetTotal > 0 && (
              <> · Overtime <strong style={{ color: overtimeMs >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {overtimeMs >= 0 ? '+' : '-'}{fmtMs(Math.abs(overtimeMs))}
              </strong></>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryRow({ row, targetMs, onRequestEdit }) {
  const date = new Date(row.date);
  const today = new Date().toISOString().slice(0, 10);
  const isToday = row.date === today;
  // For a still-open entry (clocked in, not out yet) compute live progress —
  // otherwise today's row would render '—' until the user clocks out.
  const workMs = row.total_work_ms
    || (row.clock_in && !row.clock_out
        ? Math.max(0, Date.now() - new Date(row.clock_in).getTime() - (row.total_break_ms || 0))
        : 0);
  const pct = Math.min(100, Math.round((workMs / targetMs) * 100));
  const status = deriveHistoryStatus(row);

  return (
    <div className="att-hist-row">
      <div className="att-date-cell">
        <div className={`att-date-tile ${isToday ? 'is-today' : ''}`}>
          <div className="att-date-tile-month">{date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div>
          <div className="att-date-tile-day">{date.getDate()}</div>
        </div>
        <div>
          <div className="att-date-name">{date.toLocaleDateString(undefined, { weekday: 'long' })}</div>
          <div className="att-date-sub">{isToday ? 'Today' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
        </div>
      </div>
      <div className="att-hist-val">
        {row.clock_in ? (
          <>
            {fmtTime(row.clock_in)}
            <span className="att-hist-arrow"> → </span>
            {row.clock_out ? fmtTime(row.clock_out) : '—'}
            {onRequestEdit && row.clock_in && (
              <button type="button" onClick={() => onRequestEdit(row)} title="Request time correction"
                style={{ marginLeft: 8, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                <PencilIcon width="11" height="11" />
              </button>
            )}
          </>
        ) : <span style={{ color: 'var(--text-muted)' }}>Not started</span>}
      </div>
      <div className="att-hist-val">{workMs ? fmtMs(workMs) : '—'}</div>
      <div className="att-hist-val">{row.total_break_ms ? fmtMs(row.total_break_ms) : '—'}</div>
      <div className="att-hist-target">
        <div className="att-progress-track att-progress-track-sm">
          <div className="att-progress-fill att-progress-fill-dark" style={{ width: `${pct}%` }} />
        </div>
        <span>{pct}%</span>
      </div>
      <div><HistoryStatusPill status={status} /></div>
      <div className="att-hist-loc">{locationLabel(row.location)}</div>
    </div>
  );
}

// --------------------------------------------------------------
// Employee edit-request modal — request a correction on clock_in
// or clock_out for a specific past attendance row.
// --------------------------------------------------------------
function EditRequestModal({ row, onClose, onSubmitted, recovery = false }) {
  // Recovery flow always wants clock_out (the user forgot to clock
  // out — that's the whole reason we're prompting). Otherwise default
  // to whichever field already has a value the user might want to fix.
  const [field, setField] = useState(recovery ? 'clock_out' : (row.clock_out ? 'clock_out' : 'clock_in'));
  const initial = (row[field] ? new Date(row[field]) : new Date()).toISOString().slice(0, 16);
  const [value, setValue] = useState(initial);
  const [reason, setReason] = useState(recovery ? 'Forgot to clock out — recovering session.' : '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const elapsedH = row.clock_in ? ((Date.now() - new Date(row.clock_in).getTime()) / 3600000) : 0;

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!reason.trim()) return setErr('Please tell your manager why you need this change.');
    setSaving(true);
    try {
      await requestAttendanceEdit({
        attendanceId:   row.id,
        field,
        requestedValue: new Date(value).toISOString(),
        reason:         reason.trim(),
      });
      onSubmitted();
    } catch (e) { setErr(e.message); setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">
              {recovery ? 'Looks like you forgot to clock out' : 'Request time correction'}
            </div>
            <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
          </div>
          <div className="wx-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {err && (
              <div className="wx-alert wx-alert-danger">
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}
            {recovery && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Your shift started <strong>{fmtTime(row.clock_in)}</strong> on{' '}
                <strong>{new Date(row.clock_in).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
                {' '}({elapsedH.toFixed(1)}h ago). Pick when you actually stopped working.
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {new Date(row.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
              {row.clock_in && <> · Currently recorded: <strong>{fmtTime(row.clock_in)} → {row.clock_out ? fmtTime(row.clock_out) : '—'}</strong></>}
            </div>

            <div>
              <label className="wx-label">Field to correct</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {['clock_in','clock_out'].map((f) => (
                  <button key={f} type="button"
                    className={`wx-role-chip ${field === f ? 'wx-role-chip-active' : ''}`}
                    onClick={() => { setField(f); setValue((row[f] ? new Date(row[f]) : new Date()).toISOString().slice(0,16)); }}
                    disabled={saving || (f === 'clock_out' && !row.clock_out)}>
                    {f === 'clock_in' ? 'Clock in' : 'Clock out'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="wx-label">Correct time</label>
              <input type="datetime-local" className="wx-input"
                value={value} onChange={(e) => setValue(e.target.value)} disabled={saving} />
            </div>

            <div>
              <label className="wx-label">Reason</label>
              <textarea className="wx-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                disabled={saving} placeholder="Why does this need a correction?" />
            </div>
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Sending…</> : 'Send request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --------------------------------------------------------------
// Force-close modal — Boss/OL/Developer override for stuck open
// sessions. Picks the actual stop time, optional reason, and
// closes through att_force_close (which stamps audit columns and
// emits a notification to the user).
// --------------------------------------------------------------
function ForceCloseModal({ row, onClose, onDone }) {
  const clockInMs = row.clock_in ? new Date(row.clock_in).getTime() : Date.now();
  const HARD_CAP_MS = 16 * 60 * 60 * 1000;
  const maxMs = Math.min(Date.now(), clockInMs + HARD_CAP_MS);
  const defaultMs = Math.min(clockInMs + 8 * 60 * 60 * 1000, maxMs - 60 * 1000);
  const [value, setValue] = useState(() => {
    const d = new Date(defaultMs);
    // datetime-local needs YYYY-MM-DDTHH:MM in local time
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const elapsedH = (Date.now() - clockInMs) / 3600000;

  async function submit(e) {
    e.preventDefault(); setErr('');
    const picked = new Date(value);
    if (isNaN(picked.getTime())) { setErr('Pick a valid time.'); return; }
    if (picked.getTime() <= clockInMs) { setErr('Clock-out must be after clock-in.'); return; }
    if (picked.getTime() > maxMs) {
      setErr('Clock-out cannot be more than 16h after clock-in (and not in the future).');
      return;
    }
    setSaving(true);
    try {
      await forceCloseSession({
        attendanceId: row.id,
        clockOut:     picked.toISOString(),
        reason:       reason.trim() || null,
      });
      onDone();
    } catch (e) { setErr(e.message); setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={saving ? undefined : onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">
              Close session for {row.user?.display_name || 'user'}
            </div>
            <button type="button" className="shell-icon-btn" onClick={onClose} disabled={saving}>
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {err && (
              <div className="wx-alert wx-alert-danger">
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Clocked in <strong>{fmtTime(row.clock_in)}</strong> on{' '}
              <strong>{new Date(row.clock_in).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
              {elapsedH >= 1 && <> ({elapsedH.toFixed(1)}h ago)</>}.
              Pick when they actually stopped working — they'll be notified.
            </div>

            <div>
              <label className="wx-label">Clock-out time</label>
              <input type="datetime-local" className="wx-input"
                value={value} onChange={(e) => setValue(e.target.value)} disabled={saving} />
            </div>

            <div>
              <label className="wx-label">Reason (optional, shown to user)</label>
              <textarea className="wx-input" rows={2} value={reason}
                onChange={(e) => setReason(e.target.value)} disabled={saving}
                placeholder="e.g. Forgot to clock out — closing on your behalf." />
            </div>
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="wx-btn wx-btn-danger" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Closing…</> : 'Close session'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Team history (manager view)
// ============================================================
function TeamHistorySection({ rows, range, onRange, userFilter, onUserFilter, targetMs, currentUid, canForceClose = false, onForceClose }) {
  // Drop the caller's own rows — a manager's personal attendance belongs on
  // their History tab, not the Team view of teammates.
  const teamRows = useMemo(() =>
    (rows || []).filter((r) => r.user_id && r.user_id !== currentUid),
    [rows, currentUid]);

  // Build the user dropdown from rows we actually received (scoped by RLS).
  const users = useMemo(() => {
    const m = new Map();
    teamRows.forEach((r) => { if (r.user) m.set(r.user_id, r.user); });
    return Array.from(m.entries())
      .map(([id, u]) => ({ id, ...u }))
      .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  }, [teamRows]);

  const filtered = useMemo(() => {
    const now = new Date();
    const from = new Date(now);
    if (range === 'week')         { const dow = (now.getDay() + 6) % 7; from.setDate(now.getDate() - dow); }
    else if (range === 'month')   { from.setDate(1); }
    else if (range === 'quarter') { from.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); }
    const fromStr = from.toISOString().slice(0, 10);
    return teamRows
      .filter((r) => r.date >= fromStr)
      .filter((r) => userFilter === 'all' || r.user_id === userFilter);
  }, [teamRows, range, userFilter]);

  // Per-user rollup for the summary strip
  const rollup = useMemo(() => {
    const m = new Map();
    filtered.forEach((r) => {
      const key = r.user_id;
      if (!key) return;
      const live = r.total_work_ms
        || (r.clock_in && !r.clock_out
            ? Math.max(0, Date.now() - new Date(r.clock_in).getTime() - (r.total_break_ms || 0))
            : 0);
      const prev = m.get(key) || { user: r.user, workMs: 0, days: 0, late: 0 };
      prev.workMs += live;
      if (live > 0) prev.days++;
      if (deriveHistoryStatus(r) === 'late') prev.late++;
      m.set(key, prev);
    });
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.workMs - a.workMs);
  }, [filtered]);

  const totalWorkMs = filtered.reduce((sum, r) => {
    const live = r.total_work_ms
      || (r.clock_in && !r.clock_out
          ? Math.max(0, Date.now() - new Date(r.clock_in).getTime() - (r.total_break_ms || 0))
          : 0);
    return sum + live;
  }, 0);

  function exportCsv() {
    const header = ['Date','User','Role','Clock in','Clock out','Worked (ms)','Break (ms)','Status','Location'];
    const lines = [header.join(',')];
    filtered.forEach((r) => {
      lines.push([
        r.date,
        r.user?.display_name || '',
        r.user?.role || '',
        r.clock_in  ? new Date(r.clock_in).toISOString()  : '',
        r.clock_out ? new Date(r.clock_out).toISOString() : '',
        r.total_work_ms || 0,
        r.total_break_ms || 0,
        r.status,
        r.location || '',
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `team-attendance-${range}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="att-history">
      <div className="att-history-head">
        <div>
          <div className="att-history-title">Team attendance</div>
          <div className="att-history-sub">
            {rollup.length} teammate{rollup.length === 1 ? '' : 's'} · {filtered.length} record{filtered.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="att-history-actions">
          <select className="wx-input att-team-filter"
            value={userFilter} onChange={(e) => onUserFilter(e.target.value)}>
            <option value="all">All teammates</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.display_name || u.email}</option>
            ))}
          </select>
          <div className="att-range-tabs">
            {['week','month','quarter'].map((k) => (
              <button key={k} type="button"
                className={`att-range-tab ${range === k ? 'is-active' : ''}`}
                onClick={() => onRange(k)}>
                {k === 'week' ? 'This week' : k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="att-export-btn" onClick={exportCsv}>
            <DownloadGlyph /> Export CSV
          </button>
        </div>
      </div>

      {/* Per-user rollup strip — only when looking at everyone */}
      {userFilter === 'all' && rollup.length > 0 && (
        <div className="att-team-rollup">
          {rollup.map((r) => (
            <button key={r.id} type="button"
              className="att-team-rollup-card"
              onClick={() => onUserFilter(r.id)}
              title="Filter to this teammate">
              <Avatar user={r.user} />
              <div style={{ minWidth: 0, textAlign: 'left' }}>
                <div className="att-team-rollup-name">{r.user?.display_name || '—'}</div>
                <div className="att-team-rollup-sub">{r.user?.role} · {r.days} day{r.days === 1 ? '' : 's'}{r.late > 0 ? ` · ${r.late} late` : ''}</div>
              </div>
              <div className="att-team-rollup-hrs">{fmtMs(r.workMs)}</div>
            </button>
          ))}
        </div>
      )}

      <div className="att-hist-table">
        <div className="att-hist-row att-hist-head-row att-hist-team-row">
          <div>Date</div>
          <div>User</div>
          <div>Clock in → Out</div>
          <div>Worked</div>
          <div>Break</div>
          <div>Status</div>
          <div>Location</div>
        </div>

        {filtered.length === 0 ? (
          <div className="att-empty" style={{ padding: 32 }}>
            <div className="att-empty-title">No team records in this range</div>
            <div>Pick a different range or teammate.</div>
          </div>
        ) : (
          filtered.map((r) => (
            <TeamHistoryRow
              key={r.id}
              row={r}
              targetMs={targetMs}
              canForceClose={canForceClose}
              onForceClose={onForceClose}
            />
          ))
        )}
      </div>

      {filtered.length > 0 && (
        <div className="att-hist-footer">
          <div>
            Showing {filtered.length} record{filtered.length === 1 ? '' : 's'}
            {userFilter !== 'all' && users.find((u) => u.id === userFilter) ? (
              <> · {users.find((u) => u.id === userFilter).display_name}</>
            ) : null}
          </div>
          <div>Total team hours <strong>{fmtMs(totalWorkMs)}</strong></div>
        </div>
      )}
    </div>
  );
}

function TeamHistoryRow({ row, canForceClose = false, onForceClose }) {
  const date = new Date(row.date);
  const today = new Date().toISOString().slice(0, 10);
  const isToday = row.date === today;
  const workMs = row.total_work_ms
    || (row.clock_in && !row.clock_out
        ? Math.max(0, Date.now() - new Date(row.clock_in).getTime() - (row.total_break_ms || 0))
        : 0);
  const status = deriveHistoryStatus(row);

  return (
    <div className="att-hist-row att-hist-team-row">
      <div className="att-date-cell">
        <div className={`att-date-tile ${isToday ? 'is-today' : ''}`}>
          <div className="att-date-tile-month">{date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase()}</div>
          <div className="att-date-tile-day">{date.getDate()}</div>
        </div>
        <div>
          <div className="att-date-name">{date.toLocaleDateString(undefined, { weekday: 'long' })}</div>
          <div className="att-date-sub">{isToday ? 'Today' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
        </div>
      </div>
      <div className="att-team-user-cell">
        <Avatar user={row.user} sm />
        <div style={{ minWidth: 0 }}>
          <div className="att-team-user-name">{row.user?.display_name || '—'}</div>
          <div className="att-team-user-role">{row.user?.role}</div>
        </div>
      </div>
      <div className="att-hist-val">
        {row.clock_in ? (
          <>
            {fmtTime(row.clock_in)}
            <span className="att-hist-arrow"> → </span>
            {row.clock_out ? fmtTime(row.clock_out) : '—'}
          </>
        ) : <span style={{ color: 'var(--text-muted)' }}>Not started</span>}
      </div>
      <div className="att-hist-val">{workMs ? fmtMs(workMs) : '—'}</div>
      <div className="att-hist-val">{row.total_break_ms ? fmtMs(row.total_break_ms) : '—'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <HistoryStatusPill status={status} />
        {canForceClose && status === 'auto' && !row.clock_out && (
          <button
            type="button"
            className="wx-btn wx-btn-ghost wx-btn-sm"
            style={{ color: 'var(--danger)', padding: '2px 8px', fontSize: 11 }}
            title="Force-close this stuck session"
            onClick={() => onForceClose?.(row)}>
            Close
          </button>
        )}
      </div>
      <div className="att-hist-loc">{locationLabel(row.location)}</div>
    </div>
  );
}

function HistoryStatusPill({ status }) {
  const map = {
    'on-time':   { cls: 'is-ontime',   label: 'On time' },
    'late':      { cls: 'is-late',     label: 'Late' },
    'half-day':  { cls: 'is-halfday',  label: 'Half day' },
    'pending':   { cls: 'is-pending',  label: 'Pending' },
    'live':      { cls: 'is-live',     label: 'On shift' },
    'break':     { cls: 'is-break',    label: 'On break' },
    'auto':      { cls: 'is-auto',     label: 'Auto-closed' },
  };
  const t = map[status] || map['on-time'];
  return <span className={`att-hist-pill ${t.cls}`}><span className="att-hist-pill-dot" />{t.label}</span>;
}

function deriveHistoryStatus(r) {
  // Treat a row as auto-closed when:
  //   1. It's flagged auto_closed (legacy hard auto-close, pre-migration 117).
  //   2. It's still open but the session has gone stale: >14h elapsed OR the
  //      calendar day has rolled over since clock-in. Without this, rows that
  //      the user forgot to clock out on keep rendering as "On shift" forever
  //      now that pg_cron auto-close is retired (migration 117).
  if (r.auto_closed) return 'auto';
  if (!r.clock_out && r.clock_in) {
    const inMs = new Date(r.clock_in).getTime();
    const elapsed = Date.now() - inMs;
    const STALE_MS = 14 * 60 * 60 * 1000;
    const inDate = new Date(inMs);
    const now    = new Date();
    const crossedDay =
      inDate.getFullYear() !== now.getFullYear() ||
      inDate.getMonth()    !== now.getMonth()    ||
      inDate.getDate()     !== now.getDate();
    if (elapsed > STALE_MS || crossedDay) return 'auto';
  }
  if (r.status === 'pending-approval') return 'pending';
  if (r.status === 'on-break')         return 'break';
  if (r.status === 'clocked-in')       return 'live';
  const workMs = r.total_work_ms || 0;
  if (workMs > 0 && workMs < 5 * 3600 * 1000) return 'half-day';
  // Late if clock-in later than 09:15 local
  if (r.clock_in) {
    const t = new Date(r.clock_in);
    const mins = t.getHours() * 60 + t.getMinutes();
    if (mins > 9 * 60 + 15) return 'late';
  }
  return 'on-time';
}

function BreaksDiff({ oldBreaks, newBreaks }) {
  const fmt = (b) => {
    const s = b?.start ? fmtTime(b.start) : '—';
    const e = b?.end   ? fmtTime(b.end)   : 'open';
    return `${s} → ${e}`;
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
      <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '6px 10px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Current</div>
        {oldBreaks.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>(no breaks)</div>
        ) : (
          oldBreaks.map((b, i) => (
            <div key={i} style={{ fontSize: 11.5 }}>{fmt(b)}</div>
          ))
        )}
      </div>
      <div style={{ background: 'color-mix(in srgb, var(--accent-soft) 60%, transparent)', borderRadius: 8, padding: '6px 10px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Proposed</div>
        {newBreaks.length === 0 ? (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>(no breaks)</div>
        ) : (
          newBreaks.map((b, i) => (
            <div key={i} style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(b)}</div>
          ))
        )}
      </div>
    </div>
  );
}

function Avatar({ user, sm = false }) {
  if (user?.avatar_url) {
    return (
      <div className={`att-avatar ${sm ? 'att-avatar-sm' : ''}`}>
        <img src={user.avatar_url} alt={user.display_name || ''} />
      </div>
    );
  }
  return (
    <div className={`att-avatar ${sm ? 'att-avatar-sm' : ''}`}>
      {initialsOf(user?.display_name)}
    </div>
  );
}

// ============================================================
// Small presentational helpers
// ============================================================
// --------------------------------------------------------------
// Personal monthly attendance — sits at the top of the Today tab.
// Shows working days (Mon–Fri), days present (clocked in), days
// on approved leave, days missed (past working days neither
// attended nor on leave), and total hours for the current month.
// Stacked progress bar combines present + approved-leave coverage
// without double-counting a day that was both.
// --------------------------------------------------------------
function MonthlyAttendanceWidget({ uid, history, displayName }) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const monthStr = `${year}-${pad(month + 1)}`;
  const startStr = `${monthStr}-01`;
  const endStr   = `${monthStr}-${pad(new Date(year, month + 1, 0).getDate())}`;

  // Approved leaves overlapping this calendar month.
  const { data: leaves = [] } = useQuery({
    queryKey: ['attendance', 'monthly-leaves', uid, startStr, endStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leave_requests')
        .select('start_date,end_date,status')
        .eq('requester_id', uid)
        .eq('status', 'approved')
        // WFH still has a clock-in, so don't treat it as a leave for
        // attendance-coverage math (matches Roster + perf_attendance_score).
        .in('type', ['medical', 'emergency'])
        .lte('start_date', endStr)
        .gte('end_date', startStr);
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: !!uid,
    staleTime: 5 * 60_000,
  });

  // Manual adjustments (Roster overrides) — so the widget reflects
  // any backfill the user's manager applied.
  const { data: adjustments = [] } = useQuery({
    queryKey: ['attendance', 'monthly-adjustments', uid, monthStr],
    queryFn: () => listAdjustmentsForUserMonth(uid, monthStr),
    enabled: !!uid,
    staleTime: 60_000,
  });

  // Company-wide holiday dates inside this month (Mon-Fri only).
  // Holiday dates count as covered without requiring a clock-in.
  const { data: holidayDates = new Set() } = useQuery({
    queryKey: ['attendance', 'monthly-holidays', monthStr],
    queryFn: () => listHolidayDatesForMonth(monthStr),
    staleTime: 5 * 60_000,
  });

  const stats = useMemo(() => {
    // Expand approved-leave ranges into a Set of weekday dates inside the
    // month. Holiday dates are skipped because they're already covered by
    // the holiday set passed below — a leave that overlaps Eid shouldn't
    // also show up as a leave day.
    const leaveDates = new Set();
    leaves.forEach((lv) => {
      if (!lv.start_date || !lv.end_date) return;
      const cur = new Date(lv.start_date + 'T00:00:00');
      const stop = new Date(lv.end_date  + 'T00:00:00');
      while (cur <= stop) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) {
          const ds = `${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`;
          if (ds >= startStr && ds <= endStr && !holidayDates.has(ds)) leaveDates.add(ds);
        }
        cur.setDate(cur.getDate() + 1);
      }
    });

    const s = summarizeMonth({
      rows: history || [],
      adjustments,
      leaveDates,
      holidayDates,
      monthStr,
      today: now,
    });
    return {
      ...s,
      monthLabel: now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, leaves, adjustments, holidayDates, monthStr]);

  const pct = stats.workingDays > 0
    ? Math.round((stats.accountedDays / stats.workingDays) * 100)
    : 0;
  const pctTone = pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'danger';
  const hrs  = Math.floor(stats.totalWorkMs / 3600000);
  const mins = Math.floor((stats.totalWorkMs % 3600000) / 60000);

  // Stacked bar: present takes its slice, then leave takes its slice
  // (excluding overlap), then holidays take whatever else is in the
  // accounted set. The three bands together never exceed 100%.
  const wd = Math.max(1, stats.workingDays);
  const presentPct = (stats.presentDays / wd) * 100;
  const leaveOnlyDays = Math.max(0, [...stats.leaveDates].filter((d) => !stats.presentDates.has(d)).length);
  const leaveOnlyPct = (leaveOnlyDays / wd) * 100;
  const holidayOnlyDays = Math.max(
    0,
    stats.accountedDays - stats.presentDays - leaveOnlyDays,
  );
  const holidayOnlyPct = (holidayOnlyDays / wd) * 100;

  return (
    <div className="wx-card" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>My attendance · {stats.monthLabel}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {displayName ? `${displayName} · ` : ''}{stats.workingDays} working days this month (Mon–Fri)
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: `color-mix(in srgb, var(--${pctTone}) 14%, transparent)`,
          color: `var(--${pctTone})`,
          border: `1px solid color-mix(in srgb, var(--${pctTone}) 35%, transparent)`,
          padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700,
        }}>
          <CheckIcon width="12" height="12" />
          {stats.accountedDays} / {stats.workingDays} days · {pct}%
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
        <MonthTile dot="var(--success)" label="Days present"  value={stats.presentDays} sub="clocked in" />
        <MonthTile dot="var(--info)"    label="Days on leave" value={stats.leaveDays}   sub="approved" />
        {stats.holidayDays > 0 ? (
          <MonthTile dot="#a855f7" label="Holidays" value={stats.holidayDays} sub="counts as present" />
        ) : null}
        {stats.adjustedDays > 0 ? (
          <MonthTile dot="var(--warning)" label="Manager-adjusted" value={stats.adjustedDays} sub="counts as present" />
        ) : null}
        <MonthTile dot="var(--danger)"  label="Days missed"   value={stats.missedDays}  sub="past working days" />
        <MonthTile dot="var(--text-primary)" label="Hours worked" value={`${hrs}h ${pad(mins)}m`} sub="this month" prominent />
      </div>

      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden', display: 'flex' }}>
        {presentPct > 0 && (
          <div title={`Present: ${stats.presentDays} days`}
            style={{ width: `${presentPct}%`, background: 'var(--success)' }} />
        )}
        {leaveOnlyPct > 0 && (
          <div title={`Approved leave: ${leaveOnlyDays} days`}
            style={{ width: `${leaveOnlyPct}%`, background: 'var(--info)' }} />
        )}
        {holidayOnlyPct > 0 && (
          <div title={`Company holidays: ${holidayOnlyDays} days`}
            style={{ width: `${holidayOnlyPct}%`, background: '#a855f7' }} />
        )}
      </div>
    </div>
  );
}

function MonthTile({ dot, label, value, sub, prominent }) {
  return (
    <div style={{
      padding: 12, borderRadius: 10,
      background: prominent ? 'var(--text-primary)' : 'var(--surface-2)',
      border: '1px solid var(--border-subtle)',
      color: prominent ? 'var(--surface-1)' : 'var(--text-primary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: prominent ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        {label}
      </div>
      <div style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.2, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, marginTop: 2, color: prominent ? 'rgba(255,255,255,0.6)' : 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, sub, mono }) {
  return (
    <div className="att-mini-stat">
      <div className="att-mini-stat-label">{label}</div>
      <div className={`att-mini-stat-value ${mono ? 'is-mono' : ''}`}>{value}</div>
      {sub && <div className="att-mini-stat-sub">{sub}</div>}
    </div>
  );
}

function DashStat({ label, value }) {
  return (
    <div className="att-dash-stat">
      <div className="att-dash-stat-label">{label}</div>
      <div className="att-dash-stat-value">{value}</div>
    </div>
  );
}

function DownloadGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// ============================================================
// Formatting helpers
// ============================================================
function initialsOf(name) {
  if (!name) return '?';
  return String(name).split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}
function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtClock(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtMsShort(ms) {
  if (!ms || ms < 0) return '0h';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m ? `${h}:${String(m).padStart(2, '0')}` : `${h}h`;
}
function fmtBreakShort(ms) {
  if (!ms || ms < 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h <= 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtTargetLabel(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return m ? `${h}h ${m}m` : `${h}h`;
}
function fmtDateShort(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function relativeDay(dateStr) {
  const d = new Date(dateStr);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - d) / 86400000);
  if (diffDays === 1) return 'yesterday';
  if (diffDays === 0) return 'earlier today';
  if (diffDays < 7)   return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
