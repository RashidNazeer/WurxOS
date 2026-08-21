import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  listDevTasks, getDevTask, createDevTask, updateDevTask, setDevTaskStatus,
  forceCompleteDevTask, confirmRequested, deleteDevTask,
  createSubtask, setSubtaskStatus, updateSubtask, deleteSubtask,
  listSubtasks, addNote, listRequesters,
  listProjects, createProject, updateProject, archiveProject, PROJECT_COLOURS,
  STATUS_META, PRIORITY_META, DEV_PRIORITIES, BOARD_COLUMNS, sortTasks, nextUp,
} from '../../lib/devTasksApi';
// The .wx-modal / .wx-modal-backdrop overlay styles live here and are imported
// PER PAGE, not globally (see the same import in HaloShareModal, AuditPage,
// BrandDetailPage...). Without it the dialogs render as unstyled blocks in the
// page flow, which is exactly what happened here.
import '../../styles/table.css';

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

function ProjectChip({ name, colour }) {
  if (!name) return null;
  const c = PROJECT_COLOURS[colour] || PROJECT_COLOURS.slate;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
      fontWeight: 700, color: c, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: c, flex: '0 0 auto' }} />
      {name}
    </span>
  );
}

// The Boss's real question is "what is coming, what is moving, what is stuck".
// The parent's own status cannot answer it: a pipeline sits at Pending while a
// subtask inside it is already in progress, which is exactly what looked wrong
// on the first version of this card.
function StatusBreakdown({ counts }) {
  const entries = Object.entries(counts || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => Object.keys(STATUS_META).indexOf(a[0]) - Object.keys(STATUS_META).indexOf(b[0]));
  if (!entries.length) return null;
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      {entries.map(([st, n]) => {
        const m = STATUS_META[st] || STATUS_META.pending;
        return (
          <span key={st} title={`${n} ${m.label}`} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11, fontWeight: 600, color: m.tone,
          }}>
            <i className={`bi ${m.icon}`} style={{ fontSize: 10 }} />
            {n} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{m.label.toLowerCase()}</span>
          </span>
        );
      })}
    </div>
  );
}

