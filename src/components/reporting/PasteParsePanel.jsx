import React, { useState } from 'react';

/**
 * Reusable "Paste & Parse" affordance for report sections.
 *
 * A compact toggle button that expands to a textarea. The user pastes raw
 * copy-pasted analytics (e.g. TikTok Shop's top-videos table), we run `parse`,
 * and hand the resulting rows back via `onApply`. Purely additive to manual
 * entry — nothing here blocks typing rows by hand or using Euka autofill.
 *
 * Props:
 *   noun      – singular label for the parsed item, e.g. "video" (for messages)
 *   parse     – (text:string) => rows[]   pure parser
 *   onApply   – (rows[]) => void           merges rows into the form
 *   hint      – placeholder / helper shown inside the textarea area
 *   accent    – accent colour for the header (defaults to the theme accent)
 */
export default function PasteParsePanel({ noun = 'row', parse, onApply, hint, accent = 'var(--accent)' }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null); // { kind:'success'|'error', msg }

  const reset = () => { setText(''); setStatus(null); };

  const handleParse = () => {
    let rows = [];
    try {
      rows = parse(text) || [];
    } catch {
      setStatus({ kind: 'error', msg: `Couldn't read that — check the pasted format or enter ${noun}s manually.` });
      return;
    }
    if (!rows.length) {
      setStatus({ kind: 'error', msg: `No ${noun}s detected. Make sure you copied the whole table, or enter them manually.` });
      return;
    }
    onApply(rows);
    setStatus({ kind: 'success', msg: `Filled ${rows.length} ${noun}${rows.length === 1 ? '' : 's'} below — review & edit before submitting.` });
    setText('');
  };

  return (
    <div className="mb-3">
      <button type="button" onClick={() => { setOpen(o => !o); setStatus(null); }}
        className="btn btn-sm d-inline-flex align-items-center gap-1"
        style={{
          borderRadius: 8, fontSize: '0.72rem', fontWeight: 600,
          color: open ? '#fff' : accent,
          background: open ? accent : 'transparent',
          border: `1px solid ${accent}`,
        }}>
        <i className={`bi ${open ? 'bi-chevron-up' : 'bi-clipboard-plus'}`} />
        {open ? 'Close paste box' : 'Paste & Parse'}
      </button>

      {open && (
        <div className="mt-2 p-3 rounded-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
          <div className="d-flex align-items-start gap-2 mb-2">
            <i className="bi bi-info-circle" style={{ color: accent, fontSize: '0.95rem', marginTop: 1 }} />
            <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>{hint}</div>
          </div>
          <textarea
            value={text}
            onChange={e => { setText(e.target.value); if (status) setStatus(null); }}
            rows={8}
            placeholder="Paste the copied table here…"
            spellCheck={false}
            style={{
              width: '100%', borderRadius: 8, padding: '10px 12px',
              fontSize: '0.74rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              background: 'var(--surface-1)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', resize: 'vertical', outline: 'none',
            }}
          />
          <div className="d-flex flex-wrap align-items-center gap-2 mt-2">
            <button type="button" onClick={handleParse} disabled={!text.trim()}
              className="btn btn-sm d-inline-flex align-items-center gap-1"
              style={{ borderRadius: 8, fontSize: '0.74rem', fontWeight: 600, color: '#fff', background: accent, border: 'none', opacity: text.trim() ? 1 : 0.5 }}>
              <i className="bi bi-magic" /> Parse &amp; Fill
            </button>
            <button type="button" onClick={reset} disabled={!text && !status}
              className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.74rem' }}>
              Clear
            </button>
            {status && (
              <span className="d-inline-flex align-items-center gap-1" style={{
                fontSize: '0.72rem', fontWeight: 600,
                color: status.kind === 'success' ? 'var(--success)' : 'var(--danger)',
              }}>
                <i className={`bi ${status.kind === 'success' ? 'bi-check-circle-fill' : 'bi-exclamation-circle-fill'}`} />
                {status.msg}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
