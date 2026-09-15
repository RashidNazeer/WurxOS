// One task in a list: status, title and acceptance check, where it belongs,
// priority, and what happens next — its due date, who has it ("with Ali"), or
// "mark live" when it is the viewer's to deploy.
import { Avatar, StatusPill, PriorityPill } from './Primitives';
import { firstName, shortDate } from './devFormat';

function nextStep(task, viewerId) {
  if (task.status === 'dev_review') return `with ${firstName(task.reviewer) || 'senior dev'}`;
  if (task.status === 'your_review') return `with ${firstName(task.finalReviewer) || 'Usman'}`;
  if (task.status === 'tested') return viewerId === task.owner_id ? 'mark live' : 'ready to deploy';
  if (task.status === 'live') return task.resolution === 'duplicate' ? 'duplicate' : 'live';
  return task.due_date ? `due ${shortDate(task.due_date)}` : 'no due date';
}

export default function TaskRow({ task, feature, viewerId, onOpen }) {
  const readyToShip = task.status === 'tested' && viewerId === task.owner_id;

  return (
    <button type="button" className="dev-task-row" onClick={() => onOpen(task)}>
      <StatusPill status={task.status} />
      <span className="dev-task-copy">
        <strong>{task.title}</strong>
        <small>
          {readyToShip ? 'Deploy with the next release.' : task.acceptance_check || 'Acceptance check not added yet.'}
        </small>
      </span>
      <span className="dev-task-context">
        {feature?.project_name}
        <small>{feature?.title}</small>
      </span>
      <PriorityPill priority={task.priority} />
      <span className="dev-task-due">{nextStep(task, viewerId)}</span>
      <Avatar person={task.owner} />
      <i className="bi bi-chevron-right" aria-hidden="true" />
    </button>
  );
}
