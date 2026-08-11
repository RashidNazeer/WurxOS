import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaMeetings, listAgendaTeams, listMeetingAttendance, listPresentations,
  listAgendaTasks, markAttendance, startPresenting, stopPresenting, reopenPresentation,
  startMeeting, finishMeeting, pauseMeeting, getAgendaSettings, getAgendaTeamSchedules,
  subscribeAgendaMeetings, subscribeAgendaRoom, agendaMeetingStartAt, agendaMeetLinkFor,
  getMyGuestTeams, listAgendaGuestTeams, isGuestOf,
} from '../../lib/agendaApi';
import OngoingEvaluation from '../../components/agenda/OngoingEvaluation';
import { useNow } from '../../hooks/useNow';

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
  const location = useLocation();

  // Guest teams (mig 249). A guest attends the meetings an OL ticked them
  // into — no more, no less. RLS already hides the rest, so every meeting
  // list on this page is pre-filtered to what this viewer may attend; these
  // slugs only decide how the page is SHAPED (room picker vs own-team pin)
  // and let us name the team they're attending as.
  const [myGuestSlugs, setMyGuestSlugs] = useState([]);
  const [guestTeamLabels, setGuestTeamLabels] = useState({});
  const isGuest = myGuestSlugs.length > 0;
  // Anyone who chooses a room from a list, rather than being pinned to one.
  const canSeeRooms = isOL || isGuest;

  const [meeting, setMeeting]         = useState(null);
  const [activeMeetings, setActiveMeetings] = useState([]);  // ongoing + paused (team-active)
  const [selectedMeetingId, setSelectedMeetingId] = useState(location.state?.meetingId || null);
  // Ref mirror so the mount-once realtime callback reads the latest selection
  // without re-subscribing.
  const selectedRef = useRef(location.state?.meetingId || null);
  // A guest with exactly one live room drops straight into it — but ONLY on
  // arrival. Re-running it on every refresh would bounce them back in after
  // "Back to rooms", and would silently teleport them into a different team's
  // room the moment the OL finished the one they were actually in.
  const firstLoadRef = useRef(true);
  const [team, setTeam]               = useState(null);   // { tl, apcs }
  const [attendance, setAttendance]   = useState([]);
  const [presentations, setPresentations] = useState([]);
  const [myTasks, setMyTasks]         = useState([]);
  const [weekUpcoming, setWeekUpcoming] = useState([]);
  const [allTeams, setAllTeams]       = useState([]);
  const [meetLink, setMeetLink]       = useState('');
  const [schedules, setSchedules]     = useState([]);
  const [justFinished, setJustFinished] = useState(false);
  const [loading, setLoading]         = useState(true);
  const [busy, setBusy]               = useState('');
  const [finishModalOpen, setFinishModalOpen] = useState(false);
  // OL is reviewing an already-presented APC (add remarks without reopening).
  const [reviewTargetId, setReviewTargetId] = useState(null);

  async function refresh() {
    try {
      const [active, upcoming, teams, settings, sched, mySlugs, allGuestTeams] = await Promise.all([
        listAgendaMeetings({ statuses: ['ongoing', 'paused'] }),
        listAgendaMeetings({ status: 'upcoming' }),
        listAgendaTeams(),
        getAgendaSettings(),
        getAgendaTeamSchedules(),
        getMyGuestTeams(),
        listAgendaGuestTeams(),
      ]);
      setAllTeams(teams);
      setMeetLink(settings?.google_meet_link || '');
      setSchedules(sched || []);
      setMyGuestSlugs(mySlugs || []);
      setGuestTeamLabels(Object.fromEntries((allGuestTeams || []).map((g) => [g.slug, g.label])));
      // Read guest state from THIS fetch, not from React state — on the first
      // refresh the state hasn't landed yet, and the room-selection branch
      // below would take the wrong path for a guest.
      const guest = (mySlugs || []).length > 0;

      // Only surface meetings whose TL is still an active team (deleted/
      // deactivated users can leave orphaned rows behind).
      const activeTlIds = new Set((teams || []).map((t) => t.tl.id));
      const activeRooms    = (active   || []).filter((m) => activeTlIds.has(m.tl_id));
      const upcomingActive = (upcoming || []).filter((m) => activeTlIds.has(m.tl_id));
      const wk = mondayStr();
      setActiveMeetings(activeRooms);
      setWeekUpcoming(upcomingActive.filter((m) => m.week_start === wk));

      // Room selection. A TL/APC lands on THEIR OWN team's live room — even if
      // they're also a guest elsewhere, because their own team comes first.
      // Only once their own team isn't live do they get the guest picker.
      // OL and guests pick from the list, which RLS has already narrowed to
      // the meetings they may attend — so a guest with no invite gets an empty
      // list and the honest "no meeting" state.
      const myTlId = isTL ? uid : (isApc ? (profile?.reports_to || null) : null);
      const myTeamRoom = myTlId ? activeRooms.find((m) => m.tl_id === myTlId) : null;

      let targetId;
      if (myTeamRoom && !guest) {
        targetId = myTeamRoom.id;
      } else if (myTeamRoom && guest && firstLoadRef.current) {
        targetId = myTeamRoom.id;          // own team wins on arrival
      } else if (!isOL && !guest) {
        targetId = null;                   // plain TL/APC, own team not live
      } else {
        targetId = selectedRef.current;
        if (targetId && !activeRooms.some((m) => m.id === targetId)) targetId = null;
        // Exactly one room and nothing chosen: a guest is here for that room.
        // Only on arrival — see firstLoadRef.
        if (!targetId && guest && !isOL && firstLoadRef.current && activeRooms.length === 1) {
          targetId = activeRooms[0].id;
        }
      }
      selectedRef.current = targetId;
      setSelectedMeetingId(targetId);

      const m = activeRooms.find((x) => x.id === targetId) || null;
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

  // OL/guest opens a specific room from the list (or backs out with null).
  function openRoom(id) {
    firstLoadRef.current = false;
    selectedRef.current = id || null;
    setSelectedMeetingId(id || null);
    setReviewTargetId(null);
    refresh();
  }

  useEffect(() => {
    refresh().finally(() => { firstLoadRef.current = false; setLoading(false); });
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
  // OL is adding remarks to an already-presented APC (only valid while 'done').
  const reviewTarget = useMemo(
    () => (reviewTargetId && presMap[reviewTargetId]?.status === 'done' ? presMap[reviewTargetId] : null),
    [reviewTargetId, presMap],
  );
  // The presentation the OL's evaluation panel shows: an explicitly-chosen
  // past presentation takes precedence over the live presenter.
  const evalPresentation = reviewTarget || activePresentation;
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
  // OL reopens a done APC: they're marked NOT presented and can present again.
  async function handleReopen(apcId) {
    if (!window.confirm('Reopen this APC’s session? They will be marked as NOT presented and can present again.')) return;
    setBusy(`reopen-${apcId}`);
    try {
      await reopenPresentation(meeting.id, apcId);
      if (reviewTargetId === apcId) setReviewTargetId(null);
      await refresh();
    } catch (e) { alert(e.message || 'Failed to reopen the session'); }
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
    try { setJustFinished(false); selectedRef.current = meetingId; setSelectedMeetingId(meetingId); await startMeeting(meetingId); await refresh(); }
    catch (e) { alert(e.message || 'Failed to start meeting'); }
    finally { setBusy(''); }
  }
  async function handlePause() {
    setBusy('pause');
    try { await pauseMeeting(meeting.id); await refresh(); }
    catch (e) { alert(e.message || 'Failed to pause meeting'); }
    finally { setBusy(''); }
  }
  async function handleResume() {
    setBusy('resume');
    try { await startMeeting(meeting.id); await refresh(); }
    catch (e) { alert(e.message || 'Failed to resume meeting'); }
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
    const hasActive  = canSeeRooms && activeMeetings.length > 0;
    const showNextUp = isOL && weekUpcoming.length > 0;  // Start buttons — OL only
    // What a guest is waiting for: the meetings they were invited to but that
    // haven't started. Naming them beats a bare "nothing here".
    const myGuestUpcoming = isGuest && !isOL
      ? weekUpcoming.filter((m) => isGuestOf(m.guest_teams, myGuestSlugs))
      : [];
    return (
      <div style={{ padding: '32px 32px 48px' }}>
        <div className="mb-4">
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-broadcast" style={{ fontSize: '1.15rem' }} />
            Ongoing Meetings
          </h5>
          {isOL && (
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>
              <i className="bi bi-globe2 me-1" />All times shown in Pakistan time (PKT)
            </div>
          )}
        </div>

        {justFinished && (
          <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3"
            style={{ background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)' }}>
            <i className="bi bi-check2-circle text-success" style={{ fontSize: '1.3rem' }} />
            <div>
              <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--success)' }}>Meeting finished</div>
              <div className="text-muted" style={{ fontSize: '0.78rem' }}>
                {showNextUp || hasActive ? 'Start or open another team right here — no need to leave this page.'
                  : 'All scheduled meetings for this week are done.'}
              </div>
            </div>
          </div>
        )}

        {hasActive && (
          <ActiveRoomsList meetings={activeMeetings} teamsById={teamsById} onOpen={openRoom} />
        )}

        {showNextUp && (
          <NextUpPanel meetings={weekUpcoming} teamsById={teamsById}
            busy={busy} onStart={handleStartMeeting} />
        )}

        {!hasActive && !showNextUp && (
          <div className="d-flex flex-column align-items-center justify-content-center py-5 px-3 text-center" style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
            <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
              <i className="bi bi-broadcast text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
            </div>
            <p className="fw-semibold text-dark mb-1">No meeting in progress</p>
            {isGuest && !isOL ? (
              myGuestUpcoming.length > 0 ? (
                <>
                  <p className="text-muted small mb-2" style={{ maxWidth: 420 }}>
                    Nothing live yet. You’re attending {myGuestUpcoming.length === 1 ? 'this meeting' : 'these meetings'} this week —
                    we’ll notify you the moment {myGuestUpcoming.length === 1 ? 'it starts' : 'each one starts'}.
                  </p>
                  <div className="d-flex flex-column gap-1 mb-3">
                    {myGuestUpcoming
                      .sort((a, b) => `${a.meeting_date}${a.meeting_time || ''}`.localeCompare(`${b.meeting_date}${b.meeting_time || ''}`))
                      .map((m) => (
                        <div key={m.id} className="rounded-2 px-3 py-1" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: '0.78rem' }}>
                          <strong style={{ color: 'var(--text-primary)' }}>
                            {teamsById[m.tl_id]?.tl?.display_name || m.tl?.display_name || 'Team'}
                          </strong>
                          <span className="text-muted"> · {fmtDate(m.meeting_date)} at {fmtTime(m.meeting_time)} PKT</span>
                        </div>
                      ))}
                  </div>
                </>
              ) : (
                <p className="text-muted small mb-2" style={{ maxWidth: 420 }}>
                  You’re not attending any meeting this week. An Operation Lead adds your team to a meeting
                  under Settings → Schedules, and you’ll be notified when they do.
                </p>
              )
            ) : (
              <p className="text-muted small mb-2">
                {isOL ? 'No active or scheduled meetings for this week.' : 'You’ll see your team’s meeting here the moment it starts.'}
              </p>
            )}
            {canSeeRooms && <Link to="/agenda/upcoming" className="btn btn-sm btn-outline-dark" style={{ borderRadius: 8 }}>Go to Upcoming Meetings</Link>}
          </div>
        )}
      </div>
    );
  }

  const teamName = team?.tl?.display_name || meeting.tl?.display_name || 'Team';
  const paused = meeting.status === 'paused';
  const joinLink = agendaMeetLinkFor(meeting, schedules, meetLink);
  // Is this the viewer's OWN team's meeting? Attendance controls are the TL's
  // alone (isMyTeam). But "am I here as a GUEST or as a member of this team?"
  // is a wider question — an APC on a guest team sitting in their own team's
  // room is a member, not an observer, and must not be told otherwise.
  const isMyTeam = isTL && meeting.tl_id === uid;
  const myTlId   = isTL ? uid : (isApc ? (profile?.reports_to || null) : null);
  const inOwnTeamRoom = !!myTlId && meeting.tl_id === myTlId;
  const hereAsGuest   = isGuest && !isOL && !inOwnTeamRoom;
  // The guest team(s) that got this viewer into THIS room — worth naming, so
  // an IPC sitting in four different teams' meetings knows which hat they wear.
  const myLabelsHere = (meeting.guest_teams || [])
    .filter((s) => myGuestSlugs.includes(s))
    .map((s) => guestTeamLabels[s] || s);

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      {/* Back to the rooms list — anyone who picks from one (OL or guest) */}
      {canSeeRooms && (
        <button type="button" onClick={() => openRoom(null)}
          className="btn btn-sm btn-link text-decoration-none px-0 mb-2"
          style={{ fontSize: '0.78rem' }}>
          <i className="bi bi-arrow-left me-1" />Back to rooms
        </button>
      )}
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <div className="d-flex align-items-center gap-2 mb-1">
            {paused ? (
              <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
                style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.62rem', fontWeight: 800 }}>
                <i className="bi bi-pause-fill" />PAUSED
              </span>
            ) : (
              <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
                style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.62rem', fontWeight: 800 }}>
                <span className="rounded-circle" style={{ width: 6, height: 6, background: 'var(--danger)', display: 'inline-block' }} />
                LIVE
              </span>
            )}
            <h5 className="fw-bold mb-0" style={{ color: 'var(--text-primary)' }}>{teamName} — Agenda Meeting</h5>
          </div>
          <p className="text-muted small mb-0">
            {apcs.length} APC{apcs.length === 1 ? '' : 's'} · {presentCount} present · {absentCount} absent
          </p>
        </div>
        {isOL && (
          <div className="d-flex gap-2 flex-wrap">
            {paused ? (
              <button className="btn btn-sm btn-primary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.8rem' }}
                onClick={handleResume} disabled={busy === 'resume'}>
                {busy === 'resume'
                  ? <><span className="spinner-border spinner-border-sm" /> Resuming…</>
                  : <><i className="bi bi-play-fill" /> Resume</>}
              </button>
            ) : (
              <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 8, fontSize: '0.8rem' }}
                onClick={handlePause} disabled={busy === 'pause'}>
                {busy === 'pause'
                  ? <><span className="spinner-border spinner-border-sm" /> Pausing…</>
                  : <><i className="bi bi-pause-fill" /> Pause</>}
              </button>
            )}
            <button className="btn btn-sm btn-success d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8, fontSize: '0.8rem' }}
              onClick={handleFinishClick} disabled={busy === 'finish'}>
              {busy === 'finish'
                ? <><span className="spinner-border spinner-border-sm" /> Finishing…</>
                : <><i className="bi bi-check2-circle" /> Finish Meeting</>}
            </button>
          </div>
        )}
      </div>

      {/* Paused banner — visible to the whole team */}
      {paused && (
        <div className="rounded-3 p-2 mb-3 d-flex align-items-center gap-2"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          <i className="bi bi-pause-circle-fill text-warning" />
          Meeting paused{isOL ? ' — resume to continue presentations.' : ' — waiting for the OL to resume.'}
        </div>
      )}

      {/* Join meeting — live for everyone in the active team's room */}
      <div className="mb-3">
        {joinLink ? (
          <a href={joinLink} target="_blank" rel="noreferrer"
            className="btn btn-success w-100 d-inline-flex align-items-center justify-content-center gap-2"
            style={{ borderRadius: 12, fontWeight: 700, fontSize: '0.95rem', padding: '12px 16px' }}>
            <i className="bi bi-camera-video-fill" style={{ fontSize: '1.1rem' }} />
            Join Meeting Now
            <span className="rounded-pill px-2 d-inline-flex align-items-center gap-1"
              style={{ background: 'color-mix(in srgb, currentColor 22%, transparent)', fontSize: '0.6rem', fontWeight: 800 }}>
              <span className="rounded-circle" style={{ width: 6, height: 6, background: 'currentColor', display: 'inline-block' }} />
              LIVE
            </span>
          </a>
        ) : (
          <div className="rounded-3 p-2 text-center text-muted"
            style={{ background: 'var(--surface-2)', border: '1px dashed var(--border-default)', fontSize: '0.78rem' }}>
            <i className="bi bi-camera-video-off me-1" />
            No Google Meet link set for this team — an OL can add one in Settings → Schedules.
          </div>
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
              {isMyTeam ? 'Tap a name to mark Present / Absent' : 'Marked by the Team Lead'}
            </span>
          </div>
          {apcs.length === 0 ? (
            <div className="text-muted small">No APCs on this team.</div>
          ) : (
            <div className="d-flex flex-wrap gap-2">
              {apcs.map((a) => {
                const st = attMap[a.id];
                const bg = st === 'present' ? 'var(--success-soft)' : st === 'absent' ? 'var(--danger-soft)' : 'var(--surface-2)';
                const bd = st === 'present'
                  ? 'color-mix(in srgb, var(--success) 35%, transparent)'
                  : st === 'absent'
                    ? 'color-mix(in srgb, var(--danger) 35%, transparent)'
                    : 'var(--border-subtle)';
                return (
                  <div key={a.id} className="rounded-2 px-2 py-1 d-flex align-items-center gap-2"
                    style={{ background: bg, border: `1px solid ${bd}` }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>{a.display_name}</span>
                    {st && (
                      <span style={{ fontSize: '0.64rem', fontWeight: 700, color: st === 'present' ? 'var(--success)' : 'var(--danger)' }}>
                        {st === 'present' ? 'Present' : 'Absent'}
                      </span>
                    )}
                    {isMyTeam && (
                      <span className="d-inline-flex gap-1">
                        <button className="btn btn-sm p-0 px-1" title="Present"
                          style={{ fontSize: '0.62rem', borderRadius: 5, background: st === 'present' ? 'var(--success)' : 'var(--surface-1)', color: st === 'present' ? 'var(--surface-1)' : 'var(--success)', border: '1px solid var(--success)' }}
                          disabled={busy === `att-${a.id}`}
                          onClick={() => handleMark(a.id, 'present')}>
                          <i className="bi bi-check-lg" />
                        </button>
                        <button className="btn btn-sm p-0 px-1" title="Absent"
                          style={{ fontSize: '0.62rem', borderRadius: 5, background: st === 'absent' ? 'var(--danger)' : 'var(--surface-1)', color: st === 'absent' ? 'var(--surface-1)' : 'var(--danger)', border: '1px solid var(--danger)' }}
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
          background: activePresentation ? 'var(--accent)' : 'var(--surface-2)',
          color: activePresentation ? 'var(--on-accent)' : 'var(--text-secondary)',
        }}>
        <div className="rounded-circle d-flex align-items-center justify-content-center flex-shrink-0"
          style={{ width: 44, height: 44, background: activePresentation ? 'color-mix(in srgb, var(--on-accent) 18%, transparent)' : 'var(--surface-3)' }}>
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
            style={{ background: 'color-mix(in srgb, var(--on-accent) 18%, transparent)', fontSize: '0.62rem', fontWeight: 800 }}>
            <span className="rounded-circle" style={{ width: 6, height: 6, background: 'var(--on-accent)', display: 'inline-block' }} />
            LIVE
          </span>
        )}
      </div>

      {/* Presentation progress — who has presented / who is pending (read-only;
          OL and guest observers). */}
      {canSeeRooms && apcs.length > 0 && (
        <PresentationProgress apcs={apcs} presMap={presMap}
          onReopen={isOL ? handleReopen : null}
          onRemarks={isOL ? setReviewTargetId : null}
          reviewTargetId={reviewTargetId}
          busy={busy} />
      )}

      {/* APC presenting controls */}
      {isApc && (
        <APCControls
          meeting={meeting}
          uid={uid}
          myPresentation={presMap[uid]}
          activePresentation={activePresentation}
          paused={paused}
          busy={busy === 'present'}
          onStart={handleStart}
          onStop={() => handleStop(uid)}
          myTasks={myTasks}
        />
      )}

      {/* OL evaluation interface */}
      {isOL && (
        <>
          {reviewTarget && (
            <div className="rounded-3 p-2 mb-2 d-flex align-items-center justify-content-between gap-2 flex-wrap"
              style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              <span>
                <i className="bi bi-clock-history text-warning me-1" />
                Adding remarks for <strong>{reviewTarget.apc?.display_name || 'APC'}</strong> — already presented.
                Reviews save without changing their status.
              </span>
              <div className="d-flex gap-2">
                <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.74rem' }}
                  onClick={() => setReviewTargetId(null)}>
                  <i className="bi bi-x-lg me-1" />{activePresentation ? 'Back to live presenter' : 'Close'}
                </button>
                <button className="btn btn-sm btn-outline-danger" style={{ borderRadius: 8, fontSize: '0.74rem' }}
                  disabled={busy === `reopen-${reviewTarget.apc_id}`}
                  onClick={() => handleReopen(reviewTarget.apc_id)}>
                  <i className="bi bi-arrow-counterclockwise me-1" />Reopen so they present again
                </button>
              </div>
            </div>
          )}
          <OngoingEvaluation meeting={meeting} activePresentation={evalPresentation} />
        </>
      )}

      {/* TL of THIS team — presenter / OL actions overview */}
      {isMyTeam && (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
          <div className="card-body p-3 text-muted small">
            <i className="bi bi-info-circle me-1" />
            Mark attendance above. The OL is running the presentation review.
          </div>
        </div>
      )}

      {/* Guest sitting in on another team's room — observer only */}
      {hereAsGuest && (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
          <div className="card-body p-3 text-muted small">
            <i className="bi bi-eye me-1" />
            You’re attending {teamName}’s meeting
            {myLabelsHere.length > 0 && <> as <strong style={{ color: 'var(--text-primary)' }}>{myLabelsHere.join(' + ')}</strong></>}.
            The team’s own Team Lead marks attendance and the OL runs the review.
          </div>
        </div>
      )}

      {/* Finish-meeting guard — present APCs who never presented */}
      {finishModalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={() => setFinishModalOpen(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 14 }}>
            <div className="card-body p-4">
              <div className="d-flex align-items-start gap-3 mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--warning-soft)' }}>
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
                  <span key={a.id} className="rounded-pill px-2 py-1" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.72rem', fontWeight: 600 }}>
                    {a.display_name}
                  </span>
                ))}
              </div>
              <div className="rounded-2 p-2 mb-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
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

// ── Active rooms list (OL) — open any live or paused meeting ────────────
function ActiveRoomsList({ meetings, teamsById, onOpen }) {
  const sorted = [...meetings].sort((a, b) =>
    `${a.meeting_date}${a.meeting_time || ''}`.localeCompare(`${b.meeting_date}${b.meeting_time || ''}`));
  return (
    <div className="mb-4">
      <div className="fw-semibold small mb-2 d-flex align-items-center gap-2">
        <i className="bi bi-broadcast-pin text-danger" />Live &amp; paused rooms
      </div>
      <div className="row g-3">
        {sorted.map((m) => {
          const team = teamsById[m.tl_id];
          const apcs = team?.apcs || [];
          const isPaused = m.status === 'paused';
          return (
            <div key={m.id} className="col-12 col-md-6 col-xl-4">
              <div className="card border-0 shadow-sm h-100"
                style={{ borderRadius: 14, border: `1px solid ${isPaused ? 'color-mix(in srgb, var(--warning) 45%, transparent)' : 'color-mix(in srgb, var(--danger) 45%, transparent)'}` }}>
                <div className="card-body p-3 d-flex flex-column">
                  <span className="rounded-pill px-2 py-1 mb-2 align-self-start d-inline-flex align-items-center gap-1"
                    style={{ fontSize: '0.6rem', fontWeight: 800,
                      background: isPaused ? 'var(--warning-soft)' : 'var(--danger-soft)',
                      color: isPaused ? 'var(--warning)' : 'var(--danger)' }}>
                    {isPaused ? <><i className="bi bi-pause-fill" />PAUSED</>
                      : <><span className="rounded-circle" style={{ width: 6, height: 6, background: 'var(--danger)', display: 'inline-block' }} />LIVE</>}
                  </span>
                  <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                    {team?.tl?.display_name || m.tl?.display_name || 'Team'}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                    <i className="bi bi-people me-1" />{apcs.length} APC{apcs.length === 1 ? '' : 's'}
                    {' · '}<i className="bi bi-clock me-1" />{fmtTime(m.meeting_time)} PKT
                  </div>
                  <div style={{ flexGrow: 1 }} />
                  <button className="btn btn-sm btn-dark w-100 mt-3 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.74rem' }}
                    onClick={() => onOpen(m.id)}>
                    <i className="bi bi-box-arrow-in-right" /> {isPaused ? 'Open / Resume' : 'Open room'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Next-up panel (OL, shown after finishing) ───────────────────────────
function NextUpPanel({ meetings, teamsById, busy, onStart }) {
  const now = useNow();
  const sorted = [...meetings].sort((a, b) =>
    `${a.meeting_date}${a.meeting_time || ''}`.localeCompare(`${b.meeting_date}${b.meeting_time || ''}`));
  // Per-meeting gate: a team's Start button appears once that meeting's OWN
  // scheduled time is reached (server clock). Once the week is under way (a
  // meeting was finished this session) the rest stay open for back-to-back.
  // Scheduled time is a hint, never a lock — the two OLs run teams in parallel
  // and start ahead of the slot. See the same note in AgendaUpcomingPage.
  const timeReached = (m) => {
    const at = agendaMeetingStartAt(m);
    return !at || now.getTime() >= at.getTime();
  };
  const first = sorted[0];
  const noSlotReachedYet = sorted.length > 0 && !sorted.some(timeReached);
  return (
    <>
      <div className="fw-semibold small mb-2 d-flex align-items-center gap-2">
        <i className="bi bi-arrow-right-circle text-primary" />Next up this week
      </div>
      {noSlotReachedYet && first && (
        <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
          <i className="bi bi-megaphone-fill text-primary" style={{ fontSize: '1.15rem' }} />
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            Teams are notified. The first slot is{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{fmtTime(first.meeting_time)} PKT</strong>
            {' '}({fmtDate(first.meeting_date)}) — you can start any team before then.
          </div>
        </div>
      )}
      <div className="row g-3">
        {sorted.map((m, i) => {
          const team = teamsById[m.tl_id];
          const apcs = team?.apcs || [];
          const isNext = i === 0;
          return (
            <div key={m.id} className="col-12 col-md-6 col-xl-4">
              <div className="card border-0 shadow-sm h-100"
                style={{ borderRadius: 14, border: isNext ? '2px solid var(--accent)' : '1px solid var(--border-subtle)' }}>
                <div className="card-body p-3 d-flex flex-column">
                  {isNext && (
                    <span className="rounded-pill px-2 py-1 mb-2 align-self-start"
                      style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: '0.6rem', fontWeight: 800 }}>
                      NEXT
                    </span>
                  )}
                  <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                    {team?.tl?.display_name || m.tl?.display_name || 'Team'}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                    <i className="bi bi-people me-1" />{apcs.length} APC{apcs.length === 1 ? '' : 's'}
                    {' · '}<i className="bi bi-calendar3 me-1" />{fmtDate(m.meeting_date)}
                    {' · '}<i className="bi bi-clock me-1" />{fmtTime(m.meeting_time)} PKT
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
                  {!timeReached(m) && (
                    <div className="text-muted text-center mt-1" style={{ fontSize: '0.66rem' }}>
                      <i className="bi bi-clock-history me-1" />Scheduled {fmtTime(m.meeting_time)} PKT
                    </div>
                  )}
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
// For a Presented APC the OL gets two actions: "Remarks" (review their tasks
// without changing status) and "Reopen" (mark not-presented so they can go
// again). Handlers are null for non-OL observers, hiding the buttons.
function PresentationProgress({ apcs, presMap, onReopen, onRemarks, reviewTargetId, busy }) {
  const META = {
    done:       { label: 'Presented',  color: 'var(--success)',        bg: 'var(--success-soft)', icon: 'bi-check-circle-fill' },
    presenting: { label: 'Presenting', color: 'var(--accent)',         bg: 'var(--accent-soft)',  icon: 'bi-easel2-fill' },
    pending:    { label: 'Pending',    color: 'var(--text-secondary)', bg: 'var(--surface-2)',    icon: 'bi-hourglass-split' },
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
            const st = statusOf(a);
            const m = META[st];
            const isDone   = st === 'done';
            const selected = reviewTargetId === a.id;
            return (
              <div key={a.id} className="rounded-2 px-2 py-1 d-flex align-items-center gap-2"
                style={{ background: m.bg, border: `1px solid ${selected ? 'var(--accent)' : `color-mix(in srgb, ${m.color} 30%, transparent)`}` }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>{a.display_name}</span>
                <span className="d-inline-flex align-items-center gap-1" style={{ fontSize: '0.62rem', fontWeight: 700, color: m.color }}>
                  <i className={`bi ${m.icon}`} />{m.label}
                </span>
                {isDone && onRemarks && (
                  <button className="btn btn-sm p-0 px-1 d-inline-flex align-items-center gap-1" title="Add remarks / review their tasks — no status change"
                    style={{ fontSize: '0.6rem', fontWeight: 700, borderRadius: 5,
                      background: selected ? 'var(--accent)' : 'var(--surface-1)',
                      color: selected ? 'var(--surface-1)' : 'var(--accent)', border: '1px solid var(--accent)' }}
                    onClick={() => onRemarks(a.id)}>
                    <i className="bi bi-chat-left-text" />Remarks
                  </button>
                )}
                {isDone && onReopen && (
                  <button className="btn btn-sm p-0 px-1 d-inline-flex align-items-center gap-1" title="Reopen — mark not presented so they can present again"
                    style={{ fontSize: '0.6rem', fontWeight: 700, borderRadius: 5, background: 'var(--surface-1)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
                    disabled={busy === `reopen-${a.id}`}
                    onClick={() => onReopen(a.id)}>
                    {busy === `reopen-${a.id}`
                      ? <span className="spinner-border spinner-border-sm" style={{ width: '0.6rem', height: '0.6rem' }} />
                      : <><i className="bi bi-arrow-counterclockwise" />Reopen</>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── APC controls ────────────────────────────────────────────────────────
function APCControls({ meeting, uid, myPresentation, activePresentation, paused, busy, onStart, onStop, myTasks }) {
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
                : paused ? 'Meeting is paused — wait for the OL to resume.'
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
              style={{ borderRadius: 8 }} disabled={busy || someoneElse || paused} onClick={onStart}>
              {paused ? <><i className="bi bi-pause-fill" /> Paused</>
                : someoneElse ? <><i className="bi bi-lock-fill" /> Locked</>
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
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
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
                  <span className="rounded-pill px-2 flex-shrink-0" style={{ background: 'var(--surface-3)', color: 'var(--text-secondary)', fontSize: '0.62rem', fontWeight: 700 }}>
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
