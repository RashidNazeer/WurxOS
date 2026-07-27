// ============================================================
// Brand-scoped custom report sections — shared by the Weekly, Bi-Weekly,
// and Monthly report forms.
//
// These were originally inline in WeeklyReportForm.jsx; extracted here so
// every report type renders/edits brand custom sections identically and the
// implementations can't drift. The Monthly form previously had only a
// per-USER "custom fields" template, which leaked the same fields across
// every brand — this shared, brand-scoped mechanism replaces that.
//
// Storage shape inside data.customFields:
//   long_text:      { [section.id]: { name, value, kind:'long_text', source:'brand' } }
//   table:          { [field.id]:   { name, value, kind:'table', sectionId, sectionName, type, source:'brand' } }
//   builtin_extra:  { [field.id]:   { name, value, kind:'builtin_extra', sectionKey, sectionTitle, type, source:'brand' } }
// These coexist with legacy user-level custom fields (no `kind`/`source`).
// ============================================================
import React, { useState } from 'react';
import { cleanNumericInput } from '../../lib/reportsApi';
import RichTextEditor from '../shared/RichTextEditor';

// `onDelete`, when provided, renders a trash button — used ONLY for
// APC-created custom sections. Built-in/default sections never pass it, so
// they can never be deleted.
export function SectionHeader({ icon, title, color, required, enabled = true, onToggle, onDelete }) {
  const togglable = typeof onToggle === 'function';
  const deletable = typeof onDelete === 'function';
  return (
    <div className="d-flex align-items-center gap-2 mb-3 mt-4">
      <div className="rounded-2 d-flex align-items-center justify-content-center"
        style={{
          width: 32, height: 32,
          background: enabled ? color + '18' : 'var(--surface-2)',
          opacity: enabled ? 1 : 0.55,
        }}>
        <i className={`bi ${icon}`} style={{
          fontSize: '0.9rem',
          color: enabled ? color : 'var(--text-muted)',
        }} />
      </div>
      <h6 className="fw-bold mb-0" style={{
        fontSize: '0.95rem',
        color: enabled ? 'var(--text-primary)' : 'var(--text-muted)',
        textDecoration: enabled ? 'none' : 'line-through',
      }}>
        {title}
        {required && enabled && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
      </h6>
      {!enabled && (
        <span className="badge" style={{
          background: 'var(--surface-2)', color: 'var(--text-muted)',
          fontSize: '0.62rem', fontWeight: 600, letterSpacing: 0.3,
        }}>
          HIDDEN
        </span>
      )}
      {(togglable || deletable) && (
        <div className="d-flex align-items-center gap-2 ms-auto">
          {deletable && (
            <button
              type="button"
              className="btn btn-sm btn-light border-0 text-danger"
              style={{ padding: '2px 8px', fontSize: '0.72rem' }}
              onClick={onDelete}
              title="Delete this custom section">
              <i className="bi bi-trash3" />
            </button>
          )}
          {togglable && (
            <div className="form-check form-switch mb-0" style={{ paddingLeft: '2.4em' }}>
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                checked={!!enabled}
                onChange={(e) => onToggle(e.target.checked)}
                title={enabled ? 'Hide this section in the report' : 'Show this section in the report'}
                style={{ cursor: 'pointer' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Standalone brand custom sections (long_text or table). Each respects the
   per-report visibility toggle, exactly like built-in sections. */
export function BrandSectionsBlock({ sections, data, setData, previousReport, sectEnabled, toggleSection, onDelete, renderPreset }) {
  function setCustomEntry(id, entry) {
    setData((d) => ({
      ...d,
      customFields: { ...(d.customFields || {}), [id]: entry },
    }));
  }

  return (
    <>
      {sections.map((section) => {
        const enabled = sectEnabled?.[section.id] !== false;
        const header = (
          <SectionHeader
            icon={section.kind === 'table' ? 'bi-table' : 'bi-card-text'}
            title={section.name}
            color="#0ea5e9"
            enabled={enabled}
            onToggle={toggleSection(section.id)}
            onDelete={() => onDelete(section)}
          />
        );
        if (section.kind === 'table') {
          return (
            <div key={section.id} id={`sec-cs-${section.id}`} style={{ scrollMarginTop: 12 }}>
              {header}
              {enabled && (
                <BrandTableSection section={section} data={data} setData={setData} renderPreset={renderPreset} />
              )}
            </div>
          );
        }
        // long_text
        const entry = data.customFields?.[section.id];
        const value = typeof entry === 'string' ? entry : (entry?.value || '');
        return (
          <div key={section.id} id={`sec-cs-${section.id}`} style={{ scrollMarginTop: 12 }}>
            {header}
            {enabled && (
            <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
              <div className="card-body p-3">
                {renderPreset?.(section)}
                <RichTextEditor
                  value={value}
                  onChange={(v) => setCustomEntry(section.id, {
                    name: section.name,
                    value: v,
                    kind: 'long_text',
                    source: 'brand',
                  })}
                  minHeight={120}
                  placeholder={`Add notes for ${section.name}…`} />
              </div>
            </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// A brand "table" custom section as a REAL editable table: the section's fields
// are the COLUMNS; the user adds as many ROWS as they want. Stored as ONE entry
// under the section id: { kind:'table', name, sectionId, columns[], rows[], source }.
// Legacy per-field single values (old model) seed the first row and are cleaned up
// on the first edit, so old sections keep their data without a migration.
function BrandTableSection({ section, data, setData, renderPreset }) {
  const columns = section.fields || [];
  const entry = data.customFields?.[section.id];

  let rows = entry && Array.isArray(entry.rows) && entry.rows.length ? entry.rows : null;
  if (!rows) {
    const legacy = {}; let any = false;
    columns.forEach((c) => {
      const old = data.customFields?.[c.id];
      if (old && typeof old === 'object' && old.value != null && old.value !== '') { legacy[c.id] = old.value; any = true; }
    });
    rows = any ? [legacy] : [{}];
  }

  function save(newRows) {
    setData((d) => {
      const cf = { ...(d.customFields || {}) };
      columns.forEach((c) => { if (cf[c.id]?.kind === 'table') delete cf[c.id]; }); // drop legacy per-field entries
      cf[section.id] = {
        kind: 'table', name: section.name, sectionId: section.id, source: 'brand',
        columns: columns.map((c) => ({ id: c.id, label: c.label, type: c.type, options: c.options || [] })),
        rows: newRows,
      };
      return { ...d, customFields: cf };
    });
  }
  const setCell = (ri, colId, v) => save(rows.map((r, i) => (i === ri ? { ...r, [colId]: v } : r)));
  const addRow = () => save([...rows, {}]);
  const removeRow = (ri) => { const next = rows.filter((_, i) => i !== ri); save(next.length ? next : [{}]); };

  const th = { padding: '6px 8px', textAlign: 'left', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border-subtle)' };

  return (
    <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
      <div className="card-body p-3">
        {renderPreset?.(section)}
        {columns.length === 0 ? (
          <div className="text-muted" style={{ fontSize: '0.82rem' }}>No columns defined for this table. Delete it and add one with columns.</div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 30, textAlign: 'center', color: 'var(--text-muted)' }}>#</th>
                    {columns.map((c) => <th key={c.id} style={th}>{c.label}</th>)}
                    <th style={{ ...th, width: 38 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri}>
                      <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{ri + 1}</td>
                      {columns.map((c) => (
                        <td key={c.id} style={{ padding: 4, minWidth: 130 }}>
                          <BrandFieldInput field={c} value={row?.[c.id] ?? ''} onChange={(v) => setCell(ri, c.id, v)} />
                        </td>
                      ))}
                      <td style={{ padding: 4, textAlign: 'center' }}>
                        <button type="button" className="btn btn-sm btn-light border-0 text-danger"
                          onClick={() => removeRow(ri)} title="Remove row" style={{ padding: '2px 6px' }}>
                          <i className="bi bi-trash3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn-sm btn-outline-secondary mt-2"
              onClick={addRow} style={{ borderRadius: 8, fontSize: '0.76rem' }}>
              <i className="bi bi-plus-circle" /> Add row
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BrandFieldInput({ field, value, onChange }) {
  if (field.type === 'dropdown') {
    return (
      <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
        value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Select —</option>
        {(field.options || []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  if (field.type === 'number' || field.type === 'currency') {
    return (
      <input type="text" inputMode="decimal"
        className="form-control form-control-sm" style={{ borderRadius: 8 }}
        placeholder="0" value={value ?? ''}
        onChange={(e) => onChange(cleanNumericInput(e.target.value))} />
    );
  }
  if (field.type === 'url') {
    return (
      <input type="url" className="form-control form-control-sm" style={{ borderRadius: 8 }}
        placeholder="https://…" value={value ?? ''}
        onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <input type="text" className="form-control form-control-sm" style={{ borderRadius: 8 }}
      value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
  );
}

/* ── Built-in section extras ───────────────────────────────────────────────
   Inline UI inside each built-in section. Each saved field renders as a
   Field-sized cell in the same flex-wrap row as the built-in inputs, with a
   "+ Add field" pill at the end. `comparisonLabel` is "Last week" / "Last
   month" so the delta hint reads correctly per report type. */
export function BuiltinExtras({
  sectionKey, sectionTitle, fields, data, setData, previousReport,
  disabled, onAddField, onRemoveField, curSym, comparisonLabel = 'Previous',
}) {
  const [adding, setAdding] = useState(false);

  function setValue(fieldId, fieldLabel, fieldType, v) {
    setData((d) => ({
      ...d,
      customFields: {
        ...(d.customFields || {}),
        [fieldId]: {
          name: fieldLabel,
          value: v,
          kind: 'builtin_extra',
          sectionKey,
          sectionTitle,
          type: fieldType,
          source: 'brand',
        },
      },
    }));
  }

  function getPrev(fieldId, label) {
    const prev = previousReport?.customFields || {};
    const byId = prev[fieldId];
    if (byId) return byId;
    if (label) {
      const byName = Object.values(prev).find((v) =>
        v && typeof v === 'object' && v.name === label);
      if (byName) return byName;
    }
    return null;
  }

  async function handleRemove(field) {
    const ok = window.confirm(
      `Remove "${field.label}" from ${sectionTitle}?\n\nIt'll disappear from this report and from future reports for this brand. Existing reports keep their saved values.`
    );
    if (!ok) return;
    try { await onRemoveField(field.id); }
    catch (err) { alert(err?.message || 'Could not remove the field.'); }
  }

  const hasFields = fields.length > 0;
  return (
    <>
      {hasFields && (
        <div className="d-flex flex-wrap gap-2 mb-2">
          {fields.map((f) => {
            const entry = data.customFields?.[f.id];
            const value = entry?.value ?? '';
            const prev  = getPrev(f.id, f.label);
            const prevValue = prev?.value ?? '';
            const labelWithCurrency = f.type === 'currency' ? `${f.label} (${curSym})` : f.label;
            return (
              <ExtraFieldCell key={f.id}
                field={f}
                labelText={labelWithCurrency}
                value={value}
                prevValue={prevValue}
                comparisonLabel={comparisonLabel}
                onChange={(v) => setValue(f.id, f.label, f.type, v)}
                onRemove={() => handleRemove(f)} />
            );
          })}
        </div>
      )}

      {adding ? (
        <AddFieldInline
          onCancel={() => setAdding(false)}
          onSave={async (def) => {
            try { await onAddField(def); setAdding(false); }
            catch (err) { alert(err?.message || 'Could not save the field.'); }
          }} />
      ) : (
        <button type="button"
          className="btn btn-sm d-inline-flex align-items-center gap-1"
          style={{ borderRadius: 9, fontSize: '0.74rem', fontWeight: 600, marginTop: 10, border: '1px solid var(--border-default)', background: 'var(--surface-1)', color: 'var(--text-secondary)' }}
          disabled={disabled}
          title={disabled ? 'Select a brand first' : 'Add a custom field to this section'}
          onClick={() => setAdding(true)}>
          <i className="bi bi-plus-circle" /> Add field
        </button>
      )}
    </>
  );
}

function ExtraFieldCell({ field, labelText, value, prevValue, comparisonLabel = 'Previous', onChange, onRemove }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ flex: '1 1 140px', minWidth: 120, position: 'relative' }}>
      <div className="d-flex align-items-center justify-content-between mb-1" style={{ gap: 6 }}>
        <label className="form-label mb-0" style={{
          fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-secondary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {labelText}
        </label>
        <button type="button"
          onClick={onRemove}
          title="Remove this field"
          style={{
            background: 'transparent', border: 0, padding: 0,
            color: 'var(--text-muted)', cursor: 'pointer',
            fontSize: '0.7rem', lineHeight: 1,
            opacity: hover ? 1 : 0,
            transition: 'opacity 120ms',
          }}>
          <i className="bi bi-x-lg" />
        </button>
      </div>
      <BrandFieldInput field={field} value={value} onChange={onChange} />
      {prevValue !== '' && prevValue != null && (
        <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 2 }}>
          {comparisonLabel}: <strong style={{ color: 'var(--text-secondary)' }}>{String(prevValue)}</strong>
          <NumericDelta cur={value} prev={prevValue} type={field.type} />
        </div>
      )}
    </div>
  );
}

function NumericDelta({ cur, prev, type }) {
  if (type !== 'number' && type !== 'currency') return null;
  if (cur === '' || cur == null || prev === '' || prev == null) return null;
  const a = Number(cur), b = Number(prev);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = a - b;
  if (diff === 0) return null;
  const up = diff > 0;
  return (
    <span style={{ marginLeft: 6, color: up ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>
      {up ? '▲' : '▼'} {Math.abs(diff).toLocaleString()}
    </span>
  );
}

/* Inline "add a single field" form. Used by BuiltinExtras. */
function AddFieldInline({ onCancel, onSave }) {
  const [label, setLabel]   = useState('');
  const [type, setType]     = useState('text');
  const [options, setOpts]  = useState('');
  const canSave = label.trim().length > 0 && (type !== 'dropdown' || options.trim().length > 0);

  return (
    <div style={{
      padding: 10, marginBottom: 8,
      background: 'var(--accent-soft)',
      border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
      borderRadius: 10,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.6fr', gap: 8 }}>
        <input className="form-control form-control-sm" autoFocus
          placeholder="Field label (e.g. Total Users)"
          value={label} onChange={(e) => setLabel(e.target.value)} />
        <select className="form-select form-select-sm" value={type}
          onChange={(e) => setType(e.target.value)}>
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="currency">Currency</option>
          <option value="url">URL</option>
          <option value="dropdown">Dropdown</option>
        </select>
        {type === 'dropdown' ? (
          <input className="form-control form-control-sm"
            placeholder="Options, comma-separated (e.g. Green, Yellow, Red)"
            value={options} onChange={(e) => setOpts(e.target.value)} />
        ) : <span />}
      </div>
      <div className="d-flex justify-content-end gap-2 mt-2">
        <button type="button" className="btn btn-sm btn-light" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-sm btn-dark"
          disabled={!canSave}
          onClick={() => onSave({
            label: label.trim(), type,
            options: type === 'dropdown'
              ? options.split(',').map((o) => o.trim()).filter(Boolean)
              : [],
          })}>
          Save field
        </button>
      </div>
    </div>
  );
}

/* Inline "add a brand-wide custom section" form. Used at the bottom of the
   Brand Sections block. */
// `defaultReportType` ('weekly'|'monthly'|'biweekly') seeds the "Appears in"
// picker so a section created here defaults to the current report's type.
const APPLIES_LABELS = { weekly: 'Weekly', biweekly: 'Bi-Weekly', monthly: 'Monthly' };
const APPLIES_ORDER = ['weekly', 'biweekly', 'monthly'];
export function AddCustomSectionInline({ disabled, onAdd, defaultReportType }) {
  const [open, setOpen]   = useState(false);
  const [name, setName]   = useState('');
  const [kind, setKind]   = useState('long_text');
  const [fields, setFields] = useState([{ label: '', type: 'text', options: '' }]);
  const [applies, setApplies] = useState(defaultReportType ? [defaultReportType] : ['weekly', 'monthly']);
  const [error, setError] = useState('');

  function reset() {
    setOpen(false); setName(''); setKind('long_text');
    setFields([{ label: '', type: 'text', options: '' }]);
    setApplies(defaultReportType ? [defaultReportType] : ['weekly', 'monthly']);
    setError('');
  }

  function toggleApplies(t) {
    setApplies((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  }

  async function submit() {
    setError('');
    if (!applies.length) { setError('Pick at least one report type this section appears in.'); return; }
    try {
      const payload = {
        name: name.trim(),
        kind,
        appliesTo: applies,
        fields: kind === 'table'
          ? fields.filter((f) => f.label.trim()).map((f) => ({
              label: f.label.trim(), type: f.type,
              options: f.type === 'dropdown'
                ? f.options.split(',').map((o) => o.trim()).filter(Boolean)
                : [],
            }))
          : [],
      };
      await onAdd(payload);
      reset();
    } catch (err) { setError(err?.message || 'Could not add the section.'); }
  }

  if (!open) {
    return (
      <button type="button"
        className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1"
        style={{ borderRadius: 8, fontSize: '0.78rem' }}
        disabled={disabled}
        title={disabled ? 'Select a brand first' : ''}
        onClick={() => setOpen(true)}>
        <i className="bi bi-plus-circle" /> Add custom section
      </button>
    );
  }

  const canSave = name.trim().length > 0
    && (kind === 'long_text' || fields.some((f) => f.label.trim()));

  return (
    <div>
      <div className="fw-bold mb-2" style={{ fontSize: '0.85rem' }}>New custom section</div>
      {error && (
        <div className="alert alert-danger py-2 mb-2" style={{ fontSize: '0.78rem' }}>{error}</div>
      )}
      <input className="form-control form-control-sm mb-2" autoFocus
        placeholder='Section name (e.g. "Client Notes" or "Health Metrics")'
        value={name} onChange={(e) => setName(e.target.value)} />
      <div className="d-flex gap-2 mb-2">
        <KindRadio active={kind === 'long_text'} onClick={() => setKind('long_text')}
          title="Long text" subtitle="Free-form notes / insights" />
        <KindRadio active={kind === 'table'} onClick={() => setKind('table')}
          title="Table" subtitle="Labelled inputs compared period to period" />
      </div>
      <div className="mb-2">
        <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Appears in
        </div>
        <div className="d-flex gap-2 flex-wrap">
          {APPLIES_ORDER.map((t) => {
            const on = applies.includes(t);
            return (
              <button key={t} type="button" onClick={() => toggleApplies(t)}
                style={{
                  fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                  border: on ? '1px solid var(--accent)' : '1px solid var(--border-default)',
                  background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                  color: on ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer',
                }}
                title={on ? `Showing in ${APPLIES_LABELS[t]} reports — click to remove` : `Also show in ${APPLIES_LABELS[t]} reports`}>
                {on ? '✓ ' : ''}{APPLIES_LABELS[t]}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
          This section will only appear on the report types you pick here.
        </div>
      </div>
      {kind === 'table' && (
        <div className="d-flex flex-column gap-2 mb-2">
          {fields.map((f, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1.6fr auto', gap: 6 }}>
              <input className="form-control form-control-sm" placeholder="Field label"
                value={f.label}
                onChange={(e) => setFields((cur) => cur.map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))} />
              <select className="form-select form-select-sm" value={f.type}
                onChange={(e) => setFields((cur) => cur.map((x, idx) => idx === i ? { ...x, type: e.target.value } : x))}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="currency">Currency</option>
                <option value="url">URL</option>
                <option value="dropdown">Dropdown</option>
              </select>
              {f.type === 'dropdown' ? (
                <input className="form-control form-control-sm" placeholder="Comma-separated options"
                  value={f.options}
                  onChange={(e) => setFields((cur) => cur.map((x, idx) => idx === i ? { ...x, options: e.target.value } : x))} />
              ) : <span />}
              <button type="button" className="btn btn-sm btn-light border-0 text-danger"
                disabled={fields.length === 1}
                onClick={() => setFields((cur) => cur.filter((_, idx) => idx !== i))}
                style={{ padding: '2px 8px' }}>
                <i className="bi bi-trash3" />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-outline-secondary align-self-start"
            onClick={() => setFields((cur) => [...cur, { label: '', type: 'text', options: '' }])}>
            <i className="bi bi-plus-circle" /> Add field
          </button>
        </div>
      )}
      <div className="d-flex justify-content-end gap-2">
        <button type="button" className="btn btn-sm btn-light" onClick={reset}>Cancel</button>
        <button type="button" className="btn btn-sm btn-dark" disabled={!canSave} onClick={submit}>
          Add section
        </button>
      </div>
    </div>
  );
}

function KindRadio({ active, title, subtitle, onClick }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        flex: '1 1 220px', textAlign: 'left',
        background: active ? 'var(--surface-1)' : 'transparent',
        border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
        borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
      }}>
      <div style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{subtitle}</div>
    </button>
  );
}
