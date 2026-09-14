// One task in a list: status, title and acceptance check, where it belongs,
// priority, due date and owner.
import { Avatar, StatusPill, PriorityPill } from './Primitives';
import { shortDate } from './devFormat';

export default function TaskRow({ task, feature, onOpen }) {
  return (
    <button type="button" className="dev-task-row" onClick={() => onOpen(task)}>
      <StatusPill status={task.status} />
      <span className="dev-task-copy">
        <strong>{task.title}</strong>
        <small>{task.acceptance_check || 'Acceptance check not added yet.'}</small>
      </span>
      <span className="dev-task-context">
        {feature?.project_name}
        <small>{feature?.title}</small>
      </span>
      <PriorityPill priority={task.priority} />
      <span className="dev-task-due">{task.due_date ? `due ${shortDate(task.due_date)}` : 'no due date'}</span>
      <Avatar person={task.owner} />
      <i className="bi bi-chevron-right" aria-hidden="true" />
    </button>
  );
}
