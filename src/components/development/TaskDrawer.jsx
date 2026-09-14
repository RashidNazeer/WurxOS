// A task: its acceptance check, who owns and reviews it, activity, notes, and
// the next step the viewer is allowed to take. Status changes go through the
// dev_transition_task RPC, which enforces who may move a task where.
import { useEffect, useState } from 'react';
import {
  listTaskActivity, transitionWorkTask, addActivity, markBugDuplicate,
  issueScreenshotUrl, allowedTaskActions, waitingLabel,
} from '../../lib/devTasksApi';
import DevDrawer from './DevDrawer';
import DevModal from './DevModal';
import WorkTaskModal from './WorkTaskModal';
import { Avatar, StatusPill, PriorityPill } from './Primitives';
import { shortDate, activityTime } from './devFormat';

// Activity is stored against the FEATURE. A task shows its own notes plus the
// feature-wide ones.
const forTask = (rows, taskId) => rows.filter((item) => !item.subtask_id || item.subtask_id === taskId);

export default function TaskDrawer({ task, feature, data, me, onClose, onRefresh }) {
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [duplicate, setDuplicate] = useState('');

  const teamMember = data.team.find((member) => member.user_id === me.id);
  const actions = allowedTaskActions(task, me.id, data.team);
  const otherBugs = data.tasks.filter((item) => item.source === 'bug_report' && item.id !== task.id);
  const canEdit = me.id === task.owner_id || me.id === task.reviewer_id || me.id === task.final_reviewer_id;
  const canCloseDuplicate = task.source === 'bug_report' && teamMember?.level === 'senior' && task.status !== 'live';

  useEffect(() => {
    let live = true;
    setLoading(true);
    listTaskActivity(feature.id)
      .then((rows) => { if (live) setActivity(forTask(rows, task.id)); })
      .catch((e) => setError(e.message))
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [feature.id, task.id]);

  useEffect(() => {
    if (!task.screenshot_path) return;
    issueScreenshotUrl(task.screenshot_path).then(setScreenshot).catch(() => {});
  }, [task.screenshot_path]);

  async function run(item) {
    setError('');
    if (item.note) {
      setNote('');
      setAction(item);
      return;
    }
    setBusy(true);
    try {
      await transitionWorkTask(task.id, item.to);
      await onRefresh();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    setBusy(true);
    setError('');
    try {
      await transitionWorkTask(task.id, action.to, {
        note,
        blockedReason: action.note === 'blocked' ? note : '',
      });
      setAction(null);
      await onRefresh();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function postNote() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await addActivity(feature.id, task.id, note);
      setNote('');
      setActivity(forTask(await listTaskActivity(feature.id), task.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function closeDuplicate() {
    if (!duplicate) return;
    setBusy(true);
    try {
      await markBugDuplicate(task.id, duplicate);
      await onRefresh();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const meta = (
    <>
      <StatusPill status={task.status} />
      <PriorityPill priority={task.priority} />
      {feature.block_starts_on && (
        <em>{shortDate(feature.block_starts_on)} – {shortDate(feature.block_ends_on)}</em>
      )}
    </>
  );

  const footer = actions.length
    ? actions.map((item) => (
      <button
        key={item.to + item.label}
        type="button"
        className={`wx-btn ${item.primary ? 'wx-btn-primary' : 'wx-btn-ghost'}`}
        disabled={busy}
        onClick={() => run(item)}
      >
        {item.label}
      </button>
    ))
    : <span>Waiting on {waitingLabel(task)}.</span>;

  return (
    <>
      <DevDrawer
        className="task-panel"
        crumb={`${feature.project_name} › ${feature.title} › task`}
        title={task.title}
        meta={meta}
        footer={footer}
        onClose={onClose}
      >
        {error && !action && <div className="wx-alert wx-alert-danger">{error}</div>}

        <section className="dev-acceptance">
          <small>Acceptance check</small>
          <p>{task.acceptance_check || 'Not added yet. This task cannot be scheduled without one.'}</p>
        </section>

        {task.blocked_reason && (
          <section className="dev-block-reason">
            <small>Blocked because</small>
            <p>{task.blocked_reason}</p>
          </section>
        )}

        <dl className="dev-task-facts">
          <dt>Owner</dt>
          <dd><Avatar person={task.owner} />{task.owner?.display_name || 'Unassigned'}</dd>
          <dt>Reviewer</dt>
          <dd>{task.reviewer?.display_name || '—'}</dd>
          <dt>Final review</dt>
          <dd>{task.finalReviewer?.display_name || 'Usman'}</dd>
          <dt>Due</dt>
          <dd>{shortDate(task.due_date)}</dd>
          <dt>Source</dt>
          <dd>{task.source === 'bug_report' ? `Reported by ${task.reporter?.display_name || 'employee'}` : 'Manual'}</dd>
          {task.page_url && (
            <>
              <dt>Page</dt>
              <dd className="break">{task.page_url}</dd>
            </>
          )}
        </dl>

        {task.expected && (
          <section className="dev-expected">
            <small>Reporter expected</small>
            <p>{task.expected}</p>
          </section>
        )}

        {screenshot && (
          <a className="dev-screenshot" href={screenshot} target="_blank" rel="noreferrer">
            <img src={screenshot} alt="Issue screenshot" />
          </a>
        )}

        <div className="dev-drawer-section-head">
          <h3>Activity</h3>
          {canEdit && (
            <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setEditing(true)}>
              <i className="bi bi-pencil" aria-hidden="true" /> Edit
            </button>
          )}
        </div>

        <div className="dev-activity">
          {loading ? <span>Loading…</span> : activity.map((item) => (
            <div key={item.id}>
              <time>{activityTime(item.created_at)}</time>
              <p>
                <b>{item.author?.display_name || 'System'}</b>
                {item.status_to && <> moved <StatusPill status={item.status_to} /></>}
                {item.body && <> {item.body}</>}
              </p>
            </div>
          ))}
          {!loading && !activity.length && <span>No activity yet.</span>}
        </div>

        <div className="dev-note-box">
          <textarea
            className="wx-input"
            rows={2}
            aria-label="Add a note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note…"
          />
          <button type="button" className="wx-btn wx-btn-ghost" disabled={busy || !note.trim()} onClick={postNote}>
            Post
          </button>
        </div>

        {canCloseDuplicate && (
          <div className="dev-duplicate">
            <select className="wx-input" aria-label="Duplicate of" value={duplicate} onChange={(e) => setDuplicate(e.target.value)}>
              <option value="">Duplicate of…</option>
              {otherBugs.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <button type="button" className="wx-btn wx-btn-ghost" disabled={!duplicate || busy} onClick={closeDuplicate}>
              Close duplicate
            </button>
          </div>
        )}
      </DevDrawer>

      {editing && (
        <WorkTaskModal
          feature={feature}
          developers={data.people.filter((person) => person.role === 'developer')}
          task={task}
          onClose={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await onRefresh(); onClose(); }}
        />
      )}

      {action && (
        <DevModal
          title={action.note === 'blocked' ? 'What is blocking this?' : 'Send back with a note'}
          onClose={() => setAction(null)}
          footer={(
            <>
              <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setAction(null)}>Cancel</button>
              <button type="button" className="wx-btn wx-btn-primary" disabled={busy || !note.trim()} onClick={confirmAction}>
                Confirm
              </button>
            </>
          )}
        >
          {/* Shown here, not in the panel behind: an error the reader cannot
              see is an error they will not act on. */}
          {error && <div className="wx-alert wx-alert-danger">{error}</div>}
          <label className="dev-modal-note">
            Note
            <textarea
              className="wx-input"
              autoFocus
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={action.note === 'blocked' ? 'Who or what is holding this up?' : 'What needs to change?'}
            />
          </label>
        </DevModal>
      )}
    </>
  );
}
