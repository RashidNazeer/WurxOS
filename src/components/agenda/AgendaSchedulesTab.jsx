import React, { useEffect, useMemo, useState } from 'react';
import {
  listAgendaTeams, getAgendaTeamSchedules,
  upsertAgendaTeamSchedule, deleteAgendaTeamSchedule,
  listAgendaMeetings, resyncWeek, listAgendaGuestMembers,
} from '../../lib/agendaApi';

// Schedules settings — OL sets each team's recurring meeting day + time, and
// which guest teams (Paid Collab / Paid Media) sit in on that team's meeting.
// A team left "Not scheduled" is skipped when notifying teams.

const DAYS = [
  ['', 'Not scheduled'],
  ['monday', 'Monday'], ['tuesday', 'Tuesday'], ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
  ['sunday', 'Sunday'],
];
const DAY_LABEL = Object.fromEntries(DAYS);

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function currentWeekMonday() {
  const x = new Date(); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return ymd(x);
}
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

export default function AgendaSchedulesTab() {
  const [teams, setTeams]       = useState([]);
  const [guestTeams, setGuestTeams] = useState([]);   // [{ slug, label, roleMembers, explicitMembers }]
  const [draft, setDraft]       = useState({});      // tlId -> { day, time, link, guests[] }
  const [original, setOriginal] = useState({});
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [savedTick, setSavedTick] = useState(false);
  const [askApply, setAskApply] = useState(false);   // confirm modal open

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAgendaTeams(), getAgendaTeamSchedules(), listAgendaGuestMembers()])
      .then(([tm, sched, gt]) => {
        if (cancelled) return;
        setTeams(tm || []);
        setGuestTeams(gt || []);
        const map = {};
        (sched || []).forEach((s) => {
          map[s.tl_id] = {
            day: s.meeting_day,
            time: (s.meeting_time || '').slice(0, 5),
            link: s.meet_link || '',
            guests: s.guest_teams || [],
          };
        });
        const init = {};
        (tm || []).forEach(({ tl }) => {
          init[tl.id] = map[tl.id] || { day: '', time: '15:00', link: '', guests: [] };
        });
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
  function toggleGuest(tlId, slug) {
    setDraft((d) => {
      const cur = d[tlId]?.guests || [];
      const next = cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug];
      return { ...d, [tlId]: { ...d[tlId], guests: next } };
    });
  }

  // Anyone who is a guest-team member and leads no APCs of their own doesn't
  // HOST a meeting — they attend other teams'. Abdul Subhan is a TL only
  // because Paid Media isn't a role yet; scheduling him would just recreate
  // the empty meeting mig 249 deleted.
  const guestHostIds = useMemo(() => {
    const ids = new Set();
    guestTeams.forEach((g) => {
      [...(g.roleMembers || []), ...(g.explicitMembers || [])].forEach((p) => ids.add(p.id));
    });
    return ids;
  }, [guestTeams]);

  const changedTeamIds = useMemo(() => {
    return teams
      .map(({ tl }) => tl.id)
      .filter((id) => JSON.stringify(draft[id]) !== JSON.stringify(original[id]));
  }, [teams, draft, original]);

  const dirty = changedTeamIds.length > 0;

  // Two teams meeting at the same day+time can't both host the same guests —
  // the guests would have to be in two rooms at once. Warn; don't block. The
  // OL may well be staggering people deliberately, and they know their org.
  const clashes = useMemo(() => {
    const out = [];
    guestTeams.forEach((g) => {
      const slots = new Map();   // "day|time" -> [tlName]
      teams.forEach(({ tl }) => {
        const d = draft[tl.id];
        if (!d?.day || !(d.guests || []).includes(g.slug)) return;
        const key = `${d.day}|${d.time}`;
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(tl.display_name || tl.email);
      });
      slots.forEach((names, key) => {
        if (names.length > 1) {
          const [day, time] = key.split('|');
          out.push({ label: g.label, day, time, names });
        }
      });
    });
    return out;
  }, [teams, draft, guestTeams]);

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
          await upsertAgendaTeamSchedule(tlId, cur.day, cur.time || '15:00', cur.link || '', cur.guests || []);
        } else if (was.day) {
          await deleteAgendaTeamSchedule(tlId);
        }
      }
      if (applyToCurrentWeek) {
        // Only the teams actually edited — resyncing all of them would revert
        // a per-week guest override the OL set on some other team.
        await resyncWeek(currentWeekMonday(), changedTeamIds);
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
        Set each team’s recurring agenda-meeting slot, its own permanent Google Meet link, and which guest
        teams sit in on it. Teams left “Not scheduled” are skipped when you notify teams.
      </p>
      {error && <div className="alert alert-danger py-2 small">{error}</div>}

      {clashes.length > 0 && (
        <div className="rounded-3 p-3 mb-3"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}>
          <div className="fw-semibold d-flex align-items-center gap-2 mb-1" style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>
            <i className="bi bi-exclamation-triangle-fill text-warning" />
            Guests are double-booked
          </div>
          {clashes.map((c, i) => (
            <div key={i} style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
              <strong>{c.label}</strong> is in {c.names.join(' and ')} — both {DAY_LABEL[c.day]} at {fmtTime(c.time)}.
              They can only attend one.
            </div>
          ))}
        </div>
      )}

      {teams.length === 0 ? (
        <div className="text-muted small py-3">No team leads found.</div>
      ) : (
        <div className="d-flex flex-column gap-2">
          {teams.map(({ tl, apcs }) => {
            const d = draft[tl.id] || { day: '', time: '15:00', link: '', guests: [] };
            // A guest-team member with no APCs attends meetings, doesn't host one.
            const isGuestHost = guestHostIds.has(tl.id) && apcs.length === 0;
            return (
              <div key={tl.id} className="card border-0 shadow-sm" style={{ borderRadius: 10, opacity: isGuestHost ? 0.7 : 1 }}>
                <div className="card-body p-3 d-flex align-items-center gap-3 flex-wrap">
                  <div className="flex-grow-1 min-w-0" style={{ minWidth: 180 }}>
                    <div className="fw-semibold d-flex align-items-center gap-2" style={{ fontSize: '0.86rem' }}>
                      {tl.display_name || tl.email}
                      {isGuestHost && (
                        <span className="rounded-pill px-2" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: '0.58rem', fontWeight: 800 }}>
                          GUEST
                        </span>
                      )}
                    </div>
                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                      {isGuestHost
                        ? 'Attends other teams’ meetings — no team of their own to host'
                        : <><i className="bi bi-people me-1" />{apcs.length} APC{apcs.length === 1 ? '' : 's'}</>}
                    </div>
                  </div>

                  {isGuestHost ? (
                    <div className="text-muted" style={{ fontSize: '0.72rem' }}>
                      <i className="bi bi-info-circle me-1" />
                      Tick them into a team’s meeting below.
                    </div>
                  ) : (
                    <>
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

                      {/* Guest teams sitting in on this team's meeting */}
                      <div className="d-flex align-items-center gap-3 flex-wrap pt-2"
                        style={{ flexBasis: '100%', borderTop: '1px dashed var(--border-subtle)' }}>
                        <span className="text-muted d-inline-flex align-items-center gap-1" style={{ fontSize: '0.72rem', fontWeight: 600 }}>
                          <i className="bi bi-person-plus" />Guests
                        </span>
                        {guestTeams.map((g) => {
                          const count = (g.roleMembers?.length || 0) + (g.explicitMembers?.length || 0);
                          const on = (d.guests || []).includes(g.slug);
                          return (
                            <label key={g.slug}
                              className="d-inline-flex align-items-center gap-2 rounded-2 px-2 py-1"
                              style={{
                                cursor: d.day ? 'pointer' : 'not-allowed',
                                background: on ? 'var(--accent-soft)' : 'var(--surface-2)',
                                border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--border-subtle)'}`,
                                opacity: d.day ? 1 : 0.55,
                              }}>
                              <input type="checkbox" className="form-check-input mt-0"
                                style={{ cursor: d.day ? 'pointer' : 'not-allowed' }}
                                checked={on} disabled={!d.day}
                                onChange={() => toggleGuest(tl.id, g.slug)} />
                              <span style={{ fontSize: '0.76rem', fontWeight: 600, color: on ? 'var(--accent)' : 'var(--text-secondary)' }}>
                                {g.label}
                              </span>
                              <span className="text-muted" style={{ fontSize: '0.66rem' }}>
                                {count} {count === 1 ? 'person' : 'people'}
                              </span>
                            </label>
                          );
                        })}
                        {!d.day && (
                          <span className="text-muted" style={{ fontSize: '0.68rem' }}>Pick a meeting day first.</span>
                        )}
                      </div>
                    </>
                  )}
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
                    This week’s meetings have already been scheduled. Should the new day, time and guests apply to
                    them as well, or only to upcoming weeks?
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
