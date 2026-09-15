import { useDev } from '../../pages/development/DevelopmentContext';
import { AvatarStack, ProgressBar, ProjectMark, StateBadge } from './ui';
import { HEALTH_BY_KEY, deliveryState, progressOf, shortDate } from './devModel';

// The Boss's health setting wins when it says "at risk" or "off track";
// otherwise the card says what the tasks say.
export function projectState(project, tasks) {
  if (project.health && project.health !== 'on_track') {
    const h = HEALTH_BY_KEY[project.health];
    return { label: h.label, tone: h.tone };
  }
  return deliveryState(tasks);
}

export default function ProjectCard({ project, onOpen }) {
  const { data, maps } = useDev();
  const tasks = data.tasks.filter((t) => t.project_id === project.id);
  const { done, total, pct } = progressOf(tasks);
  const current = data.releases.find((r) => r.project_id === project.id && r.status === 'current');
  const peopleIds = new Set([
    ...(project.member_ids || []),
    ...tasks.filter((t) => t.status !== 'done').map((t) => t.assignee_id).filter(Boolean),
  ]);
  const people = [...peopleIds].map((id) => maps.personById.get(id)).filter(Boolean);

  return (
    <button type="button" className={`dv-project c-${project.color}${project.archived_at ? ' is-archived' : ''}`} onClick={() => onOpen(project)}>
      <span className="dv-project-top">
        <ProjectMark project={project} size={40} />
        <span className="dv-project-stage">{project.archived_at ? 'Archived' : project.stage === 'live' ? 'Live' : 'Pre-launch'}</span>
        <StateBadge state={projectState(project, tasks)} />
      </span>
      <span className="dv-project-name">{project.name}</span>
      <span className="dv-project-desc">{project.description || 'No description yet.'}</span>
      <span className="dv-project-progress">
        <span>{done} of {total} task{total === 1 ? '' : 's'} done</span>
        <strong className="dv-mono">{pct}%</strong>
      </span>
      <ProgressBar pct={pct} color={project.color} label={`${project.name} progress`} />
      <span className="dv-project-foot">
        {people.length ? <AvatarStack people={people} size={26} /> : <span className="dv-muted">No members yet</span>}
        <span className="dv-project-release">
          {current ? (
            <>
              <i className="bi bi-flag" aria-hidden="true" />
              <span>{current.name}{current.target_date ? ` · ${shortDate(current.target_date)}` : ''}</span>
            </>
          ) : 'No current release'}
        </span>
      </span>
    </button>
  );
}
