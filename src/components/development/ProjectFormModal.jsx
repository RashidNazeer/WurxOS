// New project / Edit project (Boss).
import { useState } from 'react';
import { useDev } from '../../pages/development/DevelopmentContext';
import { createProject, updateProject } from '../../lib/developmentApi';
import { Field, Modal } from './Overlay';
import { Avatar } from './ui';
import { HEALTH, PROJECT_COLORS, slugify } from './devModel';

const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export default function ProjectFormModal({ project, onClose }) {
  const { data, notify, refresh, confirm } = useDev();
  const editing = !!project;
  const [form, setForm] = useState(() => ({
    name: project?.name || '',
    key: project?.key || '',
    symbol: project?.symbol || '',
    color: project?.color || 'orange',
    stage: project?.stage || 'prelaunch',
    health: project?.health || 'on_track',
    description: project?.description || '',
    lead_id: project?.lead_id || '',
    member_ids: project?.member_ids || [],
  }));
  const [keyTouched, setKeyTouched] = useState(editing);
  const [symbolTouched, setSymbolTouched] = useState(editing);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  function onName(value) {
    setForm((f) => ({
      ...f,
      name: value,
      key: keyTouched ? f.key : slugify(value),
      symbol: symbolTouched ? f.symbol : (value.trim()[0] || '').toUpperCase(),
    }));
  }

  function toggleMember(id) {
    setForm((f) => ({
      ...f,
      member_ids: f.member_ids.includes(id) ? f.member_ids.filter((m) => m !== id) : [...f.member_ids, id],
    }));
  }

  async function submit() {
    const next = {};
    if (!form.name.trim()) next.name = 'Name the project.';
    if (!editing && (form.key.length < 2 || !KEY_PATTERN.test(form.key))) {
      next.key = 'Use 2–30 lowercase letters, numbers and single hyphens.';
    }
    if (!form.symbol.trim()) next.symbol = 'One or two letters.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    const fields = {
      name: form.name.trim(),
      symbol: form.symbol.trim().slice(0, 2),
      color: form.color,
      stage: form.stage,
      health: form.health,
      description: form.description.trim() || null,
      lead_id: form.lead_id || null,
      member_ids: form.member_ids,
    };
    try {
      if (editing) {
        await updateProject(project.id, fields);
        notify(`${fields.name} updated`);
      } else {
        await createProject({ ...fields, key: form.key, sort_order: data.projects.length });
        notify(`${fields.name} added`);
      }
      refresh();
      onClose();
    } catch (error) {
      setErrors({ form: error.message });
      setSaving(false);
    }
  }

  async function toggleArchive() {
    const archiving = !project.archived_at;
    if (archiving) {
      const yes = await confirm({
        title: `Archive ${project.name}?`,
        body: 'It leaves the roadmap and the project lists. Its tasks and history stay, and you can restore it later.',
        confirmLabel: 'Archive project',
        danger: true,
      });
      if (!yes) return;
    }
    try {
      await updateProject(project.id, { archived_at: archiving ? new Date().toISOString() : null });
      notify(archiving ? `${project.name} archived` : `${project.name} restored`);
      refresh();
      onClose();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${project.name}` : 'New project'}
      onClose={onClose}
      width={600}
      onSubmit={submit}
      footer={(
        <>
          {editing && (
            <button type="button" className="dv-btn is-ghost dv-foot-left" onClick={toggleArchive}>
              <i className={`bi ${project.archived_at ? 'bi-arrow-counterclockwise' : 'bi-archive'}`} aria-hidden="true" />
              {project.archived_at ? 'Restore project' : 'Archive project'}
            </button>
          )}
          {errors.form && <p className="dv-field-error dv-foot-error" role="alert">{errors.form}</p>}
          <button type="button" className="dv-btn is-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="dv-btn is-primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add project'}
          </button>
        </>
      )}
    >
      <div className="dv-form-grid">
        <Field label="Name" htmlFor="dv-project-name" error={errors.name} className="is-wide">
          <input
            id="dv-project-name"
            className="dv-input"
            data-autofocus=""
            value={form.name}
            maxLength={60}
            placeholder="Wurx Academy"
            onChange={(event) => onName(event.target.value)}
          />
        </Field>
        <Field
          label="Short name"
          htmlFor="dv-project-key"
          error={errors.key}
          hint={editing ? 'Fixed once created, so links keep working.' : 'Used in links, e.g. /development/projects/wurx-academy'}
        >
          <input
            id="dv-project-key"
            className="dv-input dv-mono"
            value={form.key}
            maxLength={30}
            readOnly={editing}
            onChange={(event) => { setKeyTouched(true); set('key', event.target.value.toLowerCase()); }}
          />
        </Field>
        <Field label="Letter mark" htmlFor="dv-project-symbol" error={errors.symbol}>
          <input
            id="dv-project-symbol"
            className="dv-input"
            value={form.symbol}
            maxLength={2}
            onChange={(event) => { setSymbolTouched(true); set('symbol', event.target.value.toUpperCase()); }}
          />
        </Field>

        <div className="dv-field is-wide">
          <span className="dv-label" id="dv-project-color-label">Colour</span>
          <div className="dv-swatches" role="radiogroup" aria-labelledby="dv-project-color-label">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={form.color === color}
                aria-label={color}
                className={`dv-swatch c-${color}${form.color === color ? ' is-on' : ''}`}
                onClick={() => set('color', color)}
              >
                {form.color === color && <i className="bi bi-check-lg" aria-hidden="true" />}
              </button>
            ))}
            <span className={`dv-mark c-${form.color} dv-swatch-preview`} aria-hidden="true">{form.symbol || '?'}</span>
          </div>
        </div>

        <Field label="Stage" htmlFor="dv-project-stage">
          <select id="dv-project-stage" className="dv-select" value={form.stage} onChange={(event) => set('stage', event.target.value)}>
            <option value="live">Live</option>
            <option value="prelaunch">Pre-launch</option>
          </select>
        </Field>
        <Field label="Health" htmlFor="dv-project-health">
          <select id="dv-project-health" className="dv-select" value={form.health} onChange={(event) => set('health', event.target.value)}>
            {HEALTH.map((h) => <option key={h.key} value={h.key}>{h.label}</option>)}
          </select>
        </Field>

        <Field label="Description" htmlFor="dv-project-description" className="is-wide">
          <input
            id="dv-project-description"
            className="dv-input"
            value={form.description}
            maxLength={300}
            placeholder="One line on what this product is for."
            onChange={(event) => set('description', event.target.value)}
          />
        </Field>

        <Field label="Lead" htmlFor="dv-project-lead">
          <select id="dv-project-lead" className="dv-select" value={form.lead_id} onChange={(event) => set('lead_id', event.target.value)}>
            <option value="">No lead</option>
            {data.people.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
          </select>
        </Field>

        <div className="dv-field is-wide">
          <span className="dv-label">Members</span>
          <div className="dv-member-picker">
            {data.people.map((person) => {
              const on = form.member_ids.includes(person.id);
              return (
                <button
                  key={person.id}
                  type="button"
                  className={`dv-chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleMember(person.id)}
                >
                  <Avatar person={person} size={20} />
                  {person.display_name}
                  {on && <i className="bi bi-check-lg" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
