// Tasks as a list or a board, with tabs, filters and search.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDev } from '../../pages/development/DevelopmentContext';
import { Avatar, EmptyState, PriorityFlag, Segmented, StatusPill, TypeIcon } from './ui';
import { PRIORITIES, STATUSES, compareTasks, firstName, isOverdue, shortDate, taskCode } from './devModel';
import { readPref, writePref } from './prefs';

const STATUS_RANK = { blocked: 0, in_review: 1, in_progress: 2, todo: 3, done: 4 };

export default function TaskListPanel({
  title = 'Tasks', storageKey = 'dv.tasks.layout', fixedType = null, fixedProjectId = null, addDefaults = {},
}) {
  const { data, maps, profile, activeProjects, openTask, openNewTask } = useDev();
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const wanted = params.get('status');
    return ['mine', 'moving', 'blocked', 'done'].includes(wanted) ? wanted : 'all';
  });
  const [layout, setLayout] = useState(() => readPref(storageKey, 'list'));
  const [projectId, setProjectId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => writePref(storageKey, layout), [storageKey, layout]);

  const scoped = useMemo(
    () => data.tasks.filter((t) => (!fixedType || t.type === fixedType) && (!fixedProjectId || t.project_id === fixedProjectId)),
    [data.tasks, fixedType, fixedProjectId],
  );

  const counts = {
    mine: scoped.filter((t) => t.assignee_id === profile?.id && t.status !== 'done').length,
    moving: scoped.filter((t) => t.status === 'in_progress' || t.status === 'in_review').length,
    blocked: scoped.filter((t) => t.status === 'blocked').length,
  };

  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    return scoped
      .filter((t) => {
        if (tab === 'mine' && t.assignee_id !== profile?.id) return false;
        if (tab === 'moving' && !(t.status === 'in_progress' || t.status === 'in_review')) return false;
        if (tab === 'blocked' && t.status !== 'blocked') return false;
        if (tab === 'done' && t.status !== 'done') return false;
        if (projectId && t.project_id !== projectId) return false;
        if (assigneeId === 'none' ? t.assignee_id : assigneeId && t.assignee_id !== assigneeId) return false;
        if (type && t.type !== type) return false;
        if (priority && t.priority !== priority) return false;
        if (text && !(t.title.toLowerCase().includes(text) || taskCode(t).toLowerCase().includes(text))) return false;
        return true;
      })
      .sort((a, b) => (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || compareTasks(a, b));
  }, [scoped, tab, projectId, assigneeId, type, priority, query, profile?.id]);

  const filtering = !!(projectId || assigneeId || type || priority || query.trim());
  const clear = () => {
    setProjectId(''); setAssigneeId(''); setType(''); setPriority(''); setQuery(''); setTab('all');
  };

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'mine', label: 'My tasks', count: counts.mine },
    { key: 'moving', label: 'In progress', count: counts.moving },
    { key: 'blocked', label: 'Blocked', count: counts.blocked, alert: counts.blocked > 0 },
    { key: 'done', label: 'Done' },
  ];

  return (
    <section className="dv-panel dv-tasks-panel" aria-label={title}>
      <div className="dv-panel-head">
        <h2>{title} <span className="dv-muted">/ {scoped.length}</span></h2>
        <div className="dv-panel-head-actions">
          <Segmented
            label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'list', icon: 'bi-list-ul', title: 'List' },
              { value: 'board', icon: 'bi-kanban', title: 'Board' },
            ]}
          />
          <button
            type="button"
            className="dv-btn is-sm"
            onClick={() => openNewTask({ projectId: fixedProjectId || projectId || undefined, type: fixedType || undefined, ...addDefaults })}
          >
            <i className="bi bi-plus-lg" aria-hidden="true" />{fixedType === 'bug' ? 'Report a bug' : 'Add task'}
          </button>
        </div>
      </div>

      <div className="dv-tabs is-underline" role="tablist" aria-label="Filter by status">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'is-on' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count > 0 && <span className={`dv-count${t.alert ? ' is-alert' : ''}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="dv-toolbar">
        <span className="dv-search-inline">
          <i className="bi bi-search" aria-hidden="true" />
          <input
            className="dv-input"
            value={query}
            placeholder="Search tasks"
            aria-label="Search tasks"
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
        {!fixedProjectId && (
          <select className="dv-select is-sm" aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <select className="dv-select is-sm" aria-label="Owner" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {data.people.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
        </select>
        {!fixedType && (
          <select className="dv-select is-sm" aria-label="Type" value={type} onChange={(event) => setType(event.target.value)}>
            <option value="">Features and bugs</option>
            <option value="feature">Features</option>
            <option value="bug">Bugs</option>
          </select>
        )}
        <select className="dv-select is-sm" aria-label="Priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {filtering && <button type="button" className="dv-link" onClick={clear}>Clear filters</button>}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          compact
          icon={scoped.length ? 'bi-funnel' : 'bi-check2-square'}
          title={scoped.length ? 'No tasks match this view' : fixedType === 'bug' ? 'No bugs reported' : 'No tasks yet'}
          action={scoped.length ? <button type="button" className="dv-btn is-sm" onClick={clear}>Clear filters</button> : null}
        />
      ) : layout === 'board' ? (
        <TaskBoard rows={rows} />
      ) : (
        <div className="dv-table-wrap">
          <table className="dv-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Priority</th>
                <th scope="col">Owner</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => {
                const project = maps.projectById.get(task.project_id);
                const release = task.release_id ? maps.releaseById.get(task.release_id) : null;
                const owner = maps.personById.get(task.assignee_id);
                return (
                  <tr key={task.id} onClick={() => openTask(task.number)}>
                    <td>
                      <button
                        type="button"
                        className="dv-row-title"
                        onClick={(event) => { event.stopPropagation(); openTask(task.number); }}
                      >
                        <TypeIcon type={task.type} />
                        <span>{task.title}</span>
                      </button>
                      <div className="dv-row-meta">
                        {project && <span className={`dv-dot c-${project.color}`} aria-hidden="true" />}
                        <span>{project?.name}</span>
                        <span className="dv-mono">· {taskCode(task)}</span>
                        {release && <span>· {release.name}</span>}
                      </div>
                    </td>
                    <td><StatusPill status={task.status} /></td>
                    <td><PriorityFlag priority={task.priority} /></td>
                    <td>
                      <span className="dv-row-owner">
                        <Avatar person={owner} size={24} />
                        <span>{owner ? firstName(owner.display_name) : 'Unassigned'}</span>
                      </span>
                    </td>
                    <td className={`dv-date${isOverdue(task) ? ' is-overdue' : ''}`}>{task.due_date ? shortDate(task.due_date) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TaskBoard({ rows }) {
  const { maps, canEdit, moveTask, openTask } = useDev();
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const dragged = dragId ? maps.taskById.get(dragId) : null;

  return (
    <div className="dv-board">
      {STATUSES.map((status) => {
        const column = rows.filter((t) => t.status === status.key);
        return (
          <section
            key={status.key}
            className={`dv-board-col${over === status.key ? ' is-drop' : ''}`}
            aria-label={`${status.label}, ${column.length}`}
            onDragOver={(event) => {
              if (!dragged || dragged.status === status.key) return;
              event.preventDefault();
              if (over !== status.key) setOver(status.key);
            }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOver(null); }}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              setDragId(null);
              if (dragged && dragged.status !== status.key) moveTask(dragged, status.key);
            }}
          >
            <header>
              <StatusPill status={status.key} />
              <span className="dv-count">{column.length}</span>
            </header>
            {column.map((task) => {
              const project = maps.projectById.get(task.project_id);
              const owner = maps.personById.get(task.assignee_id);
              const editable = canEdit(task);
              return (
                <button
                  key={task.id}
                  type="button"
                  className={`dv-board-card${dragId === task.id ? ' is-dragging' : ''}`}
                  draggable={editable}
                  onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); setDragId(task.id); }}
                  onDragEnd={() => { setDragId(null); setOver(null); }}
                  onClick={() => openTask(task.number)}
                >
                  <span className="dv-board-card-meta">
                    <TypeIcon type={task.type} />
                    <span className="dv-mono">{taskCode(task)}</span>
                    <span>· {project?.name}</span>
                  </span>
                  <span className="dv-board-card-title">{task.title}</span>
                  <span className="dv-board-card-foot">
                    <PriorityFlag priority={task.priority} />
                    <span className={`dv-mono${isOverdue(task) ? ' is-overdue' : ''}`}>{task.due_date ? shortDate(task.due_date) : ''}</span>
                    <Avatar person={owner} size={22} />
                  </span>
                </button>
              );
            })}
            {!column.length && <p className="dv-board-empty">Nothing here</p>}
          </section>
        );
      })}
    </div>
  );
}