// ── Projects manager ────────────────────────────────────────────────
function ProjectsModal({ onClose, onChanged }) {
  const [projects, setProjects] = useState([]);
  const [name, setName] = useState('');
  const [colour, setColour] = useState('blue');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setProjects(await listProjects({ includeArchived: true })); }
    catch (e) { setErr(e.message || String(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!name.trim()) return;
    setBusy(true); setErr('');
    try { await createProject({ name, colour }); setName(''); await load(); onChanged(); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  return createPortal(
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Projects</div>
          <button className="wx-btn wx-btn-ghost" onClick={onClose}><i className="bi bi-x-lg" /></button>
        </div>
        <div className="wx-modal-body" style={{ display: 'grid', gap: 14 }}>
          {err && <div className="wx-alert wx-alert-danger"><span>{err}</span></div>}
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            One per product you build, so the Boss can see what is being worked on without opening tasks.
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input className="wx-input" placeholder="e.g. WurxMediaHub" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            <select className="wx-input" style={{ width: 110 }} value={colour} onChange={(e) => setColour(e.target.value)}>
              {Object.keys(PROJECT_COLOURS).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="wx-btn wx-btn-primary" onClick={add} disabled={busy || !name.trim()}>Add</button>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            {projects.map((p) => (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                border: '1px solid var(--border-subtle)', borderRadius: 8,
                opacity: p.is_active ? 1 : 0.5,
              }}>
                <ProjectChip name={p.name} colour={p.colour} />
                {!p.is_active && <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>archived</span>}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {p.is_active ? (
                    <button className="wx-btn wx-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                      title="Archive — tasks keep pointing at it"
                      onClick={async () => { await archiveProject(p.id); await load(); onChanged(); }}>
                      Archive
                    </button>
                  ) : (
                    <button className="wx-btn wx-btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={async () => { await updateProject(p.id, { is_active: true }); await load(); onChanged(); }}>
                      Restore
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!projects.length && (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No projects yet.</div>
            )}
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Create / edit task ──────────────────────────────────────────────
function TaskModal({ task, requesters, projects, me, onClose, onSaved }) {
  const editing = !!task;
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [dueDate, setDueDate] = useState(task?.due_date || '');
  const [requestedBy, setRequestedBy] = useState(task?.requested_by || '');
  const [projectId, setProjectId] = useState(task?.project_id || '');
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
          project_id: projectId || null,
        });
      } else {
        await createDevTask({ title, description, priority, dueDate, requestedBy, projectId });
      }
      onSaved();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  return createPortal(
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
            <label className="wx-label">Project</label>
            <select className="wx-input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
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
    </div>,
    document.body,
  );
}

// ── Ask for a note when a status changes ────────────────────────────
function StatusNoteModal({ label, onCancel, onConfirm }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return createPortal(
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
    </div>,
    document.body,
  );
}

// ── The list of pipelines ───────────────────────────────────────────

// Clicking a status opens a proper menu of coloured options rather than a
// native <select>, which cannot show the status colour, looks like a form
// control in the middle of a board, and is miserable on touch.
function StatusMenu({ value, onPick, size = 'sm', align = 'left' }) {
  const [open, setOpen] = useState(false);
  const m = STATUS_META[value] || STATUS_META.pending;
  const pad = size === 'md' ? '5px 11px' : '3px 9px';
  const font = size === 'md' ? 12.5 : 11;

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: pad,
          fontSize: font, fontWeight: 700, cursor: 'pointer', borderRadius: 999,
          background: `color-mix(in srgb, ${m.tone} 13%, transparent)`,
          color: m.tone, border: `1px solid color-mix(in srgb, ${m.tone} 32%, transparent)`,
        }}>
        <i className={`bi ${m.icon}`} style={{ fontSize: font - 1 }} />
        {m.label}
        <i className="bi bi-chevron-down" style={{ fontSize: font - 3, opacity: 0.7 }} />
      </button>

      {open && (
        <>
          {/* Click-away catcher. Sits under the menu, over everything else. */}
          <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); }}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', [align]: 0, zIndex: 41,
            background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
            borderRadius: 12, padding: 5, minWidth: 172,
            boxShadow: '0 12px 32px rgba(16,24,40,.18)',
          }}>
            {Object.entries(STATUS_META).map(([k, mm]) => {
              const on = k === value;
              return (
                <button key={k} type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); if (!on) onPick(k); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                    padding: '7px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: on ? `color-mix(in srgb, ${mm.tone} 12%, transparent)` : 'transparent',
                    color: on ? mm.tone : 'var(--text-primary)',
                    fontSize: 12.5, fontWeight: on ? 700 : 500, textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}>
                  <i className={`bi ${mm.icon}`} style={{ color: mm.tone, fontSize: 12 }} />
                  {mm.label}
                  {on && <i className="bi bi-check2" style={{ marginLeft: 'auto' }} />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// One bar split BY STATUS rather than a done/not-done fill, so composition
// reads at a glance: "mostly blocked" looks different from "barely started".
function CompositionBar({ counts, total }) {
  const order = ['done', 'in_progress', 'blocked', 'paused', 'pending', 'cancelled'];
  const segs = order.map((k) => [k, counts?.[k] || 0]).filter(([, n]) => n > 0);
  if (!total) {
    return <div style={{ height: 7, borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }} />;
  }
  return (
    <div style={{
      height: 7, borderRadius: 999, overflow: 'hidden', display: 'flex', gap: 2,
      background: 'transparent',
    }}>
      {segs.map(([k, n]) => (
        <div key={k} title={`${n} ${STATUS_META[k].label}`} style={{
          width: `${(n / total) * 100}%`, borderRadius: 999,
          background: k === 'pending' ? 'var(--border-subtle)' : STATUS_META[k].tone,
          opacity: k === 'cancelled' ? 0.35 : 1,
        }} />
      ))}
    </div>
  );
}

// THE POINT OF THE CARD. "1 active" tells the Boss nothing — he then has to
// open the pipeline to find out WHAT is active, which is the click this page
// exists to remove. So name the live subtasks right here, in-progress and
// blocked first, and only fall back to counts when there is nothing running.
function LiveSubtasks({ subtasks, onOpen }) {
  if (!subtasks?.length) return null;
  const rank = { in_progress: 0, blocked: 1, paused: 2, pending: 3, done: 4, cancelled: 5 };
  const live = [...subtasks]
    .filter((s) => !['done', 'cancelled'].includes(s.status))
    .sort((a, b) => (rank[a.status] - rank[b.status])
      || ((PRIORITY_META[a.priority]?.rank ?? 9) - (PRIORITY_META[b.priority]?.rank ?? 9)));
  if (!live.length) return null;
  const shown = live.slice(0, 3);
  const rest = live.length - shown.length;

  return (
    <div style={{ display: 'grid', gap: 5 }}>
      {shown.map((s) => {
        const m = STATUS_META[s.status] || STATUS_META.pending;
        const running = s.status === 'in_progress';
        const stuck = s.status === 'blocked';
        return (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px',
            borderRadius: 9, fontSize: 12.3,
            background: running || stuck ? `color-mix(in srgb, ${m.tone} 9%, transparent)` : 'var(--surface-2)',
            border: `1px solid ${running || stuck ? `color-mix(in srgb, ${m.tone} 26%, transparent)` : 'transparent'}`,
          }}>
            <i className={`bi ${m.icon}`} style={{ color: m.tone, fontSize: 11, flex: '0 0 auto' }} />
            <span style={{
              color: running || stuck ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: running || stuck ? 650 : 500,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{s.title}</span>
            {s.due_date && (
              <span style={{ marginLeft: 'auto', flex: '0 0 auto', fontSize: 10.5, color: 'var(--text-muted)' }}>
                {fmtDate(s.due_date)}
              </span>
            )}
          </div>
        );
      })}
      {rest > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 3 }}>
          +{rest} more
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, subtasks, onOpen }) {
  const overdue = task.is_overdue;
  const accent = task.project_colour
    ? (PROJECT_COLOURS[task.project_colour] || PROJECT_COLOURS.slate)
    : 'var(--border-subtle)';
  const counts = task.status_counts || {};

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(task.id); }}
      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 8px 24px rgba(16,24,40,.10)'; e.currentTarget.style.borderColor = accent; }}
      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(16,24,40,.05)'; e.currentTarget.style.borderColor = overdue ? 'var(--danger)' : 'var(--border-subtle)'; }}
      style={{
        textAlign: 'left', width: '100%', cursor: 'pointer',
        background: 'var(--surface-1)',
        border: `1px solid ${overdue ? 'var(--danger)' : 'var(--border-subtle)'}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 14, padding: '15px 16px 13px', display: 'grid', gap: 12,
        boxShadow: '0 1px 2px rgba(16,24,40,.05)', transition: 'box-shadow .16s, border-color .16s',
      }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, justifyContent: 'space-between' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', lineHeight: 1.3 }}>
            {task.title}
          </div>
          {task.description && (
            <div style={{
              fontSize: 12.3, color: 'var(--text-muted)', lineHeight: 1.45, marginTop: 3,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>{task.description}</div>
          )}
        </div>
        <div style={{ display: 'grid', gap: 5, justifyItems: 'end', flex: '0 0 auto' }}>
          <PriorityChip priority={task.priority} />
          {overdue && <Chip tone="var(--danger)" solid>Overdue</Chip>}
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 7 }}>
          <span style={{ fontSize: 21, fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>
            {task.progress_pct == null ? '—' : `${task.progress_pct}%`}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {task.subtask_counted ? `${task.subtask_done} of ${task.subtask_counted} done` : 'no subtasks yet'}
          </span>
        </div>
        <CompositionBar counts={counts} total={task.subtask_total} />
      </div>

      <LiveSubtasks subtasks={subtasks} />

      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap',
        borderTop: '1px solid var(--border-subtle)', paddingTop: 10,
        fontSize: 11.3, color: 'var(--text-muted)',
      }}>
        {task.project_name
          ? <ProjectChip name={task.project_name} colour={task.project_colour} />
          : <span style={{ fontStyle: 'italic' }}>No project</span>}
        {task.due_date && (
          <span style={{ color: overdue ? 'var(--danger)' : 'var(--text-muted)', fontWeight: overdue ? 700 : 400 }}>
            <i className="bi bi-calendar3" style={{ marginRight: 4 }} />{fmtDate(task.due_date)}
          </span>
        )}
        {task.requester && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <i className="bi bi-person" />{task.requester.display_name}
            {!task.requested_confirmed_at && (
              <span title="Recorded by the developer; not yet confirmed by that person."
                style={{ color: 'var(--warning)', fontWeight: 700 }}> · unconfirmed</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}


// ── The "one glance" header ─────────────────────────────────────────

// The Boss's question is literally "which project, which main task, which
// subtask". So show that as a chain rather than making him infer it from a
// card. This is the single most important element on the page.
function ActiveChain({ next, onOpen }) {
  if (!next) {
    return (
      <div style={{
        border: '1px dashed var(--border-subtle)', borderRadius: 16, padding: '22px 20px',
        textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
      }}>
        Nothing is in progress right now.
      </div>
    );
  }
  const { task, subtask } = next;
  const accent = task.project_colour ? (PROJECT_COLOURS[task.project_colour] || PROJECT_COLOURS.slate) : 'var(--primary)';
  const sub = STATUS_META[subtask.status] || STATUS_META.pending;

  return (
    <div style={{
      position: 'relative', overflow: 'hidden', borderRadius: 16, padding: '18px 20px',
      background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 10%, var(--surface-1)) 0%, var(--surface-1) 60%)`,
      border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
    }}>
      <div style={{
        position: 'absolute', inset: 0, width: 3, background: accent,
      }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 260, flex: 1 }}>
          <div style={{
            fontSize: 10.5, fontWeight: 800, letterSpacing: 0.7, textTransform: 'uppercase',
            color: accent, marginBottom: 7, display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 99, background: accent,
              boxShadow: `0 0 0 3px color-mix(in srgb, ${accent} 22%, transparent)`,
            }} />
            Working on now
          </div>

          {/* project › task › subtask */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
            <span style={{ fontWeight: 700, color: accent }}>{task.project_name || 'No project'}</span>
            <i className="bi bi-chevron-right" style={{ fontSize: 9, color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{task.title}</span>
          </div>

          <div style={{
            fontSize: 20, fontWeight: 800, color: 'var(--text-primary)',
            lineHeight: 1.25, marginTop: 5,
          }}>{subtask.title}</div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 9 }}>
            <Chip tone={sub.tone}><i className={`bi ${sub.icon}`} style={{ marginRight: 4 }} />{sub.label}</Chip>
            <PriorityChip priority={subtask.priority} />
            {subtask.due_date && (
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                <i className="bi bi-calendar3" style={{ marginRight: 4 }} />due {fmtDate(subtask.due_date)}
              </span>
            )}
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {task.progress_pct == null ? '' : `pipeline ${task.progress_pct}% complete`}
            </span>
          </div>
        </div>

        <button className="wx-btn wx-btn-primary" style={{ fontWeight: 700 }} onClick={() => onOpen(task.id)}>
          Open pipeline <i className="bi bi-arrow-right" style={{ marginLeft: 6 }} />
        </button>
      </div>
    </div>
  );
}

