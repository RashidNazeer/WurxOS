// ============================================================
// Halo V2 — Investment Planning (brief §23 Layer C, §24, §25, §H).
//
// Planning is NOT measurement and must never be presented as measurement. But
// the previous version went too far the other way: Conservative / Base / Upside
// defaulted to 50 / 100 / 150 — three numbers with no relationship to anything
// measured — and the only way to involve the model was one button that pushed
// its FULL cumulative estimate into Base alone.
//
// That button was the sharp edge. On real data the full cumulative was ~167%
// while the delayed-only relationship was a fraction of it, so one click put a
// number carrying same-period co-movement into a plan as though it were halo.
//
// So this file now does two things it did not before:
//
//   1. GATES. planningEligibility decides whether the model is allowed to drive
//      planning at all, and returns every reason it is not. The gates are the
//      brief's: a fitted model, both metrics monetary, an interval that
//      excludes zero on the planning basis, and confidence at or above a floor.
//
//   2. MAPS THE INTERVAL, not the point. When eligible, all THREE scenarios
//      come from the model: Base from the point estimate, Conservative from the
//      lower bound, Upside from the upper. The spread between them is then the
//      model's actual uncertainty rather than an arbitrary ±50%.
//
// When the gates fail, 50/100/150 survive — but as explicitly ASSUMED
// placeholders with the blockers listed, never as model output.
// ============================================================

import { atLeastConfidence } from './confidence.js';

// PLACEHOLDERS, used only in assumptions mode. Deliberately not called
// "defaults": they are three round numbers, and the whole point of §H is that
// they must never be mistaken for a measurement.
export const DEFAULT_ASSUMPTIONS = { conservative: 50, base: 100, upside: 150 };

// Auto-apply floor (§H). "Directional" and below stay assumptions-only: a
// direction is not a magnitude, and planning needs a magnitude.
export const PLANNING_CONFIDENCE_FLOOR = 'Moderate Confidence';

export const PLANNING_MODES = {
  model: 'From adjusted model',
  assumptions: 'Planning assumptions',
  override: 'Manual override',
};

/**
 * One scenario.
 *   ttsRevenue     — direct TikTok Shop revenue
 *   marketingSpend — TikTok marketing spend
 *   haloPercent    — off-platform revenue as a % of TTS revenue
 */
export function scenario(ttsRevenue, marketingSpend, haloPercent) {
  const tts = Number(ttsRevenue) || 0;
  const spend = Number(marketingSpend) || 0;
  const pct = Number(haloPercent) || 0;
  const offPlatform = tts * (pct / 100);
  const total = tts + offPlatform;
  return {
    haloPercent: pct,
    haloPerCurrencyUnit: pct / 100,          // e.g. 0.5 → $0.50 per $1
    directRevenue: tts,
    offPlatformRevenue: offPlatform,
    totalInfluencedRevenue: total,
    marketingSpend: spend,
    blendedMultiple: spend > 0 ? total / spend : null,
    directMultiple: spend > 0 ? tts / spend : null,
  };
}

/**
 * Which coefficient planning should be based on, and whether it may be used.
 *
 * Basis selection is not a preference — it is the §F rule applied to planning.
 * Where the window has lags, the delayed-only relationship IS the halo claim.
 * Where it does not (max lag 0), only a same-period association exists, and the
 * brief allows planning on it while requiring it to be badged as a weak halo
 * claim — because same-period co-movement is what a shared cause produces.
 *
 * Returns the blockers as a list so the UI can explain the situation and offer
 * a route out of it, rather than just refusing.
 */
