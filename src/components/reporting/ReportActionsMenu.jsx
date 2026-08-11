import { useEffect, useRef, useState } from 'react';

// "Other options" dropdown for the report-detail sticky bar.
//
// The report view (WeeklyReportView / MonthlyReportView) owns the
// highlighter + export logic; it hands the handlers up through its
// `onActions` callback. This menu renders them so they stay
// reachable while scrolling a long report, without cluttering the
// sticky bar with extra buttons.
//
// `actions` is null until the report view has mounted and reported
// its handlers — render nothing until then.
// `extraItems` are page-supplied menu rows shown ABOVE the report-view actions
// (e.g. Submit as APC / Delete) — each { key, label, icon, iconColor, onClick,
// disabled, danger }. `hidePrimaryExports` drops Highlighter + Export PDF from
// the menu when the page surfaces them as their own icon buttons instead.
export default function ReportActionsMenu({ actions, extraItems = [], hidePrimaryExports = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const items = (extraItems || []).filter(Boolean);
  if (!actions && !items.length) return null;

  const {
    highlighterActive, onToggleHighlighter,
    onExportPdf, pdfBusy,
    onExportWord, docxBusy,
    canCopyInsights, onCopyInsights, copyDone,
  } = actions || {};

  const itemStyle = {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
    padding: '8px 10px', border: 0, background: 'transparent',
    color: 'var(--text-primary)', fontSize: '0.8rem', cursor: 'pointer',
    textAlign: 'left', borderRadius: 8, lineHeight: 1.3,
  };

  function run(fn) {
    if (typeof fn === 'function') fn();
    setOpen(false);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
        style={{ borderRadius: 8, fontSize: '0.78rem' }}
        onClick={() => setOpen((o) => !o)}
        title="More report actions">
        <i className="bi bi-three-dots" /> Other options
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30,
          minWidth: 224, background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)', borderRadius: 10,
          boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0,0,0,0.2))', padding: 6,
        }}>
          {items.map((it) => (
            <button key={it.key} type="button" disabled={it.disabled}
              style={{ ...itemStyle, color: it.danger ? 'var(--danger)' : 'var(--text-primary)', opacity: it.disabled ? 0.6 : 1 }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => run(it.onClick)}>
              <i className={`bi ${it.icon}`} style={{ color: it.iconColor || (it.danger ? 'var(--danger)' : 'var(--text-secondary)') }} />
              {it.label}
            </button>
          ))}
          {items.length > 0 && actions && (
            <div style={{ height: 1, background: 'var(--border-subtle)', margin: '5px 6px' }} />
          )}
          {actions && !hidePrimaryExports && (
          <button
            type="button"
            style={itemStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            onClick={() => run(onToggleHighlighter)}>
            <i className="bi bi-highlighter" style={{ color: 'var(--warning)' }} />
            {highlighterActive ? 'Highlighter — on (click to stop)' : 'Highlighter'}
          </button>
          )}
          {canCopyInsights && (
            <button
              type="button"
              style={itemStyle}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => run(onCopyInsights)}>
              <i className={`bi ${copyDone ? 'bi-check-circle-fill' : 'bi-clipboard-check'}`}
                style={{ color: 'var(--accent)' }} />
              {copyDone ? 'Copied!' : 'Copy all insights'}
            </button>
          )}
          {actions && !hidePrimaryExports && (
          <button
            type="button"
            style={{ ...itemStyle, opacity: pdfBusy ? 0.6 : 1 }}
            disabled={pdfBusy}
            onMouseEnter={(e) => { if (!pdfBusy) e.currentTarget.style.background = 'var(--surface-2)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            onClick={() => run(onExportPdf)}>
            <i className="bi bi-file-earmark-pdf" style={{ color: 'var(--accent)' }} />
            {pdfBusy ? 'Exporting PDF…' : 'Export PDF'}
          </button>
          )}
          {typeof onExportWord === 'function' && (
            <button
              type="button"
              style={{ ...itemStyle, opacity: docxBusy ? 0.6 : 1 }}
              disabled={docxBusy}
              onMouseEnter={(e) => { if (!docxBusy) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              onClick={() => run(onExportWord)}>
              <i className="bi bi-file-earmark-word" style={{ color: 'var(--info)' }} />
              {docxBusy ? 'Building Word…' : 'Export Word'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
