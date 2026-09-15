// Every task, filterable by status. The Bugs tab is this same list restricted
// to reported issues. Picking a product on the roadmap narrows both.
import { useState } from 'react';
import { STATUS_META, sortWorkTasks } from '../../lib/devTasksApi';
import TaskRow from './TaskRow';
import { Empty } from './Primitives';

function matchesStatus(task, filter) {
  if (filter === 'all') return true;
  if (filter === 'open') return task.status !== 'live';
  return task.status === filter;
}

export default function ListView({ tasks, features, viewerId, productId = null, source = null, onOpen }) {
  const [status, setStatus] = useState('open');
  const featureById = Object.fromEntries(features.map((feature) => [feature.id, feature]));
  const rows = sortWorkTasks(tasks.filter((task) => (!source || task.source === source)
    && (!productId || featureById[task.task_id]?.project_id === productId)
    && matchesStatus(task, status)));
  const isBugs = source === 'bug_report';

  return (
    <>
      <div className="dev-list-toolbar">
        <select
          className="wx-input"
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="open">Open work</option>
          <option value="all">Every status</option>
          {Object.entries(STATUS_META).map(([value, meta]) => (
            <option value={value} key={value}>{meta.label}</option>
          ))}
        </select>
        <span>{rows.length} {isBugs ? 'bug' : 'task'}{rows.length === 1 ? '' : 's'}</span>
      </div>

      <div className="dev-task-list">
        {rows.map((task) => (
          <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} viewerId={viewerId} onOpen={onOpen} />
        ))}
        {!rows.length && (
          <Empty
            title={isBugs ? 'No bugs here' : 'Nothing here'}
            body={isBugs
              ? 'Issues reported from the user menu appear here.'
              : 'Change the filter or add a task to a feature.'}
          />
        )}
      </div>
    </>
  );
}
