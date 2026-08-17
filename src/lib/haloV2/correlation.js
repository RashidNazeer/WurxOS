// ============================================================
// Halo V2 — SIGNED correlation.
//
// The single most important behavioural change in the brief (§2): V1 floored
// negative correlations to zero, so the tool could only ever report a positive
// or absent halo. V2 keeps the sign. A negative relationship is a finding, not
// a rendering problem.
//
// Inverse metrics (§3) are handled by reporting BOTH numbers rather than
// silently flipping one: rawCorrelation keeps the statistical truth, and
// businessAdjustedCorrelation expresses it in "is this good for the brand?"
// terms. Amazon Keyword Search Rank falling as TikTok rises is a raw -0.6 and a
// business +0.6, and a credible tool shows both.
// ============================================================

import { isInverseMetric } from './metricMetadata.js';

export const MIN_CORRELATION_OBS = 6;   // brief §13 — below this we don't compute

// Raw Pearson r in [-1, +1]. null when it is undefined rather than zero:
// too few points, or a series with no variation (brief test 11).
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;   // constant series
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? r : null;
}

// How much weight the UI should give a correlation, by overlap count.
// These are product confidence rules, NOT claims of statistical sufficiency —
// the brief is explicit about that distinction (§13).
export function sufficiencyOf(n) {
  if (n == null || n < MIN_CORRELATION_OBS) {
    return { level: 'insufficient', label: 'Not enough overlapping periods', computable: false };
  }
  if (n <= 11) return { level: 'very_limited', label: 'Very limited data', computable: true };
  if (n <= 25) return { level: 'directional', label: 'Directional evidence', computable: true };
  return { level: 'stable', label: 'More stable directional evidence', computable: true };
}

/**
 * Signed correlation between two aligned series, with the inverse-metric
 * reading alongside it.
 *   { rawCorrelation, businessAdjustedCorrelation, inverted, n, sufficiency, reason }
 * `reason` is populated only when a correlation could not be produced, so the
 * UI can say WHY instead of printing a bare dash.
 */
export function signedCorrelation(xs, ys, xKey, yKey) {
  const n = Math.min(xs.length, ys.length);
  const sufficiency = sufficiencyOf(n);
  if (!sufficiency.computable) {
    return { rawCorrelation: null, businessAdjustedCorrelation: null, inverted: false, n, sufficiency,
      reason: `Only ${n} overlapping period${n === 1 ? '' : 's'} — at least ${MIN_CORRELATION_OBS} are needed.` };
  }
  const raw = pearson(xs, ys);
  if (raw == null) {
    return { rawCorrelation: null, businessAdjustedCorrelation: null, inverted: false, n, sufficiency,
      reason: 'One of these series never changes over this period, so a correlation is undefined.' };
  }
  // Exactly one side inverse → the business reading is the mirror of the raw one.
  const inverted = isInverseMetric(xKey) !== isInverseMetric(yKey);
  return {
    rawCorrelation: raw,
    businessAdjustedCorrelation: inverted ? -raw : raw,
    inverted,
    n,
    sufficiency,
    reason: null,
  };
}

// Plain-language reading of a signed correlation. Never claims causation.
export function describeCorrelation(r) {
  if (r == null) return 'No correlation available';
  const a = Math.abs(r);
  const strength = a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.15 ? 'weak' : 'negligible';
  if (a < 0.15) return 'No meaningful linear relationship';
  return `${strength.charAt(0).toUpperCase()}${strength.slice(1)} ${r > 0 ? 'positive' : 'negative'} relationship`;
}

// Heatmap fill for a SIGNED correlation (brief §27): red negative, neutral at
// zero, green positive. Zero must never read as red — that was V1's bug, and it
// made "no relationship" look like a failure.
export function signedCorrColor(r) {
  if (r == null) return 'var(--surface-2, #2a2a33)';
  const a = Math.min(1, Math.abs(r));
  if (a < 0.05) return 'rgba(148, 163, 184, 0.18)';               // neutral grey
  const alpha = (0.15 + a * 0.6).toFixed(3);
  return r > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
}

export function signedCorrTextColor(r) {
  if (r == null) return 'var(--text-muted)';
  if (Math.abs(r) < 0.05) return 'var(--text-secondary)';
  return r > 0 ? '#22c55e' : '#ef4444';
}

// Signed percentage string: +61%, -18%, 0%.
export function fmtSignedPct(r) {
  if (r == null) return null;
  const p = Math.round(r * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}
