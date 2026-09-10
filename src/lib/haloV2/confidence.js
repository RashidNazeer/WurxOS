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

/** Rank of a confidence label, or -1 for anything unrecognised. */
export const confidenceRank = (label) => (label in RANK ? RANK[label] : -1);

/**
 * Is `label` at least as strong as `floor`?
 *
 * Exported so the planning layer can express its floor as a level name rather
 * than duplicating this ordering — a second copy of the ladder is how the
 * planner and the model end up disagreeing about what "Moderate" means.
 * An unrecognised label is treated as NOT meeting the floor: failing closed is
 * the only safe direction when the thing being gated is investment planning.
 */
export function atLeastConfidence(label, floor) {
  const l = confidenceRank(label);
  const f = confidenceRank(floor);
  if (l < 0 || f < 0) return false;
  return l >= f;
}

/**
 * Cap a label at a ceiling. Returns the ceiling when the score earned more.
 * Never RAISES a label — a ceiling can only ever hold confidence down.
 */
function applyCeiling(label, ceiling) {
  if (!ceiling) return label;
  return RANK[label] > RANK[ceiling] ? ceiling : label;
}

// ── History described in the grain the user is actually looking at ──
// The sample-size reasons used a week-shaped template: at n >= 52 they said
// "about a year of history" whatever the grain. On a daily view 52 usable
// periods is seven weeks, and the model details cheerfully called that a year —
// the single most misleading sentence on the page, because sample size is the
// first thing anyone checks before trusting a figure.
//
// The score thresholds below are deliberately unchanged; only the description
// is derived from the real grain.
const PER_YEAR = { day: 365, week: 52, month: 12 };

export function historyPhrase(n, unit = 'period') {
  const count = `${n} usable ${unit}${n === 1 ? '' : 's'}`;
  const perYear = PER_YEAR[unit];
  if (!perYear) return count;
  const years = n / perYear;
  if (years >= 1.85) return `${count} — about ${years.toFixed(1)} years of history`;
  if (years >= 0.85) return `${count} — about a year of history`;
  // Below a year, describe it in the next unit UP where that reads better than
  // a bare count ("118 usable days — about 17 weeks"). Three weeks is the floor:
  // below it "about 1 weeks" is worse than the plain day count.
  if (unit === 'day' && n >= 21) return `${count} — about ${Math.round(n / 7)} weeks`;
  if (unit === 'month' && n >= 6) return `${count} — about ${(n / 12).toFixed(1)} of a year`;
  return count;
}

export function modelConfidence({
  model, lagRows = [], controlsIncluded = [], controlsUnavailable = [], missingMajor = null,
  // The grain being viewed, so the history description matches it.
  unit = 'period',
}) {
  const reasons = [];

  if (!model?.available) {
    return {
      label: 'Insufficient Data',
      score: 0,
      reasons: [model?.message || 'The adjusted model could not be estimated for this period.'],
    };
  }

  let score = 0;

  // 1. Sample size. Thresholds unchanged; the wording now names the grain.
  const n = model.sampleSize;
  const span = historyPhrase(n, unit);
  if (n >= 78) { score += 2; reasons.push(`${span} — plenty to estimate on.`); }
  else if (n >= 52) { score += 1.5; reasons.push(`${span}.`); }
  else if (n >= 26) { score += 1; reasons.push(`${span}.`); }
  else { score += 0.25; reasons.push(`${span} — few enough that the estimate moves easily.`); }

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
