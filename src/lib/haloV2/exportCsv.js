// ============================================================
// Halo V2 - CSV for finance.
//
// Four blocks in one file: what the snapshot said, what the model concluded,
// the planning scenarios, and the per-period series behind all of it.
//
// The summary comes first and repeats the provenance: n, both intervals,
// controls, grain, range, the same-period share and the not-incremental line. A
// spreadsheet is the most likely place one of these numbers gets separated from
// its caveats and pasted into a deck, so the caveats travel in the file.
//
// Every scenario row carries its own evidence tag, MODELLED or ASSUMED. That
// column is the reason this export can include planning figures from a model
// that was not eligible to produce them: the tag says so on the row itself, and
// it cannot be cropped off the way a header note can.
// ============================================================

import { fmtValue } from '../haloFields.js';
import { plainMetricLabel } from './plainLanguage.js';
import { NOT_CLAIM_LINE } from './snapshot.js';

// RFC-4180 quoting: wrap in quotes and double any internal quote. Applied to
// every cell rather than only the ones that look risky, because a brand name
// with a comma in it is exactly the case that gets missed.
const cell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells) => cells.map(cell).join(',');

/**
 * Build the CSV text for the current analysis.
 *
 * `periods` are the aligned rows the charts drew, so the export and the screen
 * cannot disagree about what was in the window. `planning` is the live planning
 * state, so the scenario block matches the table on screen.
 */
