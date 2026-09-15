// Upcoming releases across projects, in two-week delivery windows.
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDev } from '../../pages/development/DevelopmentContext';
import { ProjectMark } from './ui';
import { HEALTH_BY_KEY, deliveryWindows, progressOf, shortDate, windowForDate } from './devModel';

export default function ReleaseTimeline({ projects }) {
  const { data, isBoss, openReleaseForm } = useDev();
  const navigate = useNavigate();
  const windows = useMemo(() => deliveryWindows(), []);

  return (
    <div className="dv-timeline-wrap">
      <table className="dv-timeline">
        <thead>
          <tr>
            <th scope="col">Project</th>
            {windows.map((w) => <th key={w.key} scope="col">{w.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => {
            const releases = data.releases
              .filter((r) => r.project_id === project.id && r.status !== 'shipped')
              .sort((a, b) => String(a.target_date || '9999').localeCompare(String(b.target_date || '9999')));
            return (
              <tr key={project.id}>
                <th scope="row">
                  <span className="dv-timeline-project">
                    <ProjectMark project={project} size={28} />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{HEALTH_BY_KEY[project.health]?.label}</small>
                    </span>
                  </span>
                  {isBoss && (
                    <button type="button" className="dv-link is-sm" onClick={() => openReleaseForm({ projectId: project.id })}>
                      <i className="bi bi-plus" aria-hidden="true" />Plan release
                    </button>
                  )}
                </th>
                {windows.map((w) => {
                  const inWindow = releases.filter((r) => windowForDate(windows, r.target_date) === w.key);
                  return (
                    <td key={w.key}>
                      {inWindow.map((release) => {
                        const { done, total } = progressOf(data.tasks.filter((t) => t.release_id === release.id));
                        return (
                          <button
                            key={release.id}
                            type="button"
                            className={`dv-milestone c-${project.color}${release.status === 'current' ? ' is-current' : ''}`}
                            onClick={() => navigate(`/development/roadmap?project=${project.key}&release=${release.id}`)}
                          >
                            <strong>{release.name}</strong>
                            <small>
                              {release.target_date ? `Target ${shortDate(release.target_date)}` : 'No target date'} · {done}/{total} done
                            </small>
                          </button>
                        );
                      })}
                      {!inWindow.length && w.key === 'later' && <span className="dv-muted">No release planned</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