export function planningEligibility(model, { xIsMonetary = false, yIsMonetary = false, confidenceLabel = null } = {}) {
  const blockers = [];
  const notes = [];
  // Confidence is computed OUTSIDE the fit (confidence.js blends the model with
  // the lag correlations and the control lists), so the raw model object does
  // not carry a label. Reading `model.confidenceLabel` therefore found
  // undefined and — because the floor check fails closed — refused planning for
  // every model ever fitted. It has to be passed in explicitly.
  const confLabel = confidenceLabel ?? model?.confidenceLabel ?? null;

  if (!model?.available) {
    return {
      eligible: false, basis: null, basisLabel: null, weakHaloClaim: false,
      point: null, lower: null, upper: null,
      blockers: [{
        code: 'no_model',
        message: model?.headline || 'No adjusted model could be estimated for this period, so there is nothing to derive scenarios from.',
        fix: 'Widen the date range, or switch to a grain with more usable periods.',
      }],
      notes,
    };
  }

  // The coefficient is "Amazon currency per 1 unit of the TikTok metric". That
  // is only a PERCENTAGE when both sides are money — otherwise a "halo %" would
  // be dollars per video view, which is not a percentage of anything.
  if (!xIsMonetary || !yIsMonetary) {
    blockers.push({
      code: 'not_monetary',
      message: 'A halo percentage only means something when both metrics are money. This pair is not, so the coefficient cannot be read as a percentage of TikTok Shop revenue.',
      fix: 'Choose a monetary TikTok metric (e.g. GMV) and a monetary Amazon metric (e.g. revenue).',
    });
  }

  const useLagged = !!(model.laggedOnlyAvailable && model.laggedOnly);
  const basis = useLagged ? 'lagged_only' : 'cumulative';
  const weakHaloClaim = !useLagged;
  if (weakHaloClaim) {
    notes.push('Only a same-period association is available in this window, so any plan built on it is a weak halo claim.');
  }

  const point = useLagged ? model.laggedOnly.coefficient : model.cumulativeCoefficient;
  const lower = useLagged ? model.laggedOnly.lower : model.confidenceInterval?.lower ?? null;
  const upper = useLagged ? model.laggedOnly.upper : model.confidenceInterval?.upper ?? null;

  if (lower == null || upper == null) {
    blockers.push({
      code: 'no_interval',
      message: 'No usable 95% interval could be computed on the planning basis, so Conservative and Upside cannot be derived.',
      fix: 'A longer history usually resolves this.',
    });
  } else if (lower < 0 && upper > 0) {
    blockers.push({
      code: 'ci_spans_zero',
      message: `The 95% interval on the ${useLagged ? 'lagged-only' : 'cumulative'} basis includes zero, so even the direction of the relationship is unresolved. Deriving investment scenarios from it would put a sign nobody has established into a plan.`,
      fix: 'More history, or controlling for a missing confounder, is what narrows this.',
    });
  }

  if (!atLeastConfidence(confLabel, PLANNING_CONFIDENCE_FLOOR)) {
    blockers.push({
      code: 'low_confidence',
      message: `Model confidence is "${confLabel || 'unknown'}", below the ${PLANNING_CONFIDENCE_FLOOR} needed to drive planning automatically.`,
      fix: 'The confidence panel lists what is holding it down — usually sample size or a missing control.',
    });
  }

  return {
    eligible: blockers.length === 0,
    basis,
    basisLabel: useLagged ? 'lagged-only' : 'same-period',
    weakHaloClaim,
    point: point ?? null,
    lower,
    upper,
    blockers,
    notes,
  };
}

/**
 * Turn the model's interval into all three planning scenarios (§H).
 *
 *   Base         = the point estimate
 *   Conservative = the lower bound, FLOORED AT ZERO
 *   Upside       = the upper bound
 *
 * The floor is a deliberate asymmetry. A negative lower bound is a real
 * statistical possibility, but "conservative" in an investment plan means the
 * cautious case, not a case where TikTok activity destroys Amazon revenue —
 * planning a budget against a negative halo is not a decision anybody makes.
 * The negative bound is still reported (`lowerRaw`) so it is not hidden, and
 * `lowerFloored` says the floor was applied.
 */
