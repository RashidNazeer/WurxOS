// ============================================================
// Halo V2 - Adjust: what did we adjust for?
//
// The client question this answers is "what about Prime Day, what about the
// stock-out in May". Two things therefore lead:
//
//   1. The controls readiness checklist. A missing major confounder is shown as
//      a blocker on the estimate, not as a line of prose at the bottom. It is
//      read straight off the fitted model, so the page can never claim an
//      adjustment the regression did not make.
//   2. The split between same-period co-movement and the delayed part. The
//      delayed part is the halo claim. The cumulative figure is bigger and more
//      flattering and includes movement inside one period, which a shared cause
//      explains just as well.
//
// Diagnostics (coefficients, HAC errors, VIF, the influence refit) are Lab
// only. They are the reason an analyst trusts the number and the reason a
// client cannot read the page.
// ============================================================

import { useMemo } from 'react';
import { refitWithout } from '../../lib/haloV2/distributedLag.js';
import { controlsChecklist } from '../../lib/haloV2/controls.js';
import { plainMetricLabel } from '../../lib/haloV2/plainLanguage.js';
import { Note, Stat, Row, ProgressMeter, Chip } from './shared.jsx';
import { Term } from './Glossary.jsx';

export default function AdjustLayer({
  result, unit, cur, xKey, yKey, periods, maxLag, controlOpts,
  excludeIndex, setExcludeIndex, showAdvanced, setShowAdvanced, assessment, lab = false,
}) {
  const m = result.adjustedModel;

  const refit = useMemo(() => {
    if (excludeIndex == null) return null;
    return refitWithout(periods, excludeIndex, { maxLag, controls: controlOpts, xKey, yKey });
  }, [excludeIndex, periods, maxLag, controlOpts, xKey, yKey]);

  if (!m.available) {
    return (
      <>
        <Note tone="warn"><strong>{m.headline}</strong> {m.message}</Note>
        {assessment && m.requiredObservations && (
          <ProgressMeter
            usable={m.sampleSize}
            required={m.requiredObservations}
            unit={unit}
            almostThere={assessment.almostThere}
          />
        )}
      </>
    );
  }

  const checklist = controlsChecklist(m);
  const lagged = m.laggedOnly;
  const hasLagged = m.laggedOnlyAvailable && lagged;
  const fullLabel = `${cur}${m.cumulativeCoefficient.toFixed(2)}`;
  const sharePct = m.samePeriodShare == null ? null : Math.round(m.samePeriodShare * 100);

  return (
    <>
      {/* ── 1. The checklist ─────────────────────────────────── */}
      <div style={{
        display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))',
      }}>
        {checklist.primary.map((c) => <ControlRow key={c.label} control={c} />)}
      </div>

      {checklist.missingMajor.length > 0 && (
        <Note tone="warn">
          <strong>{checklist.missingMajor.map((c) => c.label).join(' and ')}</strong>
          {' '}{checklist.missingMajor.length === 1 ? 'is' : 'are'} not in the model. These are the usual
          reasons a halo estimate comes out too high: a promotion lifts both channels at once, and a
          stock-out drops Amazon while TikTok keeps running. Add the columns to the sheet and the model
          picks them up automatically. Until then, confidence is capped and the size of the effect should
          be read as a ceiling.
        </Note>
      )}

      {m.confidenceCappedBy?.length > 0 && (
        <Note tone="warn">
          {m.confidenceCappedBy.map((r, i) => <div key={i}>{r}</div>)}
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
            On the score alone it would have read &ldquo;{m.confidenceEarned}&rdquo;.
          </div>
        </Note>
      )}

      {lab && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10 }}>
          Also in the register, and not in this model:{' '}
          {checklist.others.filter((c) => !c.included).map((c) => c.label).join(', ') || 'nothing'}.
        </div>
      )}

      {/* ── 2. Same period vs delayed ────────────────────────── */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
        <h3 style={{ fontSize: '.95rem', fontWeight: 800, margin: '0 0 2px' }}>
          How much of this is a delay, and how much is the same {unit}?
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px', maxWidth: 760 }}>
          Only the delayed part supports a halo reading. Movement inside a single {unit} is what a shared
          cause produces, so it is reported separately rather than folded into the headline.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {hasLagged ? (
            <Stat
              label="Delayed only (the halo claim)"
              value={`${cur}${lagged.coefficient.toFixed(2)} per ${cur}1`}
              sub={lagged.lower == null
                ? 'No interval available'
                : `95%: ${cur}${lagged.lower.toFixed(2)} to ${cur}${lagged.upper.toFixed(2)}${lagged.spansZero ? ', which includes zero' : ''}`}
              tone={lagged.spansZero ? 'warn' : lagged.coefficient >= 0 ? 'pos' : 'neg'}
              emphasis
            />
          ) : (
            <Stat
              label="Same period only"
              value={`${fullLabel} per ${cur}1`}
              sub="No lag window is selected, so no delayed effect has been looked for."
              tone="warn"
              emphasis
            />
          )}
          <Stat
            label="Same period plus delayed"
            value={`${fullLabel} per ${cur}1`}
            sub={`Includes same-${unit} co-movement${sharePct != null ? `, which is ${sharePct}% of this figure` : ''}`}
            tone="muted"
          />
          <Stat
            label="Model confidence"
            value={m.confidenceLabel}
            sub={`${m.sampleSize} usable ${unit}s · adj R² ${m.adjustedR2 == null ? 'not available' : m.adjustedR2.toFixed(2)}`}
            tone={m.confidenceCeiling ? 'warn' : undefined}
          />
        </div>

        {sharePct != null && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-secondary)' }}>Share of the combined figure that is same-{unit} movement</span>
              <strong style={{ color: sharePct >= 60 ? 'var(--warning)' : 'var(--text-primary)' }}>{sharePct}%</strong>
            </div>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden', display: 'flex' }}>
              <div style={{ width: `${Math.min(100, Math.max(0, sharePct))}%`, background: 'var(--warning)' }} />
              <div style={{ flex: 1, background: 'var(--accent)' }} />
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
              Amber is same-{unit} co-movement. The rest is the delayed part, which is the halo claim.
            </div>
          </div>
        )}

        {m.mixedLagSigns && (
          <Note tone="warn">
            The lag coefficients point in opposite directions, so the split between same-{unit} and delayed
            movement cannot be shown as a share: the parts would exceed the whole. Read the two figures
            above separately.
          </Note>
        )}

        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12, maxWidth: 820 }}>
          {hasLagged ? (
            <>
              Across the {maxLag} {unit}{maxLag === 1 ? '' : 's'} following a change, an additional {cur}1 of{' '}
              {plainMetricLabel(xKey)} is <strong>associated with</strong> about{' '}
              <strong>{cur}{lagged.coefficient.toFixed(2)}</strong> of {plainMetricLabel(yKey)}, after the
              controls above. Adding same-{unit} movement takes the total to {fullLabel}.
            </>
          ) : (
            <>
              An additional {cur}1 of {plainMetricLabel(xKey)} moves with about <strong>{fullLabel}</strong> of{' '}
              {plainMetricLabel(yKey)} in the same {unit}. Nothing here separates a spillover from a shared
              cause. Select a lag window in Lab view to look for a delayed effect.
            </>
          )}
        </p>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <span>What these mean:</span>
          <Term term="Modelled" />
          <Term term="95% interval" />
          <Term term="Confidence" />
          <Term term="Lag" />
          <Term term="Incremental" />
        </div>
      </div>

      {(m.warnings || []).map((w) => (
        <Note key={w.code} tone="warn">
          {w.message}
          {lab && w.code === 'influential_observation' && (
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 8 }}
              onClick={() => setExcludeIndex(excludeIndex == null ? w.index : null)}>
              {excludeIndex == null ? 'Run without it' : 'Restore'}
            </button>
          )}
        </Note>
      ))}
      {refit && (
        <Note tone="info">
          Without that period the combined relationship is{' '}
          <strong>{refit.available ? `${cur}${refit.cumulativeCoefficient.toFixed(2)}` : 'not estimable'}</strong>
          {refit.available && <> (it was {fullLabel})</>}
          {refit.available && refit.laggedOnly && <>, and the delayed part is <strong>{cur}{refit.laggedOnly.coefficient.toFixed(2)}</strong></>}.
        </Note>
      )}

      {/* ── 3. Diagnostics, Lab only ─────────────────────────── */}
      {lab && (
        <>
          <button
            type="button"
            className="wx-btn wx-btn-ghost wx-btn-sm"
            style={{ marginTop: 14 }}
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((s) => !s)}
          >
            <i className={`bi bi-chevron-${showAdvanced ? 'up' : 'down'}`} /> Model details
          </button>
          {showAdvanced && <ModelDetails m={m} unit={unit} lagged={lagged} hasLagged={hasLagged} sharePct={sharePct} />}
        </>
      )}
    </>
  );
}

