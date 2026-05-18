import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaTasks, updateAgendaTask, deleteAgendaTask, subscribeAgendaTasks,
  getAgendaResetSchedule, formatAgendaResetHint,
} from '../../lib/agendaApi';
import AgendaTaskModal from '../../components/agenda/AgendaTaskModal';
import AgendaResetScheduleModal from '../../components/agenda/AgendaResetScheduleModal';

// Weekly Agenda Meetings — Tasks. A recurring per-APC task system,
// fully separate from the main /tasks module.

const STATUS = {
  todo:        { label: 'To Do',       color: 'var(--warning)', bg: 'var(--warning-soft)' },
  in_progress: { label: 'In Progress', color: 'var(--info)',    bg: 'var(--info-soft)' },
  completed:   { label: 'Completed',   color: 'var(--success)', bg: 'var(--success-soft)' },
};
const STATUS_ORDER = ['todo', 'in_progress', 'completed'];

function fmtDate(d) {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AgendaTasksPage() {
  const { user, profile } = useAuth();
  const role = profile?.role || '';
  const isApc      = role === 'apc';
  const isManager  = role === 'tl' || role === 'ol' || role === 'boss';
  const isOLBoss   = role === 'ol' || role === 'boss';
  const uid = user?.id;

  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [apcFilter, setApcFilter]       = useState('');   // manager: focus one APC
  const [search, setSearch]     = useState('');
  const [modalOpen, setModalOpen]       = useState(false);
  const [resetOpen, setResetOpen]       = useState(false);
  const [resetHint, setResetHint]       = useState('');

  function reload() {
    listAgendaTasks()
      .then((r) => setRows(r || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    const unsub = subscribeAgendaTasks(reload);
    return () => unsub();
  }, []);

  // APC: surface their own reset cadence as a banner.
  useEffect(() => {
    if (!isApc || !uid) return;
    getAgendaResetSchedule(uid)
      .then((s) => setResetHint(formatAgendaResetHint(s)))
      .catch(() => {});
  }, [isApc, uid]);

  // Manager APC list (derived from visible tasks' assignees).
  const apcOptions = useMemo(() => {
    const map = new Map();
    rows.forEach((r) => {
      if (r.assignee && !map.has(r.assignee.id)) map.set(r.assignee.id, r.assignee);
    });
    return Array.from(map.values()).sort((a, b) =>
      (a.display_name || '').localeCompare(b.display_name || ''));
  }, [rows]);

  const focusedApc = useMemo(
    () => apcOptions.find((a) => a.id === apcFilter) || null,
    [apcOptions, apcFilter],
  );

  const counts = useMemo(() => {
    const base = apcFilter ? rows.filter((r) => r.assignee_id === apcFilter) : rows;
    return {
      all: base.length,
      todo: base.filter((r) => r.status === 'todo').length,
      in_progress: base.filter((r) => r.status === 'in_progress').length,
      completed: base.filter((r) => r.status === 'completed').length,
    };
  }, [rows, apcFilter]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (apcFilter && r.assignee_id !== apcFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(r.title || '').toLowerCase().includes(q)
          && !(r.details || '').toLowerCase().includes(q)
          && !(r.brand?.brand_name || '').toLowerCase().includes(q)
          && !(r.assignee?.display_name || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, apcFilter, statusFilter, search]);

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-list-check" style={{ fontSize: '1.15rem' }} />
            Agenda Tasks
          </h5>
          <p className="text-muted small mb-0">
            {isApc ? 'Your recurring tasks for the weekly agenda meeting.'
                   : 'Recurring agenda tasks for your team.'}
          </p>
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {isApc && (
            <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8, fontSize: '0.78rem' }} onClick={() => setResetOpen(true)}>
              <i className="bi bi-arrow-repeat" /> Reset schedule
            </button>
          )}
          <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem' }} onClick={() => setModalOpen(true)}>
            <i className="bi bi-plus-lg" style={{ fontSize: '0.72rem' }} />
            {isApc ? 'Add task' : 'Assign task'}
          </button>
        </div>
      </div>

      {isApc && resetHint && (
        <div className="rounded-2 px-3 py-2 mb-3 d-inline-flex align-items-center gap-2"
          style={{ background: 'var(--accent-soft)', border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)', fontSize: '0.76rem' }}>
          <i className="bi bi-arrow-repeat text-primary" />{resetHint}.
        </div>
      )}

      {/* Controls */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3 d-flex flex-wrap gap-2 align-items-center">
          <div className="d-flex gap-1 flex-wrap">
            {[['all', 'All', counts.all], ...STATUS_ORDER.map((s) => [s, STATUS[s].label, counts[s]])].map(([key, label, n]) => (
              <button key={key} type="button"
                className="d-flex align-items-center gap-2 px-3 py-1 rounded-2 border-0"
                style={{
                  background: statusFilter === key ? 'var(--accent)' : 'var(--surface-2)',
                  color: statusFilter === key ? 'var(--on-accent)' : 'var(--text-secondary)',
                  fontWeight: 600, fontSize: '0.78rem', cursor: 'pointer',
                }}
                onClick={() => setStatusFilter(key)}>
                {label}
                <span className="rounded-pill px-2" style={{
                  background: statusFilter === key ? 'color-mix(in srgb, var(--on-accent) 22%, transparent)' : 'var(--surface-3)',
                  fontSize: '0.66rem', fontWeight: 700,
                }}>{n}</span>
              </button>
            ))}
          </div>

          {isManager && apcOptions.length > 0 && (
            <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 160 }}
              value={apcFilter} onChange={(e) => setApcFilter(e.target.value)}>
              <option value="">All APCs</option>
              {apcOptions.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
            </select>
          )}

          <div className="position-relative ms-auto" style={{ flex: '0 1 220px', minWidth: 160 }}>
            <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search tasks…"
              style={{ paddingLeft: 30, borderRadius: 8 }} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {focusedApc && (
        <div className="d-inline-flex align-items-center gap-2 rounded-pill px-3 py-1 mb-3"
          style={{ background: 'var(--accent-soft)', border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)', fontSize: '0.76rem' }}>
          <i className="bi bi-person-badge text-primary" />
          Viewing <strong>{focusedApc.display_name}</strong>’s agenda tasks
          <button className="btn btn-sm p-0 ms-1" style={{ fontSize: '0.72rem' }}
            onClick={() => setApcFilter('')}>✕</button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : filtered.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
            <i className="bi bi-list-check text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No agenda tasks</p>
          <p className="text-muted small mb-0">{isApc ? 'Add your first agenda task.' : 'Assign the first agenda task.'}</p>
        </div>
      ) : (
        <div className="d-flex flex-column gap-2">
          {filtered.map((t) => (
            <TaskCard key={t.id} task={t} uid={uid} isManager={isManager} isOLBoss={isOLBoss}
              onChanged={reload} />
          ))}
        </div>
      )}

      {modalOpen && (
        <AgendaTaskModal
          presetAssignee={focusedApc}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); reload(); }}
        />
      )}
      {resetOpen && (
        <AgendaResetScheduleModal
          onClose={() => setResetOpen(false)}
          onSaved={() => getAgendaResetSchedule(uid).then((s) => setResetHint(formatAgendaResetHint(s))).catch(() => {})}
        />
      )}
    </div>
  );
}

