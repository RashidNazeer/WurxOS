// "Waiting on you" — the Boss's queue: tasks sent for final review, and blocked
// tasks that are either unplanned or blocked on him. Oldest first, and anything
// waiting 48 hours or more is marked late.
import { StatusPill, PriorityPill } from './Primitives';
import { age, firstName } from './devFormat';

const LATE_AFTER_MS = 48 * 3600000;

function mentionsBoss(task) {
  const name = (firstName(task.finalReviewer) || 'Usman').toLowerCase();
  return String(task.blocked_reason || '').toLowerCase().includes(name);
}

// "Wurx Creator App › Landing page · owner Hamza · passed by Ali"
function context(task, feature) {
  const parts = [
    `${feature?.project_name || 'Unknown product'} › ${feature?.title || 'Unknown feature'}`,
    `owner ${task.owner?.display_name || 'unassigned'}`,
  ];
  // A junior's task reaches final review only after the senior passed it.
  if (task.status === 'your_review' && task.reviewer_id && task.reviewer_id !== task.final_reviewer_id) {
    parts.push(`passed by ${task.reviewer?.display_name || 'the senior developer'}`);
  }
  if (task.status === 'blocked' && task.blocked_reason) parts.push(`“${task.blocked_reason}”`);
  return parts.join(' · ');
}

export default function WaitingStrip({ tasks, features, onOpen }) {
  const featureById = Object.fromEntries(features.map((feature) => [feature.id, feature]));

  const waiting = tasks
    .filter((task) => task.status === 'your_review'
      || (task.status === 'blocked' && (!featureById[task.task_id]?.block_id || mentionsBoss(task))))
    .sort((a, b) => new Date(a.status_changed_at) - new Date(b.status_changed_at));

  if (!waiting.length) return null;

  return (
    <section className="dev-waiting" aria-label="Waiting on you">
      <div className="dev-waiting-title">
        <i className="bi bi-hourglass-split" aria-hidden="true" /> Waiting on you <b>{waiting.length}</b>
      </div>
      <div className="dev-waiting-list">
        {waiting.map((task) => {
          const late = Date.now() - new Date(task.status_changed_at).getTime() >= LATE_AFTER_MS;
          return (
            <button type="button" className="dev-waiting-row" key={task.id} onClick={() => onOpen(task)}>
              <span className="dev-waiting-copy">
                <strong>{task.title}</strong>
                <small>{context(task, featureById[task.task_id])}</small>
              </span>
              <StatusPill status={task.status} />
              <PriorityPill priority={task.priority} />
              <span className={`dev-age${late ? ' is-late' : ''}`} title="Time since it entered this status">
                {age(task.status_changed_at)}
              </span>
              <i className="bi bi-chevron-right" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
