// ============================================================
// Halo V2 — historical contribution + forward scenarios (brief §17, §18).
//
// The contribution figure is a COUNTERFACTUAL, not a share-out of revenue:
// predict Amazon with the TikTok activity that actually happened, predict it
// again with TikTok held at a reference level, and take the difference.
//
// The reference defaults to the period MEDIAN, never zero (§17). Zero TikTok is
// far outside the range the model ever saw, so predicting there is extrapolation
// dressed up as measurement — and it inflates the answer.
//
// Negative weeks are kept (§9). A week where TikTok ran below its reference
// should pull the total down; flooring it would rebuild the positive-only bias
// this whole redesign removes.
// ============================================================

import { matVec } from './matrix.js';
import { median, mean } from './matrix.js';

export const REFERENCE_METHODS = {
  period_median: 'Median TikTok activity in this period',
  period_average: 'Average TikTok activity in this period',
  custom: 'Custom baseline',
  pre_period: 'Pre-period baseline',
};

export function referenceValue(xs, method = 'period_median', customValue = null) {
  const vals = xs.filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  if (method === 'custom') return Number.isFinite(Number(customValue)) ? Number(customValue) : null;
  if (method === 'period_average') return mean(vals);
  if (method === 'pre_period') return Number.isFinite(Number(customValue)) ? Number(customValue) : median(vals);
  return median(vals);
}

/**
 * Modelled contribution of TikTok activity relative to a reference level.
 * Returns per-period detail plus the total, or null when the model isn't
 * available (no estimate, no contribution — we never fall back to the simple
 * slope here, because that would silently swap methods behind one number).
 */
export function historicalContribution(model, { method = 'period_median', customValue = null } = {}) {
  if (!model?.available || !model._fit || !model._design) return null;
  const { _fit: fit, _design: design, maxLag: L, _usable: usable } = model;

  const xsAll = usable.map((u) => u.lags[0]);
  const ref = referenceValue(xsAll, method, customValue);
  if (ref == null) return null;

  const predictedActual = matVec(design, fit.beta);
  // Same rows, but every TikTok lag column replaced by the reference level.
  const baselineDesign = design.map((row) => {
    const next = [...row];
    for (let l = 0; l <= L; l++) next[1 + l] = ref;
    return next;
  });
  const predictedBaseline = matVec(baselineDesign, fit.beta);

  const perPeriod = usable.map((u, i) => ({
    key: u.period?.key ?? i,
    actualX: u.lags[0],
    actualY: u.y,
    predictedActual: predictedActual[i],
    predictedBaseline: predictedBaseline[i],
    contribution: predictedActual[i] - predictedBaseline[i],
  }));

  const total = perPeriod.reduce((s, p) => s + p.contribution, 0);
  const positive = perPeriod.filter((p) => p.contribution > 0).reduce((s, p) => s + p.contribution, 0);
  const negative = perPeriod.filter((p) => p.contribution < 0).reduce((s, p) => s + p.contribution, 0);

  return {
    referenceMethod: method,
    referenceLabel: REFERENCE_METHODS[method] || method,
    referenceValue: ref,
    amount: total,
    positiveAmount: positive,
    negativeAmount: negative,
    perPeriod,
    label: 'Modelled Amazon revenue associated with TikTok activity above/below the selected reference level.',
  };
}

/**
 * Forward scenario (§18): what a change in TikTok activity is associated with
 * across the halo window. Deliberately uses the cumulative coefficient and its
 * interval, so the answer carries its own uncertainty.
 *
 * changeSpec: { type: 'percent', value: 10 } | { type: 'absolute', value: 2000 }
 */
export function marginalScenario(model, avgPeriodX, changeSpec = { type: 'percent', value: 10 }) {
  if (!model?.available) return null;
  const base = Number(avgPeriodX);
  if (!Number.isFinite(base)) return null;

  const delta = changeSpec.type === 'absolute'
    ? Number(changeSpec.value)
    : base * (Number(changeSpec.value) / 100);
  if (!Number.isFinite(delta)) return null;

  const coef = model.cumulativeCoefficient;
  const lo = model.confidenceInterval?.lower;
  const hi = model.confidenceInterval?.upper;

  return {
    basePeriodActivity: base,
    change: delta,
    changeLabel: changeSpec.type === 'absolute'
      ? `+${delta.toLocaleString()}`
      : `+${changeSpec.value}%`,
    estimated: coef * delta,
    lower: lo == null ? null : lo * delta,
    upper: hi == null ? null : hi * delta,
    coefficient: coef,
    note: 'Estimated association across the selected halo window, not a guaranteed return.',
  };
}
