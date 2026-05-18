import React, { useEffect, useMemo, useState } from 'react';
import {
  listAgendaTeams, getAgendaTeamSchedules, getAgendaSettings,
  upsertAgendaTeamSchedule, deleteAgendaTeamSchedule,
} from '../../lib/agendaApi';

// Schedules settings — OL sets each team's recurring meeting day + time.
// A team left "Not scheduled" is skipped when notifying teams.

const DAYS = [
  ['', 'Not scheduled'],
  ['monday', 'Monday'], ['tuesday', 'Tuesday'], ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
  ['sunday', 'Sunday'],
];

export default function AgendaSchedulesTab() {
  const [teams, setTeams]   = useState([]);
  const [draft, setDraft]   = useState({});   // tlId -> { day, time }
  const [original, setOriginal] = useState({});
  const [defaultDay, setDefaultDay] = useState('tuesday');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [savedTick, setSavedTick] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgendaTeams(), getAgendaTeamSchedules(), getAgendaSettings()])
      .then(([tm, sched, settings]) => {
        if (cancelled) return;
        setTeams(tm || []);
        setDefaultDay(settings?.meeting_day || 'tuesday');
        const map = {};
        (sched || []).forEach((s) => { map[s.tl_id] = { day: s.meeting_day, time: (s.meeting_time || '').slice(0, 5) }; });
        const init = {};
        (tm || []).forEach(({ tl }) => { init[tl.id] = map[tl.id] || { day: '', time: '15:00' }; });
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

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(original),
    [draft, original],
  );

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      for (const { tl } of teams) {
        const cur = draft[tl.id] || { day: '', time: '' };
        const was = original[tl.id] || { day: '', time: '' };
        if (cur.day === was.day && cur.time === was.time) continue;
        if (cur.day) {
          await upsertAgendaTeamSchedule(tl.id, cur.day, cur.time || '15:00');
        } else if (was.day) {
          await deleteAgendaTeamSchedule(tl.id);
        }
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

  if (loading) {
    return <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading teams…</div>;
  }

  return (
    <div>
      <p className="text-muted small mb-3">
        Set each team’s recurring agenda-meeting slot. Teams left “Not scheduled” are skipped when you notify teams.
      </p>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {teams.length === 0 ? (
        <div className="text-muted small py-3">No team leads found.</div>
      ) : (
        <div className="d-flex flex-column gap-2">
          {teams.map(({ tl, apcs }) => {
            const d = draft[tl.id] || { day: '', time: '15:00' };
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
                  {!d.day && (
                    <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.72rem' }}
                      onClick={() => set(tl.id, { day: defaultDay, time: d.time || '15:00' })}>
                      Use default ({defaultDay})
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="d-flex align-items-center gap-2 mt-3">
        <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" style={{ borderRadius: 8 }}
          onClick={handleSave} disabled={saving || !dirty}>
          {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save schedules</>}
        </button>
        {savedTick && <span className="text-success small d-inline-flex align-items-center gap-1"><i className="bi bi-check-circle-fill" /> Saved</span>}
      </div>
    </div>
  );
}
