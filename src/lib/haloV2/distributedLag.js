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

// ── Capacity accounting ─────────────────────────────────────────────
// Extracted from fitDistributedLag so that the grain recommender, the status
// panel and the model itself all answer "how many usable periods are there, and
// is that enough?" from ONE implementation.
//
// The alternative — a second copy of the usable-row and parameter-count rules
// living in the UI — is the bug this codebase keeps writing comments about: the
// panel would promise a model the fit then refuses, or hide a grain that would
// actually have worked. Every gate below is the gate fitDistributedLag applies,
// because it is the same code.

/**
 * The rows a lag-L model can actually use.
 *
 * A row at t survives only if y[t] and EVERY x[t-l] for l in 0..L are finite.
 * Missing stays missing (§29) — never zero-filled — so a single gap in the
 * TikTok series removes L+1 rows, and the first L rows are always lost to
 * lagging. Both losses are real and get reported rather than hidden.
 */
export function usableRows(periods, L) {
  const rows = Array.isArray(periods) ? periods : [];
  const out = [];
  for (let t = L; t < rows.length; t++) {
    const y = Number(rows[t]?.y);
    const lags = [];
    let ok = Number.isFinite(y);
    for (let l = 0; ok && l <= L; l++) {
      const v = Number(rows[t - l]?.x);
      if (!Number.isFinite(v)) { ok = false; break; }
      lags.push(v);
    }
    if (ok) out.push({ period: rows[t], y, lags });
  }
  return out;
}

/**
 * Can a lag-L model with these controls be estimated on these periods?
 *
 * Returns the full accounting — usable count, parameter count, the §13
 * requirement and the control lists — WITHOUT running the regression, so it is
 * cheap enough to call for every grain on every render. `_usable` / `_controls`
 * are handed back so fitDistributedLag can reuse the work instead of repeating it.
 */
export function capacityOf(periods, { maxLag = MAX_SUPPORTED_LAG, controls = {} } = {}) {
  const L = Math.max(0, Math.min(MAX_SUPPORTED_LAG, maxLag));
  const supplied = Array.isArray(periods) ? periods.length : 0;
  const usable = usableRows(periods, L);
  const ctrl = buildControls(usable.map((u) => u.period), controls);
  const parameterCount = 1 + (L + 1) + ctrl.columns.length;   // intercept + lags + controls
  const check = sufficiencyCheck(usable.length, parameterCount);
  return {
    maxLag: L,
    periodsSupplied: supplied,
    usable: usable.length,
    droppedToLags: supplied - usable.length,
    parameterCount,
    required: check.required,
    ok: check.ok,
    // How close, for the "almost there" progress meter (§A5).
    shortfall: Math.max(0, check.required - usable.length),
    controlsIncluded: ctrl.included,
    controlsUnavailable: ctrl.unavailable,
    _usable: usable,
    _controls: ctrl,
  };
}

/**
 * The largest lag window these periods can actually support, at or below the
 * requested one.
 *
 * Brief §F: a hard fail at the knife-edge (23 usable vs 24 required) is a worse
 * product than a 1-lag model plus a note saying why. Reducing the window drops
 * one parameter AND recovers one row, so it moves both sides of the inequality
 * — which is why stepping down often succeeds where the requested window fails.
 *
 * Returns null for `lag` only when even the same-period model is unsupportable.
 */