export function buildHaloV2Csv({
  result, periods, gran, range, xKey, yKey, brandName = null, currency = '$',
  snapshot = null, planning = null,
}) {
  const m = result?.adjustedModel || {};
  const contrib = result?.historicalContribution || null;
  const plan = result?.planning || null;
  const el = result?.planningEligibility || {};
  const generatedAt = new Date().toISOString();
  const lines = [];

  const money = (v) => (v == null ? '' : `${currency}${Number(v).toFixed(4)}`);
  const pct = (v) => (v == null ? '' : `${(Number(v) * 100).toFixed(1)}%`);
  const metricPair = `${plainMetricLabel(xKey)} against ${plainMetricLabel(yKey)}`;

  lines.push(row(['Amazon Halo V2: modelled association, NOT incremental']));
  lines.push(row(['Generated', generatedAt]));
  if (brandName) lines.push(row(['Brand', brandName]));
  lines.push(row(['TikTok metric', plainMetricLabel(xKey)]));
  lines.push(row(['Amazon metric', plainMetricLabel(yKey)]));
  lines.push(row(['View', gran]));
  lines.push(row(['Date range', range?.start && range?.end ? `${range.start} to ${range.end}` : 'all available']));
  lines.push(row([]));

  // ── Snapshot: the five things the meeting actually discussed ──
  if (snapshot) {
    lines.push(row(['SNAPSHOT']));
    lines.push(row([snapshot.effect.label, snapshot.effect.value]));
    lines.push(row([snapshot.range.label, snapshot.range.value]));
    lines.push(row(['Signal strength', snapshot.signal.level, snapshot.signal.why]));
    lines.push(row(['Next action', snapshot.action.verdict, snapshot.action.detail]));
    lines.push(row(['What this is not', snapshot.notClaim]));
    lines.push(row([]));
  }

  lines.push(row(['SUMMARY']));
  if (!m.available) {
    lines.push(row(['Adjusted model', 'not estimated']));
    lines.push(row(['Reason', m.message || m.headline || 'insufficient data']));
  } else {
    lines.push(row(['Usable periods', m.sampleSize]));
    lines.push(row(['Parameters estimated', m.parameterCount]));
    lines.push(row(['Lag window', `${m.maxLag} ${gran}${m.maxLag === 1 ? '' : 's'}`]));
    if (m.laggedOnlyAvailable && m.laggedOnly) {
      lines.push(row(['Delayed only, per 1', money(m.laggedOnly.coefficient)]));
      lines.push(row(['Delayed only 95% interval', `${money(m.laggedOnly.lower)} to ${money(m.laggedOnly.upper)}`]));
    } else {
      lines.push(row(['Delayed only, per 1', 'not applicable, no lag window selected']));
    }
    lines.push(row(['Same period plus delayed, per 1', money(m.cumulativeCoefficient)]));
    lines.push(row(['Same period plus delayed 95% interval', `${money(m.confidenceInterval?.lower)} to ${money(m.confidenceInterval?.upper)}`]));
    lines.push(row([
      'Same-period share of the combined figure',
      m.samePeriodShare == null ? 'withheld (opposing lag signs)' : `${Math.round(m.samePeriodShare * 100)}%`,
    ]));
    lines.push(row(['Adjusted R2', m.adjustedR2 == null ? '' : m.adjustedR2.toFixed(4)]));
    lines.push(row(['Standard errors', m.covarianceKind]));
    lines.push(row(['Controls included', (m.controls || []).join('; ') || 'none']));
    lines.push(row(['Controls missing', (m.controlsUnavailable || []).join('; ') || 'none']));
    lines.push(row(['Confidence', m.confidenceCeiling ? `${m.confidenceLabel} (capped from ${m.confidenceEarned})` : m.confidenceLabel]));
    if (contrib) {
      lines.push(row(['Contribution against the reference', fmtValue(contrib.amount, 'money')]));
      lines.push(row(['Reference level', `${contrib.referenceLabel} (${fmtValue(contrib.referenceValue, 'num')})`]));
      lines.push(row(['Contribution 95% interval', contrib.lower == null ? '' : `${fmtValue(contrib.lower, 'money')} to ${fmtValue(contrib.upper, 'money')}`]));
    }
  }
  lines.push(row([]));
  lines.push(row([NOT_CLAIM_LINE]));
  lines.push(row(['Incremental lift would require geo or holdout validation, which this tool does not perform.']));
  lines.push(row(['Correlation is not causation. Planning figures are assumptions, not forecasts.']));
  lines.push(row([]));

  // ── Scenarios ──
  // Written whenever revenue has been entered, in either mode. The evidence
  // column is what makes an assumptions-mode row safe to hand to finance.
  const scenarioRows = plan?.base ? [
    ['Conservative', plan.conservative],
    ['Base', plan.base],
    ['Upside', plan.upside],
  ] : [];
  const enteredRevenue = String(planning?.ttsRevenue ?? '').trim() !== '';
  if (scenarioRows.length && enteredRevenue) {
    const evidence = plan.mode === 'model' ? 'MODELLED' : 'ASSUMED';
    const sym = planning?.currency || currency;
    lines.push(row(['SCENARIOS']));
    lines.push(row(['Basis', plan.mode === 'model' ? `from the adjusted model, ${el.basisLabel || ''} basis` : 'planning assumptions, not from the model']));
    lines.push(row(['Planning period', planning?.periodLabel || 'not stated']));
    lines.push(row([
      'scenario', 'halo_percent', `per_${sym}1`, 'tiktok_shop_revenue', 'marketing_spend',
      'off_platform_revenue', 'total_influenced_revenue', 'multiple', 'evidence',
      'usable_periods', 'ci_low', 'ci_high', 'grain', 'metric_pair', 'generated_at',
    ]));
    for (const [name, s] of scenarioRows) {
      lines.push(row([
        name,
        `${s.haloPercent}%`,
        `${sym}${s.haloPerCurrencyUnit.toFixed(2)}`,
        s.directRevenue.toFixed(2),
        s.marketingSpend.toFixed(2),
        s.offPlatformRevenue.toFixed(2),
        s.totalInfluencedRevenue.toFixed(2),
        s.blendedMultiple == null ? '' : `${s.blendedMultiple.toFixed(2)}x`,
        evidence,
        m.available ? m.sampleSize : '',
        evidence === 'MODELLED' ? pct(el.lower) : '',
        evidence === 'MODELLED' ? pct(el.upper) : '',
        gran,
        metricPair,
        generatedAt,
      ]));
    }
    lines.push(row([]));
    lines.push(row([plan.disclaimer || 'Planning assumptions, not measured results.']));
    lines.push(row([]));
  }

  // ── Series ──
  // Both raw metrics, plus the two predicted series where the model produced
  // them, keyed on the same period label the chart used.
  const predByKey = new Map((contrib?.perPeriod || []).map((p) => [String(p.key), p]));
  lines.push(row(['SERIES']));
  lines.push(row([
    'period',
    plainMetricLabel(xKey),
    plainMetricLabel(yKey),
    'predicted_actual',
    'predicted_at_reference',
    'modelled_contribution',
  ]));
  for (const p of periods || []) {
    const pred = predByKey.get(String(p.key));
    lines.push(row([
      p.label || p.key,
      p.x ?? '',
      p.y ?? '',
      pred ? pred.predictedActual.toFixed(4) : '',
      pred ? pred.predictedBaseline.toFixed(4) : '',
      pred ? pred.contribution.toFixed(4) : '',
    ]));
  }

  return lines.join('\r\n');
}

/** Trigger a browser download. Safe to call from the anonymous portal. */
export function downloadHaloV2Csv(text, filename) {
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function haloV2CsvFilename({ brandName, gran, range }) {
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const parts = ['halo-v2', slug(brandName) || null, gran, range?.start || null, range?.end || null].filter(Boolean);
  return `${parts.join('_')}.csv`;
}
