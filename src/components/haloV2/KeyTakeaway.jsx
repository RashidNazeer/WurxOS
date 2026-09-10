// ============================================================
// Halo V2 — the key takeaway (brief §1).
//
// The first viewport. A brand CMO must be able to answer three questions from
// this block alone, without scrolling and without an analyst:
//   what moved · how sure are we · what must we not claim
//
// Everything else on the page is detail behind that. The measurement stepper,
// the controls and the model diagnostics used to occupy this space, which is
// why the review said a non-data-scientist could not understand the page: the
// first thing they saw was apparatus, not an answer.
//
// The MODELED · NOT INCREMENTAL badge is deliberately LARGE here. Elsewhere it
// is a small chip travelling with a figure; in the takeaway it is a headline
// caveat, because this is the block someone screenshots.
// ============================================================

import { ModelledBadge } from './shared.jsx';

export default function KeyTakeaway({ takeaway, sticky = true, onOpenGlossary }) {
  if (!takeaway) return null;

  const dirColor = takeaway.direction === 'positive' ? 'var(--success, #22c55e)'
    : takeaway.direction === 'negative' ? 'var(--danger, #ef4444)'
    : 'var(--text-muted)';

  return (
    <div
      className="wx-card"
      style={{
        padding: '18px 20px',
        borderLeft: `4px solid ${dirColor}`,
        // Sticky so the answer stays on screen while the reader scrolls into
        // the evidence.
        //
        // top MUST be var(--topbar-h) rather than 0: the page itself scrolls
        // (.shell is a grid with min-height:100vh; only the sidebar nav has its
        // own overflow) and .shell-topbar is sticky at the top of that scroll.
        // At top:0 this card slid underneath the topbar. shell.css says as much
        // where it declares the variable, and every other sticky header in the
        // app pins the same way.
        //
        // The portal renders no shell, so it sets --topbar-h: 0px on its root
        // and the same expression resolves to a flush 0 there.
        ...(sticky ? { position: 'sticky', top: 'var(--topbar-h, 68px)', zIndex: 5 } : null),
        background: 'var(--surface-1)',
        boxShadow: sticky ? '0 2px 12px rgba(0,0,0,.08)' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 420px', minWidth: 280 }}>
          <div style={{
            fontSize: 10, fontWeight: 800, letterSpacing: '.08em',
            textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6,
          }}>
            What happened
          </div>

          {/* The answer. Kept to one sentence -- if it needs two, it is not a
              takeaway. */}
          <h2 style={{
            fontSize: 'clamp(1.05rem, 2.2vw, 1.4rem)', fontWeight: 800, margin: 0,
            lineHeight: 1.3, color: 'var(--text-primary)',
          }}>
            {takeaway.headline}
          </h2>

          {/* Confidence + how much data it rests on, side by side, because one
              without the other is misleading in both directions. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
            {takeaway.confidenceLabel && (
              <span style={{
                fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                background: 'var(--surface-3, rgba(148,163,184,.16))', color: 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
              }}>
                {takeaway.confidenceLabel}
              </span>
            )}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {takeaway.observations} {takeaway.observationUnit}{takeaway.observations === 1 ? '' : 's'} of data
            </span>
            {onOpenGlossary && (
              <button
                type="button"
                className="wx-btn wx-btn-ghost wx-btn-sm"
                onClick={onOpenGlossary}
                style={{ fontSize: 11.5, padding: '2px 8px' }}
              >
                <i className="bi bi-question-circle" style={{ marginRight: 4 }} />What do these terms mean?
              </button>
            )}
          </div>
        </div>

        {/* The caveat block. Not a footnote -- it sits at the same visual weight
            as the answer, because the answer is not safe to read without it. */}
        <div style={{
          flex: '0 1 300px', minWidth: 250,
          padding: '12px 14px', borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
        }}>
          <div style={{ marginBottom: 8 }}><ModelledBadge /></div>
          <div style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 600, lineHeight: 1.45 }}>
            {takeaway.caveat}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.45 }}>
            {takeaway.soWhat}
          </div>
        </div>
      </div>
    </div>
  );
}
