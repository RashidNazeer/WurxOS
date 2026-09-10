// ============================================================
// Halo V2 — the one-page client summary (brief §6).
//
// A purpose-built document, not a screenshot of the page. Capturing the live
// explorer would produce several feet of PDF containing dropdowns, disclosure
// buttons and an empty-state panel — controls a client cannot use in a file.
// This renders the eight things that belong in front of a CMO and nothing else.
//
// Rendered OFF-SCREEN at a fixed 820px so the raster has a stable page width
// regardless of the browser window, and wrapped in data-theme="light" so the
// document is light whatever theme the app is in. tokens.css scopes its palette
// on [data-theme='...'] selectors, so nesting the attribute re-resolves every
// token inside this subtree — no hardcoded hex needed to guarantee a light page.
//
// It is laid out (left: -10000px), NOT display:none: html-to-image captures
// through the real browser renderer, and an element with no layout box
// rasterises to nothing.
// ============================================================

import { fmtValue } from '../../lib/haloFields';
import { plainMetricLabel, comparisonSentence } from '../../lib/haloV2/plainLanguage.js';
import { GRAIN_LABEL } from '../../lib/haloV2/grainRecommendation.js';

export const SUMMARY_WIDTH = 820;

export default function ClientSummarySheet({
  sheetRef, result, takeaway, gran, range, xKey, yKey, cur, brandName,
}) {
  const m = result?.adjustedModel || {};
  const contrib = result?.historicalContribution || null;
  const lagged = m.laggedOnlyAvailable ? m.laggedOnly : null;
  const sharePct = m.samePeriodShare == null ? null : Math.round(m.samePeriodShare * 100);
  const unit = gran;

  return (
    <div
      aria-hidden="true"
      style={{ position: 'fixed', left: -10000, top: 0, pointerEvents: 'none' }}
    >
      <div
        ref={sheetRef}
        data-theme="light"
        style={{
          width: SUMMARY_WIDTH,
          padding: 36,
          background: 'var(--surface-1)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Header ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.01em' }}>Amazon Halo V2</div>
            {brandName && <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 2 }}>{brandName}</div>}
          </div>
          <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <div>{GRAIN_LABEL[gran] || gran} view</div>
            {range?.start && range?.end && <div>{range.start} to {range.end}</div>}
            <div>Generated {new Date().toLocaleDateString()}</div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, paddingBottom: 14, borderBottom: '2px solid var(--border-default)' }}>
          Comparing <strong>{comparisonSentence(xKey, yKey)}</strong>
        </div>

        {/* ── The answer ─────────────────────────────────────── */}
        <div style={{ marginTop: 20 }}>
          <SectionLabel>What happened</SectionLabel>
          <div style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.35, marginTop: 6 }}>
            {takeaway?.headline}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap', fontSize: 12 }}>
            {takeaway?.confidenceLabel && (
              <span style={{
                fontWeight: 700, padding: '3px 10px', borderRadius: 999,
                background: 'var(--surface-3, #eef1f5)', border: '1px solid var(--border-subtle)',
              }}>{takeaway.confidenceLabel}</span>
            )}
            <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>
              {takeaway?.observations} {takeaway?.observationUnit}s of data
            </span>
          </div>
        </div>

        {/* ── The badge + caveats. High on the page on purpose: this is a
             document that will be forwarded without its context. ───── */}
        <div style={{
          marginTop: 18, padding: 14, borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border-default)',
        }}>
          <div style={{
            display: 'inline-block', fontSize: 11, fontWeight: 800, letterSpacing: '.06em',
            padding: '4px 9px', borderRadius: 4, marginBottom: 8,
            background: 'var(--warning-soft, #fdf3e3)', color: 'var(--warning, #b45309)',
            border: '1px solid var(--warning, #b45309)',
          }}>
            MODELLED · NOT INCREMENTAL
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.5 }}>{takeaway?.caveat}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
            {takeaway?.soWhat}
          </div>
        </div>

        {/* ── The figures ───────────────────────────────────── */}
        <div style={{ marginTop: 22 }}>
          <SectionLabel>What the model suggests</SectionLabel>
          {!m.available ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.5 }}>
              <strong>{m.headline}</strong> {m.message}
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                <Figure
                  label={lagged ? 'Delayed halo (lagged only)' : 'Same-period association'}
                  value={lagged
                    ? `${cur}${lagged.coefficient.toFixed(2)} per ${cur}1`
                    : `${cur}${m.cumulativeCoefficient.toFixed(2)} per ${cur}1`}
                  sub={lagged
                    ? (lagged.lower == null ? 'No interval available'
                      : `95% interval ${cur}${lagged.lower.toFixed(2)} to ${cur}${lagged.upper.toFixed(2)}${lagged.spansZero ? ' — includes zero' : ''}`)
                    : 'No lag window selected, so no delayed effect was looked for'}
                  primary
                />
                <Figure
                  label="Full cumulative"
                  value={`${cur}${m.cumulativeCoefficient.toFixed(2)} per ${cur}1`}
                  sub={`Includes same-${unit} co-movement, which is not a delay${sharePct != null ? ` — ${sharePct}% of this figure` : ''}`}
                />
                {contrib && (
                  <Figure
                    label="Modelled contribution"
                    value={fmtValue(contrib.amount, 'money')}
                    sub={contrib.lower == null
                      ? `Measured against the ${contrib.referenceLabel.toLowerCase()}`
                      : `95% interval ${fmtValue(contrib.lower, 'money')} to ${fmtValue(contrib.upper, 'money')} · vs ${contrib.referenceLabel.toLowerCase()}`}
                  />
                )}
                <Figure
                  label="Confidence"
                  value={m.confidenceLabel}
                  sub={m.confidenceCeiling
                    ? `Capped from ${m.confidenceEarned} — a major factor is not in the model`
                    : `${m.sampleSize} usable ${unit}s`}
                />
              </div>

              {/* ── Controls honesty, verbatim from what the model did ── */}
              <div style={{ marginTop: 16, fontSize: 11.5, lineHeight: 1.6 }}>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Adjusted for: </span>
                  <strong>{m.controls?.length ? m.controls.join(', ') : 'nothing'}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Not adjusted for: </span>
                  <strong>{m.controlsUnavailable?.length ? m.controlsUnavailable.join('; ') : 'nothing outstanding'}</strong>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────── */}
        <div style={{
          marginTop: 24, paddingTop: 12, borderTop: '1px solid var(--border-subtle)',
          fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.6,
        }}>
          <div>
            Correlation is not causation. Figures here are an estimate of <strong>association</strong> after
            the controls listed above — not proof of cause, and not attributed sales.
          </div>
          <div style={{ marginTop: 3 }}>
            Incremental lift would require a controlled test (a geo or holdout experiment). This tool does
            not run one, so nothing in this document is incremental.
          </div>
          {m.available && (
            <div style={{ marginTop: 3 }}>
              Estimated on {m.sampleSize} usable {unit}s with {m.parameterCount} parameters · {m.covarianceKind} standard errors.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SectionLabel = ({ children }) => (
  <div style={{
    fontSize: 9.5, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase',
    color: 'var(--text-muted)',
  }}>{children}</div>
);

function Figure({ label, value, sub, primary = false }) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: primary ? 'var(--accent-soft, #eef2ff)' : 'var(--surface-2)',
      border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-subtle)'}`,
    }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 800, marginTop: 3, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

/** Filename for the downloaded PDF. */
export function summaryFilename({ brandName, gran, range }) {
  const slug = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
  const parts = ['Amazon Halo V2', slug(brandName), GRAIN_LABEL[gran] || gran];
  if (range?.start && range?.end) parts.push(`${range.start} to ${range.end}`);
  return parts.filter(Boolean).join(' — ');
}
