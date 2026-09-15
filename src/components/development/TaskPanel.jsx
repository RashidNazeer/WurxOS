// The task panel: opens from any card, row or notification (?task=127).
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDev } from '../../pages/development/DevelopmentContext';
import { Drawer } from './Overlay';
import { ActionMenu, Avatar, EmptyState, ProjectMark, Spinner } from './ui';
import {
  PRIORITIES, STATUSES, STATUS_BY_KEY, TYPES, TYPE_BY_KEY,
  firstName, isOverdue, taskCode, timeAgo, exactTime,
} from './devModel';
import { deleteTask, getTask, listActivity } from '../../lib/developmentApi';
import RichTextEditor from '../common/RichTextEditor';
import RichContent from '../common/RichContent';
import TaskChecklist from './TaskChecklist';
import TaskFiles from './TaskFiles';
import TaskThread from './TaskThread';
import { ActivityFeed } from './Activity';

export default function TaskPanel({ number, commentId, onClose }) {
  const {
    data, maps, activeProjects, isBoss, canEdit, patchTask, moveTask, notify, confirm, refresh, openTask,
  } = useDev();
  const baseId = useId();
  const listTask = maps.taskByNumber.get(number);
  const [tab, setTab] = useState('comments');

  const full = useQuery({
    queryKey: ['development', 'task', listTask?.id],
    queryFn: () => getTask(listTask.id),
    enabled: !!listTask,
    staleTime: 15_000,
  });
  const history = useQuery({
    queryKey: ['development', 'activity', 'task', listTask?.id],
    queryFn: () => listActivity({ taskId: listTask.id, limit: 100 }),
    enabled: !!listTask && tab === 'history',
  });

  const titleId = `${baseId}-title`;

  if (!listTask) {
    return (
      <Drawer onClose={onClose} labelledBy={titleId} className="dv-task-drawer">
        <div className="dv-panel-top">
          <span className="dv-crumb" id={titleId}>WRX-{number}</span>
          <button type="button" className="dv-icon-btn" onClick={onClose} aria-label="Close task">
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>
        <div className="dv-panel-body">
          <EmptyState icon="bi-question-circle" title="This task isn’t here">
            It may have been deleted, or the link has a typo.
          </EmptyState>
        </div>
      </Drawer>
    );
  }

  const task = { ...(full.data || {}), ...listTask, description: full.data?.description ?? null };
  const editable = canEdit(task);
  const project = maps.projectById.get(task.project_id);
  const owner = maps.personById.get(task.assignee_id);
  const creator = maps.personById.get(task.created_by);
  const stats = data.statsByTask[task.id] || {};
  const code = taskCode(task);

  const projectOptions = activeProjects.some((p) => p.id === task.project_id)
    ? activeProjects
    : [...activeProjects, project].filter(Boolean);
  const releaseOptions = data.releases
    .filter((r) => r.project_id === task.project_id && (r.status !== 'shipped' || r.id === task.release_id));

  async function copyLink() {
    const url = `${window.location.origin}/development/roadmap?task=${task.number}`;
    try {
      await navigator.clipboard.writeText(url);
      notify('Link copied');
    } catch {
      notify(url);
    }
  }

  async function onDelete() {
    const yes = await confirm({
      title: `Delete ${code}?`,
      body: 'Its checklist, comments and files are deleted with it. The history keeps a note that it existed.',
      confirmLabel: 'Delete task',
      danger: true,
    });
    if (!yes) return;
    try {
      await deleteTask(task.id);
      notify(`${code} deleted`);
      onClose();
      refresh();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  const lockedNote = !editable && (
    <p className="dv-note">
      <i className="bi bi-lock" aria-hidden="true" />
      {owner
        ? `Only ${firstName(owner.display_name)} and the Boss can change this task. You can still comment.`
        : 'Only the Boss can change an unassigned task. You can still comment.'}
    </p>
  );

  return (
    <Drawer onClose={onClose} labelledBy={titleId} className="dv-task-drawer">
      <div className="dv-panel-top">
        <span className="dv-crumb">
          <ProjectMark project={project} size={20} />
          <span>{project?.name || 'Project'}</span>
          <span aria-hidden="true" className="dv-crumb-sep">/</span>
          <strong>{code}</strong>
        </span>
        <div className="dv-panel-top-actions">
          <button type="button" className="dv-icon-btn" onClick={copyLink} aria-label="Copy link to this task" title="Copy link">
            <i className="bi bi-link-45deg" aria-hidden="true" />
          </button>
          <ActionMenu
            label="Task actions"
            items={[isBoss && { label: 'Delete task', icon: 'bi-trash3', danger: true, onClick: onDelete }]}
          />
          <button type="button" className="dv-icon-btn" onClick={onClose} aria-label="Close task" title="Close">
            <i className="bi bi-x-lg" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="dv-panel-body">
        <EditableTitle
          id={titleId}
          title={task.title}
          editable={editable}
          onSave={(title) => patchTask(task, { title })}
        />
        <p className="dv-panel-meta">
          <span className={`dv-type-chip is-${task.type}`}>
            <i className={`bi ${TYPE_BY_KEY[task.type]?.icon}`} aria-hidden="true" />{TYPE_BY_KEY[task.type]?.label}
          </span>
          <span>Created by {creator?.display_name || 'someone'}</span>
          <time dateTime={task.created_at} title={exactTime(task.created_at)}>{timeAgo(task.created_at)}</time>
          <span aria-hidden="true">·</span>
          <span>Updated <time dateTime={task.updated_at} title={exactTime(task.updated_at)}>{timeAgo(task.updated_at)}</time></span>
        </p>
        {lockedNote}

        <dl className="dv-props">
          <div className="dv-prop">
            <dt><label htmlFor={`${baseId}-status`}>Status</label></dt>
            <dd>
              <select
                id={`${baseId}-status`}
                className={`dv-select is-status is-${STATUS_BY_KEY[task.status]?.tone}`}
                value={task.status}
                disabled={!editable}
                onChange={(event) => moveTask(task, event.target.value)}
              >
                {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </dd>
          </div>
          <div className="dv-prop">
            <dt><label htmlFor={`${baseId}-priority`}>Priority</label></dt>
            <dd>
              <select
                id={`${baseId}-priority`}
                className={`dv-select is-priority is-${task.priority}`}
                value={task.priority}
                disabled={!editable}
                onChange={(event) => patchTask(task, { priority: event.target.value })}
              >
                {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </dd>
          </div>
          <div className="dv-prop">
            <dt>{isBoss ? <label htmlFor={`${baseId}-owner`}>Assigned to</label> : 'Assigned to'}</dt>
            <dd className="dv-prop-owner">
              <Avatar person={owner} size={24} />
              {isBoss ? (
                <select
                  id={`${baseId}-owner`}
                  className="dv-select"
                  value={task.assignee_id || ''}
                  onChange={(event) => patchTask(task, { assignee_id: event.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {data.people.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
                </select>
              ) : (
                <span>{owner?.display_name || 'Unassigned'}</span>
              )}
            </dd>
          </div>
          <div className="dv-prop">
            <dt><label htmlFor={`${baseId}-due`}>Due date</label></dt>
            <dd className="dv-prop-due">
              <input
                id={`${baseId}-due`}
                type="date"
                className="dv-input"
                value={task.due_date || ''}
                disabled={!editable}
                onChange={(event) => patchTask(task, { due_date: event.target.value || null })}
              />
              {isOverdue(task) && <span className="dv-badge is-bad">Overdue</span>}
            </dd>
          </div>
          <div className="dv-prop">
            <dt><label htmlFor={`${baseId}-type`}>Type</label></dt>
            <dd>
              <select
                id={`${baseId}-type`}
                className="dv-select"
                value={task.type}
                disabled={!editable}
                onChange={(event) => patchTask(task, { type: event.target.value })}
              >
                {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </dd>
          </div>
          <div className="dv-prop">
            <dt><label htmlFor={`${baseId}-project`}>Project</label></dt>
            <dd>
              <select
                id={`${baseId}-project`}
                className="dv-select"
                value={task.project_id}
                disabled={!editable}
                onChange={(event) => patchTask(task, { project_id: event.target.value, release_id: null })}
              >
                {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </dd>
          </div>
          <div className="dv-prop">
            <dt><label htmlFor={`${baseId}-release`}>Release</label></dt>
            <dd>
              <select
                id={`${baseId}-release`}
                className="dv-select"
                value={task.release_id || ''}
                disabled={!editable}
                onChange={(event) => patchTask(task, { release_id: event.target.value || null })}
              >
                <option value="">Unscheduled</option>
                {releaseOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}{r.status === 'current' ? ' · current' : r.status === 'shipped' ? ' · shipped' : ''}
                  </option>
                ))}
              </select>
            </dd>
          </div>
        </dl>

        {task.status === 'blocked' && (
          <BlockedBox task={task} editable={editable} onSave={(reason) => patchTask(task, { blocked_reason: reason })} />
        )}

        <Description
          task={task}
          editable={editable}
          loading={full.isLoading}
          onSave={(description) => patchTask(task, { description: description || null })}
        />

        <TaskChecklist task={task} editable={editable} />
        <TaskFiles task={task} editable={editable} />

        <section className="dv-section dv-conversation" aria-label="Conversation">
          <div className="dv-tabs" role="tablist" aria-label="Conversation">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'comments'}
              className={tab === 'comments' ? 'is-on' : ''}
              onClick={() => setTab('comments')}
            >
              Comments{stats.comments ? <span className="dv-count">{stats.comments}</span> : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={tab === 'history' ? 'is-on' : ''}
              onClick={() => setTab('history')}
            >
              History
            </button>
          </div>
          {tab === 'comments' ? (
            <TaskThread task={task} highlightId={commentId} />
          ) : history.isLoading ? (
            <div className="dv-loading is-inline"><Spinner /></div>
          ) : (
            <ActivityFeed entries={history.data} maps={maps} onOpenTask={openTask} inTask empty="No changes yet." />
          )}
        </section>
      </div>
    </Drawer>
  );
}

function EditableTitle({ id, title, editable, onSave }) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  if (!editable) return <h2 id={id} className="dv-panel-title">{title}</h2>;
  return (
    <textarea
      id={id}
      className="dv-panel-title is-editable"
      aria-label="Task title"
      value={draft}
      rows={1}
      maxLength={160}
      onChange={(event) => setDraft(event.target.value.replace(/\n/g, ' '))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onBlur={() => {
        const next = draft.trim();
        if (next && next !== title) onSave(next);
        else setDraft(title);
      }}
    />
  );
}

function BlockedBox({ task, editable, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.blocked_reason || '');
  useEffect(() => {
    if (!editing) setDraft(task.blocked_reason || '');
  }, [task.blocked_reason, editing]);

  return (
    <div className="dv-blocked" role="note">
      <div className="dv-blocked-head">
        <i className="bi bi-exclamation-triangle-fill" aria-hidden="true" />
        <strong>What’s blocking this task?</strong>
        {editable && !editing && (
          <button type="button" className="dv-link" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            className="dv-input"
            aria-label="What is blocking this task"
            rows={3}
            maxLength={1000}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="dv-row-end">
            <button type="button" className="dv-btn is-ghost is-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button
              type="button"
              className="dv-btn is-primary is-sm"
              disabled={!draft.trim()}
              onClick={async () => { if (await onSave(draft.trim())) setEditing(false); }}
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <p>{task.blocked_reason}</p>
      )}
    </div>
  );
}

function hasText(html) {
  return !!String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function Description({ task, editable, loading, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const filled = hasText(task.description);

  return (
    <section className="dv-section" aria-label="Description">
      <div className="dv-section-head">
        <h3>Description</h3>
        {editable && !editing && !loading && (
          <button
            type="button"
            className="dv-link"
            onClick={() => { setDraft(task.description || ''); setEditing(true); }}
          >
            {filled ? 'Edit' : 'Add a description'}
          </button>
        )}
      </div>
      {loading ? (
        <div className="dv-loading is-inline"><Spinner /></div>
      ) : editing ? (
        <div className="dv-rte">
          <RichTextEditor
            value={draft}
            onChange={setDraft}
            minHeight={150}
            placeholder="Add context, requirements, or steps to reproduce…"
          />
          <div className="dv-row-end">
            <button type="button" className="dv-btn is-ghost is-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button
              type="button"
              className="dv-btn is-primary is-sm"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const ok = await onSave(hasText(draft) ? draft : null);
                setSaving(false);
                if (ok) setEditing(false);
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : filled ? (
        <RichContent html={task.description} className="dv-description" />
      ) : (
        <p className="dv-muted">No description yet.</p>
      )}
    </section>
  );
}
