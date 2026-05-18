import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaMeetings, listAgendaTeams, getAgendaTeamSchedules,
  notifyWeek, startMeeting, subscribeAgendaMeetings,
} from '../../lib/agendaApi';

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
  const myTeamTlId = isTL ? user?.id : (isApc ? (profile?.reports_to || null) : null);

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

  async function handleStart(meetingId) {
    setBusyId(meetingId);
    try {
      await startMeeting(meetingId);
      reloadMeetings();
    } catch (e) {
      alert('Failed to start: ' + (e.message || 'unknown'));
    } finally {
      setBusyId(null);
    }
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
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
            <i className="bi bi-calendar3-week" style={{ fontSize: '1.15rem' }} />
            Upcoming Meetings
          </h5>
          <p className="text-muted small mb-0">
            {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} ·
            {' '}weekly agenda meeting schedule.
          </p>
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
          style={{ background: '#fff7ed', border: '1px solid #fed7aa', fontSize: '0.76rem' }}>
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
                myTeamTlId={myTeamTlId}
                today={today}
                busyId={busyId}
                onStart={handleStart}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Week card ───────────────────────────────────────────────────────────
function WeekCard({ card, isOL, myTeamTlId, today, busyId, onStart }) {
  const rows = myTeamTlId
    ? card.rows.filter((r) => r.tlId === myTeamTlId)
    : card.rows;

  const notifiedRows = card.rows.filter((r) => r.meeting);
  const allDone = notifiedRows.length > 0 && notifiedRows.every((r) => r.meeting.status === 'completed');

  let state = 'future';
  if (card.isPast) state = 'past';
  else if (card.isCurrent) state = allDone ? 'done' : 'current';

  const live = state === 'current';
  const greyed = state === 'past' || state === 'future' || state === 'done';

  const BADGE = {
    current: { label: 'Current Week', bg: '#eef2ff', color: '#4f46e5', icon: 'bi-star-fill' },
    done:    { label: 'Completed',    bg: '#e6f4ea', color: '#198754', icon: 'bi-check-circle-fill' },
    past:    { label: 'Past',         bg: '#f1f5f9', color: '#64748b', icon: 'bi-clock-history' },
    future:  { label: 'Upcoming',     bg: '#f1f5f9', color: '#64748b', icon: 'bi-lock-fill' },
  }[state];

  return (
    <div className="card h-100" style={{
      borderRadius: 14,
      border: live ? '2px solid #6366f1' : '1px solid #e2e8f0',
      boxShadow: live ? '0 8px 28px rgba(99,102,241,0.18)' : '0 1px 3px rgba(15,23,42,0.06)',
      background: greyed ? '#fafbfc' : '#fff',
      opacity: state === 'future' || state === 'past' ? 0.82 : 1,
    }}>
      <div className="card-body p-3 d-flex flex-column">
        <div className="d-flex align-items-center justify-content-between mb-1">
          <span className="fw-bold" style={{ fontSize: '0.74rem', letterSpacing: '0.06em', color: '#94a3b8', textTransform: 'uppercase' }}>
            Week {card.index}
          </span>
          <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
            style={{ background: BADGE.bg, color: BADGE.color, fontSize: '0.6rem', fontWeight: 800 }}>
            <i className={`bi ${BADGE.icon}`} style={{ fontSize: '0.6rem' }} />{BADGE.label}
          </span>
        </div>
        <div className="fw-bold mb-2" style={{ fontSize: '1rem', color: '#1a1a2e' }}>
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
            const canStart = live && isOL && mStatus === 'upcoming' && today >= r.meetingDate;
            const tooEarly = live && isOL && mStatus === 'upcoming' && today < r.meetingDate;
            return (
              <div key={r.tlId} className="rounded-2 p-2" style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <div className="min-w-0">
                    <div className="fw-semibold text-truncate" style={{ fontSize: '0.78rem', color: '#1a1a2e' }}>{r.tlName}</div>
                    <div className="text-muted" style={{ fontSize: '0.66rem' }}>
                      <i className="bi bi-people me-1" />{r.apcs.length} APC{r.apcs.length === 1 ? '' : 's'}
                      {' · '}<i className="bi bi-clock me-1" />{fmtTime(r.meetingTime)}
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
                    disabled={busyId === r.meeting.id}
                    onClick={() => onStart(r.meeting.id)}>
                    {busyId === r.meeting.id
                      ? <span className="spinner-border spinner-border-sm" />
                      : <><i className="bi bi-play-fill" /> Start Meeting</>}
                  </button>
                )}
                {tooEarly && (
                  <div className="text-muted mt-1" style={{ fontSize: '0.64rem' }}>
                    <i className="bi bi-hourglass-split me-1" />Can start on {fmtDate(r.meetingDate, false)}
                  </div>
                )}
                {live && isOL && mStatus === 'not_notified' && (
                  <div className="text-muted mt-1" style={{ fontSize: '0.64rem' }}>
                    <i className="bi bi-megaphone me-1" />Use “Notify Teams” to open this week.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }) {
  const M = {
    not_notified: { label: 'Not notified', color: '#94a3b8' },
    upcoming:     { label: 'Scheduled',    color: '#fd7e14' },
    ongoing:      { label: 'In progress',  color: '#0d6efd' },
    completed:    { label: 'Completed',    color: '#198754' },
  }[status] || { label: status, color: '#94a3b8' };
  return (
    <span className="d-inline-flex align-items-center gap-1 flex-shrink-0" style={{ fontSize: '0.62rem', fontWeight: 700, color: M.color }}>
      <span className="rounded-circle" style={{ width: 7, height: 7, background: M.color, display: 'inline-block' }} />
      {M.label}
    </span>
  );
}
