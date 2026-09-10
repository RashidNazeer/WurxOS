// ============================================================
// Halo V2 — Stage 5: historical contribution + forward scenarios
// (brief §17, §18, and the Stage 5 completion in §G).
//
// The contribution figure is a COUNTERFACTUAL, not a share-out of revenue:
// predict Amazon with the TikTok activity that actually happened, predict it
// again with TikTok held at a reference level, and take the difference.
//
// The reference is never zero (§17). Zero TikTok is far outside the range the
// model ever saw, so predicting there is extrapolation dressed up as
// measurement — and it inflates the answer.
//
// Negative periods are kept (§9). A period where TikTok ran below its reference
// should pull the total down; flooring it would rebuild the positive-only bias
// this whole redesign removes.
//
// ── WHY THE INTERVAL IS EXACT RATHER THAN A BAND ────────────────────────────
// Per period, predictedActual - predictedBaseline collapses to
//   Σ_l β_l · (x[t-l] − ref)
// because every non-TikTok column is identical in both designs and cancels.
// The total is therefore Σ_l β_l · w_l with w_l = Σ_t (x[t-l] − ref) — a plain
// linear combination of the lag coefficients. That means the same machinery
// that produces the cumulative interval produces this one, from the same
// covariance matrix, with no extra assumptions. A hand-drawn band would have
// been a guess about uncertainty in a figure whose uncertainty is computable.
// ============================================================

import { matVec, median, mean } from './matrix.js';
import { linearCombo, ci95 } from './regression.js';

// ── Reference levels ────────────────────────────────────────────────
// The brief offers two candidate rules for the recommended default: the median
// of the lowest quartile of TikTok activity, or the median of the first 20–30%
// of the window. It says to pick ONE, document it, and stick to it.
//
// We pick the LOWEST-QUARTILE MEDIAN, for three reasons:
//   1. It does not assume the window opens on a quiet stretch. A date range
//      that happens to start mid-campaign would give the first-20% rule a
//      baseline as high as the campaign itself, and the contribution would
//      collapse for a reason nobody could see.
//   2. It is invariant to ordering, so nudging the date range does not make the
//      baseline jump around — the number stays comparable between sessions.
//   3. It answers the question actually being asked: what does Amazon look like
//      when TikTok is quiet?
//
// A quartile needs enough points to be a quartile at all: at n=6 the lowest
// quartile is one observation and the "baseline" is whichever period happened
// to be slowest. Below LOW_ACTIVITY_MIN_OBS we fall back to the window median
// and say so, rather than dressing up a single point as a baseline.
export const LOW_ACTIVITY_MIN_OBS = 8;
export const LOW_ACTIVITY_QUANTILE = 0.25;

export const REFERENCE_METHOD_SPECS = [
  {
    name: 'low_activity',
    label: 'Low-activity baseline (recommended)',
    short: 'Low-activity baseline',
    recommended: true,
    describe: 'Median of the quietest quarter of TikTok activity in this window — what Amazon looks like when TikTok is quiet.',
  },
  {
    name: 'period_median',
    label: 'Median activity in this window',
    short: 'Median activity',
    describe: 'Median TikTok activity across the whole window.',
  },
  {
    name: 'period_average',
    label: 'Average activity in this window',
    short: 'Period average',
    describe: 'Mean TikTok activity across the whole window. Pulled upward by spikes.',
  },
  {
    name: 'custom',
    label: 'Custom baseline',
    short: 'Custom baseline',
    describe: 'A TikTok activity level you supply.',
  },
];

// Back-compatible name → label map (the previous shape of this export).
export const REFERENCE_METHODS = Object.fromEntries(
  REFERENCE_METHOD_SPECS.map((s) => [s.name, s.label]),
);

export const referenceSpec = (name) =>
  REFERENCE_METHOD_SPECS.find((s) => s.name === name) || null;

/** Median of the values at or below the given quantile. */
function lowQuantileMedian(vals, q = LOW_ACTIVITY_QUANTILE) {
  const sorted = vals.slice().sort((a, b) => a - b);
  // At least one point, and at least the bottom q of them.
  const take = Math.max(1, Math.floor(sorted.length * q));
  return median(sorted.slice(0, take));
}

