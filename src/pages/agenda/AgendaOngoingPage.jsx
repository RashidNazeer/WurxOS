import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaMeetings, listAgendaTeams, listMeetingAttendance, listPresentations,
  listAgendaTasks, markAttendance, startPresenting, stopPresenting,
  startMeeting, finishMeeting, subscribeAgendaMeetings, subscribeAgendaRoom,
} from '../../lib/agendaApi';
import OngoingEvaluation from '../../components/agenda/OngoingEvaluation';

// Weekly Agenda Meetings — Ongoing (the live meeting room).
// Realtime: attendance, presenter state and meeting status all sync
// for every participant with no manual refresh.

const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', completed: 'Completed' };

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayStr() {
  const x = new Date(); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
}
function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

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
  const [weekUpcoming, setWeekUpcoming] = useState([]);
  const [allTeams, setAllTeams]       = useState([]);
  const [justFinished, setJustFinished] = useState(false);
  const [loading, setLoading]         = useState(true);
  const [busy, setBusy]               = useState('');
  const [finishModalOpen, setFinishModalOpen] = useState(false);

  async function refresh() {
    try {
      const [ongoing, upcoming, teams] = await Promise.all([
        listAgendaMeetings({ status: 'ongoing' }),
        listAgendaMeetings({ status: 'upcoming' }),
        listAgendaTeams(),
      ]);
      setAllTeams(teams);
      const wk = mondayStr();
      setWeekUpcoming((upcoming || []).filter((m) => m.week_start === wk));
      const m = ongoing[0] || null;
      if (!m) {
        setMeeting(null); setTeam(null); setAttendance([]); setPresentations([]);
        return;
      }
      const [att, pres] = await Promise.all([
        listMeetingAttendance(m.id), listPresentations(m.id),
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
  // Present APCs who have not presented — flagged before finishing.
  const pendingPresent = useMemo(
    () => apcs.filter((a) => attMap[a.id] === 'present'
      && (!presMap[a.id] || presMap[a.id].status === 'pending')),
    [apcs, attMap, presMap],
  );

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
  function handleFinishClick() {
    // If any present APC never presented, confirm via the modal first.
    if (pendingPresent.length > 0) { setFinishModalOpen(true); return; }
    if (!window.confirm('Finish this meeting? This ends the session for everyone.')) return;
    doFinish();
  }
  async function doFinish() {
    setFinishModalOpen(false);
    setBusy('finish');
    try { await finishMeeting(meeting.id); setJustFinished(true); await refresh(); }
    catch (e) { alert(e.message || 'Failed to finish meeting'); }
    finally { setBusy(''); }
  }
  async function handleStartMeeting(meetingId) {
    setBusy(`start-${meetingId}`);
    try { setJustFinished(false); await startMeeting(meetingId); await refresh(); }
    catch (e) { alert(e.message || 'Failed to start meeting'); }
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
    const teamsById = {};
    allTeams.forEach((t) => { teamsById[t.tl.id] = t; });
    const showNextUp = isOL && weekUpcoming.length > 0;
    return (
      <div style={{ padding: '32px 32px 48px' }}>
        <div className="mb-4">
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
            <i className="bi bi-broadcast" style={{ fontSize: '1.15rem' }} />
            Ongoing Meetings
          </h5>
        </div>

        {justFinished && (
          <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3"
            style={{ background: '#e6f4ea', border: '1px solid #b7dfc4' }}>
            <i className="bi bi-check2-circle text-success" style={{ fontSize: '1.3rem' }} />
            <div>
              <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#166534' }}>Meeting finished</div>
              <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                {showNextUp ? 'Start the next team right here — no need to leave this page.'
                  : 'All scheduled meetings for this week are done.'}
              </div>
            </div>
          </div>
        )}

        {showNextUp ? (
          <NextUpPanel meetings={weekUpcoming} teamsById={teamsById}
            busy={busy} onStart={handleStartMeeting} />
        ) : (
          <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16, background: '#fff' }}>
            <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: '#f0f1f5' }}>
              <i className="bi bi-broadcast text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
            </div>
            <p className="fw-semibold text-dark mb-1">No meeting in progress</p>
            <p className="text-muted small mb-2">
              {isOL ? 'No more meetings scheduled for this week.' : 'You’ll see your team’s meeting here the moment it starts.'}
            </p>
            {isOL && <Link to="/agenda/upcoming" className="btn btn-sm btn-outline-dark" style={{ borderRadius: 8 }}>Go to Upcoming Meetings</Link>}
          </div>
        )}
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
            onClick={handleFinishClick} disabled={busy === 'finish'}>
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

      {/* Presentation progress — OL sees who has presented / who is pending */}
      {isOL && apcs.length > 0 && (
        <PresentationProgress apcs={apcs} presMap={presMap} />
      )}

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

      {/* Finish-meeting guard — present APCs who never presented */}
      {finishModalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={() => setFinishModalOpen(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 14 }}>
            <div className="card-body p-4">
              <div className="d-flex align-items-start gap-3 mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#fff3e0' }}>
                  <i className="bi bi-exclamation-triangle text-warning" style={{ fontSize: '1rem' }} />
                </div>
                <div>
                  <p className="fw-semibold mb-0 small">Finish meeting?</p>
                  <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>
                    These present APCs have not presented yet:
                  </p>
                </div>
              </div>
              <div className="d-flex flex-wrap gap-1 mb-3">
                {pendingPresent.map((a) => (
                  <span key={a.id} className="rounded-pill px-2 py-1" style={{ background: '#fff3e0', color: '#9a3412', fontSize: '0.72rem', fontWeight: 600 }}>
                    {a.display_name}
                  </span>
                ))}
              </div>
              <div className="rounded-2 p-2 mb-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: '0.76rem', color: '#475569' }}>
                <i className="bi bi-info-circle me-1" />
                Finishing now will mark them as <strong>Presented</strong> with no review or remarks.
              </div>
              <div className="d-flex gap-2 justify-content-end">
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setFinishModalOpen(false)} disabled={busy === 'finish'}>
                  Cancel
                </button>
                <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1" onClick={doFinish} disabled={busy === 'finish'}>
                  {busy === 'finish'
                    ? <><span className="spinner-border spinner-border-sm" /> Finishing…</>
                    : <><i className="bi bi-check2-circle" /> Finish meeting anyway</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Next-up panel (OL, shown after finishing) ───────────────────────────
function NextUpPanel({ meetings, teamsById, busy, onStart }) {
  const sorted = [...meetings].sort((a, b) =>
    `${a.meeting_date}${a.meeting_time || ''}`.localeCompare(`${b.meeting_date}${b.meeting_time || ''}`));
  return (
    <>
      <div className="fw-semibold small mb-2 d-flex align-items-center gap-2">
        <i className="bi bi-arrow-right-circle text-primary" />Next up this week
      </div>
      <div className="row g-3">
        {sorted.map((m, i) => {
          const team = teamsById[m.tl_id];
          const apcs = team?.apcs || [];
          const isNext = i === 0;
          return (
            <div key={m.id} className="col-12 col-md-6 col-xl-4">
              <div className="card border-0 shadow-sm h-100"
                style={{ borderRadius: 14, border: isNext ? '2px solid #6366f1' : '1px solid #e2e8f0' }}>
                <div className="card-body p-3 d-flex flex-column">
                  {isNext && (
                    <span className="rounded-pill px-2 py-1 mb-2 align-self-start"
                      style={{ background: '#eef2ff', color: '#4f46e5', fontSize: '0.6rem', fontWeight: 800 }}>
                      NEXT
                    </span>
                  )}
                  <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#1a1a2e' }}>
                    {team?.tl?.display_name || m.tl?.display_name || 'Team'}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                    <i className="bi bi-people me-1" />{apcs.length} APC{apcs.length === 1 ? '' : 's'}
                    {' · '}<i className="bi bi-calendar3 me-1" />{fmtDate(m.meeting_date)}
                    {' · '}<i className="bi bi-clock me-1" />{fmtTime(m.meeting_time)}
                  </div>
                  {apcs.length > 0 && (
                    <div className="text-muted mt-1" style={{ fontSize: '0.66rem' }}>
                      {apcs.map((a) => a.display_name).filter(Boolean).join(', ')}
                    </div>
                  )}
                  <div style={{ flexGrow: 1 }} />
                  <button className="btn btn-sm btn-success w-100 mt-3 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.74rem' }}
                    disabled={busy === `start-${m.id}`}
                    onClick={() => onStart(m.id)}>
                    {busy === `start-${m.id}`
                      ? <span className="spinner-border spinner-border-sm" />
                      : <><i className="bi bi-play-fill" /> Start Meeting</>}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Presentation progress (OL) ──────────────────────────────────────────
function PresentationProgress({ apcs, presMap }) {
  const META = {
    done:       { label: 'Presented',  color: '#198754', bg: '#e6f4ea', icon: 'bi-check-circle-fill' },
    presenting: { label: 'Presenting', color: '#4f46e5', bg: '#eef2ff', icon: 'bi-easel2-fill' },
    pending:    { label: 'Pending',    color: '#64748b', bg: '#f1f5f9', icon: 'bi-hourglass-split' },
  };
  const statusOf = (a) => presMap[a.id]?.status || 'pending';
  const doneCount    = apcs.filter((a) => statusOf(a) === 'done').length;
  const pendingCount = apcs.filter((a) => statusOf(a) === 'pending').length;

  return (
    <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-2">
          <span className="fw-semibold small d-flex align-items-center gap-2">
            <i className="bi bi-list-ol text-primary" />Presentation progress
          </span>
          <span className="text-muted" style={{ fontSize: '0.72rem' }}>
            {doneCount} presented · {pendingCount} pending
          </span>
        </div>
        <div className="d-flex flex-wrap gap-2">
          {apcs.map((a) => {
            const m = META[statusOf(a)];
            return (
              <div key={a.id} className="rounded-2 px-2 py-1 d-flex align-items-center gap-2"
                style={{ background: m.bg, border: `1px solid ${m.color}30` }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#1a1a2e' }}>{a.display_name}</span>
                <span className="d-inline-flex align-items-center gap-1" style={{ fontSize: '0.62rem', fontWeight: 700, color: m.color }}>
                  <i className={`bi ${m.icon}`} />{m.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
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
          ) : done ? (
            <button className="btn btn-sm btn-outline-success d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8 }} disabled>
              <i className="bi bi-check2-circle" /> Presented
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
