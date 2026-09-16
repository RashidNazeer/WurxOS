// ============================================================
// Halo V2 - methodology and provenance, in a modal.
//
// This content used to be a disclosure card sitting in the page flow. Even
// collapsed it was another band of chrome on the way down the page, and opened
// it was a wall. It is now behind a Methodology button: off the face entirely,
// structured into sections rather than one dump, and closed unless asked for.
//
// It absorbs what were two separate blocks (the stage ladder drawer and the
// Lab provenance card), because they answered the same question from two
// places: how was this produced, and what does it not cover.
//
// The copy-to-clipboard block stays, in one line per fact: the realistic way a
// figure leaves this tool is a screenshot pasted into a deck, and this is what
// belongs underneath it.
// ============================================================

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtValue } from '../../lib/haloFields';
import { plainMetricLabel } from '../../lib/haloV2/plainLanguage.js';
import { GRAIN_LABEL } from '../../lib/haloV2/grainRecommendation.js';
import { NOT_CLAIM_LINE } from '../../lib/haloV2/snapshot.js';
import { XIcon } from '../common/Icon';
import StageStepper from './StageStepper.jsx';
import '../../styles/table.css';

// The method this tool implements, named so a client can ask about it and an
// operator can tell two vintages of a figure apart.
export const METHOD_VERSION = 'Halo V2 distributed-lag model';

const STAGE_TO_STEP = {
  descriptive: 'Step 1, See',
  correlations: 'Step 1, See',
  regression: 'Step 2, Adjust',
  distributedLag: 'Steps 2 and 3',
  counterfactual: 'Step 3, Estimate',
  validation: 'Not in this tool',
};