/**
 * Resolve a reference method to a value, with the reasoning attached.
 *   { value, method, requestedMethod, label, describe, note, fellBack }
 * `note` is populated only when the resolution did something the caller did not
 * literally ask for, so the UI can say so instead of silently substituting.
 */
export function resolveReference(xs, method = 'low_activity', customValue = null) {
  const vals = (xs || []).filter((v) => Number.isFinite(v));
  if (!vals.length) {
    return { value: null, method, requestedMethod: method, label: 'No data', describe: null, note: 'No usable TikTok values in this window.', fellBack: false };
  }

  const done = (value, name, note = null, fellBack = false) => {
    const spec = referenceSpec(name);
    return {
      value,
      method: name,
      requestedMethod: method,
      label: spec?.short || name,
      describe: spec?.describe || null,
      note,
      fellBack,
    };
  };

  if (method === 'custom') {
    // Number(null) and Number('') are both 0, which is FINITE — so a blank
    // custom box used to resolve to a zero baseline. Zero TikTok is far outside
    // anything the model ever saw, so predicting there is extrapolation, and it
    // inflates the contribution enormously. §17 is explicit that the reference
    // is never zero; an empty field has to mean "not supplied", not "zero".
    const blank = customValue === null || customValue === undefined || customValue === '';
    const n = blank ? NaN : Number(customValue);
    if (Number.isFinite(n)) return done(n, 'custom');
    return done(median(vals), 'period_median', 'No custom baseline was supplied, so the window median was used instead.', true);
  }
  if (method === 'period_average') return done(mean(vals), 'period_average');
  if (method === 'period_median') return done(median(vals), 'period_median');

  // 'pre_period' was the previous name for this idea and may still arrive from
  // a saved selection; it means the same thing, so it resolves here rather than
  // falling through by accident.
  // low_activity (default / recommended)
  if (vals.length < LOW_ACTIVITY_MIN_OBS) {
    return done(
      median(vals),
      'period_median',
      `A low-activity baseline needs at least ${LOW_ACTIVITY_MIN_OBS} periods to have a meaningful quietest quarter — this window has ${vals.length}, so the window median was used instead.`,
      true,
    );
  }
  return done(lowQuantileMedian(vals), 'low_activity');
}

// Kept for back-compatibility: the old export returned a bare number.
export function referenceValue(xs, method = 'low_activity', customValue = null) {
  return resolveReference(xs, method, customValue).value;
}

/**
 * Which reference the UI should offer as the default for this model.
 * Falls back to the window median when there is not enough history for a
 * quartile to mean anything — so the recommendation never points at a rule the
 * data cannot support.
 */
export function recommendedReferenceMethod(model) {
  const n = model?._usable?.length || 0;
  return n >= LOW_ACTIVITY_MIN_OBS ? 'low_activity' : 'period_median';
}

/**
 * Modelled contribution of TikTok activity relative to a reference level.
 *
 * Returns per-period detail (both predicted series, so the actual-vs-
 * counterfactual chart can be drawn straight from it) plus the total and its
 * 95% interval. Null when the model isn't available — we never fall back to the
 * simple slope, because that would silently swap methods behind one number.
 */
