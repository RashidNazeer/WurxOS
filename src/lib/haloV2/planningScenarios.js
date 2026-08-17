// ============================================================
// Halo V2 — Investment Planning (brief §23 Layer C, §24, §25).
//
// This is NOT measurement and must never be presented as measurement. The user
// supplies a halo assumption; we do the arithmetic. Nothing in here reads the
// regression unless the user explicitly asks for it via
// `useModelEstimateAsBase`, which is a deliberate action, not a default (§24).
//
// External benchmarks (§25) may inform what someone types here, but they never
// enter the statistical model, so they live nowhere near this calculation.
// ============================================================

export const DEFAULT_ASSUMPTIONS = { conservative: 50, base: 100, upside: 150 };

/**
 * One scenario.
 *   ttsRevenue     — direct TikTok Shop revenue
 *   marketingSpend — TikTok marketing spend
 *   haloPercent    — assumed off-platform revenue as a % of TTS revenue
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

export function planningModel({ ttsRevenue, marketingSpend, assumptions = DEFAULT_ASSUMPTIONS }) {
  return {
    conservative: scenario(ttsRevenue, marketingSpend, assumptions.conservative),
    base: scenario(ttsRevenue, marketingSpend, assumptions.base),
    upside: scenario(ttsRevenue, marketingSpend, assumptions.upside),
    disclaimer: 'Planning assumptions — not measured results.',
  };
}

/**
 * Convert the model's cumulative coefficient into a halo % the planner can use
 * as its Base case. ONLY called from the explicit "Use adjusted model estimate
 * as Base assumption" button (§24).
 *
 * The coefficient is Amazon currency per 1 unit of the TikTok metric, so it is
 * only meaningful as a percentage when both sides are money.
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
