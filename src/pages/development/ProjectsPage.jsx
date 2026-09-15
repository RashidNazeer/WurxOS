// Development → Projects.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDev } from './DevelopmentContext';
import { DevHeader, EmptyState, Segmented } from '../../components/development/ui';
import ProjectCard from '../../components/development/ProjectCard';
import ReleaseTimeline from '../../components/development/ReleaseTimeline';

export default function ProjectsPage() {
  const { data, activeProjects, isBoss, openProjectForm, openReleaseForm } = useDev();
  const navigate = useNavigate();
  const [view, setView] = useState('active');
  const archived = data.projects.filter((p) => p.archived_at);
  const shown = view === 'archived' ? archived : activeProjects;

  return (
    <div className="dv-page">
      <DevHeader
        title="Projects"
        subtitle="Every product, owner, and delivery date in one place."
        actions={isBoss ? (
          <>
            <button type="button" className="dv-btn" onClick={() => openReleaseForm({})}>
              <i className="bi bi-flag" aria-hidden="true" />Plan a release
            </button>
            <button type="button" className="dv-btn is-primary" onClick={() => openProjectForm()}>
              <i className="bi bi-plus-lg" aria-hidden="true" />New project
            </button>
          </>
        ) : null}
      />

      {archived.length > 0 && (
        <Segmented
          label="Which projects"
          value={view}
          onChange={setView}
          options={[
            { value: 'active', label: `Active · ${activeProjects.length}` },
            { value: 'archived', label: `Archived · ${archived.length}` },
          ]}
        />
      )}

      {shown.length ? (
        <div className="dv-project-grid">
          {shown.map((project) => (
            <ProjectCard key={project.id} project={project} onOpen={(p) => navigate(`/development/projects/${p.key}`)} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon="bi-folder2"
          title={view === 'archived' ? 'No archived projects' : 'No projects yet'}
          action={isBoss && view === 'active' ? <button type="button" className="dv-btn is-primary" onClick={() => openProjectForm()}>Add a project</button> : null}
        />
      )}

      {view === 'active' && activeProjects.length > 0 && (
        <>
          <div className="dv-section-title">
            <h2>Release timeline</h2>
            <span className="dv-muted">Upcoming releases in two-week windows</span>
          </div>
          <ReleaseTimeline projects={activeProjects} />
        </>
      )}
    </div>
  );
}