export function historicalContribution(model, { method = 'low_activity', customValue = null } = {}) {
  if (!model?.available || !model._fit || !model._design) return null;
  const { _fit: fit, _design: design, maxLag: L, _usable: usable, _cov: cov } = model;

  const xsAll = usable.map((u) => u.lags[0]);
  const ref = resolveReference(xsAll, method, customValue);
  if (ref.value == null) return null;
  const refValue = ref.value;

  const predictedActual = matVec(design, fit.beta);
  // Same rows, but every TikTok lag column replaced by the reference level.
  // Controls and the intercept are untouched, so they cancel in the difference.
  const baselineDesign = design.map((row) => {
    const next = [...row];
    for (let l = 0; l <= L; l++) next[1 + l] = refValue;
    return next;
  });
  const predictedBaseline = matVec(baselineDesign, fit.beta);

  // Contrast weights for the TOTAL: w_l = Σ_t (x[t-l] − ref).
  const width = design[0].length;
  const totalWeights = new Array(width).fill(0);
  for (const u of usable) {
    for (let l = 0; l <= L; l++) totalWeights[1 + l] += (u.lags[l] - refValue);
  }
  const totalCombo = cov ? linearCombo(fit.beta, cov, totalWeights) : null;
  const totalInterval = totalCombo ? ci95(totalCombo.value, totalCombo.se) : { lower: null, upper: null };

  const perPeriod = usable.map((u, i) => {
    // Per-period interval, same construction with that row's weights only.
    let lower = null, upper = null;
    if (cov) {
      const w = new Array(width).fill(0);
      for (let l = 0; l <= L; l++) w[1 + l] += (u.lags[l] - refValue);
      const c = linearCombo(fit.beta, cov, w);
      const iv = ci95(c.value, c.se);
      lower = iv.lower; upper = iv.upper;
    }
    return {
      key: u.period?.key ?? i,
      label: u.period?.label ?? u.period?.key ?? String(i),
      actualX: u.lags[0],
      actualY: u.y,
      predictedActual: predictedActual[i],
      predictedBaseline: predictedBaseline[i],
      contribution: predictedActual[i] - predictedBaseline[i],
      lower,
      upper,
    };
  });

  const total = perPeriod.reduce((s, p) => s + p.contribution, 0);
  const positive = perPeriod.filter((p) => p.contribution > 0).reduce((s, p) => s + p.contribution, 0);
  const negative = perPeriod.filter((p) => p.contribution < 0).reduce((s, p) => s + p.contribution, 0);

  return {
    referenceMethod: ref.method,
    requestedReferenceMethod: ref.requestedMethod,
    referenceLabel: ref.label,
    referenceDescribe: ref.describe,
    referenceNote: ref.note,
    referenceFellBack: ref.fellBack,
    referenceValue: refValue,
    // `amount` is the sum of the per-period differences. totalFromContrast is
    // the same quantity via the linear combination and exists as a self-check:
    // the two are algebraically identical, so a divergence means the design and
    // the weights have fallen out of step.
    amount: total,
    totalFromContrast: totalCombo ? totalCombo.value : null,
    standardError: totalCombo ? totalCombo.se : null,
    lower: totalInterval.lower,
    upper: totalInterval.upper,
    spansZero: totalInterval.lower != null && totalInterval.lower < 0 && totalInterval.upper > 0,
    positiveAmount: positive,
    negativeAmount: negative,
    periods: perPeriod.length,
    perPeriod,
    label: 'Modelled Amazon revenue associated with TikTok activity above/below the selected reference level.',
  };
}

/**
 * How much the answer depends on which reference was chosen (brief §G1).
 *
 * The brief flags this because median and average can flip the contribution
 * from a large positive to a negative — and a number that swings on a dropdown
 * nobody thought about should not be presented as a finding. This computes the
 * total under every non-custom rule and reports whether they disagree about the
 * SIGN, or differ by enough in magnitude to change a decision.
 */
export const SENSITIVITY_SPREAD_THRESHOLD = 0.5;   // 50% of the largest magnitude
// A figure below this share of the largest one is treated as ~zero and does not
// get a vote on the SIGN. See the reasoning in referenceSensitivity.
export const SENSITIVITY_SIGN_MATERIALITY = 0.05;

