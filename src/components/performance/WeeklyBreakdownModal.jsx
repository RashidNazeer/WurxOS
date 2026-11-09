import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listApcMeetingsForMonth, listWeeklyRatingsForApcMonth,
  averageWeeklyMetrics, weeklyOverall,
  apcPerfPreview, apcPerfPending, listApcReportsForMonth,
} from '../../lib/weeklyRatingsApi';
import { getLevelTokens, V1_PILLARS } from '../../lib/performanceApi';
import { karachiYmd } from '../../lib/serverTime';
import WeeklyRatingFields from './WeeklyRatingFields';
import { PendingNotice } from './ApcPendingNotice';

// The weekly CHECKPOINT breakdown for one APC in one month: each meeting (week)
// with its score, expandable to the 4-slider rating for late / corrective entry.
// The month average here is the APC's checkpoint factor (0.6 of the performance
// pillar); the other 0.4 is the per-report external-report score (mig 304).
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

const pct = (n) => (n == null ? '—' : `${Math.round(Number(n))}/100`);

// `pillars` ({performance, incentives, attendance, flags}), `composite` and `weights`
// are the same numbers the card shows, so the modal can never disagree with it.
export default function WeeklyBreakdownModal({ apc, month, enabled, canWrite, initialMeetingId = null, pillars = null, composite = null, weights = null, onClose, onChanged }) {
  const apcId = apc?.id;
  const [meetings, setMeetings] = useState([]);
  const [ratings, setRatings] = useState([]);
  const [preview, setPreview] = useState(null);
  const [pending, setPending] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState(null);
  const today = karachiYmd();

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const [mtgs, rts, prev, pend, reps] = await Promise.all([
        listApcMeetingsForMonth(apcId, month),
        listWeeklyRatingsForApcMonth(apcId, month),
        apcPerfPreview(apcId, month).catch(() => null),
        apcPerfPending(apcId, month).catch(() => null),
        listApcReportsForMonth(apcId, month).catch(() => []),
      ]);
      setMeetings(mtgs); setRatings(rts); setPreview(prev); setPending(pend); setReports(reps);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, [apcId, month]);
  useEffect(() => { load(); }, [load]);

  const byMeeting = useMemo(() => {
    const map = {};
    for (const r of ratings) map[r.meeting_id] = r;
    return map;
  }, [ratings]);

  // One row per WEEK. An APC under 2+ TLs has a meeting (and a rating) per TL in the
  // same week; the week shows the average of them so it counts once (mig 429).
  const weeks = useMemo(() => {
    const map = new Map();
    for (const m of meetings) {
      if (!map.has(m.week_start)) map.set(m.week_start, { key: m.week_start, meetings: [] });
      map.get(m.week_start).meetings.push(m);
    }
    return [...map.values()].map((w) => {
      const rated = w.meetings.map((m) => byMeeting[m.id]).filter(Boolean);
      return { ...w, date: w.meetings[0].meeting_date, rated, avg: rated.length ? weeklyOverall(averageWeeklyMetrics(rated)) : null };
    });
  }, [meetings, byMeeting]);

  // Open the week holding the meeting we were deep-linked to.
  useEffect(() => {
    if (!initialMeetingId || !meetings.length) return;
    const m = meetings.find((x) => x.id === initialMeetingId);
    if (m) setOpenId(m.week_start);
  }, [initialMeetingId, meetings]);

  // Projected monthly score = average of the weekly averages (mirrors the SQL rollup).
  const projected = useMemo(() => {
    if (!ratings.length) return null;
    return weeklyOverall(averageWeeklyMetrics(ratings));
  }, [ratings]);
  const lvl = projected != null ? getLevelTokens(projected) : null;

  // Refresh only the ratings (not the whole meeting list) so autosaving a slider
  // doesn't remount the open editor behind the "Loading weeks…" spinner.
  const onSaved = useCallback(() => {
    listWeeklyRatingsForApcMonth(apcId, month).then(setRatings).catch(() => {});
    apcPerfPreview(apcId, month).then(setPreview).catch(() => {});
    apcPerfPending(apcId, month).then(setPending).catch(() => {});
    onChanged?.();
  }, [apcId, month, onChanged]);

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(2.6px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 560, maxHeight: '88vh', zIndex: 1, borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column' }}>
        <div className="d-flex align-items-center justify-content-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div>
            <div className="fw-bold" style={{ fontSize: '0.95rem' }}>Performance breakdown — {apc?.displayName || apc?.userName || 'APC'}</div>
            <div className="text-muted" style={{ fontSize: '0.72rem' }}>{month} · month score = average of the weeks</div>
          </div>
          <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.9rem', lineHeight: 1 }} onClick={onClose}>✕</button>
        </div>

        <div className="px-4 py-3" style={{ overflowY: 'auto', flexGrow: 1 }}>
          <PendingNotice pending={pending} month={month} />

          {pillars && (
            <div className="rounded-3 px-3 py-2 mb-3" style={{ background: 'var(--surface-2)' }}>
              <div className="d-flex align-items-center justify-content-between mb-1">
                <span className="text-muted" style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Overall score</span>
                <strong style={{ fontSize: '0.95rem' }}>{composite == null ? 'Not rated yet' : `${composite}/100`}</strong>
              </div>
              {V1_PILLARS.map((p) => (
                <div key={p.key} className="d-flex justify-content-between" style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                  <span>{p.label}{weights?.[p.key] != null ? ` · ${weights[p.key]}%` : ''}</span>
                  <strong>{pct(pillars[p.key])}</strong>
                </div>
              ))}
            </div>
          )}

          {preview && (
            <div className="rounded-3 px-3 py-2 mb-3" style={{ border: '1px solid var(--border-subtle)', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
              <div className="text-muted mb-1" style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Performance pillar = 0.6 × checkpoint + 0.4 × external report
              </div>
              <div className="d-flex justify-content-between"><span>Checkpoint · OL weekly ratings (60%)</span><strong>{pct(preview.checkpoint)}</strong></div>
              <div className="d-flex justify-content-between"><span>External report (40%) · {preview.n || 0} verified</span><strong>{pct(preview.report)}</strong></div>
              <div className="d-flex justify-content-between text-muted ps-2" style={{ fontSize: '0.7rem' }}>
                <span>· TL stars (60%){preview.starAvg == null ? '' : ` · ${Number(preview.starAvg).toFixed(1)}★ avg`}</span><span>{pct(preview.starScore)}</span>
              </div>
              <div className="d-flex justify-content-between text-muted ps-2" style={{ fontSize: '0.7rem' }}>
                <span>· Accountability (40%) · {preview.deductions || 0} returned</span><span>{pct(preview.accountability)}</span>
              </div>
              <div className="d-flex justify-content-between pt-1 mt-1" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
                <span className="fw-semibold">Performance pillar</span><strong>{pct(preview.blended)}</strong>
              </div>
            </div>
          )}

          {/* Projected monthly */}
          <div className="d-flex align-items-center justify-content-between rounded-3 px-3 py-2 mb-3" style={{ background: 'var(--surface-2)' }}>
            <div>
              <div className="text-muted" style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {enabled ? 'Monthly checkpoint (official)' : 'Monthly checkpoint (trial preview)'}
              </div>
              <div className="text-muted" style={{ fontSize: '0.68rem' }}>{weeks.filter((w) => w.rated.length).length} week{weeks.filter((w) => w.rated.length).length === 1 ? '' : 's'} rated · 0.6 of performance</div>
            </div>
            {projected != null ? (
              <span className="rounded-pill px-3 py-1" style={{ background: lvl.bg, color: lvl.color, fontSize: '1rem', fontWeight: 800 }}>{projected}/100</span>
            ) : (
              <span className="text-muted" style={{ fontSize: '0.8rem', fontWeight: 700 }}>Not rated yet</span>
            )}
          </div>

          {!enabled && (
            <div className="rounded-2 mb-3 px-2 py-1" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', fontSize: '0.68rem', color: 'var(--warning-text)' }}>
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
              {weeks.map((w) => {
                const rated = w.rated.length > 0;
                const multi = w.meetings.length > 1;
                const upcoming = w.date > today;
                const rlvl = rated ? getLevelTokens(w.avg) : null;
                const isOpen = openId === w.key;
                return (
                  <div key={w.key} className="rounded-3" style={{ border: '1px solid var(--border-subtle)' }}>
                    <button type="button" className="btn w-100 d-flex align-items-center justify-content-between px-3 py-2"
                      style={{ background: 'transparent', border: 'none' }}
                      onClick={() => setOpenId(isOpen ? null : w.key)}>
                      <span className="d-flex align-items-center gap-2">
                        <i className={`bi ${isOpen ? 'bi-chevron-down' : 'bi-chevron-right'}`} style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} />
                        <span className="fw-semibold" style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{fmtDate(w.date)}</span>
                        {upcoming && <span className="rounded-pill px-2" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: '0.6rem', fontWeight: 700 }}>Upcoming</span>}
                        {multi && <span className="text-muted" style={{ fontSize: '0.64rem' }}>average of {w.rated.length} of {w.meetings.length} Team Leads</span>}
                      </span>
                      {rated ? (
                        <span className="rounded-pill px-2 py-1" style={{ background: rlvl.bg, color: rlvl.color, fontSize: '0.72rem', fontWeight: 800 }}>{w.avg}/100</span>
                      ) : (
                        <span className="rounded-pill px-2 py-1" style={{ background: 'var(--danger-soft)', color: 'var(--danger-text)', fontSize: '0.64rem', fontWeight: 700 }}>Not rated</span>
                      )}
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3 d-flex flex-column gap-3">
                        {w.meetings.map((m) => {
                          const r = byMeeting[m.id];
                          const ov = r ? weeklyOverall(r.metrics) : null;
                          const mUpcoming = m.meeting_date > today;
                          return (
                            <div key={m.id}>
                              {multi && (
                                <div className="fw-semibold mb-1" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                                  {m.tl?.display_name ? `${m.tl.display_name}’s meeting` : 'Meeting'}{ov != null ? ` · ${ov}/100` : ' · not rated'}
                                </div>
                              )}
                              {mUpcoming ? (
                                <div className="text-muted small">This meeting hasn’t happened yet — you can rate it once the APC has presented.</div>
                              ) : canWrite ? (
                                <WeeklyRatingFields apcId={apcId} meetingId={m.id} enabled={enabled} onSaved={onSaved} />
                              ) : r ? (
                                <div className="text-muted small">Scored {ov}/100 by {r.rater?.display_name || 'the OL'}.</div>
                              ) : (
                                <div className="text-muted small">Not rated yet.</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {!loading && (
            <div className="mt-3">
              <div className="text-muted mb-1" style={{ fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Reports verified in {month} · TL stars
              </div>
              {reports.length === 0 ? (
                <div className="text-muted small">No reports verified this month yet.</div>
              ) : (
                <div className="d-flex flex-column gap-1">
                  {reports.map((r) => (
                    <div key={r.id} className="d-flex align-items-center justify-content-between rounded-2 px-2 py-1" style={{ border: '1px solid var(--border-subtle)', fontSize: '0.74rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        <span className="fw-semibold" style={{ color: 'var(--text-primary)' }}>{r.brand?.brand_name || 'Brand'}</span>
                        {' · '}{r.type}{r.period_label ? ` · ${r.period_label}` : ''}
                        {r.dock > 0 && <span className="ms-2" style={{ color: 'var(--danger-text)' }}>returned ×{r.dock}</span>}
                      </span>
                      {r.apc_stars != null ? (
                        <span style={{ color: 'var(--warning-text)', fontWeight: 700 }}>{Number(r.apc_stars).toFixed(1)} ★</span>
                      ) : (
                        <span className="rounded-pill px-2" style={{ background: 'var(--danger-soft)', color: 'var(--danger-text)', fontSize: '0.64rem', fontWeight: 700 }}>TL star missing</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="text-muted mt-1" style={{ fontSize: '0.64rem' }}>The TL gives the star when verifying the report.</div>
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
