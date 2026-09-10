// ============================================================
// Halo V2 — glossary (brief §7).
//
// Two pieces:
//   <Term>       an inline "?" a client can hover or FOCUS for one definition
//   <GlossaryPanel>  the whole list, opened from the key takeaway
//
// Keyboard focus matters here, not just hover: the brief asks for chart and
// detail affordances that are not hover-only, and a definition a keyboard user
// cannot reach is a definition they do not have. <button> plus title gives
// focus, Enter/Space and a native tooltip for free.
// ============================================================

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY, glossaryFor } from '../../lib/haloV2/plainLanguage.js';
import { XIcon } from '../common/Icon';
import '../../styles/table.css';

/**
 * Inline definition marker. `term` must match a GLOSSARY entry; an unknown term
 * renders nothing rather than an empty tooltip, so a typo is visible in review
 * instead of shipping a dead "?" to a client.
 */
export function Term({ term, children }) {
  const g = glossaryFor(term);
  if (!g) return children ?? null;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {children ?? g.term}
      <button
        type="button"
        title={`${g.term} — ${g.def}`}
        aria-label={`What does ${g.term} mean?`}
        style={{
          background: 'none', border: 'none', padding: '0 0 0 3px', cursor: 'help',
          color: 'var(--text-muted)', font: 'inherit', fontSize: '0.85em', lineHeight: 1,
          verticalAlign: 'super',
        }}
      >
        <i className="bi bi-question-circle" />
      </button>
    </span>
  );
}

export function GlossaryPanel({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return createPortal(
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">What these terms mean</div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 0 }}>
            Written for what each term means <em>on this page</em>, which is not always the
            textbook definition — &ldquo;attributed&rdquo;, &ldquo;modelled&rdquo; and
            &ldquo;incremental&rdquo; are three different things here, and they are routinely
            treated as one.
          </p>
          <dl style={{ margin: 0 }}>
            {GLOSSARY.map((g) => (
              <div key={g.term} style={{ padding: '10px 0', borderTop: '1px solid var(--border-subtle)' }}>
                <dt style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 13.5, color: 'var(--text-primary)' }}>{g.term}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--accent)' }}>{g.short}</span>
                </dt>
                <dd style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {g.def}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
