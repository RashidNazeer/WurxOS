import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaMeetings, listAgendaTeams, finishMeeting, subscribeAgendaMeetings,
} from '../../lib/agendaApi';

// Weekly Agenda Meetings — Ongoing. Lists meetings that have been
// started; OL finishes them here. Detailed in-meeting behaviour
// (ratings, remarks) arrives in the next phase.

function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}
function fmtSince(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function AgendaOngoingPage() {
  const { user, profile } = useAuth();
  const role = profile?.role || '';
  const isOL  = role === 'ol' || role === 'boss' || role === 'developer';
  const isTL  = role === 'tl';
  const isApc = role === 'apc';
  const myTeamTlId = isTL ? user?.id : (isApc ? (profile?.reports_to || null) : null);

  const [meetings, setMeetings] = useState([]);
  const [teams, setTeams]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [busyId, setBusyId]     = useState(null);

  function reload() {
    listAgendaMeetings({ status: 'ongoing' }).then(setMeetings).catch(() => {});
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgendaMeetings({ status: 'ongoing' }), listAgendaTeams()])
      .then(([m, t]) => { if (!cancelled) { setMeetings(m || []); setTeams(t || []); } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    const unsub = subscribeAgendaMeetings(reload);
    return () => { cancelled = true; unsub(); };
  }, []);

  const teamsById = useMemo(() => {
    const m = new Map();
    teams.forEach((t) => m.set(t.tl.id, t));
    return m;
  }, [teams]);

  const visible = useMemo(
    () => (myTeamTlId ? meetings.filter((m) => m.tl_id === myTeamTlId) : meetings),
    [meetings, myTeamTlId],
  );

  async function handleFinish(id) {
    if (!window.confirm('Finish this team meeting?')) return;
    setBusyId(id);
    try {
      await finishMeeting(id);
      reload();
    } catch (e) {
      alert('Failed to finish: ' + (e.message || 'unknown'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="mb-4">
        <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
          <i className="bi bi-broadcast" style={{ fontSize: '1.15rem' }} />
          Ongoing Meetings
        </h5>
        <p className="text-muted small mb-0">Team meetings currently in progress.</p>
      </div>

      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : visible.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16, background: '#fff' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: '#f0f1f5' }}>
            <i className="bi bi-broadcast text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No meetings in progress</p>
          <p className="text-muted small mb-0">Start a meeting from Upcoming Meetings.</p>
        </div>
      ) : (
        <div className="row g-3">
          {visible.map((m) => {
            const team = teamsById.get(m.tl_id);
            const apcs = team?.apcs || [];
            return (
              <div key={m.id} className="col-12 col-md-6 col-xl-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, borderLeft: '4px solid #0d6efd' }}>
                  <div className="card-body p-3 d-flex flex-column">
                    <div className="d-flex align-items-center justify-content-between mb-2">
                      <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
                        style={{ background: '#e8f0fe', color: '#0d6efd', fontSize: '0.62rem', fontWeight: 800 }}>
                        <span className="rounded-circle" style={{ width: 6, height: 6, background: '#0d6efd', display: 'inline-block' }} />
                        LIVE
                      </span>
                      <span className="text-muted" style={{ fontSize: '0.68rem' }}>
                        Started {fmtSince(m.started_at)}
                      </span>
                    </div>

                    <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#1a1a2e' }}>
                      {team?.tl?.display_name || m.tl?.display_name || 'Team'}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                      <i className="bi bi-calendar3 me-1" />{fmtDate(m.meeting_date)}
                      {' · '}<i className="bi bi-clock me-1" />{fmtTime(m.meeting_time)}
                    </div>

                    {apcs.length > 0 && (
                      <div className="mt-2">
                        <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                          APCs presenting
                        </div>
                        <div className="d-flex flex-wrap gap-1">
                          {apcs.map((a) => (
                            <span key={a.id} className="rounded-pill px-2" style={{ background: '#eff6ff', color: '#1d4ed8', fontSize: '0.66rem', fontWeight: 600 }}>
                              {a.display_name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div style={{ flexGrow: 1 }} />

                    {isOL && (
                      <button className="btn btn-sm btn-outline-success w-100 mt-3 d-inline-flex align-items-center justify-content-center gap-1"
                        style={{ borderRadius: 8, fontSize: '0.74rem' }}
                        disabled={busyId === m.id}
                        onClick={() => handleFinish(m.id)}>
                        {busyId === m.id
                          ? <span className="spinner-border spinner-border-sm" />
                          : <><i className="bi bi-check2-circle" /> Finish Meeting</>}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
