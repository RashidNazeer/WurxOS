// ============================================================
// Halo V2 — CSV export (brief §6).
//
// Two blocks in one file: a SUMMARY of what the model concluded, then the
// per-period SERIES behind it.
//
// The summary comes first and repeats the provenance — n, both intervals,
// controls, grain, range, the same-period share and the not-incremental
// statement. A spreadsheet is the most likely place one of these numbers gets
// separated from its caveats and pasted into a deck, so the caveats travel in
// the file rather than only on the page.
// ============================================================

import { fmtValue } from '../haloFields.js';
import { plainMetricLabel } from './plainLanguage.js';

// RFC-4180 quoting: wrap in quotes and double any internal quote. Applied to
// every cell rather than only the ones that look risky — a brand name with a
// comma in it is exactly the case that gets missed.
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
 * cannot disagree about what was in the window.
 */
export function buildHaloV2Csv({
  result, periods, gran, range, xKey, yKey, brandName = null, currency = '$',
}) {
  const m = result?.adjustedModel || {};
  const contrib = result?.historicalContribution || null;
  const lines = [];

  const money = (v) => (v == null ? '' : `${currency}${Number(v).toFixed(4)}`);

  lines.push(row(['Amazon Halo V2 — modelled association, NOT incremental']));
  lines.push(row(['Generated', new Date().toISOString()]));
  if (brandName) lines.push(row(['Brand', brandName]));
  lines.push(row(['TikTok metric', plainMetricLabel(xKey)]));
  lines.push(row(['Amazon metric', plainMetricLabel(yKey)]));
  lines.push(row(['View', gran]));
  lines.push(row(['Date range', range?.start && range?.end ? `${range.start} to ${range.end}` : 'all available']));
  lines.push(row([]));

  lines.push(row(['SUMMARY']));
  if (!m.available) {
    lines.push(row(['Adjusted model', 'not estimated']));
    lines.push(row(['Reason', m.message || m.headline || 'insufficient data']));
  } else {
    lines.push(row(['Usable periods', m.sampleSize]));
    lines.push(row(['Parameters estimated', m.parameterCount]));
    lines.push(row(['Lag window', `${m.maxLag} ${gran}${m.maxLag === 1 ? '' : 's'}`]));
    if (m.laggedOnlyAvailable && m.laggedOnly) {
      lines.push(row(['Delayed (lagged-only) per 1', money(m.laggedOnly.coefficient)]));
      lines.push(row(['Delayed 95% interval', `${money(m.laggedOnly.lower)} to ${money(m.laggedOnly.upper)}`]));
    } else {
      lines.push(row(['Delayed (lagged-only) per 1', 'n/a — no lag window selected']));
    }
    lines.push(row(['Full cumulative per 1', money(m.cumulativeCoefficient)]));
    lines.push(row(['Full cumulative 95% interval', `${money(m.confidenceInterval?.lower)} to ${money(m.confidenceInterval?.upper)}`]));
    lines.push(row([
      'Same-period share of cumulative',
      m.samePeriodShare == null ? 'withheld (opposing lag signs)' : `${Math.round(m.samePeriodShare * 100)}%`,
    ]));
    lines.push(row(['Adjusted R2', m.adjustedR2 == null ? '' : m.adjustedR2.toFixed(4)]));
    lines.push(row(['Standard errors', m.covarianceKind]));
    lines.push(row(['Controls included', (m.controls || []).join('; ') || 'none']));
    lines.push(row(['Controls missing', (m.controlsUnavailable || []).join('; ') || 'none']));
    lines.push(row(['Confidence', m.confidenceCeiling ? `${m.confidenceLabel} (capped from ${m.confidenceEarned})` : m.confidenceLabel]));
    if (contrib) {
      lines.push(row(['Contribution vs reference', fmtValue(contrib.amount, 'money')]));
      lines.push(row(['Reference level', `${contrib.referenceLabel} (${fmtValue(contrib.referenceValue, 'num')})`]));
      lines.push(row(['Contribution 95% interval', contrib.lower == null ? '' : `${fmtValue(contrib.lower, 'money')} to ${fmtValue(contrib.upper, 'money')}`]));
    }
  }
  lines.push(row([]));
  lines.push(row(['Incremental lift requires geo or holdout validation, which this tool does not perform.']));
  lines.push(row(['Correlation is not causation. Planning figures are assumptions, not forecasts.']));
  lines.push(row([]));

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