export function modelDerivedAssumptions(model, { xIsMonetary = false, yIsMonetary = false, confidenceLabel = null, grainLabel = null, rangeLabel = null } = {}) {
  const el = planningEligibility(model, { xIsMonetary, yIsMonetary, confidenceLabel });
  if (!el.eligible) {
    return { usable: false, eligibility: el, reason: el.blockers[0]?.message || 'The model is not eligible to drive planning.' };
  }

  const pct = (v) => Math.round(v * 100 * 10) / 10;      // coefficient → % at 1dp
  const basePct = pct(el.point);
  const lowerRaw = pct(el.lower);
  const upperPct = pct(el.upper);
  const lowerFloored = lowerRaw < 0;

  const sourceParts = ['From adjusted model', el.basisLabel];
  if (grainLabel) sourceParts.push(grainLabel);
  if (rangeLabel) sourceParts.push(rangeLabel);

  return {
    usable: true,
    eligibility: el,
    assumptions: {
      conservative: lowerFloored ? 0 : lowerRaw,
      base: basePct,
      upside: upperPct,
    },
    basis: el.basis,
    basisLabel: el.basisLabel,
    weakHaloClaim: el.weakHaloClaim,
    lowerRaw,
    lowerFloored,
    source: sourceParts.join(' · '),
    note: el.weakHaloClaim
      ? 'Derived from a same-period association only. It remains a planning assumption once applied, and it is a weak halo claim.'
      : 'Derived from the adjusted model on the delayed (lagged-only) basis. It remains a planning assumption once applied.',
  };
}

/**
 * The three scenarios, plus what they are and where they came from.
 *
 * `mode` is carried through rather than inferred so the UI can never show
 * "From adjusted model" next to numbers a user has since edited — that
 * mislabelling is the specific failure §H's override rule exists to prevent.
 */
export function planningModel({
  ttsRevenue, marketingSpend, assumptions = DEFAULT_ASSUMPTIONS,
  mode = 'assumptions', source = null, blockers = [], weakHaloClaim = false,
}) {
  const a = assumptions || DEFAULT_ASSUMPTIONS;
  return {
    conservative: scenario(ttsRevenue, marketingSpend, a.conservative),
    base: scenario(ttsRevenue, marketingSpend, a.base),
    upside: scenario(ttsRevenue, marketingSpend, a.upside),
    mode,
    modeLabel: PLANNING_MODES[mode] || PLANNING_MODES.assumptions,
    source,
    blockers,
    weakHaloClaim,
    // Every mode is a planning assumption at the point of use. The distinction
    // is only where the number came from.
    disclaimer: mode === 'model'
      ? 'Derived from the adjusted model, then used as a planning assumption. Not a measured result and not incremental.'
      : mode === 'override'
        ? 'Manually entered planning assumptions — not measured results.'
        : 'Planning assumptions — not measured results. The model is not eligible to drive these.',
  };
}

/**
 * Superseded by modelDerivedAssumptions, which sets all three scenarios from
 * the interval instead of pushing a point estimate into Base alone.
 *
 * Kept so nothing breaks mid-series; the explorer no longer calls it.
 * @deprecated
 */
export function modelEstimateAsAssumption(model, { xIsMonetary, yIsMonetary } = {}) {
  if (!model?.available || model.cumulativeCoefficient == null) {
    return { usable: false, reason: 'No adjusted estimate is available for this period.' };
  }
  if (!xIsMonetary || !yIsMonetary) {
    return { usable: false, reason: 'The model estimate can only become a halo % when both metrics are monetary (e.g. TikTok GMV vs Amazon revenue).' };
  }
  const pct = model.cumulativeCoefficient * 100;
  return {
    usable: true,
    haloPercent: Math.round(pct * 10) / 10,
    lowerPercent: model.confidenceInterval?.lower == null ? null : Math.round(model.confidenceInterval.lower * 1000) / 10,
    upperPercent: model.confidenceInterval?.upper == null ? null : Math.round(model.confidenceInterval.upper * 1000) / 10,
    note: 'Taken from the adjusted model for this period. It remains a planning assumption once applied.',
  };
}
