import React, { useEffect, useMemo, useState } from 'react';
import {
  listAgendaTeams, getAgendaTeamSchedules,
  upsertAgendaTeamSchedule, deleteAgendaTeamSchedule,
  listAgendaMeetings, resyncWeek,
} from '../../lib/agendaApi';

// Schedules settings — OL sets each team's recurring meeting day + time.
// A team left "Not scheduled" is skipped when notifying teams.

const DAYS = [
  ['', 'Not scheduled'],
  ['monday', 'Monday'], ['tuesday', 'Tuesday'], ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
  ['sunday', 'Sunday'],
];

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function currentWeekMonday() {
  const x = new Date(); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
}

export default function AgendaSchedulesTab() {
  const [teams, setTeams]       = useState([]);
  const [draft, setDraft]       = useState({});      // tlId -> { day, time }
  const [original, setOriginal] = useState({});
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [savedTick, setSavedTick] = useState(false);
  const [askApply, setAskApply] = useState(false);   // confirm modal open

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgendaTeams(), getAgendaTeamSchedules()])
      .then(([tm, sched]) => {
        if (cancelled) return;
        setTeams(tm || []);
        const map = {};
        (sched || []).forEach((s) => { map[s.tl_id] = { day: s.meeting_day, time: (s.meeting_time || '').slice(0, 5), link: s.meet_link || '' }; });
        const init = {};
        (tm || []).forEach(({ tl }) => { init[tl.id] = map[tl.id] || { day: '', time: '15:00', link: '' }; });
        setDraft(init);
        setOriginal(JSON.parse(JSON.stringify(init)));
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function set(tlId, part) {
    setDraft((d) => ({ ...d, [tlId]: { ...d[tlId], ...part } }));
  }

  const changedTeamIds = useMemo(() => {
    return teams
      .map(({ tl }) => tl.id)
      .filter((id) => JSON.stringify(draft[id]) !== JSON.stringify(original[id]));
  }, [teams, draft, original]);

  const dirty = changedTeamIds.length > 0;

  // Persist schedule rows; optionally re-sync this week's meetings.
  async function doSave(applyToCurrentWeek) {
    setAskApply(false);
    setSaving(true);
    setError('');
    try {
      for (const tlId of changedTeamIds) {
        const cur = draft[tlId] || { day: '', time: '' };
        const was = original[tlId] || { day: '', time: '' };
        if (cur.day) {
          await upsertAgendaTeamSchedule(tlId, cur.day, cur.time || '15:00', cur.link || '');
        } else if (was.day) {
          await deleteAgendaTeamSchedule(tlId);
        }
      }
      if (applyToCurrentWeek) {
        await resyncWeek(currentWeekMonday());
      }
      setOriginal(JSON.parse(JSON.stringify(draft)));
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 2500);
    } catch (e) {
      setError(e.message || 'Failed to save schedules.');
    } finally {
      setSaving(false);
    }
  }

  // On save: if any changed team already has a meeting scheduled for
  // THIS week, ask whether to apply the change to it too.
  async function handleSaveClick() {
    if (!dirty) return;
    try {
      const wk = currentWeekMonday();
      const upcoming = await listAgendaMeetings({ status: 'upcoming' });
      const affected = (upcoming || []).filter(
        (m) => m.week_start === wk && changedTeamIds.includes(m.tl_id),
      );
      if (affected.length > 0) {
        setAskApply(true);
        return;
      }
    } catch { /* fall through to a plain save */ }
    doSave(false);
  }

  if (loading) {
    return <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading teams…</div>;
  }

  return (
    <div>
      <p className="text-muted small mb-3">
        Set each team’s recurring agenda-meeting slot and its own permanent Google Meet link. Teams left “Not scheduled” are skipped when you notify teams.
      </p>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {teams.length === 0 ? (
        <div className="text-muted small py-3">No team leads found.</div>
      ) : (
        <div className="d-flex flex-column gap-2">
          {teams.map(({ tl, apcs }) => {
            const d = draft[tl.id] || { day: '', time: '15:00', link: '' };
            return (
              <div key={tl.id} className="card border-0 shadow-sm" style={{ borderRadius: 10 }}>
                <div className="card-body p-3 d-flex align-items-center gap-3 flex-wrap">
                  <div className="flex-grow-1 min-w-0" style={{ minWidth: 180 }}>
                    <div className="fw-semibold" style={{ fontSize: '0.86rem' }}>{tl.display_name || tl.email}</div>
                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                      <i className="bi bi-people me-1" />{apcs.length} APC{apcs.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 150 }}
                    value={d.day} onChange={(e) => set(tl.id, { day: e.target.value })}>
                    {DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <input type="time" className="form-control form-control-sm" style={{ borderRadius: 8, width: 'auto' }}
                    value={d.time} disabled={!d.day}
                    onChange={(e) => set(tl.id, { time: e.target.value })} />
                  <div className="d-flex align-items-center gap-2" style={{ flexBasis: '100%', minWidth: 0 }}>
                    <i className="bi bi-camera-video text-muted flex-shrink-0" style={{ fontSize: '0.85rem' }} title="This team’s Google Meet link" />
                    <input type="url" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                      placeholder={d.day ? 'Team Google Meet link — https://meet.google.com/abc-defg-hij' : 'Pick a meeting day first to add this team’s link'}
                      value={d.link || ''} disabled={!d.day}
                      onChange={(e) => set(tl.id, { link: e.target.value })} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="d-flex align-items-center gap-2 mt-3">
        <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" style={{ borderRadius: 8 }}
          onClick={handleSaveClick} disabled={saving || !dirty}>
          {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save schedules</>}
        </button>
        {savedTick && <span className="text-success small d-inline-flex align-items-center gap-1"><i className="bi bi-check-circle-fill" /> Saved</span>}
      </div>

      {askApply && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={() => setAskApply(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 460, zIndex: 1, borderRadius: 14 }}>
            <div className="card-body p-4">
              <div className="d-flex align-items-start gap-3 mb-3">
                <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--accent-soft)' }}>
                  <i className="bi bi-calendar-week text-primary" style={{ fontSize: '1rem' }} />
                </div>
                <div>
                  <p className="fw-semibold mb-0 small">Apply to this week?</p>
                  <p className="text-muted mb-0" style={{ fontSize: '0.78rem' }}>
                    This week’s meetings have already been scheduled. Should the new day/time apply to them as well, or only to upcoming weeks?
                  </p>
                </div>
              </div>
              <div className="d-flex gap-2 justify-content-end flex-wrap">
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setAskApply(false)} disabled={saving}>Cancel</button>
                <button className="btn btn-sm btn-outline-primary px-3" onClick={() => doSave(false)} disabled={saving}>
                  Only upcoming weeks
                </button>
                <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={() => doSave(true)} disabled={saving}>
                  <i className="bi bi-check-lg" /> Apply to this week too
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
