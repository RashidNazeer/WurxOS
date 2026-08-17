// ============================================================
// Halo V2 — the distributed-lag model (brief §6, §7, §8, §13, §19, §22).
//
//   Amazon[t] = a + b0*TikTok[t] + b1*TikTok[t-1] + ... + bL*TikTok[t-L]
//               + controls + e[t]
//
// This replaces "pick the best single lag" with "estimate the whole response
// window at once". The headline number is the CUMULATIVE coefficient
// b0+...+bL: an extra £1 of TikTok today is associated with £X of Amazon spread
// across this week and the next L.
//
// The guardrail in §13 is the part that protects the product's credibility: ten
// weeks of data with three lags and several controls cannot support a confident
// money figure, so we refuse to print one rather than printing a fragile one.
// ============================================================

import { ols, hacCovariance, linearCombo, ci95, varianceInflation, influence } from './regression.js';
import { buildControls } from './controls.js';

export const MAX_SUPPORTED_LAG = 3;

// Brief §13: effective observations must clear max(20, 4 x parameters).
export function sufficiencyCheck(effectiveObservations, parameterCount) {
  const required = Math.max(20, 4 * parameterCount);
  return { ok: effectiveObservations >= required, required, effectiveObservations, parameterCount };
}

/**
 * Fit the model.
 *
 * periods: [{ key, x, y, controls? }] — ONE aligned row per period, ascending,
 *          already restricted to complete observations (brief §29: missing
 *          stays missing; it is never silently zero).
 *
 * Returns a result object that always explains itself, including when it
 * declines to estimate.
 */
export function fitDistributedLag(periods, { maxLag = MAX_SUPPORTED_LAG, controls = {}, xKey, yKey } = {}) {
  const L = Math.max(0, Math.min(MAX_SUPPORTED_LAG, maxLag));

  // Lagging costs the first L rows — that loss is real and must be shown (§29).
  const usable = [];
  for (let t = L; t < periods.length; t++) {
    const y = Number(periods[t]?.y);
    const lags = [];
    let ok = Number.isFinite(y);
    for (let l = 0; l <= L; l++) {
      const v = Number(periods[t - l]?.x);
      if (!Number.isFinite(v)) { ok = false; break; }
      lags.push(v);
    }
    if (ok) usable.push({ period: periods[t], y, lags });
  }

  const ctrl = buildControls(usable.map((u) => u.period), controls);
  const parameterCount = 1 + (L + 1) + ctrl.columns.length;   // intercept + lags + controls
  const check = sufficiencyCheck(usable.length, parameterCount);

  const base = {
    available: false,
    maxLag: L,
    sampleSize: usable.length,
    droppedToLags: periods.length - usable.length,
    parameterCount,
    controls: ctrl.included,
    controlsUnavailable: ctrl.unavailable,
    xKey,
    yKey,
    warnings: [],
  };

  if (!check.ok) {
    return {
      ...base,
      reason: 'insufficient_data',
      message: `Not enough history for an adjusted halo estimate. We can still show signed correlations and lag relationships, but ${check.effectiveObservations} usable period${check.effectiveObservations === 1 ? '' : 's'} cannot reliably estimate a ${L}-lag model with ${parameterCount} parameters (needs about ${check.required}).`,
      requiredObservations: check.required,
    };
  }

  // Design matrix: intercept, TikTok at t..t-L, then the control columns.
  const design = usable.map((u, i) => [1, ...u.lags, ...ctrl.columns.map((c) => c.values[i])]);
  const y = usable.map((u) => u.y);

  const fit = ols(design, y);
  if (!fit) {
    return { ...base, reason: 'singular', message: 'The model could not be estimated — the selected inputs are collinear or degenerate over this period.' };
  }

  const hac = hacCovariance(fit);
  const cov = hac?.cov || fit.covClassic;
  const covKind = hac?.cov ? 'Newey-West (HAC)' : 'classical';

  // Cumulative = sum of the lag coefficients only (indices 1..L+1).
  const c = design[0].map((_, i) => (i >= 1 && i <= L + 1 ? 1 : 0));
  const cum = linearCombo(fit.beta, cov, c);
  const interval = ci95(cum.value, cum.se);

  const lagCoefficients = [];
  for (let l = 0; l <= L; l++) {
    const idx = 1 + l;
    const se = cov?.[idx]?.[idx] > 0 ? Math.sqrt(cov[idx][idx]) : null;
    lagCoefficients.push({
      lag: l,
      label: l === 0 ? 'Same period' : `+${l} period${l === 1 ? '' : 's'}`,
      coefficient: fit.beta[idx],
      standardError: se,
      ...ci95(fit.beta[idx], se),
    });
  }

  const warnings = [];
  const vif = varianceInflation(design, 0);
  const lagVif = vif.slice(1, L + 2).filter((v) => v != null);
  const maxVif = lagVif.length ? Math.max(...lagVif) : null;
  if (maxVif != null && maxVif >= 10) {
    warnings.push({
      code: 'multicollinearity',
      message: 'Individual weekly lag estimates are unstable because TikTok activity is similar across adjacent weeks. Interpret the cumulative effect more heavily than any single lag coefficient.',
    });
  }
  if (interval.lower != null && interval.lower < 0 && interval.upper > 0) {
    warnings.push({ code: 'interval_spans_zero', message: 'The 95% interval includes zero — the direction of this relationship is uncertain over this period.' });
  }
  const infl = influence(fit);
  const worst = infl.reduce((a, b) => ((b.cooksD ?? 0) > (a?.cooksD ?? 0) ? b : a), null);
  const cookThreshold = 4 / Math.max(1, fit.n);
  if (worst && worst.cooksD != null && worst.cooksD > cookThreshold) {
    warnings.push({
      code: 'influential_observation',
      message: 'One period has a large influence on this estimate.',
      index: worst.index,
      periodKey: usable[worst.index]?.period?.key ?? null,
    });
  }

  return {
    ...base,
    available: true,
    reason: null,
    intercept: fit.beta[0],
    lagCoefficients,
    cumulativeCoefficient: cum.value,
    cumulativeStandardError: cum.se,
    confidenceInterval: interval,
    covarianceKind: covKind,
    hacBandwidth: hac?.bandwidth ?? null,
    adjustedR2: fit.adjR2,
    r2: fit.r2,
    maxVif,
    influence: infl,
    warnings,
    _fit: fit,
    _design: design,
    _usable: usable,
    _controlColumns: ctrl.columns,
  };
}

// Refit with one period removed — the sensitivity check offered when an
// influential observation is flagged (§30). Never applied automatically.
export function refitWithout(periods, index, opts) {
  const trimmed = periods.filter((_, i) => i !== index);
  return fitDistributedLag(trimmed, opts);
}