export function bestFeasibleLag(periods, { maxLag = MAX_SUPPORTED_LAG, controls = {} } = {}) {
  const requested = Math.max(0, Math.min(MAX_SUPPORTED_LAG, maxLag));
  const requestedCapacity = capacityOf(periods, { maxLag: requested, controls });
  if (requestedCapacity.ok) {
    return { lag: requested, requested, reduced: false, capacity: requestedCapacity };
  }
  for (let L = requested - 1; L >= 0; L--) {
    const cap = capacityOf(periods, { maxLag: L, controls });
    if (cap.ok) return { lag: L, requested, reduced: true, capacity: cap };
  }
  return { lag: null, requested, reduced: false, capacity: requestedCapacity };
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
  // Capacity accounting (usable rows, controls, §13 requirement) comes from the
  // shared helper so the status panel and the grain recommender can never
  // promise a model this function would refuse.
  const cap = capacityOf(periods, { maxLag, controls });
  const L = cap.maxLag;
  const usable = cap._usable;
  const ctrl = cap._controls;
  const parameterCount = cap.parameterCount;

  const base = {
    available: false,
    maxLag: L,
    sampleSize: usable.length,
    droppedToLags: cap.droppedToLags,
    parameterCount,
    requiredObservations: cap.required,
    shortfall: cap.shortfall,
    controls: ctrl.included,
    controlsUnavailable: ctrl.unavailable,
    xKey,
    yKey,
    warnings: [],
  };

  if (!cap.ok) {
    return {
      ...base,
      reason: 'insufficient_data',
      // `headline` and `message` are deliberately SEPARATE and must not repeat
      // each other. The explorer used to print its own bold "Not enough history
      // for an adjusted halo estimate." and then render `message`, which opened
      // with the very same sentence — so every blocked model showed the line
      // twice. The headline is the claim; the message is only the arithmetic
      // behind it.
      headline: 'Not enough history for an adjusted halo estimate.',
      message: `${cap.usable} usable period${cap.usable === 1 ? '' : 's'} cannot reliably estimate a ${L}-lag model with ${parameterCount} parameters — that needs about ${cap.required}. Signed correlations and lag relationships above need far less data and are still valid.`,
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

  // ── The two headline numbers (brief §F) ──────────────────────────
  // Design columns are [intercept, x_t, x_{t-1}, …, x_{t-L}, controls…], so lag
  // l sits at index 1+l and the same-period term is index 1.
  //
  // FULL cumulative = indices 1..L+1 — every lag INCLUDING same-period.
  // LAGGED-ONLY     = indices 2..L+1 — same-period EXCLUDED.
  //
  // The distinction is the whole point. Same-period co-movement is TikTok and
  // Amazon moving together within one bucket, which a shared cause (a promotion,
  // a payday, a seasonal spike) produces just as readily as any spillover. It is
  // not evidence of a delayed halo, and on real data it dominates: β0 ≈ +1.13 of
  // a +1.67 cumulative. Publishing the +1.67 as "the halo" credits TikTok with
  // same-day correlation, so the delayed-spillover claim leads on lagged-only
  // and the full figure is labelled as including co-movement.
  const cumIdx = design[0].map((_, i) => (i >= 1 && i <= L + 1 ? 1 : 0));
  const cum = linearCombo(fit.beta, cov, cumIdx);
  const interval = ci95(cum.value, cum.se);

  // Only meaningful when the window actually HAS lags. At L=0 there is no
  // lagged-only quantity to report, and inventing a zero would read as
  // "measured no delayed effect" rather than "did not look for one".
  const laggedOnlyAvailable = L >= 1;
  let laggedOnly = null;
  if (laggedOnlyAvailable) {
    const lagIdx = design[0].map((_, i) => (i >= 2 && i <= L + 1 ? 1 : 0));
    const lo = linearCombo(fit.beta, cov, lagIdx);
    const loInterval = ci95(lo.value, lo.se);
    laggedOnly = {
      coefficient: lo.value,
      standardError: lo.se,
      ...loInterval,
      // The gate the planning layer reads: an interval spanning zero means the
      // delayed relationship's DIRECTION is not established, so it must not
      // drive investment scenarios.
      spansZero: loInterval.lower != null && loInterval.lower < 0 && loInterval.upper > 0,
    };
  }

  const samePeriodCoefficient = fit.beta[1];
  const lagBetas = [];
  for (let l = 0; l <= L; l++) lagBetas.push(fit.beta[1 + l]);
  // Expressing the split as a percentage only makes sense while the lag
  // coefficients agree on direction. With genuinely opposing signs the parts can
  // exceed the whole (β0=+2, β1=-1 → cumulative +1, "share" 200%), and a share
  // above 100% reads as a bug rather than as the sign disagreement it is. So the
  // share is withheld there and the UI shows both coefficients instead.
  //
  // Only MATERIAL coefficients get a vote. A lag that is pure noise lands at
  // ±0.001 with an arbitrary sign, and counting those as disagreement withheld
  // the share on the very case it matters most for: a purely same-period
  // relationship, where the delayed terms are noise BY DEFINITION and the honest
  // answer is "100% of this is same-period co-movement". Scaling the threshold
  // to the largest coefficient keeps it unit-free, so it behaves the same on
  // dollars-per-dollar as on views-per-dollar.
  const scale = Math.max(...lagBetas.map((b) => Math.abs(b)), 0);
  const signTol = scale * 0.02;
  const material = lagBetas.filter((b) => Math.abs(b) > signTol);
  const mixedLagSigns = material.length > 1
    && !(material.every((b) => b > 0) || material.every((b) => b < 0));
  const samePeriodShare = (!mixedLagSigns && Math.abs(cum.value) > 1e-12)
    ? samePeriodCoefficient / cum.value
    : null;

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
  // Said plainly rather than left for the reader to infer from two intervals:
  // if the DELAYED part cannot be distinguished from zero, the full cumulative
  // must not be promoted as "the halo" — it is same-period co-movement carrying
  // the number.
  if (laggedOnly?.spansZero) {
    warnings.push({
      code: 'lagged_only_spans_zero',
      message: 'The lagged-only interval includes zero, so a delayed off-platform effect is not established over this period. The cumulative figure is being carried by same-period co-movement, which a shared cause explains just as well.',
    });
  }
  if (samePeriodShare != null && samePeriodShare >= 0.6) {
    warnings.push({
      code: 'same_period_dominant',
      message: `Same-period co-movement accounts for ${Math.round(samePeriodShare * 100)}% of the cumulative figure. Movement inside one ${L === 0 ? 'period' : 'bucket'} is not a delay, and is exactly what a shared driver such as a promotion produces.`,
    });
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
    // §F — the delayed-only relationship, its interval, and how much of the
    // full figure is same-period co-movement.
    laggedOnlyAvailable,
    laggedOnly,
    samePeriodCoefficient,
    samePeriodShare,
    mixedLagSigns,
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
