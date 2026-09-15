// The release map: a project's release at the top, the work branching out
// beneath it by what it needs, and every task opening down to its checklist.
import { useState } from 'react';
import { useDev } from '../../pages/development/DevelopmentContext';
import { updateRelease } from '../../lib/developmentApi';
import { ActionMenu, AvatarStack, ProgressBar, StateBadge } from './ui';
import TreeCard from './TreeCard';
import {
  BRANCHES, addDays, compareTasks, deliveryState, progressOf, shortDate, todayPkt,
} from './devModel';

function daysNote(targetIso, shipped) {
  if (!targetIso || shipped) return null;
  const today = todayPkt();
  const diff = Math.round((new Date(`${targetIso}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86_400_000);
  if (diff === 0) return { label: 'due today', tone: 'warn' };
  if (diff > 0) return { label: `${diff} day${diff === 1 ? '' : 's'} left`, tone: diff <= 3 ? 'warn' : 'muted' };
  return { label: `${-diff} day${diff === -1 ? '' : 's'} late`, tone: 'bad' };
}

function wirePath(index, count) {
  if (count === 1) return 'M500 0 V60';
  const x = ((index + 0.5) * 1000) / count;
  if (Math.abs(x - 500) < 1) return 'M500 0 V60';
  const turn = x > 500 ? 1 : -1;
  return `M500 0 V18 Q500 30 ${500 + 14 * turn} 30 H${x - 14 * turn} Q${x} 30 ${x} 42 V60`;
}

export default function ReleaseTree({
  project, release, releases, tasks, showCompleted, blockersOnly, zoom,
  onSelectRelease, onToggleCompleted, onToggleBlockers, onZoom,
}) {
  const { maps, isBoss, moveTask, openNewTask, openReleaseForm, notify, confirm, refresh } = useDev();
  const [dragId, setDragId] = useState(null);
  const [dropOn, setDropOn] = useState(null);

  const branches = BRANCHES
    .filter((b) => b.key !== 'done' || showCompleted)
    .filter((b) => !blockersOnly || b.key === 'blocked');
  const shipped = release?.status === 'shipped';
  const state = deliveryState(tasks, { shipped });
  const { done, total, pct } = progressOf(tasks);
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const people = [...new Set(tasks.map((t) => t.assignee_id).filter(Boolean))]
    .map((id) => maps.personById.get(id))
    .filter(Boolean);
  const note = daysNote(release?.target_date, shipped);
  const releaseKey = release ? release.id : 'unscheduled';

  const current = releases.filter((r) => r.status === 'current');
  const planned = releases
    .filter((r) => r.status === 'planned')
    .sort((a, b) => String(a.target_date || '9999').localeCompare(String(b.target_date || '9999')));
  const past = releases
    .filter((r) => r.status === 'shipped')
    .sort((a, b) => String(b.shipped_at || '').localeCompare(String(a.shipped_at || '')));

  async function setReleaseStatus(status) {
    try {
      await updateRelease(release.id, { status });
      notify(status === 'shipped' ? `${release.name} shipped` : `${release.name} is now the current release`);
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function ship() {
    const open = tasks.filter((t) => t.status !== 'done').length;
    const yes = await confirm({
      title: `Ship ${release.name}?`,
      body: open
        ? `${open} task${open === 1 ? ' is' : 's are'} still open. They stay in this release. Both developers are told it shipped.`
        : 'Everyone in Development is told it shipped.',
      confirmLabel: 'Mark as shipped',
    });
    if (yes) setReleaseStatus('shipped');
  }

  function addTo(branch) {
    openNewTask({
      projectId: project.id,
      releaseId: release ? release.id : null,
      status: branch.dropStatus,
      type: branch.key === 'blocked' ? 'bug' : 'feature',
    });
  }

  const dragged = dragId ? maps.taskById.get(dragId) : null;

  return (
    <section className="dv-canvas" aria-label={`Release map for ${project.name}`}>
      <div className="dv-canvas-bar">
        <div className="dv-canvas-crumb">
          <i className="bi bi-diagram-3" aria-hidden="true" />
          <strong>Release map</strong>
          <span className="dv-crumb-sep" aria-hidden="true">/</span>
          <span>{project.name}</span>
          <span className="dv-crumb-sep" aria-hidden="true">/</span>
          <label className="dv-visually-hidden" htmlFor="dv-release-switch">Show release</label>
          <select
            id="dv-release-switch"
            className="dv-bare-select is-strong"
            value={releaseKey}
            onChange={(event) => onSelectRelease(event.target.value)}
          >
            {current.length > 0 && (
              <optgroup label="Current">
                {current.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </optgroup>
            )}
            {planned.length > 0 && (
              <optgroup label="Planned">
                {planned.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{r.target_date ? ` · ${shortDate(r.target_date)}` : ''}</option>
                ))}
              </optgroup>
            )}
            {past.length > 0 && (
              <optgroup label="Shipped">
                {past.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </optgroup>
            )}
            <option value="unscheduled">Unscheduled work</option>
          </select>
        </div>
        <div className="dv-canvas-filters">
          <button
            type="button"
            className={`dv-filter${blockersOnly ? ' is-on' : ''}`}
            aria-pressed={blockersOnly}
            onClick={onToggleBlockers}
          >
            <i className="bi bi-exclamation-triangle" aria-hidden="true" />Blockers only
          </button>
          <button
            type="button"
            className={`dv-filter${showCompleted ? ' is-on' : ''}`}
            aria-pressed={showCompleted}
            onClick={onToggleCompleted}
          >
            <i className="bi bi-check2-circle" aria-hidden="true" />Completed <span className="dv-count">{doneCount}</span>
          </button>
          {isBoss && (
            <button type="button" className="dv-filter" onClick={() => openReleaseForm({ projectId: project.id })}>
              <i className="bi bi-flag" aria-hidden="true" />Plan release
            </button>
          )}
        </div>
      </div>

      <div className="dv-canvas-scroll">
        <div className="dv-stage" style={{ zoom: zoom / 100, '--branches': branches.length }}>
          <div className="dv-root-wrap">
            <article className={`dv-release c-${project.color}`}>
              <div className="dv-release-top">
                <i className={`bi ${release ? 'bi-flag-fill' : 'bi-inbox'}`} aria-hidden="true" />
                <span className="dv-eyebrow">
                  {!release ? 'Unscheduled work' : release.status === 'current' ? 'Current release' : shipped ? 'Shipped release' : 'Planned release'}
                </span>
                <StateBadge state={state} />
                {isBoss && release && (
                  <ActionMenu
                    label="Release actions"
                    items={[
                      { label: 'Edit release', icon: 'bi-pencil', onClick: () => openReleaseForm({ release }) },
                      release.status === 'planned' && { label: 'Make it the current release', icon: 'bi-bullseye', onClick: () => setReleaseStatus('current') },
                      !shipped && { label: 'Mark as shipped', icon: 'bi-rocket-takeoff', onClick: ship },
                      shipped && { label: 'Reopen as current', icon: 'bi-arrow-counterclockwise', onClick: () => setReleaseStatus('current') },
                    ]}
                  />
                )}
              </div>
              <h2 className="dv-release-title">{release ? release.name : `${project.name} backlog`}</h2>
              <p className="dv-release-desc">
                {release ? (release.description || `A ${project.name} release.`) : `Tasks in ${project.name} that aren’t in a release yet.`}
              </p>
              <div className="dv-release-meta">
                <span>
                  {release?.target_date ? (
                    <>
                      <i className="bi bi-calendar3" aria-hidden="true" /> Target {shortDate(release.target_date)}
                      {note && <em className={`is-${note.tone}`}>{note.label}</em>}
                    </>
                  ) : release ? (shipped && release.shipped_at ? `Shipped ${shortDate(release.shipped_at.slice(0, 10))}` : 'No target date') : `${total} task${total === 1 ? '' : 's'}`}
                </span>
                <AvatarStack people={people} size={24} />
              </div>
              <div className="dv-release-progress">
                <ProgressBar pct={pct} color={project.color} label="Release progress" />
                <button type="button" className="dv-link" aria-pressed={showCompleted} onClick={onToggleCompleted}>
                  {done}/{total} done <i className={`bi ${showCompleted ? 'bi-chevron-up' : 'bi-chevron-down'}`} aria-hidden="true" />
                </button>
              </div>
            </article>
            {isBoss && releases.length === 0 && (
              <button type="button" className="dv-btn is-sm dv-first-release" onClick={() => openReleaseForm({ projectId: project.id })}>
                <i className="bi bi-flag" aria-hidden="true" /> Plan the first {project.name} release
              </button>
            )}
          </div>

          <svg className="dv-wires" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true">
            {branches.map((branch, index) => (
              <path key={branch.key} d={wirePath(index, branches.length)} className={`is-${branch.key}`} />
            ))}
          </svg>

          <div className="dv-branches">
            {branches.map((branch) => {
              const list = tasks.filter((t) => branch.statuses.includes(t.status)).sort(compareTasks);
              const canDrop = dragged && !branch.statuses.includes(dragged.status);
              return (
                <section
                  key={branch.key}
                  className={`dv-branch is-${branch.key}${dropOn === branch.key ? ' is-drop' : ''}`}
                  aria-label={`${branch.name}, ${list.length} task${list.length === 1 ? '' : 's'}`}
                  onDragOver={(event) => {
                    if (!canDrop) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    if (dropOn !== branch.key) setDropOn(branch.key);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget)) setDropOn(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const task = dragged;
                    setDropOn(null);
                    setDragId(null);
                    if (task && !branch.statuses.includes(task.status)) moveTask(task, branch.dropStatus);
                  }}
                >
                  <header className="dv-branch-head">
                    <span className="dv-branch-icon"><i className={`bi ${branch.icon}`} aria-hidden="true" /></span>
                    <div>
                      <h3>{branch.name}<span className="dv-count">{list.length}</span></h3>
                      <p>{branch.hint}</p>
                    </div>
                    {branch.addLabel && (
                      <button type="button" className="dv-icon-btn" aria-label={`${branch.addLabel} in ${branch.name}`} onClick={() => addTo(branch)}>
                        <i className="bi bi-plus-lg" aria-hidden="true" />
                      </button>
                    )}
                  </header>
                  <div className="dv-branch-cards">
                    {list.length ? list.map((task) => (
                      <TreeCard
                        key={task.id}
                        task={task}
                        dragging={dragId === task.id}
                        onDragStart={() => setDragId(task.id)}
                        onDragEnd={() => { setDragId(null); setDropOn(null); }}
                      />
                    )) : (
                      <p className="dv-branch-empty">{branch.empty}</p>
                    )}
                  </div>
                  {branch.addLabel && (
                    <button type="button" className="dv-branch-add" onClick={() => addTo(branch)}>
                      <i className="bi bi-plus-lg" aria-hidden="true" />{branch.addLabel}
                    </button>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>

      <div className="dv-canvas-foot">
        <span>
          <i className="bi bi-arrows-move" aria-hidden="true" />
          Drag a card to another branch to change its status.
        </span>
        <div className="dv-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" disabled={zoom <= 70} onClick={() => onZoom(Math.max(70, zoom - 10))}>
            <i className="bi bi-dash" aria-hidden="true" />
          </button>
          <button type="button" title="Reset zoom" onClick={() => onZoom(100)} className="dv-mono">{zoom}%</button>
          <button type="button" aria-label="Zoom in" disabled={zoom >= 120} onClick={() => onZoom(Math.min(120, zoom + 10))}>
            <i className="bi bi-plus" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}

// Re-exported for pages that show how far a date is.
export { daysNote, addDays };
