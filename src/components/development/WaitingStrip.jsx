// "Waiting on you" — the Boss's queue: tasks sent for final review, and blocked
// tasks that are either unplanned or blocked on him. Oldest first, and anything
// waiting 48 hours or more is marked late.
import { StatusPill, PriorityPill } from './Primitives';
import { age } from './devFormat';

const LATE_AFTER_MS = 48 * 3600000;

export default function WaitingStrip({ tasks, features, onOpen }) {
  const featureById = Object.fromEntries(features.map((feature) => [feature.id, feature]));

  const waiting = tasks
    .filter((task) => task.status === 'your_review'
      || (task.status === 'blocked'
        && (!featureById[task.task_id]?.block_id || /usman/i.test(task.blocked_reason || ''))))
    .sort((a, b) => new Date(a.status_changed_at) - new Date(b.status_changed_at));

  if (!waiting.length) return null;

  return (
    <section className="dev-waiting" aria-label="Waiting on you">
      <div className="dev-waiting-title">
        <i className="bi bi-hourglass-split" aria-hidden="true" /> Waiting on you <b>{waiting.length}</b>
      </div>
      <div className="dev-waiting-list">
        {waiting.map((task) => {
          const feature = featureById[task.task_id];
          const late = Date.now() - new Date(task.status_changed_at).getTime() >= LATE_AFTER_MS;
          return (
            <button type="button" className="dev-waiting-row" key={task.id} onClick={() => onOpen(task)}>
              <span className="dev-waiting-copy">
                <strong>{task.title}</strong>
                <small>
                  {feature?.project_name} › {feature?.title} · owner {task.owner?.display_name || 'unassigned'}
                  {task.blocked_reason ? ` · “${task.blocked_reason}”` : ''}
                </small>
              </span>
              <StatusPill status={task.status} />
              <PriorityPill priority={task.priority} />
              <span className={`dev-age${late ? ' is-late' : ''}`}>{age(task.status_changed_at)}</span>
              <i className="bi bi-chevron-right" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
