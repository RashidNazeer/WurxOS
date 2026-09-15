// A feature: owner, progress, where it is planned, its description and tasks.
import { useState } from 'react';
import { ROLLUP_META, sortWorkTasks } from '../../lib/devTasksApi';
import DevDrawer from './DevDrawer';
import TaskRow from './TaskRow';
import WorkTaskModal from './WorkTaskModal';
import { Avatar, PriorityPill, Empty } from './Primitives';
import { blockPhrase } from './devBlocks';

export default function FeatureDrawer({
  feature, tasks, blocks = [], developers, viewerId, canEdit, onClose, onOpenTask, onRefresh,
}) {
  const [adding, setAdding] = useState(false);
  const rollup = ROLLUP_META[feature.rollup_status];
  const total = Number(feature.subtask_total || 0);

  const meta = (
    <>
      <PriorityPill priority={feature.priority} />
      {rollup && <span className={`dev-rollup is-${rollup.tone}`}>{rollup.label}</span>}
      <em>
        {blockPhrase(feature.block_id, blocks)}
        {feature.scope_added > 0 ? ` · +${feature.scope_added} since planning` : ''}
      </em>
    </>
  );

  return (
    <>
      <DevDrawer crumb={`${feature.project_name} › feature`} title={feature.title} meta={meta} onClose={onClose}>
        <div className="dev-feature-summary">
          <span>
            <small>Owner</small>
            <b><Avatar person={feature.owner} />{feature.owner?.display_name || 'Unassigned'}</b>
          </span>
          <span>
            <small>Progress</small>
            <b>{total ? `${feature.subtask_done}/${total} tested` : 'no tasks yet'}</b>
          </span>
        </div>

        {feature.description && <p className="dev-feature-description">{feature.description}</p>}

        <div className="dev-drawer-section-head">
          <h3>Tasks</h3>
          {canEdit && (
            <button type="button" className="wx-btn wx-btn-primary" onClick={() => setAdding(true)}>
              <i className="bi bi-plus-lg" aria-hidden="true" /> Add task
            </button>
          )}
        </div>

        <div className="dev-task-list compact">
          {sortWorkTasks(tasks).map((task) => (
            <TaskRow key={task.id} task={task} feature={feature} viewerId={viewerId} onOpen={onOpenTask} />
          ))}
          {!tasks.length && <Empty title="No tasks yet" body="Break this feature into testable pieces." />}
        </div>
      </DevDrawer>

      {adding && (
        <WorkTaskModal
          feature={feature}
          developers={developers}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); onRefresh(); }}
        />
      )}
    </>
  );
}
