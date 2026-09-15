// Development → Projects → one project.
import { Link, useParams } from 'react-router-dom';
import { useDev } from './DevelopmentContext';
import { ActionMenu, AvatarStack, DevHeader, EmptyState, ProgressBar, ProjectMark, StateBadge } from '../../components/development/ui';
import TaskListPanel from '../../components/development/TaskListPanel';
import { projectState } from '../../components/development/ProjectCard';
import { deliveryState, progressOf, shortDate } from '../../components/development/devModel';
import { updateRelease } from '../../lib/developmentApi';

const RELEASE_ORDER = { current: 0, planned: 1, shipped: 2 };

export default function ProjectPage() {
  const { key } = useParams();
  const { data, maps, isBoss, openProjectForm, openReleaseForm, notify, refresh } = useDev();
  const project = maps.projectByKey.get(key);

  if (!project) {
    return (
      <div className="dv-page">
        <Link to="/development/projects" className="dv-link dv-back"><i className="bi bi-arrow-left" aria-hidden="true" />All projects</Link>
        <EmptyState icon="bi-folder-x" title="This project doesn’t exist">It may have been renamed or removed.</EmptyState>
      </div>
    );
  }

  const tasks = data.tasks.filter((t) => t.project_id === project.id);
  const releases = data.releases
    .filter((r) => r.project_id === project.id)
    .sort((a, b) => (RELEASE_ORDER[a.status] - RELEASE_ORDER[b.status])
      || String(a.target_date || '9999').localeCompare(String(b.target_date || '9999')));
  const lead = maps.personById.get(project.lead_id);
  const members = (project.member_ids || []).map((id) => maps.personById.get(id)).filter(Boolean);
  const { done, total, pct } = progressOf(tasks);

  async function setStatus(release, status) {
    try {
      await updateRelease(release.id, { status });
      notify(status === 'shipped' ? `${release.name} shipped` : `${release.name} is now current`);
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  return (
    <div className="dv-page">
      <Link to="/development/projects" className="dv-link dv-back"><i className="bi bi-arrow-left" aria-hidden="true" />All projects</Link>
      <DevHeader
        leading={<ProjectMark project={project} size={44} />}
        title={project.name}
        subtitle={project.description || (isBoss ? 'Add a one-line description from Edit project.' : '')}
        actions={(
          <>
            <Link to={`/development/roadmap?project=${project.key}`} className="dv-btn">
              <i className="bi bi-diagram-3" aria-hidden="true" />Open roadmap
            </Link>
            {isBoss && (
              <>
                <button type="button" className="dv-btn" onClick={() => openReleaseForm({ projectId: project.id })}>
                  <i className="bi bi-flag" aria-hidden="true" />Plan release
                </button>
                <button type="button" className="dv-btn is-primary" onClick={() => openProjectForm(project)}>
                  <i className="bi bi-pencil" aria-hidden="true" />Edit project
                </button>
              </>
            )}
          </>
        )}
      />

      <div className="dv-project-summary dv-panel">
        <div>
          <span className="dv-eyebrow">Health</span>
          <StateBadge state={projectState(project, tasks)} />
        </div>
        <div>
          <span className="dv-eyebrow">Stage</span>
          <strong>{project.archived_at ? 'Archived' : project.stage === 'live' ? 'Live' : 'Pre-launch'}</strong>
        </div>
        <div>
          <span className="dv-eyebrow">Lead</span>
          <strong>{lead?.display_name || 'No lead'}</strong>
        </div>
        <div>
          <span className="dv-eyebrow">Members</span>
          {members.length ? <AvatarStack people={members} size={26} max={6} /> : <span className="dv-muted">None yet</span>}
        </div>
        <div className="is-wide">
          <span className="dv-eyebrow">Progress</span>
          <span className="dv-summary-progress">
            <ProgressBar pct={pct} color={project.color} label="Project progress" />
            <span className="dv-mono">{done}/{total}</span>
          </span>
        </div>
      </div>

      <div className="dv-section-title">
        <h2>Releases <span className="dv-muted">{releases.length}</span></h2>
      </div>
      {releases.length ? (
        <ul className="dv-release-list">
          {releases.map((release) => {
            const releaseTasks = tasks.filter((t) => t.release_id === release.id);
            const progress = progressOf(releaseTasks);
            return (
              <li key={release.id} className={`dv-release-row is-${release.status}`}>
                <div className="dv-release-row-main">
                  <span className={`dv-release-status is-${release.status}`}>
                    {release.status === 'current' ? 'Current' : release.status === 'shipped' ? 'Shipped' : 'Planned'}
                  </span>
                  <strong>{release.name}</strong>
                  <span className="dv-muted">
                    {release.status === 'shipped' && release.shipped_at
                      ? `Shipped ${shortDate(release.shipped_at.slice(0, 10))}`
                      : release.target_date ? `Target ${shortDate(release.target_date)}` : 'No target date'}
                  </span>
                </div>
                <StateBadge state={deliveryState(releaseTasks, { shipped: release.status === 'shipped' })} />
                <span className="dv-release-row-progress">
                  <ProgressBar pct={progress.pct} color={project.color} label={`${release.name} progress`} />
                  <span className="dv-mono">{progress.done}/{progress.total}</span>
                </span>
                <Link to={`/development/roadmap?project=${project.key}&release=${release.id}`} className="dv-link">Open</Link>
                {isBoss && (
                  <ActionMenu
                    label={`Actions for ${release.name}`}
                    items={[
                      { label: 'Edit release', icon: 'bi-pencil', onClick: () => openReleaseForm({ release }) },
                      release.status === 'planned' && { label: 'Make it the current release', icon: 'bi-bullseye', onClick: () => setStatus(release, 'current') },
                      release.status !== 'shipped' && { label: 'Mark as shipped', icon: 'bi-rocket-takeoff', onClick: () => setStatus(release, 'shipped') },
                    ]}
                  />
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          compact
          icon="bi-flag"
          title="No releases planned"
          action={isBoss ? <button type="button" className="dv-btn is-sm" onClick={() => openReleaseForm({ projectId: project.id })}>Plan a release</button> : null}
        />
      )}

      <TaskListPanel title={`${project.name} tasks`} storageKey="dv.project.layout" fixedProjectId={project.id} />
    </div>
  );
}
