import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listDevTasks, getDevTask, createDevTask, updateDevTask, setDevTaskStatus,
  forceCompleteDevTask, confirmRequested, deleteDevTask,
  createSubtask, setSubtaskStatus, updateSubtask, deleteSubtask,
  listSubtasks, addNote, listRequesters,
  STATUS_META, PRIORITY_META, DEV_PRIORITIES, BOARD_COLUMNS, sortTasks, nextUp,
} from '../../lib/devTasksApi';

// Developer task management. Two levels: a task (the "pipeline") holding
// subtasks shown as a board. See mig 328 for the model and why the statuses
// are what they are.

const todayKarachi = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }))
  .toISOString().slice(0, 10);

function fmtDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day))
    .toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
}
function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

function Chip({ tone, children, title, solid }) {
  return (
    <span title={title} style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.2, padding: '2.5px 8px',
      borderRadius: 999, whiteSpace: 'nowrap',
      background: solid ? tone : `color-mix(in srgb, ${tone} 14%, transparent)`,
      color: solid ? '#fff' : tone,
      border: `1px solid color-mix(in srgb, ${tone} 30%, transparent)`,
    }}>{children}</span>
  );
}

function StatusChip({ status }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return <Chip tone={m.tone}><i className={`bi ${m.icon}`} style={{ marginRight: 4 }} />{m.label}</Chip>;
}
function PriorityChip({ priority }) {
  const m = PRIORITY_META[priority] || PRIORITY_META.medium;
  return <Chip tone={m.tone} solid={priority === 'urgent'}>{m.label}</Chip>;
}

