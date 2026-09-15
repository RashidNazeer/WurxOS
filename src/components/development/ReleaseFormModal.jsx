// Plan a release / Edit a release (Boss).
import { useState } from 'react';
import { useDev } from '../../pages/development/DevelopmentContext';
import { createRelease, deleteRelease, updateRelease } from '../../lib/developmentApi';
import { Field, Modal } from './Overlay';
import { RELEASE_STATUSES } from './devModel';

export default function ReleaseFormModal({ projectId, release, onClose }) {
  const { activeProjects, maps, notify, refresh, confirm } = useDev();
  const editing = !!release;
  const [form, setForm] = useState(() => ({
    project_id: release?.project_id || projectId || activeProjects[0]?.id || '',
    name: release?.name || '',
    target_date: release?.target_date || '',
    status: release?.status || 'planned',
    description: release?.description || '',
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const project = maps.projectById.get(form.project_id);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    const next = {};
    if (!form.project_id) next.project_id = 'Choose a project.';
    if (!form.name.trim()) next.name = 'Name the release.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    const fields = {
      name: form.name.trim(),
      target_date: form.target_date || null,
      status: form.status,
      description: form.description.trim() || null,
    };
    try {
      if (editing) {
        await updateRelease(release.id, fields);
        notify(`${fields.name} updated`);
      } else {
        await createRelease({ ...fields, project_id: form.project_id });
        notify(`${fields.name} planned`);
      }
      refresh();
      onClose();
    } catch (error) {
      setErrors({ form: error.message });
      setSaving(false);
    }
  }

  async function remove() {
    const yes = await confirm({
      title: `Delete ${release.name}?`,
      body: 'Its tasks stay in the project as unscheduled work.',
      confirmLabel: 'Delete release',
      danger: true,
    });
    if (!yes) return;
    try {
      await deleteRelease(release.id);
      notify(`${release.name} deleted`);
      refresh();
      onClose();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${release.name}` : 'Plan a release'}
      eyebrow={project?.name}
      onClose={onClose}
      width={520}
      onSubmit={submit}
      footer={(
        <>
          {editing && (
            <button type="button" className="dv-btn is-ghost dv-foot-left is-danger-text" onClick={remove}>
              <i className="bi bi-trash3" aria-hidden="true" /> Delete release
            </button>
          )}
          {errors.form && <p className="dv-field-error dv-foot-error" role="alert">{errors.form}</p>}
          <button type="button" className="dv-btn is-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="dv-btn is-primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Plan release'}
          </button>
        </>
      )}
    >
      <div className="dv-form-grid">
        {!editing && (
          <Field label="Project" htmlFor="dv-release-project" error={errors.project_id} className="is-wide">
            <select id="dv-release-project" className="dv-select" value={form.project_id} onChange={(event) => set('project_id', event.target.value)}>
              {activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Name" htmlFor="dv-release-name" error={errors.name} className="is-wide">
          <input
            id="dv-release-name"
            className="dv-input"
            data-autofocus=""
            value={form.name}
            maxLength={80}
            placeholder="Operations workspace v2"
            onChange={(event) => set('name', event.target.value)}
          />
        </Field>
        <Field label="Target date" htmlFor="dv-release-date">
          <input id="dv-release-date" type="date" className="dv-input" value={form.target_date} onChange={(event) => set('target_date', event.target.value)} />
        </Field>
        <Field
          label="Status"
          htmlFor="dv-release-status"
          hint={form.status === 'current' ? 'The roadmap opens on the current release. Only one per project.' : null}
        >
          <select id="dv-release-status" className="dv-select" value={form.status} onChange={(event) => set('status', event.target.value)}>
            {RELEASE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="What ships in it" htmlFor="dv-release-description" className="is-wide">
          <textarea
            id="dv-release-description"
            className="dv-input"
            rows={3}
            maxLength={500}
            value={form.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
