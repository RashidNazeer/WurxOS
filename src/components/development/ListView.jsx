// Every task, filterable by status. The Bugs tab is this same list restricted
// to reported issues.
import { useState } from 'react';
import { STATUS_META, sortWorkTasks } from '../../lib/devTasksApi';
import TaskRow from './TaskRow';
import { Empty } from './Primitives';

function matchesStatus(task, filter) {
  if (filter === 'all') return true;
  if (filter === 'open') return task.status !== 'live';
  return task.status === filter;
}

export default function ListView({ tasks, features, onOpen, source = null }) {
  const [status, setStatus] = useState('open');
  const featureById = Object.fromEntries(features.map((feature) => [feature.id, feature]));
  const rows = sortWorkTasks(tasks.filter((task) => (!source || task.source === source) && matchesStatus(task, status)));

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
        <span>{rows.length} task{rows.length === 1 ? '' : 's'}</span>
      </div>

      <div className="dev-task-list">
        {rows.map((task) => (
          <TaskRow key={task.id} task={task} feature={featureById[task.task_id]} onOpen={onOpen} />
        ))}
        {!rows.length && <Empty title="Nothing here" body="Change the filter or add a task to a feature." />}
      </div>
    </>
  );
}