function ControlRow({ control }) {
  const { label, included, major, note } = control;
  const tone = included ? 'var(--success)' : major ? 'var(--warning)' : 'var(--text-muted)';
  return (
    <div style={{
      display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px',
      borderRadius: 'var(--radius-md)', background: 'var(--surface-2)',
      border: `1px solid ${included ? 'var(--border-subtle)' : major ? 'var(--warning)' : 'var(--border-subtle)'}`,
    }}>
      <i
        className={`bi ${included ? 'bi-check-circle-fill' : major ? 'bi-exclamation-triangle-fill' : 'bi-circle'}`}
        style={{ color: tone, fontSize: 13, marginTop: 1 }}
      />
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 700 }}>
          {label}
          {major && !included && <span style={{ marginLeft: 6 }}><Chip tone="assumed">Blocker</Chip></span>}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, lineHeight: 1.4 }}>{note}</div>
      </div>
    </div>
  );
}

function ModelDetails({ m, unit, lagged, hasLagged, sharePct }) {
  return (
    <div className="wx-card" style={{ padding: 12, marginTop: 8, fontSize: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <Row k="Observations (after lagging)" v={`${m.sampleSize}${m.droppedToLags ? ` (${m.droppedToLags} dropped to lags)` : ''}`} />
          <Row k="Parameters estimated" v={m.parameterCount ?? 'not available'} />
          <Row k="Adjusted R²" v={m.adjustedR2 == null ? 'not available' : m.adjustedR2.toFixed(3)} />
          <Row k="Selected max lag" v={`${m.maxLag} ${unit}${m.maxLag === 1 ? '' : 's'}`} />
          <Row k="Standard errors" v={m.covarianceKind} />
          <Row k="Combined coefficient" v={m.cumulativeCoefficient.toFixed(4)} />
          <Row k="Combined 95% interval" v={m.confidenceInterval.lower == null ? 'not available' : `${m.confidenceInterval.lower.toFixed(4)} to ${m.confidenceInterval.upper.toFixed(4)}`} />
          <Row k="Delayed-only coefficient" v={hasLagged ? lagged.coefficient.toFixed(4) : 'not applicable (no lag window)'} />
          <Row k="Delayed-only 95% interval" v={hasLagged && lagged.lower != null ? `${lagged.lower.toFixed(4)} to ${lagged.upper.toFixed(4)}` : 'not available'} />
          <Row k="Same-period coefficient" v={m.samePeriodCoefficient == null ? 'not available' : m.samePeriodCoefficient.toFixed(4)} />
          <Row k="Same-period share" v={sharePct == null ? 'withheld (opposing signs)' : `${sharePct}%`} />
          <Row k="Max VIF (lag terms)" v={m.maxVif == null ? 'not available' : m.maxVif.toFixed(1)} />
        </tbody>
      </table>

      <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>Coefficients by lag</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {(m.lagCoefficients || []).map((c) => (
            <Row
              key={c.lag}
              k={c.label}
              v={`${c.coefficient >= 0 ? '+' : ''}${c.coefficient.toFixed(4)}${c.standardError != null ? `  (± ${(1.96 * c.standardError).toFixed(4)})` : ''}`}
            />
          ))}
          <Row k="Combined (all lags)" v={`${m.cumulativeCoefficient >= 0 ? '+' : ''}${m.cumulativeCoefficient.toFixed(4)}`} />
        </tbody>
      </table>

      <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>Why this confidence rating</div>
      <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
        {(m.confidenceReasons || []).map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </div>
  );
}
