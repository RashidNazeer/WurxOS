import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listMeetingAttendance, listPresentations, listTaskReviews, listAgendaTeams,
} from '../../lib/agendaApi';

// Prior Meetings — a single completed meeting's record. Role-based:
//   APC → their own evaluation only
//   TL  → their team's attendance + every APC's evaluation + TL remarks
//   OL  → everything + a presentation timeline

const RATING_META = {
  excellent:         { label: 'Excellent',         color: '#198754' },
  well_explained:    { label: 'Well Explained',    color: '#0d6efd' },
  satisfied:         { label: 'Satisfied',         color: '#16a34a' },
  needs_improvement: { label: 'Needs Improvement', color: '#fd7e14' },
  incomplete:        { label: 'Incomplete',        color: '#dc3545' },
};
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', completed: 'Completed' };

function RatingChip({ value }) {
  const m = RATING_META[value];
  if (!m) return <span className="text-muted" style={{ fontSize: '0.7rem' }}>No rating</span>;
  return (
    <span className="rounded-pill px-2 py-1" style={{ background: m.color, color: '#fff', fontSize: '0.62rem', fontWeight: 700 }}>
      {m.label}
    </span>
  );
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':');
  let hh = Number(h); const ap = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}
function fmtClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function AgendaPriorDetail({ meeting, weekIndex, onBack }) {
  const { user, profile } = useAuth();
  const role = profile?.role || '';
  const isOL  = role === 'ol' || role === 'boss' || role === 'developer';
  const isApc = role === 'apc';
  const uid = user?.id;

  const [attendance, setAttendance]   = useState([]);
  const [presentations, setPresentations] = useState([]);
  const [reviews, setReviews]         = useState([]);
  const [team, setTeam]               = useState(null);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listMeetingAttendance(meeting.id),
      listPresentations(meeting.id),
      listTaskReviews(meeting.id),
      listAgendaTeams(),
    ])
      .then(([att, pres, rev, teams]) => {
        if (cancelled) return;
        setAttendance(att || []);
        setPresentations(pres || []);
        setReviews(rev || []);
        setTeam((teams || []).find((t) => t.tl.id === meeting.tl_id) || null);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [meeting.id, meeting.tl_id]);

  const attByApc  = useMemo(() => {
    const m = {}; attendance.forEach((a) => { m[a.apc_id] = a; }); return m;
  }, [attendance]);
  const presByApc = useMemo(() => {
    const m = {}; presentations.forEach((p) => { m[p.apc_id] = p; }); return m;
  }, [presentations]);
  const reviewsByApc = useMemo(() => {
    const m = {}; reviews.forEach((r) => { (m[r.apc_id] = m[r.apc_id] || []).push(r); }); return m;
  }, [reviews]);

  // Presentation order — by start time.
  const orderByApc = useMemo(() => {
    const m = {};
    [...presentations]
      .filter((p) => p.started_at)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .forEach((p, i) => { m[p.apc_id] = i + 1; });
    return m;
  }, [presentations]);

  // APC roster — team APCs, plus anyone with data, scoped to self for APCs.
  const roster = useMemo(() => {
    const m = new Map();
    (team?.apcs || []).forEach((a) => m.set(a.id, { id: a.id, display_name: a.display_name }));
    presentations.forEach((p) => { if (p.apc && !m.has(p.apc_id)) m.set(p.apc_id, p.apc); });
    attendance.forEach((a) => { if (a.apc && !m.has(a.apc_id)) m.set(a.apc_id, a.apc); });
    let list = Array.from(m.values());
    if (isApc) list = list.filter((a) => a.id === uid);
    return list.sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  }, [team, presentations, attendance, isApc, uid]);

  const presentCount = attendance.filter((a) => a.status === 'present').length;
  const absentCount  = attendance.filter((a) => a.status === 'absent').length;
  const teamName = team?.tl?.display_name || meeting.tl?.display_name || 'Team';
  const duration = (meeting.started_at && meeting.finished_at)
    ? Math.max(1, Math.round((new Date(meeting.finished_at) - new Date(meeting.started_at)) / 60000))
    : null;

  return (
    <div>
      <button className="btn btn-sm btn-outline-secondary mb-3 d-inline-flex align-items-center gap-1"
        style={{ borderRadius: 8 }} onClick={onBack}>
        <i className="bi bi-arrow-left" /> Back to Prior Meetings
      </button>

      {/* Meeting info */}
      <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 14 }}>
        <div className="card-body p-3">
          <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
            <h5 className="fw-bold mb-0" style={{ color: '#1a1a2e' }}>{teamName} — Agenda Meeting</h5>
            <span className="rounded-pill px-2 py-1" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.62rem', fontWeight: 800 }}>
              <i className="bi bi-check-circle-fill me-1" />Completed
            </span>
          </div>
          <div className="row g-2" style={{ fontSize: '0.78rem' }}>
            <Info icon="bi-calendar-event" label="Date" value={fmtDate(meeting.meeting_date)} />
            <Info icon="bi-clock" label="Scheduled time" value={fmtTime(meeting.meeting_time)} />
            <Info icon="bi-calendar3-week" label="Week" value={weekIndex ? `Week ${weekIndex}` : '—'} />
            <Info icon="bi-hourglass" label="Duration"
              value={duration ? `${duration} min (${fmtClock(meeting.started_at)} – ${fmtClock(meeting.finished_at)})` : '—'} />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-muted small py-4"><span className="spinner-border spinner-border-sm me-2" />Loading record…</div>
      ) : (
        <>
          {/* Attendance — OL / TL */}
          {!isApc && (
            <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
              <div className="card-body p-3">
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <span className="fw-semibold small d-flex align-items-center gap-2"><i className="bi bi-people-fill text-primary" />Attendance</span>
                  <span className="text-muted" style={{ fontSize: '0.72rem' }}>{presentCount} present · {absentCount} absent</span>
                </div>
                <div className="d-flex flex-wrap gap-2">
                  {roster.map((a) => {
                    const st = attByApc[a.id]?.status;
                    const bg = st === 'present' ? '#e6f4ea' : st === 'absent' ? '#fff0f0' : '#f8fafc';
                    const bd = st === 'present' ? '#b7dfc4' : st === 'absent' ? '#f5c0c0' : '#e2e8f0';
                    const col = st === 'present' ? '#198754' : st === 'absent' ? '#dc3545' : '#94a3b8';
                    return (
                      <div key={a.id} className="rounded-2 px-2 py-1 d-flex align-items-center gap-2"
                        style={{ background: bg, border: `1px solid ${bd}` }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#1a1a2e' }}>{a.display_name}</span>
                        <span style={{ fontSize: '0.62rem', fontWeight: 700, color: col }}>
                          {st === 'present' ? 'Present' : st === 'absent' ? 'Absent' : 'Not marked'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Evaluations */}
          <div className="fw-semibold small mb-2 d-flex align-items-center gap-2">
            <i className="bi bi-clipboard-data text-primary" />
            {isApc ? 'Your evaluation' : 'APC evaluations'}
          </div>
          {roster.length === 0 ? (
            <div className="text-muted small mb-3" style={{ fontSize: '0.8rem' }}>No APC records for this meeting.</div>
          ) : (
            <div className="d-flex flex-column gap-2 mb-3">
              {roster.map((a) => (
                <ApcRecord key={a.id} apc={a}
                  presentation={presByApc[a.id]}
                  reviews={reviewsByApc[a.id] || []}
                  attStatus={attByApc[a.id]?.status}
                  order={orderByApc[a.id]}
                  defaultOpen={isApc || roster.length === 1}
                  collapsible={!isApc && roster.length > 1} />
              ))}
            </div>
          )}

          {/* TL remarks — OL / TL */}
          {!isApc && (
            <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12, borderLeft: '4px solid #16a34a' }}>
              <div className="card-body p-3">
                <div className="fw-semibold small mb-2 d-flex align-items-center gap-2">
                  <i className="bi bi-person-badge text-success" />Team Lead remarks — {teamName}
                </div>
                {meeting.tl_rating || meeting.tl_remark ? (
                  <>
                    {meeting.tl_rating && <RatingChip value={meeting.tl_rating} />}
                    {meeting.tl_remark && <p className="mb-0 mt-2" style={{ fontSize: '0.82rem', color: '#1a1a2e' }}>{meeting.tl_remark}</p>}
                  </>
                ) : (
                  <span className="text-muted" style={{ fontSize: '0.78rem' }}>No remarks recorded for the Team Lead.</span>
                )}
              </div>
            </div>
          )}

          {/* Presentation timeline — OL */}
          {isOL && presentations.some((p) => p.started_at) && (
            <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
              <div className="card-body p-3">
                <div className="fw-semibold small mb-2 d-flex align-items-center gap-2">
                  <i className="bi bi-list-ol text-primary" />Presentation timeline
                </div>
                <div className="d-flex flex-column gap-1">
                  {[...presentations].filter((p) => p.started_at)
                    .sort((a, b) => a.started_at.localeCompare(b.started_at))
                    .map((p, i) => (
                      <div key={p.id} className="d-flex align-items-center gap-2" style={{ fontSize: '0.78rem' }}>
                        <span className="rounded-circle d-inline-flex align-items-center justify-content-center"
                          style={{ width: 20, height: 20, background: '#eef2ff', color: '#4f46e5', fontSize: '0.62rem', fontWeight: 800 }}>{i + 1}</span>
                        <span className="fw-semibold">{p.apc?.display_name || 'APC'}</span>
                        <span className="text-muted">{fmtClock(p.started_at)} – {fmtClock(p.ended_at)}</span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Info({ icon, label, value }) {
  return (
    <div className="col-6 col-md-3">
      <div className="text-muted" style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        <i className={`bi ${icon} me-1`} />{label}
      </div>
      <div style={{ color: '#1a1a2e' }}>{value}</div>
    </div>
  );
}

// ── Per-APC record ──────────────────────────────────────────────────────
function ApcRecord({ apc, presentation, reviews, attStatus, order, defaultOpen, collapsible }) {
  const [open, setOpen] = useState(defaultOpen);
  const presented = presentation?.status === 'done' || presentation?.status === 'presenting';

  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
      <button type="button"
        onClick={() => collapsible && setOpen((o) => !o)}
        className="card-body p-3 border-0 w-100 text-start d-flex align-items-center gap-2"
        style={{ background: 'transparent', cursor: collapsible ? 'pointer' : 'default' }}>
        {collapsible && <i className={`bi bi-chevron-${open ? 'down' : 'right'} text-muted`} style={{ fontSize: '0.72rem' }} />}
        <span className="fw-semibold" style={{ fontSize: '0.88rem', color: '#1a1a2e' }}>{apc.display_name}</span>
        <span className="rounded-pill px-2" style={{
          background: presented ? '#e6f4ea' : '#f1f5f9', color: presented ? '#198754' : '#64748b',
          fontSize: '0.6rem', fontWeight: 700,
        }}>
          {presented ? `Presented${order ? ` · #${order}` : ''}` : 'Did not present'}
        </span>
        {attStatus && (
          <span className="rounded-pill px-2" style={{
            background: attStatus === 'present' ? '#e6f4ea' : '#fff0f0',
            color: attStatus === 'present' ? '#198754' : '#dc3545', fontSize: '0.6rem', fontWeight: 700,
          }}>
            {attStatus === 'present' ? 'Present' : 'Absent'}
          </span>
        )}
        <span className="ms-auto" />
        {presentation?.overall_rating && <RatingChip value={presentation.overall_rating} />}
      </button>

      {open && (
        <div className="px-3 pb-3">
          {/* Overall summary */}
          <div className="rounded-2 p-2 mb-2" style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
            <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Overall summary
            </div>
            {presentation?.overall_rating || presentation?.overall_summary ? (
              <>
                {presentation.overall_rating && <RatingChip value={presentation.overall_rating} />}
                {presentation.overall_summary && (
                  <p className="mb-0 mt-1" style={{ fontSize: '0.8rem', color: '#1a1a2e' }}>{presentation.overall_summary}</p>
                )}
                {(presentation.reviewer?.display_name || presentation.updated_at) && (
                  <div className="text-muted mt-1" style={{ fontSize: '0.66rem' }}>
                    {presentation.reviewer?.display_name ? `By ${presentation.reviewer.display_name}` : ''}
                    {presentation.updated_at ? ` · ${fmtStamp(presentation.updated_at)}` : ''}
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted" style={{ fontSize: '0.76rem' }}>No overall summary recorded.</span>
            )}
          </div>

          {/* Task reviews */}
          <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Task reviews ({reviews.length})
          </div>
          {reviews.length === 0 ? (
            <span className="text-muted" style={{ fontSize: '0.76rem' }}>No task reviews recorded.</span>
          ) : (
            <div className="d-flex flex-column gap-2">
              {reviews.map((r) => (
                <div key={r.id} className="rounded-2 p-2" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
                  <div className="d-flex align-items-start justify-content-between gap-2">
                    <div className="min-w-0">
                      <div className="fw-semibold" style={{ fontSize: '0.82rem', color: '#1a1a2e' }}>{r.task?.title || 'Task'}</div>
                      <div className="d-flex align-items-center gap-2 flex-wrap mt-1" style={{ fontSize: '0.68rem' }}>
                        {r.task?.status && (
                          <span className="rounded-pill px-2" style={{ background: '#f1f5f9', color: '#475569', fontWeight: 700 }}>
                            {STATUS_LABEL[r.task.status] || r.task.status}
                          </span>
                        )}
                        {r.task?.brand?.brand_name && (
                          <span className="badge rounded-pill" style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                            <i className="bi bi-shop me-1" />{r.task.brand.brand_name}
                          </span>
                        )}
                        {r.task?.due_date && <span className="text-muted"><i className="bi bi-calendar3 me-1" />Due {r.task.due_date}</span>}
                        {r.task?.link && <a href={r.task.link} target="_blank" rel="noreferrer"><i className="bi bi-link-45deg" />Link</a>}
                      </div>
                    </div>
                    {r.rating && <div className="flex-shrink-0"><RatingChip value={r.rating} /></div>}
                  </div>
                  {r.notes && (
                    <p className="mb-0 mt-2 pt-2" style={{ fontSize: '0.78rem', color: '#475569', borderTop: '1px dashed #e2e8f0' }}>{r.notes}</p>
                  )}
                  {(r.reviewer?.display_name || r.updated_at) && (
                    <div className="text-muted mt-1" style={{ fontSize: '0.64rem' }}>
                      {r.reviewer?.display_name ? `By ${r.reviewer.display_name}` : ''}
                      {r.updated_at ? ` · ${fmtStamp(r.updated_at)}` : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
