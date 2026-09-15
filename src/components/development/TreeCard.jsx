// A task on the roadmap tree. Owner, priority, status and due date change right
// on the card; its checklist opens underneath as the tree's last level.
import { useState } from 'react';
import { useDev } from '../../pages/development/DevelopmentContext';
import { Avatar, PriorityFlag, StatusPill, TypeIcon } from './ui';
import { PRIORITIES, STATUSES, STATUS_BY_KEY, firstName, isOverdue, shortDate, taskCode } from './devModel';
import { useChecklist, useChecklistActions } from './TaskChecklist';

export default function TreeCard({ task, dragging = false, onDragStart, onDragEnd }) {
  const { data, maps, isBoss, canEdit, patchTask, moveTask, openTask } = useDev();
  const [expanded, setExpanded] = useState(false);
  const editable = canEdit(task);
  const stats = data.statsByTask[task.id] || {};
  const owner = maps.personById.get(task.assignee_id);
  const code = taskCode(task);
  const tone = STATUS_BY_KEY[task.status]?.tone || 'todo';
  const overdue = isOverdue(task);

  return (
    <article
      className={`dv-card is-${tone}${dragging ? ' is-dragging' : ''}${editable ? ' is-draggable' : ''}`}
      draggable={editable}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', task.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart?.(task);
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      <div className="dv-card-top">
        <span className="dv-card-code"><TypeIcon type={task.type} />{code}</span>
        {editable ? (
          <select
            className={`dv-pill-select is-priority is-${task.priority}`}
            value={task.priority}
            aria-label={`Priority of ${code}`}
            onChange={(event) => patchTask(task, { priority: event.target.value })}
          >
            {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        ) : (
          <PriorityFlag priority={task.priority} />
        )}
      </div>

      <button type="button" className="dv-card-title" onClick={() => openTask(task.number)}>
        {task.title}
      </button>

      {task.status === 'blocked' && task.blocked_reason && (
        <button type="button" className="dv-card-reason" onClick={() => openTask(task.number)}>
          <i className="bi bi-exclamation-triangle" aria-hidden="true" />
          <span>{task.blocked_reason}</span>
        </button>
      )}

      <div className="dv-card-row">
        {editable ? (
          <select
            className={`dv-pill-select is-status is-${tone}`}
            value={task.status}
            aria-label={`Status of ${code}`}
            onChange={(event) => moveTask(task, event.target.value)}
          >
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        ) : (
          <StatusPill status={task.status} />
        )}
        <span className="dv-card-counts">
          {stats.checklist_total > 0 && (
            <button
              type="button"
              className={`dv-card-chip${expanded ? ' is-on' : ''}`}
              aria-expanded={expanded}
              title={expanded ? 'Hide checklist' : 'Show checklist'}
              onClick={() => setExpanded((v) => !v)}
            >
              <i className="bi bi-list-check" aria-hidden="true" />
              {stats.checklist_done}/{stats.checklist_total}
            </button>
          )}
          <button type="button" className="dv-card-chip" title="Comments and files" onClick={() => openTask(task.number)}>
            <i className="bi bi-chat" aria-hidden="true" />{stats.comments || 0}
            {stats.files > 0 && (<><i className="bi bi-paperclip" aria-hidden="true" />{stats.files}</>)}
          </button>
        </span>
      </div>

      {expanded && <CardChecklist task={task} editable={editable} />}

      <div className="dv-card-foot">
        <span className="dv-card-owner">
          <Avatar person={owner} size={22} />
          {isBoss ? (
            <select
              className="dv-bare-select"
              value={task.assignee_id || ''}
              aria-label={`Owner of ${code}`}
              onChange={(event) => patchTask(task, { assignee_id: event.target.value || null })}
            >
              <option value="">Unassigned</option>
              {data.people.map((person) => (
                <option key={person.id} value={person.id}>{firstName(person.display_name)}</option>
              ))}
            </select>
          ) : (
            <span>{owner ? firstName(owner.display_name) : 'Unassigned'}</span>
          )}
        </span>
        <span className={`dv-card-due${overdue ? ' is-overdue' : ''}`} title={overdue ? 'Overdue' : undefined}>
          <i className="bi bi-calendar3" aria-hidden="true" />
          {editable ? (
            <input
              type="date"
              className="dv-bare-date"
              value={task.due_date || ''}
              aria-label={`Due date of ${code}`}
              onChange={(event) => patchTask(task, { due_date: event.target.value || null })}
            />
          ) : (
            <span>{task.due_date ? shortDate(task.due_date) : 'No date'}</span>
          )}
        </span>
      </div>
    </article>
  );
}

function CardChecklist({ task, editable }) {
  const checklist = useChecklist(task.id);
  const actions = useChecklistActions(task.id);
  if (checklist.isLoading) {
    return <div className="dv-card-checklist is-loading"><span className="dv-spinner is-sm" /></div>;
  }
  return (
    <ul className="dv-card-checklist" aria-label={`Checklist of ${taskCode(task)}`}>
      {(checklist.data || []).map((item) => (
        <li key={item.id} className={item.done ? 'is-done' : ''}>
          <label className="dv-check is-sm">
            <input
              type="checkbox"
              checked={item.done}
              disabled={!editable}
              aria-label={item.body}
              onChange={() => actions.toggle(item)}
            />
            <span aria-hidden="true"><i className="bi bi-check" /></span>
          </label>
          <span>{item.body}</span>
        </li>
      ))}
    </ul>
  );
}
