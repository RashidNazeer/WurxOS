// Development → Overview.
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDev } from './DevelopmentContext';
import { DevHeader, Spinner } from '../../components/development/ui';
import ProjectCard from '../../components/development/ProjectCard';
import TaskListPanel from '../../components/development/TaskListPanel';
import { ActivityFeed } from '../../components/development/Activity';
import { listActivity } from '../../lib/developmentApi';

export default function OverviewPage() {
  const { data, maps, activeProjects, openNewTask, openTask } = useDev();
  const navigate = useNavigate();
  const recent = useQuery({
    queryKey: ['development', 'activity', 'recent'],
    queryFn: () => listActivity({ limit: 6 }),
    staleTime: 20_000,
  });

  const moving = data.tasks.filter((t) => t.status === 'in_progress' || t.status === 'in_review').length;
  const blocked = data.tasks.filter((t) => t.status === 'blocked').length;
  const done = data.tasks.filter((t) => t.status === 'done').length;
  const prelaunch = activeProjects.filter((p) => p.stage === 'prelaunch').length;
  const pctDone = data.tasks.length ? Math.round((done / data.tasks.length) * 100) : 0;

  const stats = [
    { label: 'Active projects', value: activeProjects.length, note: prelaunch ? `${prelaunch} in pre-launch` : 'All live', foot: 'Across the company', icon: 'bi-folder2' },
    { label: 'In progress', value: moving, note: '', foot: 'Tasks moving forward', icon: 'bi-activity' },
    { label: 'Needs attention', value: blocked, note: blocked ? 'Action required' : '', foot: 'Blocked tasks to resolve', icon: 'bi-exclamation-triangle', tone: blocked ? 'bad' : '' },
    { label: 'Completed', value: done, note: '', foot: `${pctDone}% of all tasks`, icon: 'bi-check2-square', tone: done ? 'good' : '' },
  ];

  return (
    <div className="dv-page">
      <DevHeader
        title="Workspace overview"
        subtitle="A clear view of what’s moving, and what needs you."
        actions={(
          <>
            <Link to="/development/roadmap" className="dv-btn"><i className="bi bi-diagram-3" aria-hidden="true" />Roadmap</Link>
            <button type="button" className="dv-btn is-primary" onClick={() => openNewTask()}>
              <i className="bi bi-plus-lg" aria-hidden="true" />New task
            </button>
          </>
        )}
      />

      <div className="dv-stats">
        {stats.map((s) => (
          <div key={s.label} className="dv-stat">
            <div className="dv-stat-label"><span>{s.label}</span><i className={`bi ${s.icon}`} aria-hidden="true" /></div>
            <div className={`dv-stat-value${s.tone ? ` is-${s.tone}` : ''}`}>
              {s.value}
              {s.note && <span>{s.note}</span>}
            </div>
            <div className="dv-stat-foot">{s.foot}</div>
          </div>
        ))}
      </div>

      <div className="dv-section-title">
        <h2>Projects <span className="dv-muted">{activeProjects.length} active</span></h2>
        <Link to="/development/projects" className="dv-link">All projects <i className="bi bi-arrow-right" aria-hidden="true" /></Link>
      </div>
      <div className="dv-project-grid">
        {activeProjects.slice(0, 6).map((project) => (
          <ProjectCard key={project.id} project={project} onOpen={(p) => navigate(`/development/projects/${p.key}`)} />
        ))}
      </div>

      <div className="dv-overview-lower">
        <TaskListPanel title="Team tasks" storageKey="dv.overview.layout" />
        <aside className="dv-overview-side">
          <section className="dv-panel" aria-label="Recent activity">
            <div className="dv-panel-head">
              <h2>Recent activity</h2>
              <Link to="/development/activity" className="dv-link">All activity</Link>
            </div>
            <div className="dv-panel-pad">
              {recent.isLoading ? (
                <div className="dv-loading is-inline"><Spinner /></div>
              ) : (
                <ActivityFeed entries={recent.data} maps={maps} onOpenTask={openTask} empty="Changes and comments will appear here." />
              )}
            </div>
          </section>
          {blocked > 0 && (
            <section className="dv-attention" aria-label="Blocked tasks">
              <h3><i className="bi bi-exclamation-triangle" aria-hidden="true" />{blocked} task{blocked === 1 ? ' needs' : 's need'} a decision</h3>
              <p>Unblock the team to keep the next release moving.</p>
              <Link to="/development/tasks?status=blocked" className="dv-link is-strong">Review blockers <i className="bi bi-arrow-right" aria-hidden="true" /></Link>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
