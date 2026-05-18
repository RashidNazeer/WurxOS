import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaMeetings, listAgendaTeams, listMeetingAttendance, listPresentations,
  listAgendaTasks, markAttendance, startPresenting, stopPresenting, finishMeeting,
  subscribeAgendaMeetings, subscribeAgendaRoom,
} from '../../lib/agendaApi';
import OngoingEvaluation from '../../components/agenda/OngoingEvaluation';

// Weekly Agenda Meetings — Ongoing (the live meeting room).
// Realtime: attendance, presenter state and meeting status all sync
// for every participant with no manual refresh.

const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', completed: 'Completed' };

export default function AgendaOngoingPage() {
  const { user, profile } = useAuth();
  const role = profile?.role || '';
  const isOL  = role === 'ol' || role === 'boss' || role === 'developer';
  const isTL  = role === 'tl';
  const isApc = role === 'apc';
  const uid = user?.id;

  const [meeting, setMeeting]         = useState(null);
  const [team, setTeam]               = useState(null);   // { tl, apcs }
  const [attendance, setAttendance]   = useState([]);
  const [presentations, setPresentations] = useState([]);
  const [myTasks, setMyTasks]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [busy, setBusy]               = useState('');

  async function refresh() {
    try {
      const ongoing = await listAgendaMeetings({ status: 'ongoing' });
      const m = ongoing[0] || null;
      if (!m) {
        setMeeting(null); setTeam(null); setAttendance([]); setPresentations([]);
        return;
      }
      const [teams, att, pres] = await Promise.all([
        listAgendaTeams(), listMeetingAttendance(m.id), listPresentations(m.id),
      ]);
      setMeeting(m);
      setTeam(teams.find((t) => t.tl.id === m.tl_id) || null);
      setAttendance(att);
      setPresentations(pres);
    } catch { /* keep last good state */ }
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    const unsub = subscribeAgendaMeetings(refresh);   // catches start/finish
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!meeting?.id) return undefined;
    const unsub = subscribeAgendaRoom(meeting.id, refresh);  // attendance + presenter
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting?.id]);

  useEffect(() => {
    if (!isApc || !meeting) { setMyTasks([]); return; }
    listAgendaTasks({ assigneeMe: true }).then(setMyTasks).catch(() => setMyTasks([]));
  }, [isApc, meeting?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const apcs = team?.apcs || [];
  const attMap  = useMemo(() => {
    const m = {}; attendance.forEach((a) => { m[a.apc_id] = a.status; }); return m;
  }, [attendance]);
  const presMap = useMemo(() => {
    const m = {}; presentations.forEach((p) => { m[p.apc_id] = p; }); return m;
  }, [presentations]);
  const activePresentation = useMemo(
    () => presentations.find((p) => p.status === 'presenting') || null,
    [presentations],
  );
  const presentCount = attendance.filter((a) => a.status === 'present').length;
  const absentCount  = attendance.filter((a) => a.status === 'absent').length;

  async function handleMark(apcId, status) {
    setBusy(`att-${apcId}`);
    try { await markAttendance(meeting.id, apcId, status); await refresh(); }
    catch (e) { alert('Failed: ' + (e.message || 'unknown')); }
    finally { setBusy(''); }
  }
  async function handleStart() {
    setBusy('present');
    try { await startPresenting(meeting.id); await refresh(); }
    catch (e) { alert(e.message || 'Failed to start presenting'); }
    finally { setBusy(''); }
  }
  async function handleStop(apcId) {
    setBusy('present');
    try { await stopPresenting(meeting.id, apcId); await refresh(); }
    catch (e) { alert(e.message || 'Failed to stop presenting'); }
    finally { setBusy(''); }
  }
  async function handleFinish() {
    if (!window.confirm('Finish this meeting? This ends the session for everyone.')) return;
    setBusy('finish');
    try { await finishMeeting(meeting.id); await refresh(); }
    catch (e) { alert(e.message || 'Failed to finish meeting'); }
    finally { setBusy(''); }
  }

  if (loading) {
    return (
      <div style={{ padding: '32px' }}>
        <div className="d-flex align-items-center gap-2 text-muted">
          <span className="spinner-border spinner-border-sm" /> Loading…
        </div>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div style={{ padding: '32px 32px 48px' }}>
        <div className="mb-4">
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
            <i className="bi bi-broadcast" style={{ fontSize: '1.15rem' }} />
            Ongoing Meetings
          </h5>
        </div>
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16, background: '#fff' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: '#f0f1f5' }}>
            <i className="bi bi-broadcast text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No meeting in progress</p>
          <p className="text-muted small mb-2">
            {isOL ? 'Start a team meeting from Upcoming Meetings.' : 'You’ll see your team’s meeting here the moment it starts.'}
          </p>
          {isOL && <Link to="/agenda/upcoming" className="btn btn-sm btn-outline-dark" style={{ borderRadius: 8 }}>Go to Upcoming Meetings</Link>}
        </div>
      </div>
    );
  }

  const teamName = team?.tl?.display_name || meeting.tl?.display_name || 'Team';

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <div className="d-flex align-items-center gap-2 mb-1">
            <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
              style={{ background: '#fef2f2', color: '#dc2626', fontSize: '0.62rem', fontWeight: 800 }}>
              <span className="rounded-circle" style={{ width: 6, height: 6, background: '#dc2626', display: 'inline-block' }} />
              LIVE
            </span>
            <h5 className="fw-bold mb-0" style={{ color: '#1a1a2e' }}>{teamName} — Agenda Meeting</h5>
          </div>
          <p className="text-muted small mb-0">
            {apcs.length} APC{apcs.length === 1 ? '' : 's'} · {presentCount} present · {absentCount} absent
          </p>
        </div>
        {isOL && (
          <button className="btn btn-sm btn-success d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem' }}
            onClick={handleFinish} disabled={busy === 'finish'}>
            {busy === 'finish'
              ? <><span className="spinner-border spinner-border-sm" /> Finishing…</>
              : <><i className="bi bi-check2-circle" /> Finish Meeting</>}
          </button>
        )}
      </div>

      {/* Attendance strip */}
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex align-items-center justify-content-between mb-2">
            <span className="fw-semibold small d-flex align-items-center gap-2">
              <i className="bi bi-people-fill text-primary" />Attendance
            </span>
            <span className="text-muted" style={{ fontSize: '0.72rem' }}>
              {isTL ? 'Tap a name to mark Present / Absent' : 'Marked by the Team Lead'}
            </span>
          </div>
          {apcs.length === 0 ? (
            <div className="text-muted small">No APCs on this team.</div>
          ) : (
            <div className="d-flex flex-wrap gap-2">
              {apcs.map((a) => {
                const st = attMap[a.id];
                const bg = st === 'present' ? '#e6f4ea' : st === 'absent' ? '#fff0f0' : '#f8fafc';
                const bd = st === 'present' ? '#b7dfc4' : st === 'absent' ? '#f5c0c0' : '#e2e8f0';
                return (
                  <div key={a.id} className="rounded-2 px-2 py-1 d-flex align-items-center gap-2"
                    style={{ background: bg, border: `1px solid ${bd}` }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#1a1a2e' }}>{a.display_name}</span>
                    {st && (
                      <span style={{ fontSize: '0.64rem', fontWeight: 700, color: st === 'present' ? '#198754' : '#dc3545' }}>
                        {st === 'present' ? 'Present' : 'Absent'}
                      </span>
                    )}
                    {isTL && (
                      <span className="d-inline-flex gap-1">
                        <button className="btn btn-sm p-0 px-1" title="Present"
                          style={{ fontSize: '0.62rem', borderRadius: 5, background: st === 'present' ? '#198754' : '#fff', color: st === 'present' ? '#fff' : '#198754', border: '1px solid #198754' }}
                          disabled={busy === `att-${a.id}`}
                          onClick={() => handleMark(a.id, 'present')}>
                          <i className="bi bi-check-lg" />
                        </button>
                        <button className="btn btn-sm p-0 px-1" title="Absent"
                          style={{ fontSize: '0.62rem', borderRadius: 5, background: st === 'absent' ? '#dc3545' : '#fff', color: st === 'absent' ? '#fff' : '#dc3545', border: '1px solid #dc3545' }}
                          disabled={busy === `att-${a.id}`}
                          onClick={() => handleMark(a.id, 'absent')}>
                          <i className="bi bi-x-lg" />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Currently presenting banner */}
      <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3"
        style={{
          background: activePresentation ? 'linear-gradient(135deg,#4f46e5,#6366f1)' : '#f1f5f9',
          color: activePresentation ? '#fff' : '#64748b',
        }}>
        <div className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0"
          style={{ width: 44, height: 44, background: activePresentation ? 'rgba(255,255,255,0.2)' : '#e2e8f0' }}>
          <i className={`bi ${activePresentation ? 'bi-easel2-fill' : 'bi-easel2'}`} style={{ fontSize: '1.2rem' }} />
        </div>
        <div>
          <div style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', opacity: 0.8 }}>
            CURRENTLY PRESENTING
          </div>
          <div className="fw-bold" style={{ fontSize: '1.05rem' }}>
            {activePresentation ? (activePresentation.apc?.display_name || 'APC') : 'No one is presenting yet'}
          </div>
        </div>
        {activePresentation && (
          <span className="ms-auto rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
            style={{ background: 'rgba(255,255,255,0.2)', fontSize: '0.62rem', fontWeight: 800 }}>
            <span className="rounded-circle" style={{ width: 6, height: 6, background: '#fff', display: 'inline-block' }} />
            LIVE
          </span>
        )}
      </div>

      {/* APC presenting controls */}
      {isApc && (
        <APCControls
          meeting={meeting}
          uid={uid}
          myPresentation={presMap[uid]}
          activePresentation={activePresentation}
          busy={busy === 'present'}
          onStart={handleStart}
          onStop={() => handleStop(uid)}
          myTasks={myTasks}
        />
      )}

      {/* OL evaluation interface */}
      {isOL && (
        <OngoingEvaluation meeting={meeting} activePresentation={activePresentation} />
      )}

      {/* TL — presenter / OL actions overview */}
      {isTL && (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
          <div className="card-body p-3 text-muted small">
            <i className="bi bi-info-circle me-1" />
            Mark attendance above. The OL is running the presentation review.
          </div>
        </div>
      )}
    </div>
  );
}

// ── APC controls ────────────────────────────────────────────────────────
function APCControls({ meeting, uid, myPresentation, activePresentation, busy, onStart, onStop, myTasks }) {
  const iAmPresenting   = activePresentation?.apc_id === uid;
  const someoneElse     = activePresentation && activePresentation.apc_id !== uid;
  const done            = myPresentation?.status === 'done' && !iAmPresenting;

  return (
    <>
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
        <div className="card-body p-3 d-flex align-items-center justify-content-between gap-3 flex-wrap">
          <div>
            <div className="fw-semibold" style={{ fontSize: '0.86rem' }}>Your presentation</div>
            <div className="text-muted" style={{ fontSize: '0.74rem' }}>
              {iAmPresenting ? 'You are presenting now — the OL is reviewing your tasks.'
                : someoneElse ? `Locked — ${activePresentation.apc?.display_name || 'another APC'} is presenting.`
                : done ? 'You have finished presenting.'
                : 'When you are ready, start your presentation.'}
            </div>
          </div>
          {iAmPresenting ? (
            <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8 }} disabled={busy} onClick={onStop}>
              {busy ? <span className="spinner-border spinner-border-sm" /> : <><i className="bi bi-stop-fill" /> Stop Presenting</>}
            </button>
          ) : (
            <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8 }} disabled={busy || someoneElse} onClick={onStart}>
              {someoneElse ? <><i className="bi bi-lock-fill" /> Locked</>
                : busy ? <span className="spinner-border spinner-border-sm" />
                : <><i className="bi bi-play-fill" /> Start Presenting</>}
            </button>
          )}
        </div>
      </div>

      {myTasks.length > 0 && (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
          <div className="card-body p-3">
            <div className="fw-semibold small mb-2"><i className="bi bi-list-check me-1 text-primary" />Your agenda tasks</div>
            <div className="d-flex flex-column gap-2">
              {myTasks.map((t) => (
                <div key={t.id} className="rounded-2 p-2 d-flex align-items-center justify-content-between gap-2"
                  style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
                  <div className="min-w-0">
                    <div className="fw-semibold text-truncate" style={{ fontSize: '0.78rem' }}>{t.title}</div>
                    <div className="d-flex align-items-center gap-2 flex-wrap" style={{ fontSize: '0.66rem' }}>
                      {t.brand?.brand_name && (
                        <span className="text-muted"><i className="bi bi-shop me-1" />{t.brand.brand_name}</span>
                      )}
                      {t.link && (
                        <a href={t.link} target="_blank" rel="noreferrer">
                          <i className="bi bi-link-45deg" />View document
                        </a>
                      )}
                    </div>
                  </div>
                  <span className="rounded-pill px-2 flex-shrink-0" style={{ background: '#f1f5f9', color: '#475569', fontSize: '0.62rem', fontWeight: 700 }}>
                    {STATUS_LABEL[t.status] || t.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
