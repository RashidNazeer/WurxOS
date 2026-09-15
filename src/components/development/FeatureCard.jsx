// One feature on the roadmap. Its left edge is coloured by how its tasks are
// going, and its owner's avatar turns red on their fourth feature in the
// running block.
import { ROLLUP_META } from '../../lib/devTasksApi';
import { Avatar, PriorityPill } from './Primitives';

export default function FeatureCard({ feature, now, note, draggable, overload, onOpen, onDragStart }) {
  const rollup = ROLLUP_META[feature.rollup_status] || ROLLUP_META.backlog;
  const blocked = Number(feature.status_counts?.blocked || 0);
  const total = Number(feature.subtask_total || 0);

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
      <span className="dev-feature-progress">
        {total ? `${feature.subtask_done}/${total}` : 'no tasks yet'}
      </span>
      {blocked > 0 && <span className="dev-feature-blocked">{blocked} blocked</span>}
      {note && <span className="dev-feature-note">{note}</span>}
    </button>
  );
}
