import React from 'react';

/**
 * Compact standalone single-select for the report toolbars — the period picker
 * (Week / Month / Period) pulled OUT of the Filters popover so it's one click.
 * Native <select> styled to match the toolbar's active-filter accent.
 *
 * Props:
 *   allLabel: string                 — the "no filter" option label (e.g. "All Weeks")
 *   value:    string                 — current value ('' = all)
 *   onChange: (next: string) => void
 *   options:  [{ value, label }]
 *   title:    string (optional tooltip)
 */
export default function ToolbarSelect({ allLabel, value, onChange, options = [], title }) {
  if (!options.length) return null;
  const active = value !== '' && value != null;
  return (
    <select className="form-select form-select-sm" value={value} title={title}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: 'auto', minWidth: 128, borderRadius: 8, fontSize: '0.78rem', fontWeight: 500,
        border: `1px solid ${active ? 'var(--info)' : 'var(--border-default)'}`,
        background: active ? 'var(--info-soft)' : 'var(--surface-1)',
        color: active ? 'var(--info)' : 'var(--text-secondary)',
      }}>
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