export function referenceSensitivity(model) {
  if (!model?.available) return null;
  const methods = ['low_activity', 'period_median', 'period_average'];
  const byMethod = {};
  for (const m of methods) {
    const c = historicalContribution(model, { method: m });
    if (c) byMethod[m] = { method: m, resolvedMethod: c.referenceMethod, label: c.referenceLabel, referenceValue: c.referenceValue, amount: c.amount };
  }
  const entries = Object.values(byMethod);
  if (entries.length < 2) return null;

  const amounts = entries.map((e) => e.amount);
  const maxAbs = Math.max(...amounts.map((a) => Math.abs(a)));

  // Only MATERIAL figures vote on the sign.
  //
  // Contribution measured against the period AVERAGE is approximately zero by
  // construction: it sums beta * (x - mean) over every period, and the
  // deviations from the mean cancel. Its sign is therefore noise on any
  // well-behaved series. Letting that near-zero figure disagree with a large
  // positive one produced "the rules disagree about whether the contribution is
  // positive or negative" — a genuinely alarming sentence — on data where
  // nothing was wrong at all.
  //
  // A spread is still reported in that situation, because the baseline choice
  // really does move the number a long way and the user should know. The
  // difference is that a spread is a caveat, whereas a sign flip claims the
  // DIRECTION is unresolved, and that claim has to be earned.
  const signMaterial = amounts.filter((a) => Math.abs(a) > maxAbs * SENSITIVITY_SIGN_MATERIALITY);
  const signs = new Set(signMaterial.map((a) => (a > 0 ? 1 : -1)));
  const signFlip = signs.size > 1;
  const spread = maxAbs > 0 ? (Math.max(...amounts) - Math.min(...amounts)) / maxAbs : 0;
  const materialSpread = spread > SENSITIVITY_SPREAD_THRESHOLD;

  let message = null;
  if (signFlip) {
    message = 'Contribution is highly sensitive to the reference choice: the rules below disagree about whether the contribution is positive or negative. Treat the direction as unresolved rather than picking the reference that reads best.';
  } else if (materialSpread) {
    message = `Contribution is sensitive to the reference choice: the rules below span ${Math.round(spread * 100)}% of the largest figure. The contribution is a comparison against a baseline, so the baseline is part of the claim.`;
  }

  return { byMethod, entries, signFlip, materialSpread, spread, message, sensitive: signFlip || materialSpread };
}

/**
 * Forward scenario (§18): what a change in TikTok activity is associated with
 * across the halo window.
 *
 * `basis` decides which coefficient answers. It defaults to LAGGED-ONLY where
 * that exists, because this reads as a halo claim — "spend more on TikTok, get
 * more on Amazon" — and the full cumulative includes same-period co-movement
 * that a shared cause explains just as well. The basis actually used is
 * returned so the UI can label it rather than leave the reader to assume.
 *
 * changeSpec: { type: 'percent', value: 10 } | { type: 'absolute', value: 2000 }
 */
export function marginalScenario(model, avgPeriodX, changeSpec = { type: 'percent', value: 10 }, { basis = 'lagged_only' } = {}) {
  if (!model?.available) return null;
  const base = Number(avgPeriodX);
  if (!Number.isFinite(base)) return null;

  const delta = changeSpec.type === 'absolute'
    ? Number(changeSpec.value)
    : base * (Number(changeSpec.value) / 100);
  if (!Number.isFinite(delta)) return null;

  const useLagged = basis === 'lagged_only' && model.laggedOnlyAvailable && model.laggedOnly;
  const coef = useLagged ? model.laggedOnly.coefficient : model.cumulativeCoefficient;
  const lo = useLagged ? model.laggedOnly.lower : model.confidenceInterval?.lower;
  const hi = useLagged ? model.laggedOnly.upper : model.confidenceInterval?.upper;

  return {
    basis: useLagged ? 'lagged_only' : 'cumulative',
    basisLabel: useLagged ? 'delayed (lagged-only) association' : 'full cumulative association, same-period included',
    basePeriodActivity: base,
    change: delta,
    changeLabel: changeSpec.type === 'absolute'
      ? `+${delta.toLocaleString()}`
      : `+${changeSpec.value}%`,
    estimated: coef * delta,
    lower: lo == null ? null : lo * delta,
    upper: hi == null ? null : hi * delta,
    coefficient: coef,
    spansZero: lo != null && hi != null && lo < 0 && hi > 0,
    note: 'Forward-looking scenario, not historical contribution. An estimated association across the selected halo window, not a guaranteed return.',
  };
}