// ── Task card ──────────────────────────────────────────────────────────
function TaskCard({ task, uid, isManager, isOLBoss, onChanged }) {
  const [busy, setBusy]     = useState(false);
  const [notify, setNotify] = useState(false);

  const canEdit   = isManager || task.assignee_id === uid || task.created_by === uid;
  const canDelete = task.created_by === uid || isOLBoss;
  const due = fmtDate(task.due_date);
  const overdue = task.due_date && task.status !== 'completed'
    && new Date(`${task.due_date}T23:59:59`) < new Date();

  async function setStatus(next) {
    if (next === task.status || busy) return;
    setBusy(true);
    try {
      await updateAgendaTask(task.id, { status: next, notify });
      onChanged();
    } catch (e) {
      alert('Failed to update: ' + (e.message || 'unknown'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${task.title}"?`)) return;
    setBusy(true);
    try {
      await deleteAgendaTask(task.id);
      onChanged();
    } catch (e) {
      alert('Failed to delete: ' + (e.message || 'unknown'));
    } finally {
      setBusy(false);
    }
  }

  const st = STATUS[task.status] || STATUS.todo;

  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: `4px solid ${st.color}` }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-start justify-content-between gap-3 flex-wrap">
          <div className="flex-grow-1 min-w-0" style={{ minWidth: 220 }}>
            <div className="fw-semibold" style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{task.title}</div>
            {task.details && (
              <p className="text-muted mb-1 mt-1" style={{ fontSize: '0.78rem' }}>{task.details}</p>
            )}
            <div className="d-flex align-items-center gap-2 flex-wrap mt-1" style={{ fontSize: '0.7rem' }}>
              {task.brand?.brand_name && (
                <span className="badge rounded-pill" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                  <i className="bi bi-shop me-1" />{task.brand.brand_name}
                </span>
              )}
              {isManager && task.assignee?.display_name && (
                <span className="text-muted"><i className="bi bi-person me-1" />{task.assignee.display_name}</span>
              )}
              {due && (
                <span style={{ color: overdue ? 'var(--danger)' : 'var(--text-secondary)', fontWeight: overdue ? 700 : 400 }}>
                  <i className="bi bi-calendar3 me-1" />Due {due}
                </span>
              )}
              {task.link && (
                <a href={task.link} target="_blank" rel="noreferrer" style={{ fontSize: '0.7rem' }}>
                  <i className="bi bi-link-45deg" />Link
                </a>
              )}
            </div>
          </div>

          <div className="d-flex flex-column align-items-end gap-2">
            {/* Status segmented control */}
            <div className="d-flex gap-1">
              {STATUS_ORDER.map((s) => {
                const active = task.status === s;
                const meta = STATUS[s];
                return (
                  <button key={s} type="button" disabled={!canEdit || busy}
                    onClick={() => setStatus(s)}
                    className="border-0 rounded-2 px-2 py-1"
                    style={{
                      fontSize: '0.68rem', fontWeight: 600,
                      background: active ? meta.color : meta.bg,
                      color: active ? 'var(--surface-1)' : meta.color,
                      cursor: canEdit ? 'pointer' : 'default',
                      opacity: canEdit ? 1 : 0.7,
                    }}>
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <div className="d-flex align-items-center gap-2">
              {canEdit && (
                <label className="d-inline-flex align-items-center gap-1 text-muted" style={{ fontSize: '0.66rem', cursor: 'pointer' }}>
                  <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                  Notify on change
                </label>
              )}
              {canDelete && (
                <button className="btn btn-sm btn-outline-danger px-2 py-0" style={{ fontSize: '0.66rem', borderRadius: 6 }}
                  disabled={busy} onClick={handleDelete}>
                  <i className="bi bi-trash" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
