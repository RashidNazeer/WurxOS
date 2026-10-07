import React, { useState } from 'react';
import {
  DEFAULT_COLUMNS, parseColumnList, loadColumns, saveColumns, resetColumns, isCustom,
} from '../../lib/gmvMaxLayout';

/**
 * Lets the user re-teach the GMV Max parser when TikTok changes its columns.
 *
 * The paste has no header row, so the parser works out each value from the
 * column ORDER. When TikTok inserts a column, every value after it shifts and
 * the numbers land in the wrong fields — quietly, because they still look
 * plausible. Rather than wait for someone to spot that in a client report,
 * paste TikTok's header row here and the parser re-maps itself.
 */
export default function GmvMaxColumnsEditor({ accent = 'var(--danger)' }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => loadColumns().join('\n'));
  const [saved, setSaved] = useState(null);
  const custom = isCustom();

  const cols = parseColumnList(text);
  const tooFew = cols.length < 4;

  const handleSave = () => {
    saveColumns(cols);
    setSaved(`Saved ${cols.length} columns. Pastes will use this order from now on.`);
  };
  const handleReset = () => {
    resetColumns();
    setText(DEFAULT_COLUMNS.join('\n'));
    setSaved('Reset to the built-in column order.');
  };

  return (
    <div className="mb-2">
      <button type="button" onClick={() => { setOpen(o => !o); setSaved(null); }}
        className="btn btn-sm d-inline-flex align-items-center gap-1"
        style={{
          borderRadius: 'var(--radius-sm)', fontSize: '0.68rem', fontWeight: 600,
          color: 'var(--text-secondary)', background: 'transparent',
          border: '1px solid var(--border-subtle)',
        }}>
        <i className={`bi ${open ? 'bi-chevron-up' : 'bi-table'}`} />
        {open ? 'Close columns' : 'TikTok changed its columns?'}
        {custom && !open && (
          <span style={{ color: accent, fontWeight: 700 }}>· custom</span>
        )}
      </button>

      {open && (
        <div className="mt-2 p-3" style={{
          background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
        }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            Copy the <b>column header row</b> from TikTok Shop&apos;s campaign list and paste it
            below — one name per line, or comma separated. Keep them in the order TikTok shows
            them, including columns we don&apos;t use. The parser needs the order, not the names.
          </div>
          <textarea
            className="form-control form-control-sm mt-2"
            rows={7}
            value={text}
            onChange={e => { setText(e.target.value); setSaved(null); }}
            spellCheck={false}
            style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }}
          />
          <div className="d-flex align-items-center gap-2 mt-2 flex-wrap">
            <button type="button" className="btn btn-sm" onClick={handleSave} disabled={tooFew}
              style={{
                borderRadius: 'var(--radius-sm)', fontSize: '0.7rem', fontWeight: 600,
                background: accent, color: 'var(--on-accent)', border: 'none',
                opacity: tooFew ? 0.5 : 1,
              }}>
              Save columns
            </button>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={handleReset}
              style={{ borderRadius: 'var(--radius-sm)', fontSize: '0.7rem', fontWeight: 600 }}>
              Reset to default
            </button>
            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
              {cols.length} column{cols.length === 1 ? '' : 's'}
            </span>
          </div>
          {saved && (
            <div className="mt-2" style={{ fontSize: '0.7rem', color: 'var(--success-text)' }}>
              <i className="bi bi-check-circle me-1" />{saved}
            </div>
          )}
          <div className="mt-2" style={{ fontSize: '0.66rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
            Saved in this browser only, so each person sets their own. The parser still
            cross-checks ROI against GMV ÷ Cost and falls back to reading the values by
            shape if the saved order stops fitting.
          </div>
        </div>
      )}
    </div>
  );
}
