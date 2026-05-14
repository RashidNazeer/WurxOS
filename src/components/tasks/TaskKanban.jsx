import { useMemo, useState } from 'react';
import BrandAvatar from '../brands/BrandAvatar';
import { updateTask } from '../../lib/tasksApi';
import { PencilIcon } from '../common/Icon';

const COLUMNS = [
  { status: 'todo',        label: 'To do',        tone: 'var(--border-strong)' },
  { status: 'in_progress', label: 'In progress',  tone: 'var(--warning)' },
  { status: 'done',        label: 'Done',         tone: 'var(--success)' },
];

export default function TaskKanban({ rows, canEditRow, currentUserId, onEdit, onView, onLocalPatch }) {
  const [dragOver, setDragOver] = useState(null);

  const grouped = useMemo(() => {
    const g = { todo: [], in_progress: [], done: [] };
    rows.forEach((r) => { (g[r.status] || (g[r.status] = [])).push(r); });
    return g;
  }, [rows]);

  async function handleDrop(e, targetStatus) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/task-id');
    if (!id) return;
    const row = rows.find((r) => r.id === id);
    if (!row || row.status === targetStatus) return;

    // Brand-inactive tasks are frozen — drag-and-drop is a no-op. The
    // server-side trigger (mig 171) would reject the update anyway.
    if (row.brand?.status === 'inactive') return;
    const canChange = canEditRow(row) || row.assignee_id === currentUserId;
    if (!canChange) return;

    // Optimistic patch
    onLocalPatch?.({ ...row, status: targetStatus });
    try {
      const updated = await updateTask(id, { status: targetStatus });
      onLocalPatch?.({ ...row, ...(updated || { status: targetStatus }) });
    } catch (_) {
      // Revert on failure
      onLocalPatch?.(row);
    }
  }

  return (
    <div className="task-kanban">
      {COLUMNS.map((col) => {
        const list = grouped[col.status] || [];
        return (
          <div
            key={col.status}
            className={`task-kanban-col ${dragOver === col.status ? 'task-kanban-col-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(col.status); }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => handleDrop(e, col.status)}
          >
            <div className="task-kanban-col-header">
              <span className="task-kanban-col-dot" style={{ background: col.tone }} />
              <span className="task-kanban-col-label">{col.label}</span>
              <span className="task-kanban-col-count">{list.length}</span>
            </div>

            <div className="task-kanban-col-body">
              {list.length === 0 ? (
                <div className="task-kanban-empty">No tasks</div>
              ) : list.map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  canEdit={canEditRow(t)}
                  isAssignee={t.assignee_id === currentUserId}
                  onEdit={() => onEdit(t)}
                  onView={onView ? () => onView(t) : null}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({ task, canEdit, isAssignee, onEdit, onView }) {
  const canDrag = canEdit || isAssignee;
  return (
    <div
      className="task-kanban-card"
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) { e.preventDefault(); return; }
        e.dataTransfer.setData('text/task-id', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      data-draggable={canDrag}
      onClick={onView ? () => onView() : undefined}
      style={{ cursor: onView ? 'pointer' : undefined }}
    >
      <div className="task-kanban-card-title">{task.title}</div>
      {task.description && (
        <div className="task-kanban-card-body">{task.description}</div>
      )}
      <div className="task-kanban-card-meta">
        {task.brand && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <BrandAvatar brand={task.brand} size={14} radius={3} />
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{task.brand.brand_name}</span>
          </span>
        )}
        {task.assignee && (
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            → {task.assignee.display_name}
          </span>
        )}
        <span className={`task-chip task-chip-priority-${task.priority}`} style={{ fontSize: 10 }}>
          {task.priority}
        </span>
        {task.covered_from_user_id && (
          <span className="task-chip" style={{
            fontSize: 10,
            background: 'color-mix(in srgb, var(--warning) 20%, transparent)',
            color: 'var(--warning)',
          }} title="On coverage while original owner is on leave">
            Coverage
          </span>
        )}
      </div>
      {canEdit && (
        <button
          type="button"
          className="task-kanban-card-edit"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          title="Edit"
        >
          <PencilIcon width="12" height="12" />
        </button>
      )}
    </div>
  );
}
