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

// Ordered weakest → strongest, so a ceiling is just an index comparison.
const RANK = Object.fromEntries(CONFIDENCE_LEVELS.map((l, i) => [l, i]));

/**
 * Cap a label at a ceiling. Returns the ceiling when the score earned more.
 * Never RAISES a label — a ceiling can only ever hold confidence down.
 */
function applyCeiling(label, ceiling) {
  if (!ceiling) return label;
  return RANK[label] > RANK[ceiling] ? ceiling : label;
}

export function modelConfidence({ model, lagRows = [], controlsIncluded = [], controlsUnavailable = [], missingMajor = null }) {
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

  const earned = score >= 4 ? 'Strong Evidence'
    : score >= 3 ? 'Moderate Confidence'
    : score >= 2 ? 'Directional'
    : 'Low Confidence';

  // ── Ceilings (brief §E4) ─────────────────────────────────────────
  // Scoring alone could reach "Strong Evidence" on a long history with a tight
  // interval and NOTHING controlled for but a time trend. That is precisely the
  // combination that produces a confident wrong answer: a promotion calendar
  // both series respond to will deliver a long, tight, entirely spurious
  // relationship. So two hard ceilings sit on top of the score, and a ceiling
  // can only ever hold the label DOWN.
  let ceiling = null;
  const ceilingReasons = [];

  // 1. A missing major confounder caps at Moderate. There is no amount of
  //    sample size that substitutes for knowing whether a promotion ran.
  const missing = Array.isArray(missingMajor) ? missingMajor : (model?.controlsMissingMajor || []);
  if (missing.length) {
    ceiling = 'Moderate Confidence';
    ceilingReasons.push(
      `Capped at Moderate Confidence: ${missing.map((m) => m.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the model, and ${missing.length === 1 ? 'it is' : 'they are'} a plausible rival explanation for the movement.`,
    );
  }

  // 2. If the DELAYED relationship cannot be signed, confidence in a HALO is
  //    capped regardless of how well the combined figure is estimated — the
  //    combined figure includes same-period co-movement, which is not a halo.
  //    Only applies where lags were actually estimated.
  if (model?.laggedOnlyAvailable && model?.laggedOnly?.spansZero) {
    ceiling = applyCeiling(ceiling || 'Strong Evidence', 'Directional');
    ceilingReasons.push(
      'Capped at Directional: the lagged-only interval includes zero, so a delayed off-platform effect is not established over this period.',
    );
  }

  const label = applyCeiling(earned, ceiling);
  if (ceiling && label !== earned) reasons.push(...ceilingReasons);

  return {
    label,
    score: Math.round(score * 100) / 100,
    reasons,
    // Exposed so the UI can explain a cap rather than leave the reader
    // wondering why a long, tight model reads only "Moderate".
    earnedLabel: earned,
    ceiling,
    cappedBy: label !== earned ? ceilingReasons : [],
  };
}
