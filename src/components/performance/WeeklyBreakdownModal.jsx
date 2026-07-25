import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listApcMeetingsForMonth, listWeeklyRatingsForApcMonth,
  averageWeeklyMetrics, weeklyOverall,
} from '../../lib/weeklyRatingsApi';
import { getLevelTokens } from '../../lib/performanceApi';
import { karachiYmd } from '../../lib/serverTime';
import WeeklyRatingFields from './WeeklyRatingFields';

// The weekly breakdown for one APC in one month: each meeting (week) with its
// score, expandable to the 5-slider rating for late / corrective entry. Also the
// place the Boss/OL sees the weekly scores that make up the monthly average.
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

export default function WeeklyBreakdownModal({ apc, month, enabled, canWrite, initialMeetingId = null, onClose, onChanged }) {
  const apcId = apc?.id;
  const [meetings, setMeetings] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState(initialMeetingId);
  const today = karachiYmd();

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [mtgs, rts] = await Promise.all([
        listApcMeetingsForMonth(apcId, month),
        listWeeklyRatingsForApcMonth(apcId, month),
      ]);
      setMeetings(mtgs); setRatings(rts);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, [apcId, month]);
  useEffect(() => { load(); }, [load]);

  const byMeeting = useMemo(() => {
    const map = {};
    for (const r of ratings) map[r.meeting_id] = r;
    return map;
  }, [ratings]);

  // Projected monthly score = average of the rated weeks (mirrors the SQL rollup).
  const projected = useMemo(() => {
    if (!ratings.length) return null;
    return weeklyOverall(averageWeeklyMetrics(ratings));
  }, [ratings]);
  const lvl = projected != null ? getLevelTokens(projected) : null;

  // Refresh only the ratings (not the whole meeting list) so autosaving a slider
  // doesn't remount the open editor behind the "Loading weeks…" spinner.
  const onSaved = useCallback(() => {
    listWeeklyRatingsForApcMonth(apcId, month).then(setRatings).catch(() => {});
    onChanged?.();
  }, [apcId, month, onChanged]);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 560, maxHeight: '88vh', zIndex: 1, borderRadius: 14, display: 'flex', flexDirection: 'column' }}>
        <div className="d-flex align-items-center justify-content-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <div className="fw-bold" style={{ fontSize: '0.95rem' }}>Weekly performance — {apc?.displayName || apc?.userName || 'APC'}</div>
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>{month} · month score = average of the weeks</div>
          </div>
          <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.9rem', lineHeight: 1 }} onClick={onClose}>✕</button>
        </div>

        <div className="px-4 py-3" style={{ overflowY: 'auto', flexGrow: 1 }}>
          {/* Projected monthly */}
          <div className="d-flex align-items-center justify-content-between rounded-3 px-3 py-2 mb-3" style={{ background: 'var(--surface-2)' }}>
            <div>
              <div className="text-muted" style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {enabled ? 'Monthly performance (official)' : 'Monthly performance (trial preview)'}
              </div>
              <div className="text-muted" style={{ fontSize: '0.68rem' }}>{ratings.length} week{ratings.length === 1 ? '' : 's'} rated</div>
            </div>
            {projected != null ? (
              <span className="rounded-pill px-3 py-1" style={{ background: lvl.bg, color: lvl.color, fontSize: '1rem', fontWeight: 800 }}>{projected}/100</span>
            ) : (
              <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 700 }}>Not rated yet</span>
            )}
          </div>

          {!enabled && (
            <div className="rounded-2 mb-3 px-2 py-1" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', fontSize: '0.68rem', color: 'var(--warning)' }}>
              <i className="bi bi-flask me-1" />Trial mode — scores here are a preview and don’t affect the official monthly score until the Boss switches this to Live.
            </div>
          )}

          {err && <div className="alert alert-danger py-2" style={{ fontSize: '0.78rem' }}>{err}</div>}

          {loading ? (
            <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading weeks…</div>
          ) : meetings.length === 0 ? (
            <div className="text-muted small py-3">No meetings this APC took part in for {month} yet.</div>
          ) : (
            <div className="d-flex flex-column gap-2">
              {meetings.map((m) => {
                const r = byMeeting[m.id];
                const rated = !!r;
                const upcoming = m.meeting_date > today;
                const ov = rated ? weeklyOverall(r.metrics) : null;
                const rlvl = ov != null ? getLevelTokens(ov) : null;
                const isOpen = openId === m.id;
                return (
                  <div key={m.id} className="rounded-3" style={{ border: '1px solid var(--border-subtle)' }}>
                    <button type="button" className="btn w-100 d-flex align-items-center justify-content-between px-3 py-2"
                      style={{ background: 'transparent', border: 'none' }}
                      onClick={() => setOpenId(isOpen ? null : m.id)}>
                      <span className="d-flex align-items-center gap-2">
                        <i className={`bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}`} style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} />
                        <span className="fw-semibold" style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{fmtDate(m.meeting_date)}</span>
                        {upcoming && <span className="rounded-pill px-2" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: '0.6rem', fontWeight: 700 }}>Upcoming</span>}
                      </span>
                      {rated ? (
                        <span className="rounded-pill px-2 py-1" style={{ background: rlvl.bg, color: rlvl.color, fontSize: '0.72rem', fontWeight: 800 }}>{ov}/100</span>
                      ) : (
                        <span className="rounded-pill px-2 py-1" style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.64rem', fontWeight: 700 }}>Not rated</span>
                      )}
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3">
                        {upcoming ? (
                          <div className="text-muted small">This meeting hasn’t happened yet — you can rate it once the APC has presented.</div>
                        ) : canWrite ? (
                          <WeeklyRatingFields apcId={apcId} meetingId={m.id} enabled={enabled} onSaved={onSaved} />
                        ) : rated ? (
                          <div className="text-muted small">Scored {ov}/100 by {r.rater?.display_name || 'the OL'}.</div>
                        ) : (
                          <div className="text-muted small">Not rated yet.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="d-flex justify-content-end px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
