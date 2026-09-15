// Add a task to a feature, or edit one. A task in a planned block needs an
// acceptance check; devTasksApi refuses to create one without it.
import { useState } from 'react';
import { DEV_PRIORITIES, PRIORITY_META, createWorkTask, updateWorkTask } from '../../lib/devTasksApi';
import DevModal from './DevModal';

export default function WorkTaskModal({ feature, developers, task = null, onClose, onSaved }) {
  const [form, setForm] = useState({
    title: task?.title || '',
    acceptance: task?.acceptance_check || '',
    ownerId: task?.owner_id || feature.owner_id || developers[0]?.id || '',
    priority: task?.priority || feature.priority || 'normal',
    due: task?.due_date || feature.block_ends_on || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }));

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (!form.title.trim()) throw new Error('Task title is required.');
      if (task) {
        await updateWorkTask(task.id, {
          title: form.title.trim(),
          acceptance_check: form.acceptance.trim() || null,
          owner_id: form.ownerId,
          priority: form.priority,
          due_date: form.due || null,
        });
      } else {
        await createWorkTask(feature, form);
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose}>Cancel</button>
      <button type="button" className="wx-btn wx-btn-primary" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Save task'}
      </button>
    </>
  );

  return (
    <DevModal title={task ? 'Edit task' : `Add task · ${feature.title}`} onClose={onClose} footer={footer}>
      <div className="dev-form">
        {error && <div className="wx-alert wx-alert-danger">{error}</div>}

        <label>
          Task title
          <input
            className="wx-input"
            autoFocus
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Fix landing CTA link"
          />
        </label>

        <label>
          Acceptance check <span>required before planning</span>
          <textarea
            className="wx-input dev-acceptance-input"
            rows={4}
            value={form.acceptance}
            onChange={(e) => set('acceptance', e.target.value)}
            placeholder="What should be true when this is done?"
          />
        </label>

        <div className="dev-form-pair">
          <label>
            Owner
            <select className="wx-input" value={form.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
              {developers.map((person) => <option value={person.id} key={person.id}>{person.display_name}</option>)}
            </select>
          </label>
          <label>
            Priority
            <select className="wx-input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {DEV_PRIORITIES.map((priority) => <option value={priority} key={priority}>{PRIORITY_META[priority].label}</option>)}
            </select>
          </label>
        </div>

        <label>
          Due date
          <input className="wx-input" type="date" value={form.due} onChange={(e) => set('due', e.target.value)} />
        </label>
      </div>
    </DevModal>
  );
}
