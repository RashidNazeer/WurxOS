import React, { useEffect, useState } from 'react';
import {
  listAgendaTasks, listTaskReviews, saveTaskReview,
  updatePresentationReview, updateTlRemark,
} from '../../lib/agendaApi';
import { getWeeklyRatingsEnabled } from '../../lib/weeklyRatingsApi';
import WeeklyRatingFields from '../performance/WeeklyRatingFields';

// OL evaluation interface for the live meeting.
//   Left  — the presenting APC's tasks as compact cards; each opens a
//           Review Task modal (rating + notes).
//   Right — Team Lead remarks (always visible) above the presenting
//           APC's Overall Summary (swaps with the presenter).

const RATINGS = [
  ['excellent',         'Excellent',         'var(--success)'],
  ['well_explained',    'Well Explained',    'var(--info)'],
  ['satisfied',         'Satisfied',         'var(--accent)'],
  ['needs_improvement', 'Needs Improvement', 'var(--warning)'],
  ['incomplete',        'Incomplete',        'var(--danger)'],
];
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', completed: 'Completed' };
function ratingMeta(v) { return RATINGS.find((r) => r[0] === v) || null; }

function RatingPicker({ value, onPick }) {
  return (
    <div className="d-flex flex-wrap gap-1">
      {RATINGS.map(([v, label, color]) => {
        const active = value === v;
        return (
          <button key={v} type="button"
            onClick={() => onPick(active ? '' : v)}
            className="border-0 rounded-pill px-2 py-1"
            style={{
              fontSize: '0.66rem', fontWeight: 700,
              background: active ? color : `color-mix(in srgb, ${color} 14%, transparent)`,
              color: active ? 'var(--surface-1)' : color, cursor: 'pointer',
            }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Review-task modal ───────────────────────────────────────────────────
function TaskReviewModal({ task, review, onClose, onSave }) {
  const [rating, setRating] = useState(review?.rating || '');
  const [notes, setNotes]   = useState(review?.notes || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try { await onSave({ rating, notes }); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg"
        style={{ position: 'relative', width: '100%', maxWidth: 540, maxHeight: '85vh', zIndex: 1, borderRadius: 14, display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div className="d-flex align-items-center justify-content-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <span className="fw-semibold small d-flex align-items-center gap-2">
            <i className="bi bi-pencil-square text-primary" />Review task
          </span>
          <button className="btn btn-sm p-0 px-1" style={{ fontSize: '0.9rem', lineHeight: 1 }} onClick={onClose}>✕</button>
        </div>

        {/* scrollable body */}
        <div className="px-4 py-3" style={{ overflowY: 'auto', flexGrow: 1 }}>
          <div className="fw-semibold" style={{ fontSize: '0.92rem', color: 'var(--text-primary)' }}>{task.title}</div>
          {task.details && <p className="text-muted mb-2 mt-1" style={{ fontSize: '0.8rem' }}>{task.details}</p>}
          <div className="d-flex align-items-center gap-2 flex-wrap mb-3" style={{ fontSize: '0.7rem' }}>
            <span className="rounded-pill px-2" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontWeight: 700 }}>
              {STATUS_LABEL[task.status] || task.status}
            </span>
            {task.brand?.brand_name && (
              <span className="badge rounded-pill" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                <i className="bi bi-shop me-1" />{task.brand.brand_name}
              </span>
            )}
            {task.due_date && <span className="text-muted"><i className="bi bi-calendar3 me-1" />Due {task.due_date}</span>}
            {task.link && <a href={task.link} target="_blank" rel="noreferrer"><i className="bi bi-link-45deg" />Link</a>}
          </div>

          <div className="text-muted mb-1" style={{ fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Rating
          </div>
          <RatingPicker value={rating} onPick={setRating} />

          <div className="text-muted mb-1 mt-3" style={{ fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Remarks / notes
          </div>
          <textarea className="form-control form-control-sm" rows={4} style={{ borderRadius: 8, fontSize: '0.82rem' }}
            placeholder="Notes and comments for this task…"
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {/* footer */}
        <div className="d-flex gap-2 justify-content-end px-4 py-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving}>
            {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save review</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OngoingEvaluation({ meeting, activePresentation }) {
  const apcId   = activePresentation?.apc_id || null;
  const apcName = activePresentation?.apc?.display_name || 'APC';

  // Weekly performance-rating trial switch (shows a "trial preview" note when off).
  const [weeklyEnabled, setWeeklyEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getWeeklyRatingsEnabled().then((s) => { if (!cancelled) setWeeklyEnabled(!!s.enabled); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ── TL remarks — always visible, re-init only when the meeting changes.
  const [tlRating, setTlRating] = useState(meeting.tl_rating || '');
  const [tlRemark, setTlRemark] = useState(meeting.tl_remark || '');
  const [tlSaved, setTlSaved]   = useState(false);
  useEffect(() => {
    setTlRating(meeting.tl_rating || '');
    setTlRemark(meeting.tl_remark || '');
  }, [meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveTl(next) {
    try {
      await updateTlRemark(meeting.id, { rating: next.rating, remark: next.remark });
      setTlSaved(true); setTimeout(() => setTlSaved(false), 1800);
    } catch (e) { /* eslint-disable-next-line no-console */ console.warn(e); }
  }

  // ── Presenting APC: tasks + per-task reviews + overall summary.
  const [tasks, setTasks]     = useState([]);
  const [reviews, setReviews] = useState({});   // taskId -> { rating, notes }
  const [overall, setOverall] = useState({ rating: '', summary: '' });
  const [loading, setLoading] = useState(false);
  const [reviewTask, setReviewTask] = useState(null);   // task open in the modal

  useEffect(() => {
    if (!apcId) { setTasks([]); setReviews({}); return undefined; }
    let cancelled = false;
    setLoading(true);
    Promise.all([listAgendaTasks({ assigneeId: apcId }), listTaskReviews(meeting.id)])
      .then(([tk, rv]) => {
        if (cancelled) return;
        setTasks(tk || []);
        const map = {};
        (rv || []).forEach((r) => { map[r.task_id] = { rating: r.rating || '', notes: r.notes || '' }; });
        setReviews(map);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    setOverall({
      rating: activePresentation?.overall_rating || '',
      summary: activePresentation?.overall_summary || '',
    });
    return () => { cancelled = true; };
  }, [apcId, meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveReview(taskId, next) {
    setReviews((r) => ({ ...r, [taskId]: next }));
    await saveTaskReview(meeting.id, apcId, taskId, next);
    setReviewTask(null);
  }

  async function saveOverall(next) {
    if (!activePresentation) return;
    try { await updatePresentationReview(activePresentation.id, next); }
    catch (e) { /* eslint-disable-next-line no-console */ console.warn(e); }
  }

  return (
    <>
      <div className="row g-3">
        {/* ── Tasks column ─────────────────────────────────────── */}
        <div className="col-12 col-xl-8">
          {!activePresentation ? (
            <div className="d-flex flex-column align-items-center justify-content-center py-5"
              style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
              <div className="rounded-circle d-flex align-items-center justify-content-center mb-3"
                style={{ width: 60, height: 60, background: 'var(--surface-2)' }}>
                <i className="bi bi-easel text-muted" style={{ fontSize: '1.5rem', opacity: 0.4 }} />
              </div>
              <p className="fw-semibold text-dark mb-1">Waiting for an APC to present</p>
              <p className="text-muted small mb-0">The review panel opens as soon as someone starts presenting.</p>
            </div>
          ) : (
            <>
              <div className="d-flex align-items-center gap-2 mb-3">
                <span className="rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
                  style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.62rem', fontWeight: 800 }}>
                  <span className="rounded-circle" style={{ width: 6, height: 6, background: 'var(--danger)', display: 'inline-block' }} />
                  REVIEWING
                </span>
                <span className="fw-bold" style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>{apcName}</span>
                <span className="text-muted" style={{ fontSize: '0.74rem' }}>· {tasks.length} agenda task{tasks.length === 1 ? '' : 's'}</span>
              </div>

              {loading ? (
                <div className="text-muted small py-3"><span className="spinner-border spinner-border-sm me-2" />Loading tasks…</div>
              ) : tasks.length === 0 ? (
                <div className="text-muted small py-3" style={{ fontSize: '0.8rem' }}>
                  This APC has no agenda tasks to review.
                </div>
              ) : (
                <div className="d-flex flex-column gap-2">
                  {tasks.map((t) => {
                    const rv = reviews[t.id] || { rating: '', notes: '' };
                    const rm = ratingMeta(rv.rating);
                    return (
                      <div key={t.id} className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
                        <div className="card-body p-3">
                          <div className="d-flex align-items-start justify-content-between gap-2">
                            <div className="min-w-0">
                              <div className="fw-semibold text-truncate" style={{ fontSize: '0.86rem', color: 'var(--text-primary)' }}>{t.title}</div>
                              <div className="d-flex align-items-center gap-2 flex-wrap mt-1" style={{ fontSize: '0.68rem' }}>
                                <span className="rounded-pill px-2" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontWeight: 700 }}>
                                  {STATUS_LABEL[t.status] || t.status}
                                </span>
                                {t.brand?.brand_name && (
                                  <span className="badge rounded-pill" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                                    <i className="bi bi-shop me-1" />{t.brand.brand_name}
                                  </span>
                                )}
                                {t.due_date && <span className="text-muted"><i className="bi bi-calendar3 me-1" />Due {t.due_date}</span>}
                                {t.link && <a href={t.link} target="_blank" rel="noreferrer"><i className="bi bi-link-45deg" />Link</a>}
                              </div>
                            </div>
                            <button className="btn btn-sm d-inline-flex align-items-center gap-1 flex-shrink-0"
                              style={{
                                borderRadius: 8, fontSize: '0.7rem', fontWeight: 600,
                                background: rm ? 'var(--accent-soft)' : 'var(--accent)',
                                color: rm ? 'var(--accent)' : 'var(--on-accent)',
                                border: rm ? '1px solid color-mix(in srgb, var(--accent) 28%, transparent)' : 'none',
                              }}
                              onClick={() => setReviewTask(t)}>
                              <i className={`bi ${rm ? 'bi-pencil' : 'bi-chat-left-text'}`} />
                              {rm ? 'Edit review' : 'Review Task'}
                            </button>
                          </div>
                          {(rm || rv.notes) && (
                            <div className="d-flex align-items-center gap-2 flex-wrap mt-2 pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
                              {rm && (
                                <span className="rounded-pill px-2 py-1" style={{ background: rm[2], color: 'var(--surface-1)', fontSize: '0.62rem', fontWeight: 700 }}>
                                  {rm[1]}
                                </span>
                              )}
                              {rv.notes && (
                                <span className="text-muted text-truncate" style={{ fontSize: '0.72rem', flex: 1, minWidth: 0 }}>{rv.notes}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right column — TL remarks then APC overall summary ── */}
        <div className="col-12 col-xl-4">
          <div className="d-flex flex-column gap-3">
            {/* Team Lead remarks — permanent */}
            <div className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: '4px solid var(--success)' }}>
              <div className="card-body p-3">
                <div className="fw-semibold mb-1 d-flex align-items-center gap-2" style={{ fontSize: '0.84rem' }}>
                  <i className="bi bi-person-badge text-success" />
                  Team Lead remarks
                </div>
                <p className="text-muted mb-2" style={{ fontSize: '0.72rem' }}>
                  For {meeting.tl?.display_name || 'the Team Lead'} — editable any time during the meeting.
                </p>
                <div className="rounded-2 mb-2 px-2 py-1" style={{ background: 'var(--surface-2)', fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                  <i className="bi bi-info-circle me-1" />The TL's reporting star is now rated per report, when you <strong>approve</strong> it on the Reports page — not here.
                </div>
                <RatingPicker value={tlRating}
                  onPick={(v) => { setTlRating(v); saveTl({ rating: v, remark: tlRemark }); }} />
                <textarea className="form-control form-control-sm mt-2" rows={4} style={{ borderRadius: 8, fontSize: '0.8rem' }}
                  placeholder="Remarks on team management, coordination, presentation flow…"
                  value={tlRemark}
                  onChange={(e) => setTlRemark(e.target.value)}
                  onBlur={() => saveTl({ rating: tlRating, remark: tlRemark })} />
                {tlSaved && (
                  <div className="text-success mt-1" style={{ fontSize: '0.68rem' }}>
                    <i className="bi bi-check-circle-fill me-1" />Saved
                  </div>
                )}
              </div>
            </div>

            {/* APC overall summary — swaps with the presenter */}
            {activePresentation && (
              <div className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: '4px solid var(--accent)' }}>
                <div className="card-body p-3">
                  <div className="fw-semibold mb-1 d-flex align-items-center gap-2" style={{ fontSize: '0.84rem' }}>
                    <i className="bi bi-clipboard-check text-primary" />
                    Overall summary
                  </div>
                  <p className="text-muted mb-2" style={{ fontSize: '0.72rem' }}>
                    For {apcName}’s presentation.
                  </p>
                  <RatingPicker value={overall.rating}
                    onPick={(v) => { const n = { ...overall, rating: v }; setOverall(n); saveOverall(n); }} />
                  <textarea className="form-control form-control-sm mt-2" rows={4} style={{ borderRadius: 8, fontSize: '0.8rem' }}
                    placeholder="Overall performance notes for this APC's presentation…"
                    value={overall.summary}
                    onChange={(e) => setOverall((o) => ({ ...o, summary: e.target.value }))}
                    onBlur={() => saveOverall(overall)} />
                </div>
              </div>
            )}

            {/* Weekly performance rating — the 5 metrics scored per week for this APC */}
            {activePresentation && apcId && (
              <div className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: '4px solid var(--info, #0d6efd)' }}>
                <div className="card-body p-3">
                  <div className="fw-semibold mb-1 d-flex align-items-center gap-2" style={{ fontSize: '0.84rem' }}>
                    <i className="bi bi-bar-chart-fill" style={{ color: 'var(--info, #0d6efd)' }} />
                    Weekly performance rating
                  </div>
                  <p className="text-muted mb-2" style={{ fontSize: '0.72rem' }}>
                    Score {apcName} for this week. The month’s performance is the average of these weekly scores.
                  </p>
                  <WeeklyRatingFields apcId={apcId} meetingId={meeting.id} enabled={weeklyEnabled} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {reviewTask && (
        <TaskReviewModal
          task={reviewTask}
          review={reviews[reviewTask.id]}
          onClose={() => setReviewTask(null)}
          onSave={(next) => saveReview(reviewTask.id, next)}
        />
      )}
    </>
  );
}
