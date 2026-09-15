// New task / Report a bug.
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDev, WORKSPACE_KEY } from '../../pages/development/DevelopmentContext';
import { createTask, uploadFile } from '../../lib/developmentApi';
import { Field, Modal } from './Overlay';
import { PRIORITIES, STATUSES, taskCode } from './devModel';

function currentReleaseId(releases, projectId) {
  return releases.find((r) => r.project_id === projectId && r.status === 'current')?.id || '';
}

// The form takes plain text; the task panel shows (and edits) formatted HTML.
// Escape it, keep blank-line paragraphs and single line breaks.
function textToHtml(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return trimmed
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export default function TaskFormModal({ defaults = {}, onClose }) {
  const qc = useQueryClient();
  const { profile, isBoss, data, activeProjects, notify, openTask, refresh } = useDev();
  const startProject = defaults.projectId || activeProjects[0]?.id || '';

  const [form, setForm] = useState(() => ({
    title: defaults.title || '',
    type: defaults.type || 'feature',
    project_id: startProject,
    release_id: defaults.releaseId !== undefined ? (defaults.releaseId || '') : currentReleaseId(data.releases, startProject),
    assignee_id: isBoss ? (defaults.assigneeId || '') : profile?.id,
    priority: defaults.priority || (defaults.type === 'bug' ? 'high' : 'normal'),
    status: defaults.status || 'todo',
    due_date: defaults.dueDate || '',
    blocked_reason: '',
    description: '',
  }));
  const [files, setFiles] = useState([]);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const isBug = form.type === 'bug';

  const releases = useMemo(
    () => data.releases.filter((r) => r.project_id === form.project_id && r.status !== 'shipped'),
    [data.releases, form.project_id],
  );

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    const next = {};
    if (!form.title.trim()) next.title = 'Give the task a title.';
    if (!form.project_id) next.project_id = 'Choose a project.';
    if (form.status === 'blocked' && !form.blocked_reason.trim()) next.blocked_reason = 'Say what is blocking it.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    try {
      const created = await createTask({
        title: form.title.trim(),
        type: form.type,
        project_id: form.project_id,
        release_id: form.release_id || null,
        assignee_id: form.assignee_id || null,
        priority: form.priority,
        status: form.status,
        due_date: form.due_date || null,
        blocked_reason: form.status === 'blocked' ? form.blocked_reason.trim() : null,
        description: textToHtml(form.description),
      });
      for (const file of files) {
        try {
          await uploadFile({ taskId: created.id, file });
        } catch (error) {
          notify(`${file.name}: ${error.message}`, 'error');
        }
      }
      // Put it in the list now so the panel can open before the refresh lands.
      qc.setQueryData(WORKSPACE_KEY, (old) => old && { ...old, tasks: [...old.tasks, created] });
      refresh();
      notify(`${taskCode(created)} ${isBug ? 'reported' : 'created'}`);
      onClose();
      openTask(created.number);
    } catch (error) {
      setErrors({ form: error.message });
      setSaving(false);
    }
  }

  return (
    <Modal
      title={isBug ? 'Report a bug' : 'New task'}
      onClose={onClose}
      width={620}
      onSubmit={submit}
      footer={(
        <>
          {errors.form && <p className="dv-field-error dv-foot-error" role="alert">{errors.form}</p>}
          <button type="button" className="dv-btn is-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="dv-btn is-primary" disabled={saving}>
            <i className={`bi ${isBug ? 'bi-bug' : 'bi-plus-lg'}`} aria-hidden="true" />
            {saving ? 'Saving…' : isBug ? 'Report bug' : 'Create task'}
          </button>
        </>
      )}
    >
      <p className="dv-modal-lede">{isBug ? 'What needs fixing?' : 'Make the next step clear.'}</p>
      <div
        className="dv-form-grid"
        onPaste={(event) => {
          if (event.target?.closest?.('.ProseMirror')) return;
          const pasted = [...(event.clipboardData?.files || [])];
          if (!pasted.length) return;
          event.preventDefault();
          setFiles((list) => [...list, ...pasted]);
        }}
      >
        <Field label="Title" htmlFor="dv-task-title" error={errors.title} className="is-wide">
          <input
            id="dv-task-title"
            className="dv-input"
            data-autofocus=""
            value={form.title}
            maxLength={160}
            placeholder={isBug ? 'What is broken?' : 'What needs to be done?'}
            onChange={(event) => set('title', event.target.value)}
          />
        </Field>

        <Field label="Type" htmlFor="dv-task-type">
          <select id="dv-task-type" className="dv-select" value={form.type} onChange={(event) => set('type', event.target.value)}>
            <option value="feature">Feature</option>
            <option value="bug">Bug</option>
          </select>
        </Field>
        <Field label="Project" htmlFor="dv-task-project" error={errors.project_id}>
          <select
            id="dv-task-project"
            className="dv-select"
            value={form.project_id}
            onChange={(event) => setForm((f) => ({
              ...f,
              project_id: event.target.value,
              release_id: currentReleaseId(data.releases, event.target.value),
            }))}
          >
            {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        <Field label="Release" htmlFor="dv-task-release">
          <select id="dv-task-release" className="dv-select" value={form.release_id} onChange={(event) => set('release_id', event.target.value)}>
            <option value="">Unscheduled</option>
            {releases.map((r) => (
              <option key={r.id} value={r.id}>{r.name}{r.status === 'current' ? ' · current' : ''}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Assign to"
          htmlFor="dv-task-owner"
          hint={isBoss ? null : 'Tasks you create are assigned to you. The Boss can hand them to someone else.'}
        >
          {isBoss ? (
            <select id="dv-task-owner" className="dv-select" value={form.assignee_id} onChange={(event) => set('assignee_id', event.target.value)}>
              <option value="">Unassigned</option>
              {data.people.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
            </select>
          ) : (
            <input id="dv-task-owner" className="dv-input" value={profile?.display_name || 'You'} readOnly />
          )}
        </Field>

        <Field label="Priority" htmlFor="dv-task-priority">
          <select id="dv-task-priority" className="dv-select" value={form.priority} onChange={(event) => set('priority', event.target.value)}>
            {PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Due date" htmlFor="dv-task-due">
          <input id="dv-task-due" type="date" className="dv-input" value={form.due_date} onChange={(event) => set('due_date', event.target.value)} />
        </Field>

        <Field label="Status" htmlFor="dv-task-status">
          <select id="dv-task-status" className="dv-select" value={form.status} onChange={(event) => set('status', event.target.value)}>
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>

        {form.status === 'blocked' && (
          <Field label="What’s blocking it?" htmlFor="dv-task-blocked" error={errors.blocked_reason} className="is-wide">
            <textarea
              id="dv-task-blocked"
              className="dv-input"
              rows={2}
              maxLength={1000}
              value={form.blocked_reason}
              onChange={(event) => set('blocked_reason', event.target.value)}
            />
          </Field>
        )}

        <Field
          label="Description"
          htmlFor="dv-task-description"
          className="is-wide"
          hint="Formatting, links and lists can be added from the task panel."
        >
          <textarea
            id="dv-task-description"
            className="dv-input"
            rows={4}
            value={form.description}
            placeholder={isBug ? 'What happened? What should happen? Steps to reproduce.' : 'Add context or requirements.'}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>

        <div className="dv-field is-wide">
          <span className="dv-label">{isBug ? 'Screenshots or files' : 'Files'}</span>
          <label className="dv-dropzone is-form">
            <i className="bi bi-cloud-arrow-up" aria-hidden="true" />
            <span>Choose files, or paste a screenshot anywhere in this form · up to 25 MB each</span>
            <input
              type="file"
              multiple
              className="dv-visually-hidden"
              onChange={(event) => {
                const picked = [...event.target.files];
                event.target.value = '';
                setFiles((list) => [...list, ...picked]);
              }}
            />
          </label>
          {files.length > 0 && (
            <ul className="dv-pending-files">
              {files.map((file, index) => (
                <li key={`${file.name}-${index}`}>
                  <i className="bi bi-paperclip" aria-hidden="true" />
                  <span>{file.name}</span>
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((list) => list.filter((_, i) => i !== index))}>
                    <i className="bi bi-x" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
