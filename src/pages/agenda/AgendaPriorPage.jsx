import React, { useEffect, useMemo, useState } from 'react';
import { listAgendaMeetings, subscribeAgendaMeetings } from '../../lib/agendaApi';
import MonthNavigator, { currentMonthStr, monthLabel, stepMonthStr } from '../../components/leave/MonthNavigator';
import AgendaPriorDetail from '../../components/agenda/AgendaPriorDetail';

// Weekly Agenda Meetings — Prior Meetings (history archive).
// Completed meetings of the selected month, grouped by week. RLS
// scopes what each role sees (APC/TL → their team; OL → all).

function fmtDate(d) {
  if (!d) return '';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

export default function AgendaPriorPage() {
  const [meetings, setMeetings]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [viewMonth, setViewMonth] = useState(currentMonthStr);
  const [selected, setSelected]   = useState(null);   // { meeting, weekIndex }

  function reload() {
    // All statuses — so week numbers stay canonical (a completed week 3
    // reads as "Week 3", matching Upcoming Meetings).
    listAgendaMeetings()
      .then((m) => setMeetings(m || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    const unsub = subscribeAgendaMeetings(reload);   // a finished meeting lands here live
    return () => unsub();
  }, []);

  const isCurrentMonth = viewMonth === currentMonthStr();
  const viewMonthLabel = monthLabel(viewMonth);

  const weeks = useMemo(() => {
    const inMonth = meetings.filter((m) => m.meeting_date && m.meeting_date.slice(0, 7) === viewMonth);
    // Canonical week numbering — ordinal of every meeting week this month.
    const weekIndex = {};
    [...new Set(inMonth.map((m) => m.week_start))].sort()
      .forEach((ws, i) => { weekIndex[ws] = i + 1; });
    // Group the completed meetings.
    const byWeek = new Map();
    inMonth.filter((m) => m.status === 'completed').forEach((m) => {
      if (!byWeek.has(m.week_start)) byWeek.set(m.week_start, []);
      byWeek.get(m.week_start).push(m);
    });
    return [...byWeek.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([weekStart, ms]) => ({
        weekStart,
        index: weekIndex[weekStart] || 1,
        meetings: ms.sort((a, b) =>
          `${a.meeting_date}${a.meeting_time || ''}`.localeCompare(`${b.meeting_date}${b.meeting_time || ''}`)),
      }));
  }, [meetings, viewMonth]);

  if (selected) {
    return (
      <div style={{ padding: '32px 32px 48px' }}>
        <AgendaPriorDetail
          meeting={selected.meeting}
          weekIndex={selected.weekIndex}
          onBack={() => setSelected(null)}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-clock-history" style={{ fontSize: '1.15rem' }} />
            Prior Meetings
          </h5>
          <p className="text-muted small mb-0">Completed agenda meetings — records, attendance and evaluations.</p>
        </div>
        <MonthNavigator
          label={viewMonthLabel}
          isCurrent={isCurrentMonth}
          onPrev={() => setViewMonth((m) => stepMonthStr(m, -1))}
          onNext={() => setViewMonth((m) => stepMonthStr(m, 1))}
          onReset={() => setViewMonth(currentMonthStr())}
        />
      </div>

      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : weeks.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
            <i className="bi bi-clock-history text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No completed meetings in {viewMonthLabel}</p>
          <p className="text-muted small mb-0">Finished meetings appear here automatically.</p>
        </div>
      ) : (
        <div className="d-flex flex-column gap-4">
          {weeks.map((w) => (
            <div key={w.weekStart}>
              <div className="d-flex align-items-center gap-2 mb-2">
                <span className="fw-bold" style={{ fontSize: '0.74rem', letterSpacing: '0.06em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Week {w.index}
                </span>
                <span className="text-muted" style={{ fontSize: '0.72rem' }}>· week of {fmtDate(w.weekStart)}</span>
              </div>
              <div className="row g-3">
                {w.meetings.map((m) => (
                  <div key={m.id} className="col-12 col-md-6 col-xl-4">
                    <button type="button"
                      onClick={() => setSelected({ meeting: m, weekIndex: w.index })}
                      className="card border-0 shadow-sm w-100 text-start h-100"
                      style={{ borderRadius: 12, cursor: 'pointer' }}>
                      <div className="card-body p-3">
                        <div className="d-flex align-items-center justify-content-between mb-1">
                          <span className="fw-bold" style={{ fontSize: '0.92rem', color: 'var(--text-primary)' }}>
                            {m.tl?.display_name || 'Team'}
                          </span>
                          <span className="rounded-pill px-2 py-1" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.6rem', fontWeight: 800 }}>
                            <i className="bi bi-check-circle-fill me-1" />Completed
                          </span>
                        </div>
                        <div className="text-muted" style={{ fontSize: '0.74rem' }}>
                          <i className="bi bi-calendar3 me-1" />{fmtDate(m.meeting_date)}
                          {' · '}<i className="bi bi-clock me-1" />{fmtTime(m.meeting_time)} PKT
                        </div>
                        <div className="d-inline-flex align-items-center gap-1 mt-2" style={{ fontSize: '0.72rem', color: 'var(--accent)', fontWeight: 600 }}>
                          View record <i className="bi bi-arrow-right" />
                        </div>
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
