import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBrandSections, addBrandSectionRich, renameBrandSection,
  removeBrandSection, updateBrandSectionFields, normalizeSection,
  getBrandSectionVisibility, setBrandSectionVisibility,
} from '../../lib/brandReportSectionsApi';
import {
  PlusIcon, PencilIcon, TrashIcon, AlertIcon,
} from '../common/Icon';

/**
 * Brand Report Sections — management UI on the brand detail page.
 * Sections defined here auto-appear in every weekly / bi-weekly report
 * for this brand. Each section is one of two kinds:
 *   - long_text: a free-form rich-text area (original behavior)
 *   - table:     a fixed set of labelled inputs (text/number/url/
 *                dropdown). Numbers automatically compare against the
 *                previous week's value when the report form renders.
 *
 * Values are still stored per-report in data.customFields[fieldId].
 */
export default function BrandReportSectionsPanel({ brandId, brandName }) {
  const qc = useQueryClient();
  const [error, setError]                 = useState('');
  const [adding, setAdding]               = useState(false);
  const [editingFields, setEditingFields] = useState(null); // section id

  const { data: rawSections = [], isPending: loading } = useQuery({
    queryKey: ['brand-report-sections', brandId],
    queryFn: () => getBrandSections(brandId),
    enabled: !!brandId,
  });
  const sections = rawSections.map(normalizeSection);

  // Per-brand visibility for built-in sections (e.g. GMV Breakdown).
  const { data: visibility = {} } = useQuery({
    queryKey: ['brand-section-visibility', brandId],
    queryFn: () => getBrandSectionVisibility(brandId),
    enabled: !!brandId,
  });
  const [savingVis, setSavingVis] = useState(false);
  async function toggleBuiltin(key, enabled) {
    setError(''); setSavingVis(true);
    try {
      await setBrandSectionVisibility(brandId, key, enabled);
      qc.invalidateQueries({ queryKey: ['brand-section-visibility', brandId] });
    } catch (err) { setError(err.message || 'Could not update.'); }
    finally { setSavingVis(false); }
  }

  function reload() { qc.invalidateQueries({ queryKey: ['brand-report-sections', brandId] }); }

  async function handleAddRich(payload) {
    setError('');
    try {
      await addBrandSectionRich(brandId, payload);
      setAdding(false);
      reload();
    } catch (err) { setError(err.message || 'Could not add section.'); }
  }

  async function handleRename(section) {
    const next = window.prompt('Rename section:', section.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === section.name) return;
    try { await renameBrandSection(brandId, section.id, trimmed); reload(); }
    catch (err) { setError(err.message || 'Rename failed.'); }
  }

  async function handleRemove(section) {
    const ok = window.confirm(
      `Remove section "${section.name}"?\n\nNew reports for this brand won't show this section anymore. Existing reports keep whatever values they already have.`
    );
    if (!ok) return;
    try { await removeBrandSection(brandId, section.id); reload(); }
    catch (err) { setError(err.message || 'Remove failed.'); }
  }

  async function handleSaveFields(sectionId, fields) {
    setError('');
    try {
      await updateBrandSectionFields(brandId, sectionId, fields);
      setEditingFields(null);
      reload();
    } catch (err) { setError(err.message || 'Save failed.'); }
  }

  return (
    <div className="wx-card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Report Sections
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, maxWidth: 620 }}>
            Custom sections that auto-appear in every weekly report for{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>{brandName}</strong>.
            Choose a <strong>Long text</strong> section for free-form notes, or a{' '}
            <strong>Table</strong> section to track labelled metrics (numbers, dropdowns, links) week over week.
          </div>
        </div>
        {!adding && (
          <button className="wx-btn wx-btn-primary" onClick={() => { setAdding(true); setError(''); }}>
            <PlusIcon width="13" height="13" /> New section
          </button>
        )}
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
          <AlertIcon width="14" height="14" /> <span>{error}</span>
        </div>
      )}

      {/* Built-in section toggles (per brand) — currently just GMV Breakdown.
          Controls whether the donut/section appears in this brand's weekly
          AND monthly reports. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, padding: '12px 14px', marginBottom: 14,
        border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
        background: visibility?.gmvBreakdown ? 'var(--accent-soft)' : 'var(--surface-1)',
        cursor: savingVis ? 'wait' : 'pointer',
      }}
        onClick={() => !savingVis && toggleBuiltin('gmvBreakdown', !visibility?.gmvBreakdown)}>
        <div style={{ marginRight: 12 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>GMV Breakdown section</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Show the GMV-mix donut (Affiliate / Organic / LIVE / Video / Product Card) in this brand's weekly &amp; monthly reports.
          </div>
        </div>
        <span style={{
          width: 36, height: 20, borderRadius: 999, flex: '0 0 auto', position: 'relative',
          background: visibility?.gmvBreakdown ? 'var(--accent)' : 'var(--surface-3)',
          border: '1px solid', borderColor: visibility?.gmvBreakdown ? 'var(--accent)' : 'var(--border-default)',
          transition: 'background var(--dur-fast)',
        }}>
          <span style={{
            position: 'absolute', top: 1, left: visibility?.gmvBreakdown ? 17 : 1,
            width: 16, height: 16, borderRadius: '50%', background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)', transition: 'left var(--dur-fast)',
          }} />
        </span>
      </div>

      {adding && (
        <NewSectionForm
          onCancel={() => setAdding(false)}
          onAdd={handleAddRich} />
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : sections.length === 0 && !adding ? (
        <div className="wx-empty" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: 32 }}>
          <div className="wx-empty-title">No custom sections yet</div>
          <div style={{ fontSize: 12.5 }}>Add your first section to make it appear in all of this brand's future reports.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sections.map((section) => (
            <div key={section.id} style={{
              padding: '10px 14px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {section.name}
                    </div>
                    <KindBadge kind={section.kind} />
                  </div>
                  {section.kind === 'table' && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                      {section.fields.length === 0
                        ? 'No fields yet'
                        : section.fields.map((f) => `${f.label} (${f.type})`).join(' · ')}
                    </div>
                  )}
                </div>
                {section.kind === 'table' && (
                  <button className="wx-btn wx-btn-ghost"
                    onClick={() => setEditingFields(editingFields === section.id ? null : section.id)}
                    style={{ padding: '4px 8px', fontSize: 11.5 }} title="Edit fields">
                    Edit fields
                  </button>
                )}
                <button className="wx-btn wx-btn-ghost"
                  onClick={() => handleRename(section)}
                  style={{ padding: '4px 8px', fontSize: 11.5 }} title="Rename">
                  <PencilIcon width="12" height="12" />
                </button>
                <button className="wx-btn wx-btn-ghost"
                  onClick={() => handleRemove(section)}
                  style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--danger)' }} title="Remove">
                  <TrashIcon width="12" height="12" />
                </button>
              </div>
              {editingFields === section.id && section.kind === 'table' && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
                  <FieldsEditor
                    initialFields={section.fields}
                    onCancel={() => setEditingFields(null)}
                    onSave={(fields) => handleSaveFields(section.id, fields)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function KindBadge({ kind }) {
  const isTable = kind === 'table';
  return (
    <span style={{
      fontSize: 9.5, fontWeight: 800,
      padding: '2px 7px', borderRadius: 999,
      textTransform: 'uppercase', letterSpacing: '0.06em',
      background: isTable ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--surface-3, var(--surface-2))',
      color: isTable ? 'var(--accent)' : 'var(--text-muted)',
    }}>
      {isTable ? 'Table' : 'Long text'}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────
function NewSectionForm({ onCancel, onAdd }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('long_text');
  const [fields, setFields] = useState([emptyField()]);

  function emptyField() {
    return { label: '', type: 'text', options: [] };
  }

  function submit() {
    onAdd({
      name,
      kind,
      fields: kind === 'table' ? fields : [],
    });
  }

  const canSubmit = name.trim().length > 0
    && (kind === 'long_text' || fields.some((f) => f.label.trim()));

  return (
    <div style={{
      background: 'var(--accent-soft)',
      border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
      borderRadius: 'var(--radius-md)',
      padding: 14,
      marginBottom: 14,
    }}>
      <label className="wx-label" style={{ marginBottom: 4 }}>Section name</label>
      <input className="wx-input" autoFocus
        placeholder='e.g. "Client Notes" or "Weekly Health Metrics"'
        value={name} onChange={(e) => setName(e.target.value)} />

      <label className="wx-label" style={{ marginTop: 14, marginBottom: 4 }}>Section type</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <KindOption
          active={kind === 'long_text'}
          title="Long text"
          subtitle="Free-form notes / insights"
          onClick={() => setKind('long_text')} />
        <KindOption
          active={kind === 'table'}
          title="Table"
          subtitle="Labelled inputs (numbers, dropdowns, etc.) compared week to week"
          onClick={() => setKind('table')} />
      </div>

      {kind === 'table' && (
        <div style={{ marginTop: 14 }}>
          <label className="wx-label" style={{ marginBottom: 4 }}>Fields</label>
          <FieldsEditor inline initialFields={fields} onChange={setFields} />
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="wx-btn wx-btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="wx-btn wx-btn-primary" onClick={submit} disabled={!canSubmit}>
          <PlusIcon width="13" height="13" /> Add section
        </button>
      </div>
    </div>
  );
}

function KindOption({ active, title, subtitle, onClick }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        flex: '1 1 220px', textAlign: 'left',
        background: active ? 'var(--surface-1)' : 'transparent',
        border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '10px 12px', cursor: 'pointer',
      }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{subtitle}</div>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// FieldsEditor:
//   - "inline" mode (used inside NewSectionForm) calls onChange on every
//     edit and has no Save/Cancel — the outer form owns the state.
//   - "saving" mode (used to edit fields on an existing section) keeps
//     local state and shows Save / Cancel buttons.
function FieldsEditor({ initialFields, onChange, onSave, onCancel, inline = false }) {
  const [fields, setFields] = useState(() =>
    (initialFields && initialFields.length > 0)
      ? initialFields.map((f) => ({ ...f, options: [...(f.options || [])] }))
      : [{ label: '', type: 'text', options: [] }]
  );

  function update(next) {
    setFields(next);
    if (inline && onChange) onChange(next);
  }
  function setField(i, patch) {
    update(fields.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  }
  function addRow() { update([...fields, { label: '', type: 'text', options: [] }]); }
  function removeRow(i) { update(fields.filter((_, idx) => idx !== i)); }
  function setOptionsText(i, text) {
    const opts = text.split(',').map((o) => o.trim()).filter(Boolean);
    setField(i, { options: opts });
  }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {fields.map((f, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 1fr 1.5fr auto',
            gap: 8, alignItems: 'center',
          }}>
            <input className="wx-input" placeholder="Field label (e.g. Total Users)"
              value={f.label} onChange={(e) => setField(i, { label: e.target.value })} />
            <select className="wx-input" value={f.type}
              onChange={(e) => setField(i, { type: e.target.value })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="currency">Currency</option>
              <option value="url">URL</option>
              <option value="dropdown">Dropdown</option>
            </select>
            {f.type === 'dropdown' ? (
              <input className="wx-input"
                placeholder="Options, comma-separated (e.g. Green, Yellow, Red)"
                value={(f.options || []).join(', ')}
                onChange={(e) => setOptionsText(i, e.target.value)} />
            ) : <span />}
            <button className="wx-btn wx-btn-ghost" onClick={() => removeRow(i)}
              disabled={fields.length === 1}
              style={{ padding: '4px 8px', color: 'var(--danger)' }} title="Remove field">
              <TrashIcon width="12" height="12" />
            </button>
          </div>
        ))}
      </div>
      <button className="wx-btn wx-btn-ghost" onClick={addRow}
        style={{ marginTop: 8, fontSize: 12 }}>
        <PlusIcon width="12" height="12" /> Add field
      </button>
      {!inline && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="wx-btn wx-btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={() => onSave(fields)}
            disabled={!fields.some((f) => f.label.trim())}>
            Save fields
          </button>
        </div>
      )}
    </div>
  );
}
