// ============================================================
// Halo V2 - provenance (Lab).
//
// Everything that must travel WITH a modelled figure: n, both intervals,
// controls in and out, grain, range, the same-period share and the badge.
//
// It is on the page rather than only in a file, because the realistic way one
// of these numbers leaves the tool is a screenshot, and a caveat that only
// exists in a download does not survive that.
//
// The three export buttons that used to live here moved into the single Share
// menu in the scope bar (round 2): four peer CTAs in the first viewport was
// the loudest piece of chrome on the page.
// ============================================================

import { useState } from 'react';
import { fmtValue } from '../../lib/haloFields';
import { plainMetricLabel } from '../../lib/haloV2/plainLanguage.js';
import { GRAIN_LABEL } from '../../lib/haloV2/grainRecommendation.js';
import { NOT_CLAIM_LINE } from '../../lib/haloV2/snapshot.js';
import { ModelledBadge } from './shared.jsx';

export function ProvenanceBlock({ result, gran, range, unit, xKey, yKey, cur }) {
  const m = result.adjustedModel;
  const [copied, setCopied] = useState(false);

  const rangeText = range?.start && range?.end ? `${range.start} to ${range.end}` : null;
  const lines = m.available ? [
    'Halo V2: modelled association, NOT incremental.',
    `Metrics: ${plainMetricLabel(xKey)} against ${plainMetricLabel(yKey)}`,
    `Grain: ${GRAIN_LABEL[gran]}${rangeText ? ` · ${rangeText}` : ''}`,
    `Observations: ${m.sampleSize} usable ${unit}s (${m.parameterCount} parameters)`,
    m.laggedOnlyAvailable && m.laggedOnly
      ? `Delayed only: ${cur}${m.laggedOnly.coefficient.toFixed(2)} per ${cur}1`
        + (m.laggedOnly.lower != null ? ` · 95% ${cur}${m.laggedOnly.lower.toFixed(2)} to ${cur}${m.laggedOnly.upper.toFixed(2)}` : '')
      : 'No lag window selected, so same-period association only.',
    `Same period plus delayed: ${cur}${m.cumulativeCoefficient.toFixed(2)} per ${cur}1`
      + (m.confidenceInterval.lower != null ? ` · 95% ${cur}${m.confidenceInterval.lower.toFixed(2)} to ${cur}${m.confidenceInterval.upper.toFixed(2)}` : ''),
    m.samePeriodShare != null
      ? `Same-${unit} share of the combined figure: ${Math.round(m.samePeriodShare * 100)}%`
      : `Same-${unit} share: withheld, because the lag coefficients oppose each other`,
    `Standard errors: ${m.covarianceKind}`,
    `Controls included: ${m.controls.length ? m.controls.join(', ') : 'none'}`,
    `Controls missing: ${m.controlsUnavailable.length ? m.controlsUnavailable.join('; ') : 'none'}`,
    `Confidence: ${m.confidenceLabel}${m.confidenceCeiling ? ` (capped from ${m.confidenceEarned})` : ''}`,
    result.historicalContribution
      ? `Contribution against the ${result.historicalContribution.referenceLabel.toLowerCase()}: ${fmtValue(result.historicalContribution.amount, 'money')}`
      : null,
    NOT_CLAIM_LINE,
    'Incremental lift would require geo or holdout validation (Stage 6), which this tool does not perform.',
  ].filter(Boolean) : [
    'Halo V2: no modelled estimate for this window.',
    `Metrics: ${plainMetricLabel(xKey)} against ${plainMetricLabel(yKey)}`,
    `Grain: ${GRAIN_LABEL[gran]}${rangeText ? ` · ${rangeText}` : ''}`,
    `Reason: ${m.headline || ''} ${m.message || ''}`.trim(),
    NOT_CLAIM_LINE,
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked, and the block is on screen to read anyway */ }
  };

  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 800 }}>Methodology and provenance</span>
          <ModelledBadge />
        </div>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={copy}>
          <i className={`bi ${copied ? 'bi-check2' : 'bi-clipboard'}`} style={{ marginRight: 6 }} />
          {copied ? 'Copied' : 'Copy methodology'}
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8, maxWidth: 720 }}>
        Everything a figure from this page needs carried with it. If a number here reaches a deck, this
        block should go under it.
      </div>
      <pre style={{
        margin: 0, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
        color: 'var(--text-secondary)', fontFamily: 'inherit',
      }}>{lines.join('\n')}</pre>
    </div>
  );
}