function Progress({ pct, done, counted }) {
  const has = pct != null;
  return (
    <div>
      <div style={{
        height: 6, borderRadius: 999, background: 'var(--surface-2)',
        overflow: 'hidden', border: '1px solid var(--border-subtle)',
      }}>
        <div style={{
          width: `${has ? pct : 0}%`, height: '100%',
          background: pct === 100 ? 'var(--success)' : 'var(--primary)',
          transition: 'width .3s ease',
        }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
        {has ? <>{done}/{counted} subtasks · {pct}%</> : 'No subtasks'}
      </div>
    </div>
  );
}

// ── Create / edit task ──────────────────────────────────────────────
function TaskModal({ task, requesters, me, onClose, onSaved }) {
  const editing = !!task;
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [dueDate, setDueDate] = useState(task?.due_date || '');
  const [requestedBy, setRequestedBy] = useState(task?.requested_by || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (!title.trim()) { setErr('A title is required.'); return; }
    setBusy(true); setErr('');
    try {
      if (editing) {
        await updateDevTask(task.id, {
          title: title.trim(), description: description || null, priority,
          due_date: dueDate || null, requested_by: requestedBy || null,
        });
      } else {
        await createDevTask({ title, description, priority, dueDate, requestedBy });
      }
      onSaved();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">{editing ? 'Edit task' : 'New development task'}</div>
          <button className="wx-btn wx-btn-ghost" onClick={onClose}><i className="bi bi-x-lg" /></button>
        </div>
        <div className="wx-modal-body" style={{ display: 'grid', gap: 12 }}>
          {err && <div className="wx-alert wx-alert-danger"><span>{err}</span></div>}
          <div>
            <label className="wx-label">Title</label>
            <input className="wx-input" value={title} autoFocus
              placeholder="e.g. Update UI/UX" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="wx-label">Description</label>
            <textarea className="wx-input" rows={3} value={description}
              placeholder="What needs doing, and why"
              onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="wx-label">Priority</label>
              <select className="wx-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {DEV_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
              </select>
            </div>
            <div>
              <label className="wx-label">Due date <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
              <input className="wx-input" type="date" value={dueDate || ''} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="wx-label">Requested by</label>
            <select className="wx-input" value={requestedBy} onChange={(e) => setRequestedBy(e.target.value)}>
              <option value="">Nobody in particular</option>
              {requesters.map((r) => (
                <option key={r.id} value={r.id}>{r.display_name} ({r.role.toUpperCase()})</option>
              ))}
            </select>
            {/* Says out loud what the record will show. The developer picks who
                WANTED the work; who logged it is recorded separately and is
                never chosen, so the trail cannot claim someone clicked
                something they did not. */}
            {requestedBy && requestedBy !== me?.id && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>
                This will record <strong>requested by {requesters.find((r) => r.id === requestedBy)?.display_name}</strong>,
                logged by you. They will be asked to confirm.
              </div>
            )}
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Ask for a note when a status changes ────────────────────────────
function StatusNoteModal({ label, onCancel, onConfirm }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="wx-modal-backdrop" onClick={onCancel}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="wx-modal-header"><div className="wx-modal-title">{label}</div></div>
        <div className="wx-modal-body">
          <label className="wx-label">Add a note <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <textarea className="wx-input" rows={3} value={note} autoFocus
            placeholder="Why? Anything the Boss should know."
            onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="wx-btn wx-btn-primary" disabled={busy}
            onClick={async () => { setBusy(true); await onConfirm(note); }}>
            {busy ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── The list of pipelines ───────────────────────────────────────────
function TaskCard({ task, onOpen }) {
  const overdue = task.is_overdue;
  return (
    <button type="button" onClick={() => onOpen(task.id)} style={{
      textAlign: 'left', width: '100%', cursor: 'pointer',
      background: 'var(--surface-1)', border: `1px solid ${overdue ? 'var(--danger)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-lg, 14px)', padding: 16, display: 'grid', gap: 10,
      boxShadow: '0 1px 2px rgba(16,24,40,.04)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', lineHeight: 1.35 }}>
          {task.title}
        </div>
        <PriorityChip priority={task.priority} />
      </div>

      {task.description && (
        <div style={{
          fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>{task.description}</div>
      )}

      <Progress pct={task.progress_pct} done={task.subtask_done} counted={task.subtask_counted} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <StatusChip status={task.status} />
        {overdue && <Chip tone="var(--danger)" solid>Overdue</Chip>}
        {task.due_date && !overdue && (
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            <i className="bi bi-calendar3" style={{ marginRight: 4 }} />{fmtDate(task.due_date)}
          </span>
        )}
        {task.completed_override && <Chip tone="var(--text-muted)">Closed manually</Chip>}
      </div>

      {task.requester && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="bi bi-person" />
          Requested by <strong style={{ color: 'var(--text-secondary)' }}>{task.requester.display_name}</strong>
          {!task.requested_confirmed_at && (
            <Chip tone="var(--warning)" title="The developer recorded this attribution; it has not been confirmed by that person yet.">
              unconfirmed
            </Chip>
          )}
        </div>
      )}
    </button>
  );
}

// ── The board for one pipeline ──────────────────────────────────────
function SubtaskCard({ sub, canEdit, onMove, onEdit, onDelete }) {
  const overdue = sub.due_date && sub.due_date < todayKarachi() && !['done', 'cancelled'].includes(sub.status);
  return (
    <div
      draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', sub.id); e.dataTransfer.effectAllowed = 'move'; }}
      style={{
        background: 'var(--surface-1)', border: `1px solid ${overdue ? 'var(--danger)' : 'var(--border-subtle)'}`,
        borderRadius: 10, padding: 10, display: 'grid', gap: 7,
        cursor: canEdit ? 'grab' : 'default',
      }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35 }}>
        {sub.title}
      </div>
      {sub.description && (
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{sub.description}</div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <PriorityChip priority={sub.priority} />
        {sub.due_date && (
          <span style={{ fontSize: 11, color: overdue ? 'var(--danger)' : 'var(--text-muted)', fontWeight: overdue ? 700 : 400 }}>
            <i className="bi bi-calendar3" style={{ marginRight: 3 }} />{fmtDate(sub.due_date)}
          </span>
        )}
      </div>
      {canEdit && (
        <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
          <select className="wx-input" style={{ fontSize: 11, padding: '2px 6px', height: 26, flex: 1 }}
            value={sub.status} onChange={(e) => onMove(sub, e.target.value)}>
            {Object.keys(STATUS_META).map((s) => (
              <option key={s} value={s}>{STATUS_META[s].label}</option>
            ))}
          </select>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '2px 7px', fontSize: 11 }}
            title="Edit" onClick={() => onEdit(sub)}><i className="bi bi-pencil" /></button>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '2px 7px', fontSize: 11, color: 'var(--danger)' }}
            title="Delete" onClick={() => onDelete(sub)}><i className="bi bi-trash" /></button>
        </div>
      )}
    </div>
  );
}

function SubtaskModal({ sub, taskDue, onClose, onSaved }) {
  const [title, setTitle] = useState(sub?.title || '');
  const [description, setDescription] = useState(sub?.description || '');
  const [priority, setPriority] = useState(sub?.priority || 'medium');
  const [dueDate, setDueDate] = useState(sub?.due_date || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Warn, never block: a subtask legitimately running past its parent is a
  // real situation, and the honest response is to say so, not to refuse it.
  const late = dueDate && taskDue && dueDate > taskDue;

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">{sub ? 'Edit subtask' : 'New subtask'}</div>
        </div>
        <div className="wx-modal-body" style={{ display: 'grid', gap: 12 }}>
          {err && <div className="wx-alert wx-alert-danger"><span>{err}</span></div>}
          <div>
            <label className="wx-label">Title</label>
            <input className="wx-input" value={title} autoFocus
              placeholder="e.g. Update the dashboard UI" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="wx-label">Description</label>
            <textarea className="wx-input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label className="wx-label">Priority</label>
              <select className="wx-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {DEV_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
              </select>
            </div>
            <div>
              <label className="wx-label">Due date</label>
              <input className="wx-input" type="date" value={dueDate || ''} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          {late && (
            <div className="wx-alert wx-alert-info" style={{ fontSize: 12 }}>
              <span>This is due after the task itself ({fmtDate(taskDue)}), so the task will run late.</span>
            </div>
          )}
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="wx-btn wx-btn-primary" disabled={busy} onClick={async () => {
            if (!title.trim()) { setErr('A title is required.'); return; }
            setBusy(true); setErr('');
            try { await onSaved({ title, description, priority, dueDate }); }
            catch (e) { setErr(e.message || String(e)); setBusy(false); }
          }}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

export default function DevTasksPage() {
  const { profile } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const role = profile?.role;
  const canEdit = role === 'boss' || role === 'developer';
  const isBoss = role === 'boss';

  const [tasks, setTasks] = useState([]);
  const [subsByTask, setSubsByTask] = useState({});
  const [detail, setDetail] = useState(null);
  const [requesters, setRequesters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('open');
  const [showNew, setShowNew] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [subModal, setSubModal] = useState(null);   // {sub} | {new:true}
  const [pending, setPending] = useState(null);     // status change awaiting a note
  const [comment, setComment] = useState('');

  const loadList = useCallback(async () => {
    setErr('');
    try {
      const [t, r] = await Promise.all([listDevTasks(), listRequesters()]);
      setTasks(t); setRequesters(r);
      // "Next up" needs subtasks; one query per task is fine at this scale
      // (a single developer, a handful of live pipelines).
      const open = t.filter((x) => !['done', 'cancelled'].includes(x.status));
      const subs = await Promise.all(open.map((x) => listSubtasks(x.id).then((s) => [x.id, s])));
      setSubsByTask(Object.fromEntries(subs));
    } catch (e) { setErr(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (tid) => {
    setErr('');
    try { setDetail(await getDevTask(tid)); }
    catch (e) { setErr(e.message || String(e)); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (id) loadDetail(id); else setDetail(null); }, [id, loadDetail]);

  const visible = useMemo(() => {
    const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
    if (filter === 'open') return sortTasks(open);
    if (filter === 'all') return sortTasks(tasks);
    if (filter === 'overdue') return sortTasks(open.filter((t) => t.is_overdue));
    return sortTasks(tasks.filter((t) => t.status === filter));
  }, [tasks, filter]);

  const next = useMemo(() => nextUp(tasks, subsByTask), [tasks, subsByTask]);

  async function refreshBoth() {
    await loadList();
    if (id) await loadDetail(id);
  }

  // ── detail view ───────────────────────────────────────────────────
  if (id && detail) {
    const byCol = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, detail.subtasks.filter((s) => s.status === c)]));
    const finished = detail.subtasks.filter((s) => ['done', 'cancelled'].includes(s.status));
    const openCount = detail.subtasks.filter((s) => !['done', 'cancelled'].includes(s.status)).length;

    return (
      <div style={{ padding: '24px 28px 48px', maxWidth: 1400, margin: '0 auto' }}>
        <button className="wx-btn wx-btn-ghost" style={{ marginBottom: 12, paddingLeft: 0 }}
          onClick={() => navigate('/dev-tasks')}>
          <i className="bi bi-arrow-left" style={{ marginRight: 6 }} />All tasks
        </button>

        {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}><span>{err}</span></div>}

        {/* Header */}
        <div style={{
          background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
          borderRadius: 14, padding: 20, marginBottom: 18,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 260, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                <h1 style={{ fontSize: 21, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>{detail.title}</h1>
                <PriorityChip priority={detail.priority} />
                <StatusChip status={detail.status} />
                {detail.is_overdue && <Chip tone="var(--danger)" solid>Overdue</Chip>}
              </div>
              {detail.description && (
                <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 10px' }}>
                  {detail.description}
                </p>
              )}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                {detail.due_date && <span><i className="bi bi-calendar3" style={{ marginRight: 5 }} />Due {fmtDate(detail.due_date)}</span>}
                {detail.requester && (
                  <span>
                    <i className="bi bi-person" style={{ marginRight: 5 }} />
                    Requested by <strong style={{ color: 'var(--text-secondary)' }}>{detail.requester.display_name}</strong>
                    {detail.creator && detail.creator.id !== detail.requested_by && (
                      <> · logged by {detail.creator.display_name}</>
                    )}
                  </span>
                )}
              </div>
              {/* The person named as requester can confirm it was really them. */}
              {detail.requested_by && !detail.requested_confirmed_at && (
                <div className="wx-alert wx-alert-info" style={{ marginTop: 10, fontSize: 12.5 }}>
                  <span>
                    This was logged as <strong>{detail.requester?.display_name}</strong>&apos;s request but has not been confirmed.
                  </span>
                  {detail.requested_by === profile?.id && (
                    <button className="wx-btn wx-btn-primary" style={{ marginLeft: 10, padding: '2px 10px', fontSize: 12 }}
                      onClick={async () => { await confirmRequested(detail.id); refreshBoth(); }}>
                      Yes, I asked for this
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={{ minWidth: 220 }}>
              <Progress pct={detail.progress_pct} done={detail.subtask_done} counted={detail.subtask_counted} />
              {canEdit && (
                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                  <select className="wx-input" style={{ fontSize: 12, height: 30, width: 140 }}
                    value={detail.status}
                    onChange={(e) => setPending({ kind: 'task', to: e.target.value, from: detail.status })}>
                    {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                  </select>
                  <button className="wx-btn wx-btn-ghost" style={{ fontSize: 12 }} onClick={() => setEditTask(detail)}>
                    <i className="bi bi-pencil" /> Edit
                  </button>
                </div>
              )}
              {isBoss && openCount > 0 && detail.status !== 'done' && (
                <button className="wx-btn wx-btn-ghost" style={{ fontSize: 11.5, marginTop: 8, color: 'var(--warning)' }}
                  onClick={() => setPending({ kind: 'force', from: detail.status })}>
                  Close anyway ({openCount} still open)
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Board */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Subtasks</h2>
          {canEdit && (
            <button className="wx-btn wx-btn-primary" style={{ fontSize: 12.5 }} onClick={() => setSubModal({ new: true })}>
              <i className="bi bi-plus-lg" style={{ marginRight: 5 }} />Add subtask
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12, marginBottom: 20 }}>
          {BOARD_COLUMNS.map((col) => {
            const m = STATUS_META[col];
            return (
              <div key={col}
                onDragOver={(e) => { if (canEdit) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
                onDrop={(e) => {
                  if (!canEdit) return;
                  e.preventDefault();
                  const sid = e.dataTransfer.getData('text/plain');
                  const sub = detail.subtasks.find((s) => s.id === sid);
                  if (sub && sub.status !== col) setPending({ kind: 'sub', sub, to: col, from: sub.status });
                }}
                style={{
                  background: 'var(--surface-2)', borderRadius: 12, padding: 10,
                  border: '1px solid var(--border-subtle)', minHeight: 120,
                }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
                  fontSize: 11.5, fontWeight: 800, color: m.tone, textTransform: 'uppercase', letterSpacing: 0.3,
                }}>
                  <i className={`bi ${m.icon}`} />{m.label}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{byCol[col].length}</span>
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {byCol[col].map((s) => (
                    <SubtaskCard key={s.id} sub={s} canEdit={canEdit}
                      onMove={(sub, to) => setPending({ kind: 'sub', sub, to, from: sub.status })}
                      onEdit={(sub) => setSubModal({ sub })}
                      onDelete={async (sub) => {
                        if (!window.confirm(`Delete subtask "${sub.title}"?`)) return;
                        await deleteSubtask(sub.id); refreshBoth();
                      }} />
                  ))}
                  {!byCol[col].length && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', padding: '12px 0' }}>
                      Nothing here
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {finished.length > 0 && (
          <details style={{ marginBottom: 22 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>
              Finished ({finished.length})
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8, marginTop: 10 }}>
              {finished.map((s) => (
                <SubtaskCard key={s.id} sub={s} canEdit={canEdit}
                  onMove={(sub, to) => setPending({ kind: 'sub', sub, to, from: sub.status })}
                  onEdit={(sub) => setSubModal({ sub })}
                  onDelete={async (sub) => {
                    if (!window.confirm(`Delete subtask "${sub.title}"?`)) return;
                    await deleteSubtask(sub.id); refreshBoth();
                  }} />
              ))}
            </div>
          </details>
        )}

        {/* Timeline */}
        <h2 style={{ fontSize: 14, fontWeight: 800, margin: '0 0 10px', color: 'var(--text-primary)' }}>Activity</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input className="wx-input" placeholder="Add a note…" value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && comment.trim()) {
                await addNote({ taskId: detail.id, body: comment }); setComment(''); loadDetail(detail.id);
              }
            }} />
          <button className="wx-btn wx-btn-primary" disabled={!comment.trim()} onClick={async () => {
            await addNote({ taskId: detail.id, body: comment }); setComment(''); loadDetail(detail.id);
          }}>Post</button>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {detail.notes.map((n) => (
            <div key={n.id} style={{
              background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
              borderRadius: 10, padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-secondary)' }}>{n.author?.display_name || 'Someone'}</strong>
                {n.status_to && (
                  <span>
                    moved {n.status_from ? <>from <StatusChip status={n.status_from} /> </> : ''}
                    to <StatusChip status={n.status_to} />
                  </span>
                )}
                <span style={{ marginLeft: 'auto' }}>{relTime(n.created_at)}</span>
              </div>
              {n.body && (
                <div style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 6, whiteSpace: 'pre-wrap' }}>{n.body}</div>
              )}
            </div>
          ))}
          {!detail.notes.length && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Nothing yet.</div>
          )}
        </div>

        {/* Modals */}
        {editTask && (
          <TaskModal task={editTask} requesters={requesters} me={profile}
            onClose={() => setEditTask(null)}
            onSaved={() => { setEditTask(null); refreshBoth(); }} />
        )}
        {subModal && (
          <SubtaskModal sub={subModal.sub} taskDue={detail.due_date}
            onClose={() => setSubModal(null)}
            onSaved={async (vals) => {
              if (subModal.sub) {
                await updateSubtask(subModal.sub.id, {
                  title: vals.title.trim(), description: vals.description || null,
                  priority: vals.priority, due_date: vals.dueDate || null,
                });
              } else {
                await createSubtask(detail.id, vals);
              }
              setSubModal(null); refreshBoth();
            }} />
        )}
        {pending && (
          <StatusNoteModal
            label={pending.kind === 'force' ? 'Close this task with subtasks still open?'
              : `Move to ${STATUS_META[pending.to]?.label}`}
            onCancel={() => setPending(null)}
            onConfirm={async (note) => {
              try {
                if (pending.kind === 'force') await forceCompleteDevTask(detail.id, pending.from, note);
                else if (pending.kind === 'task') await setDevTaskStatus(detail.id, pending.from, pending.to, note);
                else await setSubtaskStatus(pending.sub, pending.to, note);
              } catch (e) { setErr(e.message || String(e)); }
              setPending(null); refreshBoth();
            }} />
        )}
      </div>
    );
  }

  // ── list view ─────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 28px 48px', maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Development</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Tasks between the Boss and the developer. Each one breaks into subtasks.
          </p>
        </div>
        <button className="wx-btn wx-btn-primary" onClick={() => setShowNew(true)}>
          <i className="bi bi-plus-lg" style={{ marginRight: 6 }} />New task
        </button>
      </div>

      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}><span>{err}</span></div>}

      {/* What the developer should do next. One person does not need a
          dashboard, they need the next thing. */}
      {next && (
        <div style={{
          background: 'color-mix(in srgb, var(--primary) 8%, var(--surface-1))',
          border: '1px solid color-mix(in srgb, var(--primary) 30%, transparent)',
          borderRadius: 14, padding: 16, marginBottom: 18,
          display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, flex: '0 0 auto', display: 'grid', placeItems: 'center',
            background: 'var(--primary)', color: '#fff',
          }}><i className="bi bi-lightning-charge-fill" /></div>
          <div style={{ minWidth: 220, flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: 'var(--primary)', textTransform: 'uppercase' }}>
              Next up
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{next.subtask.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              in {next.task.title}
              {next.subtask.due_date && <> · due {fmtDate(next.subtask.due_date)}</>}
            </div>
          </div>
          <PriorityChip priority={next.subtask.priority} />
          <button className="wx-btn wx-btn-primary" onClick={() => navigate(`/dev-tasks/${next.task.id}`)}>Open</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['open', 'Open'], ['overdue', 'Overdue'], ['blocked', 'Blocked'], ['done', 'Done'], ['all', 'All']].map(([k, label]) => (
          <button key={k} className={`wx-btn ${filter === k ? 'wx-btn-primary' : 'wx-btn-ghost'}`}
            style={{ fontSize: 12.5, padding: '4px 12px' }} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" style={{ width: 16, height: 16, marginRight: 8 }} />Loading…
        </div>
      ) : !visible.length ? (
        <div style={{
          textAlign: 'center', padding: '48px 20px', color: 'var(--text-muted)',
          border: '1px dashed var(--border-subtle)', borderRadius: 14,
        }}>
          <i className="bi bi-kanban" style={{ fontSize: 28, opacity: 0.5 }} />
          <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {filter === 'open' ? 'Nothing in progress' : 'Nothing here'}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Create a task to get started.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {visible.map((t) => <TaskCard key={t.id} task={t} onOpen={(tid) => navigate(`/dev-tasks/${tid}`)} />)}
        </div>
      )}

      {showNew && (
        <TaskModal requesters={requesters} me={profile}
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); loadList(); }} />
      )}
    </div>
  );
}
