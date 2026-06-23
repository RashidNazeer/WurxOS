import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaMeetings, listAgendaTeams, getAgendaTeamSchedules,
  notifyWeek, startMeeting, subscribeAgendaMeetings, agendaMeetingStartAt,
} from '../../lib/agendaApi';
import { useNow } from '../../hooks/useNow';

// Weekly Agenda Meetings — Upcoming. A month grid of week cards;
// only the current week is live (OL can notify + start meetings).

const DAY_INDEX  = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_OFFSET = { monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6 };

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOf(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
function fmtDate(dateStr, withWeekday = true) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString('en-US',
    { ...(withWeekday ? { weekday: 'short' } : {}), month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

export default function AgendaUpcomingPage() {
  const { user, profile } = useAuth();
  const role = profile?.role || '';
  const isOL  = role === 'ol' || role === 'boss' || role === 'developer';
  const isTL  = role === 'tl';
  const isApc = role === 'apc';
  // All-meeting attendees (e.g. Paid Media lead) see every team's row, like an OL.
  const canAttendAll = isOL || role === 'pctl' || role === 'ipc' || profile?.permissions?.canAttendAllMeetings === true;
  const myTeamTlId = canAttendAll ? null : (isTL ? user?.id : (isApc ? (profile?.reports_to || null) : null));

  const [meetings, setMeetings]   = useState([]);
  const [teams, setTeams]         = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [notifying, setNotifying] = useState(false);
  const [busyId, setBusyId]       = useState(null);
  const [flash, setFlash]         = useState('');

  function reloadMeetings() {
    listAgendaMeetings().then(setMeetings).catch(() => {});
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgendaMeetings(), listAgendaTeams(), getAgendaTeamSchedules()])
      .then(([m, t, s]) => {
        if (cancelled) return;
        setMeetings(m || []); setTeams(t || []); setSchedules(s || []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    const unsub = subscribeAgendaMeetings(reloadMeetings);
    return () => { cancelled = true; unsub(); };
  }, []);

  const today = ymd(new Date());
  const currentWeekStart = ymd(mondayOf(new Date()));
  const now = useNow();
  const navigate = useNavigate();

  const teamsById = useMemo(() => {
    const m = new Map();
    teams.forEach((t) => m.set(t.tl.id, t));
    return m;
  }, [teams]);

  // Week cards = the weeks of the current month that contain at least
  // one team's scheduled meeting day. Derived purely from the team
  // schedules (no separate "default day" setting).
  const cards = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear(); const mo = now.getMonth();
    const weekMap = new Map(); // weekStart -> earliest meeting date that week
    schedules.forEach((s) => {
      const dow = DAY_INDEX[s.meeting_day];
      if (dow == null) return;
      const d = new Date(y, mo, 1);
      while (d.getMonth() === mo) {
        if (d.getDay() === dow) {
          const ws = ymd(mondayOf(d));
          const ds = ymd(d);
          if (!weekMap.has(ws) || ds < weekMap.get(ws)) weekMap.set(ws, ds);
        }
        d.setDate(d.getDate() + 1);
      }
    });
    const weekStarts = Array.from(weekMap.keys()).sort();
    return weekStarts.map((weekStart, i) => {
      const isCurrent = weekStart === currentWeekStart;
      const isPast    = weekStart < currentWeekStart;
      const rows = schedules.map((s) => {
        const team = teamsById.get(s.tl_id);
        const mDate = addDays(weekStart, DAY_OFFSET[s.meeting_day] ?? 1);
        const meeting = meetings.find((mm) => mm.tl_id === s.tl_id && mm.week_start === weekStart);
        return {
          tlId: s.tl_id,
          tlName: team?.tl?.display_name || meeting?.tl?.display_name || 'Team',
          apcs: team?.apcs || [],
          meetingDate: meeting?.meeting_date || mDate,
          meetingTime: meeting?.meeting_time || s.meeting_time,
          meeting,
        };
      }).sort((a, b) => a.tlName.localeCompare(b.tlName));
      return { index: i + 1, anchor: weekMap.get(weekStart), weekStart, isCurrent, isPast, rows };
    });
  }, [schedules, meetings, teamsById, currentWeekStart]);

  async function handleNotify() {
    setNotifying(true); setFlash('');
    try {
      const res = await notifyWeek(currentWeekStart);
      setFlash(`Notified ${res?.notified ?? 0} team(s) for this week.`);
      reloadMeetings();
      setTimeout(() => setFlash(''), 4000);
    } catch (e) {
      setFlash('Failed: ' + (e.message || 'unknown'));
    } finally {
      setNotifying(false);
    }
  }

  // Start (upcoming) / Resume (paused) / Reopen (completed) all flip the
  // meeting to 'ongoing' via the same RPC, then drop the OL into its room.
  async function goLive(meetingId) {
    setBusyId(meetingId);
    try {
      await startMeeting(meetingId);
      navigate('/agenda/ongoing', { state: { meetingId } });
    } catch (e) {
      alert('Failed: ' + (e.message || 'unknown'));
    } finally {
      setBusyId(null);
    }
  }
  // Open an already-ongoing meeting's room without changing its state.
  function openRoom(meetingId) {
    navigate('/agenda/ongoing', { state: { meetingId } });
  }

  const configuredCount = schedules.length;
  const totalTeams = teams.length;

  if (loading) {
    return (
      <div style={{ padding: '32px' }}>
        <div className="d-flex align-items-center gap-2 text-muted">
          <span className="spinner-border spinner-border-sm" /> Loading meetings…
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-calendar3-week" style={{ fontSize: '1.15rem' }} />
            Upcoming Meetings
          </h5>
          <p className="text-muted small mb-0">
            {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} ·
            {' '}weekly agenda meeting schedule.
          </p>
          <div className="text-muted" style={{ fontSize: '0.72rem', marginTop: 2 }}>
            <i className="bi bi-globe2 me-1" />All times shown in Pakistan time (PKT)
          </div>
        </div>
        {isOL && (
          <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem' }}
            onClick={handleNotify} disabled={notifying || configuredCount === 0}>
            {notifying
              ? <><span className="spinner-border spinner-border-sm" /> Notifying…</>
              : <><i className="bi bi-megaphone" /> Notify Teams</>}
          </button>
        )}
      </div>

      {isOL && flash && (
        <div className="alert alert-info py-2 small">{flash}</div>
      )}
      {isOL && configuredCount < totalTeams && (
        <div className="rounded-2 px-3 py-2 mb-3 d-inline-flex align-items-center gap-2"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', fontSize: '0.76rem' }}>
          <i className="bi bi-exclamation-triangle text-warning" />
          {configuredCount} of {totalTeams} teams have a meeting schedule. Unconfigured teams are skipped — set them in Settings → Schedules.
        </div>
      )}

      {cards.length === 0 ? (
        <div className="text-muted small py-4">No meeting days fall in this month.</div>
      ) : (
        <div className="row g-3">
          {cards.map((card) => (
            <div key={card.weekStart} className="col-12 col-md-6 col-xl-3">
              <WeekCard
                card={card}
                isOL={isOL}
                canViewAll={canAttendAll}
                myTeamTlId={myTeamTlId}
                today={today}
                now={now}
                busyId={busyId}
                onStart={goLive}
                onOpen={openRoom}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Week card ───────────────────────────────────────────────────────────
function WeekCard({ card, isOL, canViewAll, myTeamTlId, today, now, busyId, onStart, onOpen }) {
  const rows = myTeamTlId
    ? card.rows.filter((r) => r.tlId === myTeamTlId)
    : card.rows;

  const notifiedRows = card.rows.filter((r) => r.meeting);
  const allDone = notifiedRows.length > 0 && notifiedRows.every((r) => r.meeting.status === 'completed');
  // Once any meeting in the week has started or finished, the week is
  // "in progress" — the remaining meetings no longer wait for their date.
  const weekProgressed = card.rows.some(
    (r) => r.meeting && ['completed', 'ongoing', 'paused'].includes(r.meeting.status),
  );
  // Global time gate (current week): Start buttons stay hidden until the
  // earliest scheduled meeting time is reached, then all teams unlock
  // together. Once the week is under way (one started/finished) it stays open.
  const weekUpcoming = card.rows
    .filter((r) => r.meeting && r.meeting.status === 'upcoming')
    .map((r) => r.meeting);
  const earliestMeeting = [...weekUpcoming].sort((a, b) =>
    `${a.meeting_date}${a.meeting_time || ''}`.localeCompare(`${b.meeting_date}${b.meeting_time || ''}`))[0] || null;
  // Per-meeting gate: each team's Start appears once that meeting's own
  // scheduled time is reached; once the week is under way it all stays open.
  const startable = (m) => {
    const at = agendaMeetingStartAt(m);
    return weekProgressed || !at || now.getTime() >= at.getTime();
  };
  const anyStartable = weekUpcoming.some(startable);

  let state = 'future';
  if (card.isPast) state = 'past';
  else if (card.isCurrent) state = allDone ? 'done' : 'current';

  const live = state === 'current';

  const BADGE = {
    current: { label: 'Current Week', bg: 'var(--accent-soft)',  color: 'var(--accent)',         icon: 'bi-star-fill' },
    done:    { label: 'Completed',    bg: 'var(--success-soft)', color: 'var(--success)',        icon: 'bi-check-circle-fill' },
    past:    { label: 'Past',         bg: 'var(--surface-2)',    color: 'var(--text-secondary)', icon: 'bi-clock-history' },
    future:  { label: 'Upcoming',     bg: 'var(--surface-2)',    color: 'var(--text-secondary)', icon: 'bi-lock-fill' },
  }[state];

  return (
    <div className="card h-100" style={{
      borderRadius: 14,
      border: live ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
      boxShadow: live ? '0 8px 28px var(--accent-ring)' : 'var(--shadow-sm)',
      background: 'var(--surface-1)',
      opacity: state === 'future' || state === 'past' ? 0.82 : 1,
    }}>
      <div className="card-body p-3 d-flex flex-column">
        <div className="d-flex align-items-center justify-content-between mb-1">
          <span className="fw-bold" style={{ fontSize: '0.74rem', letterSpacing: '0.06em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            Week {card.index}
          </span>
          <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
            style={{ background: BADGE.bg, color: BADGE.color, fontSize: '0.6rem', fontWeight: 800 }}>
            <i className={`bi ${BADGE.icon}`} style={{ fontSize: '0.6rem' }} />{BADGE.label}
          </span>
        </div>
        <div className="fw-bold mb-2" style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>
          <i className="bi bi-calendar-event me-1 text-muted" style={{ fontSize: '0.82rem' }} />
          {fmtDate(card.anchor)}
        </div>

        <div className="d-flex flex-column gap-2" style={{ flexGrow: 1 }}>
          {rows.length === 0 ? (
            <div className="text-muted small" style={{ fontSize: '0.74rem' }}>
              {myTeamTlId ? 'No meeting scheduled for your team.' : 'No teams scheduled.'}
            </div>
          ) : rows.map((r) => {
            const mStatus = r.meeting?.status || 'not_notified';
            // OL actions are available on the CURRENT week regardless of how
            // far the flow has gone — so a completed meeting can be reopened.
            const olCurrent = card.isCurrent && isOL && !!r.meeting;
            // All-meeting attendees can OPEN (join) a live room, but never
            // start/resume/reopen/notify (those stay OL-only via olCurrent).
            const canOpenRoom = card.isCurrent && canViewAll && !!r.meeting;
            const canStart  = olCurrent && mStatus === 'upcoming' && startable(r.meeting);
            const waitTime  = olCurrent && mStatus === 'upcoming' && !startable(r.meeting);
            const meetingBusy = r.meeting && busyId === r.meeting.id;
            return (
              <div key={r.tlId} className="rounded-2 p-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <div className="min-w-0">
                    <div className="fw-semibold text-truncate" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{r.tlName}</div>
                    <div className="text-muted" style={{ fontSize: '0.66rem' }}>
                      <i className="bi bi-people me-1" />{r.apcs.length} APC{r.apcs.length === 1 ? '' : 's'}
                      {' · '}<i className="bi bi-clock me-1" />{fmtTime(r.meetingTime)} PKT
                    </div>
                  </div>
                  <StatusDot status={mStatus} />
                </div>
                {r.apcs.length > 0 && (
                  <div className="text-muted mt-1 text-truncate" style={{ fontSize: '0.64rem' }}>
                    {r.apcs.map((a) => a.display_name).filter(Boolean).join(', ')}
                  </div>
                )}
                {canStart && (
                  <button className="btn btn-sm btn-success w-100 mt-2 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 6, fontSize: '0.7rem' }}
                    disabled={meetingBusy}
                    onClick={() => onStart(r.meeting.id)}>
                    {meetingBusy ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-play-fill" /> Start Meeting</>}
                  </button>
                )}
                {waitTime && (
                  <div className="text-muted mt-1" style={{ fontSize: '0.64rem' }}>
                    <i className="bi bi-clock-history me-1" />Starts at {fmtTime(r.meetingTime)} PKT
                  </div>
                )}
                {canOpenRoom && mStatus === 'ongoing' && (
                  <button className="btn btn-sm btn-outline-danger w-100 mt-2 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 6, fontSize: '0.7rem' }}
                    onClick={() => onOpen(r.meeting.id)}>
                    <i className="bi bi-box-arrow-in-right" /> Open room
                  </button>
                )}
                {olCurrent && mStatus === 'paused' && (
                  <button className="btn btn-sm btn-primary w-100 mt-2 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 6, fontSize: '0.7rem' }}
                    disabled={meetingBusy}
                    onClick={() => onStart(r.meeting.id)}>
                    {meetingBusy ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-play-fill" /> Resume</>}
                  </button>
                )}
                {olCurrent && mStatus === 'completed' && (
                  <button className="btn btn-sm btn-outline-dark w-100 mt-2 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 6, fontSize: '0.7rem' }}
                    disabled={meetingBusy}
                    onClick={() => { if (window.confirm('Reopen this completed meeting and continue it?')) onStart(r.meeting.id); }}>
                    {meetingBusy ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-arrow-counterclockwise" /> Reopen</>}
                  </button>
                )}
                {card.isCurrent && isOL && mStatus === 'not_notified' && (
                  <div className="text-muted mt-1" style={{ fontSize: '0.64rem' }}>
                    <i className="bi bi-megaphone me-1" />Use “Notify Teams” to open this week.
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {live && isOL && !anyStartable && earliestMeeting && (
          <div className="rounded-2 p-2 mt-2 d-flex align-items-start gap-2"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <i className="bi bi-megaphone-fill text-primary" style={{ fontSize: '0.8rem', marginTop: 1 }} />
            <div style={{ fontSize: '0.66rem', color: 'var(--text-secondary)' }}>
              Teams notified. You can start meetings at{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{fmtTime(earliestMeeting.meeting_time)} PKT</strong>.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }) {
  const M = {
    not_notified: { label: 'Not notified', color: 'var(--text-muted)' },
    upcoming:     { label: 'Scheduled',    color: 'var(--warning)' },
    ongoing:      { label: 'In progress',  color: 'var(--info)' },
    paused:       { label: 'Paused',       color: 'var(--warning)' },
    completed:    { label: 'Completed',    color: 'var(--success)' },
  }[status] || { label: status, color: 'var(--text-muted)' };
  return (
    <span className="d-inline-flex align-items-center gap-1 flex-shrink-0" style={{ fontSize: '0.62rem', fontWeight: 700, color: M.color }}>
      <span className="rounded-circle" style={{ width: 7, height: 7, background: M.color, display: 'inline-block' }} />
      {M.label}
    </span>
  );
}