export default function MethodologyModal({
  result, statuses, gran, range, unit, xKey, yKey, cur, filledFromDaily = [], onClose,
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const m = result?.adjustedModel || {};
  const contrib = result?.historicalContribution || null;
  const rangeText = range?.start && range?.end ? `${range.start} to ${range.end}` : 'all available';
  const money = (v) => (v == null ? 'not available' : `${cur}${Number(v).toFixed(2)}`);
  const interval = (lo, hi) => (lo == null || hi == null ? 'not available' : `${money(lo)} to ${money(hi)}`);

  const lines = [
    `Method: ${METHOD_VERSION}.`,
    `Metrics: ${plainMetricLabel(xKey)} against ${plainMetricLabel(yKey)}.`,
    `Grain: ${GRAIN_LABEL[gran] || gran}, ${rangeText}.`,
    m.available
      ? `Observations: ${m.sampleSize} usable ${unit}s, ${m.parameterCount} parameters, ${m.covarianceKind} standard errors.`
      : `No adjusted model: ${[m.headline, m.message].filter(Boolean).join(' ')}`,
    ...(m.available ? [
      m.laggedOnlyAvailable && m.laggedOnly
        ? `Delayed only: ${money(m.laggedOnly.coefficient)} per ${cur}1, 95% ${interval(m.laggedOnly.lower, m.laggedOnly.upper)}.`
        : 'No lag window selected, so same-period association only.',
      `Same period plus delayed: ${money(m.cumulativeCoefficient)} per ${cur}1, 95% ${interval(m.confidenceInterval?.lower, m.confidenceInterval?.upper)}.`,
      m.samePeriodShare != null
        ? `Same-${unit} share of the combined figure: ${Math.round(m.samePeriodShare * 100)}%.`
        : `Same-${unit} share: withheld, because the lag coefficients oppose each other.`,
      `Controls included: ${m.controls?.length ? m.controls.join(', ') : 'none'}.`,
      `Controls missing: ${m.controlsUnavailable?.length ? m.controlsUnavailable.join('; ') : 'none'}.`,
      `Confidence: ${m.confidenceLabel}${m.confidenceCeiling ? ` (capped from ${m.confidenceEarned})` : ''}.`,
    ] : []),
    ...(contrib ? [`Contribution against the ${contrib.referenceLabel.toLowerCase()}: ${fmtValue(contrib.amount, 'money')}.`] : []),
    NOT_CLAIM_LINE,
    'Incremental lift would require geo or holdout validation (Stage 6), which this tool does not perform.',
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked, and the block is on screen to read anyway */ }
  };

  return createPortal(
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Methodology and provenance</div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="wx-modal-body">
          {/* 1. At a glance. The facts a figure needs carried with it. */}
          <Section title="At a glance">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                <Row k="Method" v={METHOD_VERSION} />
                <Row k="Metrics" v={`${plainMetricLabel(xKey)} against ${plainMetricLabel(yKey)}`} />
                <Row k="Grain" v={`${GRAIN_LABEL[gran] || gran}, ${rangeText}`} />
                {m.available ? (
                  <>
                    <Row k="Observations" v={`${m.sampleSize} usable ${unit}s (${m.parameterCount} parameters)`} />
                    <Row k="Standard errors" v={m.covarianceKind} />
                    <Row k="Confidence" v={m.confidenceCeiling ? `${m.confidenceLabel}, capped from ${m.confidenceEarned}` : m.confidenceLabel} />
                  </>
                ) : (
                  <Row k="Adjusted model" v="Not estimated for this window" />
                )}
              </tbody>
            </table>
          </Section>

          {/* 2. The numbers themselves, with their ranges. */}
          {m.available && (
            <Section title="Coefficients and ranges">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <tbody>
                  {m.laggedOnlyAvailable && m.laggedOnly ? (
                    <>
                      <Row k={`Delayed only, per ${cur}1`} v={money(m.laggedOnly.coefficient)} />
                      <Row k="Delayed only, 95%" v={interval(m.laggedOnly.lower, m.laggedOnly.upper)} />
                    </>
                  ) : (
                    <Row k="Delayed only" v="Not applicable, no lag window selected" />
                  )}
                  <Row k={`Same period plus delayed, per ${cur}1`} v={money(m.cumulativeCoefficient)} />
                  <Row k="Same period plus delayed, 95%" v={interval(m.confidenceInterval?.lower, m.confidenceInterval?.upper)} />
                  <Row
                    k={`Same-${unit} share`}
                    v={m.samePeriodShare == null ? 'Withheld, the lag coefficients oppose each other' : `${Math.round(m.samePeriodShare * 100)}%`}
                  />
                  {contrib && (
                    <Row
                      k="Contribution in this window"
                      v={`${fmtValue(contrib.amount, 'money')}, against the ${contrib.referenceLabel.toLowerCase()}`}
                    />
                  )}
                </tbody>
              </table>
            </Section>
          )}

          {/* 3. What the model does, in words. */}
          <Section title="Method">
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <li>
                Amazon outcome is regressed on TikTok activity at several {unit} lags at once (a distributed
                lag model), so an effect that arrives late is still counted.
              </li>
              <li>
                The delayed figure excludes same-{unit} co-movement. That exclusion is the halo claim:
                movement inside one {unit} is just as easily a confounder, such as a promotion both
                channels ran.
              </li>
              {contrib && (
                <li>
                  The counterfactual holds TikTok at the {contrib.referenceLabel.toLowerCase()} and predicts
                  Amazon from the fitted relationship. The reference is never zero, which would sit far
                  outside anything the model has seen.
                </li>
              )}
              {filledFromDaily.length > 0 && (
                <li>
                  {filledFromDaily.map(plainMetricLabel).join(' and ')} per {unit}{' '}
                  {filledFromDaily.length > 1 ? 'are' : 'is'} totalled from the daily sheet for every{' '}
                  {unit} it covers.
                </li>
              )}
            </ul>
          </Section>

          {/* 4. Controls, stated as what the regression actually did. */}
          {m.available && (
            <Section title="Controls">
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Included: </span>
                  {m.controls?.length ? m.controls.join(', ') : 'nothing'}
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Missing: </span>
                  {m.controlsUnavailable?.length ? m.controlsUnavailable.join('; ') : 'nothing outstanding'}
                </div>
              </div>
            </Section>
          )}

          {/* 5. Where the work has reached. */}
          {statuses?.length > 0 && (
            <Section title="Stages">
              <StageStepper statuses={statuses} />
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginTop: 10 }}>
                <tbody>
                  {statuses.map((s) => (
                    <tr key={s.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <td style={{ padding: '5px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Stage {s.n}</td>
                      <td style={{ padding: '5px 8px', fontWeight: 600 }}>{s.title}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--text-secondary)' }}>{STAGE_TO_STEP[s.key]}</td>
                      <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{s.statusLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* 6. Limitations, last and plainly. */}
          <Section title="Limitations">
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <div>{NOT_CLAIM_LINE}</div>
              <div style={{ marginTop: 6 }}>
                <strong style={{ color: 'var(--text-primary)' }}>Stage 6, validation (geo or holdout): not done.</strong>
                {' '}Showing that sales would not have happened otherwise needs a controlled test with a held
                out region or audience. This tool does not run one, which is why every figure here is
                labelled modelled association rather than incremental.
              </div>
              {m.controlsMissingMajor?.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {m.controlsMissingMajor.map((c) => c.label).join(' and ')}{' '}
                  {m.controlsMissingMajor.length === 1 ? 'is' : 'are'} not in the model, so read the size of
                  the effect as a ceiling. Steps 2 to 4 unlock when platform APIs feed those controls.
                </div>
              )}
              {contrib?.spansZero && (
                <div style={{ marginTop: 6 }}>
                  The interval on the contribution includes zero, so over this window the total cannot be
                  told apart from no contribution at all.
                </div>
              )}
            </div>
          </Section>

          {/* 7. The paste-under-a-screenshot block. */}
          <Section title="Copy for a deck">
            <pre style={{
              margin: 0, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              color: 'var(--text-secondary)', fontFamily: 'inherit',
            }}>{lines.join('\n')}</pre>
          </Section>
        </div>

        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={copy}>
            <i className={`bi ${copied ? 'bi-check2' : 'bi-clipboard'}`} style={{ marginRight: 6 }} />
            {copied ? 'Copied' : 'Copy methodology'}
          </button>
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const Section = ({ title, children }) => (
  <div style={{ padding: '12px 0', borderTop: '1px solid var(--border-subtle)' }}>
    <div style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase',
      color: 'var(--text-muted)', marginBottom: 7,
    }}>{title}</div>
    {children}
  </div>
);

const Row = ({ k, v }) => (
  <tr style={{ borderTop: '1px solid var(--border-subtle)' }}>
    <td style={{ padding: '5px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{k}</td>
    <td style={{ padding: '5px 8px', textAlign: 'right' }}>{v}</td>
  </tr>
);
