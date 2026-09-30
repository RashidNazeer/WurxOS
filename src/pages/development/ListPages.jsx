// Development → All tasks, Bugs, Team, Activity.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDev } from './DevelopmentContext';
import { Avatar, DevHeader, EmptyState, ProgressBar, Spinner, StatusPill, TypeIcon } from '../../components/development/ui';
import TaskListPanel from '../../components/development/TaskListPanel';
import { ActivityFeed } from '../../components/development/Activity';
import { compareTasks, taskCode } from '../../components/development/devModel';
import { listActivity } from '../../lib/developmentApi';

export function AllTasksPage() {
  const { openSearch } = useDev();
  return (
    <div className="dv-page">
      <DevHeader
        title="All tasks"
        subtitle="The team’s work, with clear owners and next steps."
        actions={(
          <button type="button" className="dv-btn is-ghost" onClick={openSearch}>
            <i className="bi bi-search" aria-hidden="true" />Find a task <kbd>/</kbd>
          </button>
        )}
      />
      <TaskListPanel title="Tasks" storageKey="dv.tasks.layout" />
    </div>
  );
}

export function BugsPage() {
  const { openNewTask } = useDev();
  return (
    <div className="dv-page">
      <DevHeader
        title="Bug tracker"
        subtitle="Report, prioritise, and resolve product issues."
        actions={(
          <button type="button" className="dv-btn is-primary" onClick={() => openNewTask({ type: 'bug' })}>
            <i className="bi bi-bug" aria-hidden="true" />Report a bug
          </button>
        )}
      />
      <TaskListPanel title="Bugs" storageKey="dv.bugs.layout" fixedType="bug" />
    </div>
  );
}

const CAPACITY = 6;

// A developer counts as a lead the moment another developer's reports_to
// points to them — structural, not a text-tag match, so it can't drift from
// the responsibilities pills (mirrors teamApi.fetchHierarchy's same rule for
// the Team Hierarchy org chart). A lone developer with no team yet is
// neither a lead nor a junior — just "Developer", same as before.
function devRoleLabels(people) {
  const leadIds = new Set(
    people.filter((p) => p.role === 'developer' && p.reports_to).map((p) => p.reports_to),
  );
  const byId = new Map(people.map((p) => [p.id, p]));
  const labelFor = (p) => {
    if (p.role === 'boss') return 'Boss';
    if (leadIds.has(p.id)) return 'Team Lead';
    if (p.reports_to && leadIds.has(p.reports_to)) return 'Junior Developer';
    return 'Developer';
  };
  const managerNameOf = (p) => (p.reports_to ? byId.get(p.reports_to)?.display_name : null);
  return { leadIds, labelFor, managerNameOf };
}

export function TeamPage() {
  const { data, maps, openTask } = useDev();
  const { leadIds, labelFor, managerNameOf } = devRoleLabels(data.people);
  // Boss first, then leads, then everyone else — so a lead's card sits
  // above their own juniors rather than in arbitrary created_at order.
  const people = [...data.people].sort((a, b) => {
    if (a.role === 'boss' || b.role === 'boss') return a.role === 'boss' ? -1 : 1;
    if (leadIds.has(a.id) !== leadIds.has(b.id)) return leadIds.has(a.id) ? -1 : 1;
    return 0;
  });

  return (
    <div className="dv-page">
      <DevHeader title="Team workload" subtitle="See who’s working on what, and where support is needed." />
      {people.length === 0 ? (
        <EmptyState icon="bi-people" title="No one in Development yet" />
      ) : (
        <div className="dv-team-grid">
          {people.map((person) => {
            const open = data.tasks.filter((t) => t.assignee_id === person.id && t.status !== 'done').sort(compareTasks);
            const blocked = open.filter((t) => t.status === 'blocked').length;
            const load = Math.min(100, Math.round((open.length / CAPACITY) * 100));
            const manager = managerNameOf(person);
            return (
              <section key={person.id} className="dv-panel dv-member" aria-label={person.display_name}>
                <div className="dv-member-head">
                  <Avatar person={person} size={48} />
                  <div>
                    <h2>{person.display_name}</h2>
                    <p>{labelFor(person)}{manager ? ` · reports to ${manager}` : ''}</p>
                  </div>
                </div>
                <div className="dv-member-load">
                  <strong>{open.length} open task{open.length === 1 ? '' : 's'}</strong>
                  <ProgressBar pct={load} color={blocked ? 'amber' : 'green'} label={`${person.display_name} workload`} />
                  <p className={blocked ? 'is-bad' : ''}>{blocked ? `${blocked} blocked · support needed` : 'Workload on track'}</p>
                </div>
                <ul className="dv-member-tasks">
                  {open.slice(0, 8).map((task) => (
                    <li key={task.id}>
                      <button type="button" onClick={() => openTask(task.number)}>
                        <span className="dv-member-task-meta">
                          <TypeIcon type={task.type} />
                          <span className="dv-mono">{taskCode(task)}</span>
                          <span>· {maps.projectById.get(task.project_id)?.name}</span>
                        </span>
                        <span className="dv-member-task-title">{task.title}</span>
                        <StatusPill status={task.status} />
                      </button>
                    </li>
                  ))}
                  {open.length > 8 && <li className="dv-muted">and {open.length - 8} more</li>}
                  {!open.length && <li className="dv-muted">No open tasks.</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ActivityPage() {
  const { data, maps, activeProjects, openTask } = useDev();
  const [projectId, setProjectId] = useState('');
  const [actorId, setActorId] = useState('');
  const [limit, setLimit] = useState(40);
  const feed = useQuery({
    queryKey: ['development', 'activity', 'page', projectId, actorId, limit],
    queryFn: () => listActivity({ projectId: projectId || undefined, actorId: actorId || undefined, limit }),
    placeholderData: (previous) => previous,
  });

  return (
    <div className="dv-page">
      <DevHeader title="Activity" subtitle="Decisions, updates, and conversations across the team, as they happen." />
      <section className="dv-panel" aria-label="Activity">
        <div className="dv-toolbar">
          <select className="dv-select is-sm" aria-label="Project" value={projectId} onChange={(event) => { setProjectId(event.target.value); setLimit(40); }}>
            <option value="">All projects</option>
            {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="dv-select is-sm" aria-label="Person" value={actorId} onChange={(event) => { setActorId(event.target.value); setLimit(40); }}>
            <option value="">Everyone</option>
            {data.people.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
          </select>
        </div>
        <div className="dv-panel-pad">
          {feed.isLoading ? (
            <div className="dv-loading is-inline"><Spinner /></div>
          ) : (
            <>
              <ActivityFeed entries={feed.data} maps={maps} onOpenTask={openTask} empty="Nothing matches these filters yet." />
              {feed.data?.length >= limit && (
                <button type="button" className="dv-btn is-sm dv-more" onClick={() => setLimit((n) => n + 40)} disabled={feed.isFetching}>
                  {feed.isFetching ? 'Loading…' : 'Show more'}
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
