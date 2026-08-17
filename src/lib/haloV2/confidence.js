// ============================================================
// Halo V2 — model confidence label (brief §20).
//
// Explicitly NOT "how big is the correlation". A large correlation on twelve
// weeks with no controls deserves less trust than a modest one on two years
// with promotions and stock-outs accounted for. The label blends:
//   sample size · interval width and whether it spans zero · sign stability
//   across lags · how much we could control for · outlier sensitivity
//
// Every label ships with the reasons behind it so the UI can show its working
// instead of asking anyone to trust a word.
// ============================================================

export const CONFIDENCE_LEVELS = ['Insufficient Data', 'Low Confidence', 'Directional', 'Moderate Confidence', 'Strong Evidence'];

export function modelConfidence({ model, lagRows = [], controlsIncluded = [], controlsUnavailable = [] }) {
  const reasons = [];

  if (!model?.available) {
    return {
      label: 'Insufficient Data',
      score: 0,
      reasons: [model?.message || 'The adjusted model could not be estimated for this period.'],
    };
  }

  let score = 0;

  // 1. Sample size.
  const n = model.sampleSize;
  if (n >= 78) { score += 2; reasons.push(`${n} usable periods — a long history.`); }
  else if (n >= 52) { score += 1.5; reasons.push(`${n} usable periods — about a year of history.`); }
  else if (n >= 26) { score += 1; reasons.push(`${n} usable periods.`); }
  else { score += 0.25; reasons.push(`Only ${n} usable periods — estimates move easily.`); }

  // 2. Interval: does it agree on a direction, and how wide is it?
  const { lower, upper } = model.confidenceInterval || {};
  if (lower != null && upper != null) {
    const spansZero = lower < 0 && upper > 0;
    const width = Math.abs(upper - lower);
    const magnitude = Math.abs(model.cumulativeCoefficient) || 0;
    if (spansZero) {
      reasons.push('The 95% interval includes zero, so the direction is not established.');
    } else {
      score += 1.5;
      reasons.push(`The 95% interval stays ${lower > 0 ? 'positive' : 'negative'}.`);
      if (magnitude > 0 && width < magnitude * 1.5) { score += 0.5; reasons.push('The interval is reasonably tight around the estimate.'); }
    }
  } else {
    reasons.push('No usable interval could be computed for the cumulative effect.');
  }

  // 3. Sign stability across the isolated lags.
  const signed = lagRows.filter((r) => r.correlation != null && Math.abs(r.correlation) >= 0.1);
  if (signed.length >= 2) {
    const signs = new Set(signed.map((r) => Math.sign(r.correlation)));
    if (signs.size === 1) { score += 0.75; reasons.push('Lag correlations agree on direction.'); }
    else reasons.push('Lag correlations disagree on direction across the window.');
  }

  // 4. What we managed to control for.
  const realControls = controlsIncluded.filter((c) => c !== 'Trend');
  if (realControls.length >= 2) { score += 0.75; reasons.push(`Adjusted for ${realControls.join(', ').toLowerCase()}.`); }
  else if (realControls.length === 1) { score += 0.4; reasons.push(`Adjusted for ${realControls[0].toLowerCase()} only.`); }
  else reasons.push('Only a time trend could be controlled for — other drivers are unmeasured.');
  if (controlsUnavailable.length) reasons.push(`Not controlled for: ${controlsUnavailable.length} variable${controlsUnavailable.length === 1 ? '' : 's'} with no data.`);

  // 5. Penalties for known fragility.
  if (model.warnings?.some((w) => w.code === 'influential_observation')) { score -= 0.5; reasons.push('One period heavily influences the estimate.'); }
  if (model.warnings?.some((w) => w.code === 'multicollinearity')) reasons.push('Individual lag coefficients are collinear — read the cumulative figure, not the parts.');
  if (model.adjustedR2 != null && model.adjustedR2 < 0.1) { score -= 0.25; reasons.push('The model explains little of the variation in Amazon revenue.'); }

  const label = score >= 4 ? 'Strong Evidence'
    : score >= 3 ? 'Moderate Confidence'
    : score >= 2 ? 'Directional'
    : 'Low Confidence';

  return { label, score: Math.round(score * 100) / 100, reasons };
}