// Five numbers that answer "is anything wrong". Anything at zero stays grey so
// only real problems draw the eye.
function SummaryStrip({ tasks }) {
  const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  const sum = (k) => open.reduce((n, t) => n + ((t.status_counts || {})[k] || 0), 0);
  const stats = [
    { label: 'Pipelines open', value: open.length, tone: 'var(--text-primary)' },
    { label: 'Subtasks active', value: sum('in_progress'), tone: STATUS_META.in_progress.tone },
    { label: 'Blocked', value: sum('blocked'), tone: 'var(--danger)', warn: true },
    { label: 'Overdue', value: open.filter((t) => t.is_overdue).length, tone: 'var(--danger)', warn: true },
    { label: 'Completed', value: tasks.filter((t) => t.status === 'done').length, tone: 'var(--success)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
      {stats.map((s) => {
        const live = s.value > 0;
        const tone = s.warn && !live ? 'var(--text-muted)' : s.tone;
        return (
          <div key={s.label} style={{
            background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
            borderRadius: 12, padding: '12px 14px',
          }}>
            <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, color: live ? tone : 'var(--text-muted)' }}>
              {s.value}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, fontWeight: 600 }}>{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// Cards grouped under their project, so "which project" needs no reading.
function ProjectGroup({ project, tasks, subsByTask, onOpen }) {
  const c = project.colour ? (PROJECT_COLOURS[project.colour] || PROJECT_COLOURS.slate) : 'var(--text-muted)';
  const counted = tasks.reduce((n, t) => n + (t.subtask_counted || 0), 0);
  const done = tasks.reduce((n, t) => n + (t.subtask_done || 0), 0);
  const pct = counted ? Math.round((done / counted) * 100) : null;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap',
        paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span style={{ width: 9, height: 9, borderRadius: 99, background: c }} />
        <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' }}>{project.name}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {tasks.length} {tasks.length === 1 ? 'pipeline' : 'pipelines'}
          {pct != null && <> · {pct}% complete</>}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14 }}>
        {tasks.map((t) => <TaskCard key={t.id} task={t} subtasks={subsByTask?.[t.id]} onOpen={onOpen} />)}
      </div>
    </div>
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
          <StatusMenu value={sub.status} onPick={(to) => onMove(sub, to)} />
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

  return createPortal(
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
    </div>,
    document.body,
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
  const [projects, setProjects] = useState([]);
  const [showProjects, setShowProjects] = useState(false);
  const [projectFilter, setProjectFilter] = useState('all');
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
      const [t, r, pj] = await Promise.all([listDevTasks(), listRequesters(), listProjects()]);
      setTasks(t); setRequesters(r); setProjects(pj);
      // "Next up" needs subtasks; one query per task is fine at this scale
      // (a single developer, a handful of live pipelines).
      const subs = await Promise.all(t.map((x) => listSubtasks(x.id).then((s) => [x.id, s])));
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
    const scoped = projectFilter === 'all' ? tasks
      : projectFilter === 'none' ? tasks.filter((t) => !t.project_id)
      : tasks.filter((t) => t.project_id === projectFilter);
    const open = scoped.filter((t) => !['done', 'cancelled'].includes(t.status));
    if (filter === 'open') return sortTasks(open);
    if (filter === 'all') return sortTasks(scoped);
    if (filter === 'overdue') return sortTasks(open.filter((t) => t.is_overdue));
    return sortTasks(scoped.filter((t) => t.status === filter));
  }, [tasks, filter, projectFilter]);

  const next = useMemo(() => nextUp(tasks, subsByTask), [tasks, subsByTask]);

  // Group the visible cards under their project. Projects with nothing to show
  // are dropped rather than rendered as empty headings, and unassigned work
  // sinks to the bottom so it reads as a loose end rather than a category.
  const grouped = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const buckets = new Map();
    for (const t of visible) {
      const key = t.project_id || '__none';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    const out = [];
    for (const [key, items] of buckets) {
      if (key === '__none') continue;
      // An ARCHIVED project is not in `projects`, but its tasks still exist and
      // the view carries its name and colour, so fall back to the row itself
      // rather than dropping the group or labelling it "unknown".
      const fallback = { id: key, name: items[0].project_name || 'Project', colour: items[0].project_colour || 'slate' };
      out.push({ project: byId.get(key) || fallback, items });
    }
    out.sort((a, b) => a.project.name.localeCompare(b.project.name));
    if (buckets.has('__none')) {
      out.push({ project: { id: '__none', name: 'No project', colour: null }, items: buckets.get('__none') });
    }
    return out;
  }, [visible, projects]);

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
                {detail.project_name && <ProjectChip name={detail.project_name} colour={detail.project_colour} />}
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
                  <StatusMenu value={detail.status} size="md"
                    onPick={(to) => setPending({ kind: 'task', to, from: detail.status })} />
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
          <TaskModal task={editTask} requesters={requesters} projects={projects} me={profile}
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
        <div style={{ display: 'flex', gap: 8 }}>
          {canEdit && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setShowProjects(true)}>
              <i className="bi bi-folder2" style={{ marginRight: 6 }} />Projects
            </button>
          )}
          <button className="wx-btn wx-btn-primary" onClick={() => setShowNew(true)}>
            <i className="bi bi-plus-lg" style={{ marginRight: 6 }} />New task
          </button>
        </div>
      </div>

      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}><span>{err}</span></div>}

      {/* One glance: what is being worked on right now, then the numbers
          that say whether anything needs attention. */}
      <div style={{ display: 'grid', gap: 12, marginBottom: 20 }}>
        <ActiveChain next={next} onOpen={(tid) => navigate(`/dev-tasks/${tid}`)} />
        <SummaryStrip tasks={tasks} />
      </div>

      {/* ONE toolbar, not two stacked rows of pills. The old version had two
          separate "All" buttons meaning different things, which is genuinely
          confusing. Now: state as a segmented control on the left (one thing,
          one control), project as a labelled dropdown on the right. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18,
      }}>
        <div style={{
          display: 'inline-flex', padding: 3, gap: 2, borderRadius: 11,
          background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
        }}>
          {[['open', 'Open'], ['blocked', 'Blocked'], ['overdue', 'Overdue'], ['done', 'Done'], ['all', 'Everything']].map(([k, label]) => {
            const on = filter === k;
            const count = k === 'open' ? tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length
              : k === 'blocked' ? tasks.filter((t) => t.status === 'blocked').length
              : k === 'overdue' ? tasks.filter((t) => t.is_overdue).length
              : k === 'done' ? tasks.filter((t) => t.status === 'done').length
              : tasks.length;
            return (
              <button key={k} type="button" onClick={() => setFilter(k)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 13px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  fontSize: 12.5, fontWeight: on ? 700 : 500,
                  background: on ? 'var(--surface-1)' : 'transparent',
                  color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                  boxShadow: on ? '0 1px 3px rgba(16,24,40,.10)' : 'none',
                  transition: 'background .12s, color .12s',
                }}>
                {label}
                {/* The count is the useful part: an empty Blocked tab should
                    look empty before you click it. */}
                <span style={{
                  fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 999,
                  background: on ? 'var(--surface-2)' : 'transparent',
                  color: count === 0 ? 'var(--text-muted)'
                    : (k === 'blocked' || k === 'overdue') ? 'var(--danger)' : 'var(--text-muted)',
                }}>{count}</span>
              </button>
            );
          })}
        </div>

        {projects.length > 0 && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>Project</span>
            <select className="wx-input" style={{ width: 190, height: 34, fontSize: 12.5 }}
              value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="all">All projects</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="none">Unassigned</option>
            </select>
          </label>
        )}
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
        grouped.map(({ project, items }) => (
          <ProjectGroup key={project.id} project={project} tasks={items} subsByTask={subsByTask}
            onOpen={(tid) => navigate(`/dev-tasks/${tid}`)} />
        ))
      )}

      {showProjects && (
        <ProjectsModal onClose={() => setShowProjects(false)} onChanged={loadList} />
      )}
      {showNew && (
        <TaskModal requesters={requesters} projects={projects} me={profile}
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); loadList(); }} />
      )}
    </div>
  );
}
