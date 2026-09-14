// One feature on the roadmap. Its left edge is coloured by how its tasks are
// going, and its owner's avatar turns red when they hold more than three
// features in the current block.
import { ROLLUP_META } from '../../lib/devTasksApi';
import { Avatar, PriorityPill } from './Primitives';

export default function FeatureCard({ feature, now, draggable, overload, onOpen, onDragStart }) {
  const rollup = ROLLUP_META[feature.rollup_status] || ROLLUP_META.backlog;
  const blocked = Number(feature.status_counts?.blocked || 0);

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(event) => onDragStart?.(event, feature)}
      onClick={() => onOpen(feature)}
      className={`dev-feature is-${rollup.tone}${now ? ' in-now' : ''}`}
    >
      <span className="dev-feature-main">
        <strong>{feature.title}</strong>
        <span>
          <PriorityPill priority={feature.priority} />
          {feature.scope_added > 0 && <em>+{feature.scope_added} since planning</em>}
        </span>
      </span>
      <Avatar person={feature.owner} alert={overload} />
      <span className="dev-feature-progress">{feature.subtask_done}/{feature.subtask_total}</span>
      {blocked > 0 && <span className="dev-feature-blocked">{blocked} blocked</span>}
    </button>
  );
}
