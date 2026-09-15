// Development → Roadmap. The page Development opens on.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDev } from './DevelopmentContext';
import { DevHeader, EmptyState, ProjectMark } from '../../components/development/ui';
import ReleaseTree from '../../components/development/ReleaseTree';
import { readPref, writePref } from '../../components/development/prefs';
import { shortDate } from '../../components/development/devModel';

export default function RoadmapPage() {
  const { data, maps, activeProjects, isBoss, openNewTask, openProjectForm, openSearch } = useDev();
  const [params, setParams] = useSearchParams();
  const [showCompleted, setShowCompleted] = useState(() => readPref('dv.roadmap.completed', false));
  const [blockersOnly, setBlockersOnly] = useState(false);
  const [zoom, setZoom] = useState(() => readPref('dv.roadmap.zoom', 100));
  useEffect(() => writePref('dv.roadmap.completed', showCompleted), [showCompleted]);
  useEffect(() => writePref('dv.roadmap.zoom', zoom), [zoom]);

  const taskParam = params.get('task');
  const linkedTask = taskParam ? maps.taskByNumber.get(Number(taskParam)) : null;

  // Arriving from a notification or a shared link: show that task's project
  // and release behind the panel, and keep them when the panel closes.
  useEffect(() => {
    if (params.get('project') || !linkedTask) return;
    const project = maps.projectById.get(linkedTask.project_id);
    if (!project) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('project', project.key);
      next.set('release', linkedTask.release_id || 'unscheduled');
      return next;
    }, { replace: true });
  }, [linkedTask, maps, params, setParams]);

  const project = maps.projectByKey.get(params.get('project'))
    || (linkedTask ? maps.projectById.get(linkedTask.project_id) : null)
    || activeProjects[0]
    || null;

  const projectReleases = useMemo(
    () => (project ? data.releases.filter((r) => r.project_id === project.id) : []),
    [data.releases, project],
  );

  const releaseParam = params.get('release');
  let release = null;
  if (releaseParam && releaseParam !== 'unscheduled') {
    release = projectReleases.find((r) => r.id === releaseParam) || null;
  }
  if (!releaseParam || (releaseParam !== 'unscheduled' && !release)) {
    release = projectReleases.find((r) => r.status === 'current')
      || projectReleases
        .filter((r) => r.status === 'planned')
        .sort((a, b) => String(a.target_date || '9999').localeCompare(String(b.target_date || '9999')))[0]
      || null;
  }

  const tasks = project
    ? data.tasks.filter((t) => t.project_id === project.id && (release ? t.release_id === release.id : !t.release_id))
    : [];

  function selectProject(next) {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      out.set('project', next.key);
      out.delete('release');
      return out;
    });
  }

  function selectRelease(key) {
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (project) out.set('project', project.key);
      out.set('release', key);
      return out;
    });
  }

  const header = (
    <DevHeader
      eyebrow="Product delivery"
      title="From tasks to launch."
      subtitle="See the work. Make the call. Keep things moving."
      actions={(
        <>
          <button type="button" className="dv-btn is-ghost" onClick={openSearch} title="Find a task ( / )">
            <i className="bi bi-search" aria-hidden="true" />Find a task <kbd>/</kbd>
          </button>
          <button
            type="button"
            className="dv-btn"
            onClick={() => openNewTask({ type: 'bug', projectId: project?.id, releaseId: release ? release.id : null })}
          >
            <i className="bi bi-bug" aria-hidden="true" />Report a bug
          </button>
          <button
            type="button"
            className="dv-btn is-primary"
            onClick={() => openNewTask({ projectId: project?.id, releaseId: release ? release.id : null })}
          >
            <i className="bi bi-plus-lg" aria-hidden="true" />{isBoss ? 'Assign task' : 'New task'}
          </button>
        </>
      )}
    />
  );

  if (!project) {
    return (
      <div className="dv-page">
        {header}
        <EmptyState
          icon="bi-diagram-3"
          title="No projects yet"
          action={isBoss ? <button type="button" className="dv-btn is-primary" onClick={() => openProjectForm()}>Add the first project</button> : null}
        >
          {isBoss ? 'Add a project to start its roadmap.' : 'The Boss adds projects. They will appear here.'}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="dv-page">
      {header}

      <div className="dv-project-tabs" role="tablist" aria-label="Projects">
        {activeProjects.map((p) => {
          const projectTasks = data.tasks.filter((t) => t.project_id === p.id);
          const blocked = projectTasks.filter((t) => t.status === 'blocked').length;
          const open = projectTasks.filter((t) => t.status !== 'done').length;
          const current = data.releases.find((r) => r.project_id === p.id && r.status === 'current');
          const selected = p.id === project.id;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`dv-project-tab c-${p.color}${selected ? ' is-on' : ''}`}
              onClick={() => selectProject(p)}
            >
              <ProjectMark project={p} size={34} />
              <span className="dv-project-tab-text">
                <strong>{p.name}</strong>
                <small>
                  {blocked ? <span className="is-bad">{blocked} blocked</span> : `${open} open task${open === 1 ? '' : 's'}`}
                  {current?.target_date ? ` · ${shortDate(current.target_date)}` : ''}
                </small>
              </span>
              <i className="bi bi-arrow-right" aria-hidden="true" />
            </button>
          );
        })}
        {isBoss && (
          <button type="button" className="dv-project-tab is-add" onClick={() => openProjectForm()}>
            <i className="bi bi-plus-lg" aria-hidden="true" />New project
          </button>
        )}
      </div>

      <ReleaseTree
        project={project}
        release={release}
        releases={projectReleases}
        tasks={tasks}
        showCompleted={showCompleted}
        blockersOnly={blockersOnly}
        zoom={zoom}
        onSelectRelease={selectRelease}
        onToggleCompleted={() => { setShowCompleted((v) => !v); setBlockersOnly(false); }}
        onToggleBlockers={() => setBlockersOnly((v) => !v)}
        onZoom={setZoom}
      />

      <p className="dv-page-hint">
        <i className="bi bi-chat-square-text" aria-hidden="true" />
        Open a task for its description, checklist, files and comments. Owner, priority, status and due date change right on the card.
      </p>
    </div>
  );
}
