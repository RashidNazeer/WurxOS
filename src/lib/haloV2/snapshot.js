// ============================================================
// Halo V2 - the Snapshot (client-ready redesign, section 0).
//
// The first viewport has to answer one question without a narrator: what is the
// TikTok Shop effect on Amazon for this period? Four or five cards, then one
// chart. Everything else on the page is the working behind them.
//
// Nothing here measures anything. It reads what analyseHalo already decided and
// turns it into the five things a client asks for in a meeting:
//
//   1. the modelled effect, on the halo basis (delayed where one exists)
//   2. the 95% range, in plain words
//   3. signal strength, with the one reason that decides it
//   4. what this is NOT, so the claim cannot drift upward
//   5. the next action: Scale, Hold, or Need more data
//
// The basis and the interval come from planningEligibility rather than being
// re-derived: that function already owns the "delayed where available, same
// period otherwise" rule, and a second copy of it is how the snapshot and the
// plan end up quoting different numbers for the same window.
// ============================================================

import { confidenceRank } from './confidence.js';

// The claim ceiling, in one line. Repeated verbatim in the one-pager and the
// CSV so the caveat travels with every copy of the figure.
export const NOT_CLAIM_LINE = 'Modelled association after available controls. Not a geo test. Not platform ROAS.';

// Signal strength is a re-label of model confidence, not a second opinion. Two
// scales that can disagree about the same model is worse than one that a client
// finds blunt.
export const SIGNAL_BY_CONFIDENCE = {
  'Strong Evidence': 'High',
  'Moderate Confidence': 'Moderate',
  Directional: 'Low',
  'Low Confidence': 'Low',
  'Insufficient Data': 'Low',
};

export const NEXT_ACTIONS = { scale: 'Scale', hold: 'Hold', more: 'Need more data' };

const money = (cur, v) => `${cur}${Number(v).toFixed(2)}`;

/**
 * Everything the Snapshot renders.
 *
 * result - analyseHalo() output
 * unit   - 'day' | 'week' | 'month', for copy that names the period
 * cur    - currency symbol for the coefficient ("$0.42 per $1")
 */
export function buildSnapshot(result, { unit = 'period', cur = '$' } = {}) {
  const m = result?.adjustedModel || {};
  const el = result?.planningEligibility || {};
  const missingMajor = m.controlsMissingMajor || [];

  const available = !!m.available && el.point != null;
  const weakHalo = !!el.weakHaloClaim;
  const spansZero = el.lower != null && el.upper != null && el.lower < 0 && el.upper > 0;
  const negative = el.upper != null && el.upper < 0;

  const effect = available
    ? {
        available: true,
        label: weakHalo ? 'Same-period association' : 'Modelled Amazon effect',
        value: `${money(cur, el.point)} per ${cur}1`,
        sub: weakHalo
          ? 'Same period only. No lag window is selected, so no delayed effect has been looked for.'
          : `Amazon revenue associated with each ${cur}1 of TikTok activity, over the ${unit}s that follow it.`,
        basis: el.basis,
        basisLabel: el.basisLabel,
        weakHalo,
      }
    : {
        available: false,
        label: 'Modelled Amazon effect',
        value: 'Not available',
        sub: m.headline || 'There is not enough history for an adjusted model over this period.',
        basis: null,
        basisLabel: null,
        weakHalo: false,
      };

  const range = !available || el.lower == null || el.upper == null
    ? {
        available: false,
        label: '95% range',
        value: 'Not available',
        sub: available
          ? 'No usable range could be computed on this basis.'
          : 'A range needs a fitted model.',
        spansZero: false,
      }
    : {
        available: true,
        label: '95% range',
        value: `Likely between ${money(cur, el.lower)} and ${money(cur, el.upper)}`,
        sub: spansZero
          ? 'The range crosses zero, so even the direction is unresolved.'
          : 'The range the true figure most plausibly sits in.',
        spansZero,
      };

  const signal = buildSignal(m, { unit, spansZero });
  const action = buildAction({ m, el, signal, spansZero, negative, missingMajor, unit });

  return { effect, range, signal, action, notClaim: NOT_CLAIM_LINE, weakHalo };
}

// ── Signal strength ────────────────────────────────────────────────
// One sentence of "why", and it must be the reason that actually decided the
// label. A cap is always the decisive reason when one applies: a client told
// "Moderate" on 104 weeks of data deserves to know it was held there because
// promotions are missing, not because the sample is short.
function buildSignal(m, { unit, spansZero }) {
  if (!m.available) {
    return {
      level: 'Low',
      confidenceLabel: m.confidenceLabel || 'Insufficient Data',
      why: m.headline || 'There is not enough history for an adjusted model yet.',
    };
  }
  const level = SIGNAL_BY_CONFIDENCE[m.confidenceLabel] || 'Low';
  let why;
  if (m.confidenceCappedBy?.length) {
    why = m.confidenceCappedBy[0];
  } else if (spansZero) {
    why = `The 95% range crosses zero on ${m.sampleSize} usable ${unit}s, so the direction is not established.`;
  } else {
    why = `${m.sampleSize} usable ${unit}s, and the 95% range stays on one side of zero.`;
  }
  return { level, confidenceLabel: m.confidenceLabel, why };
}

// ── Next action ────────────────────────────────────────────────────
// Rule-based, in this order, from the interval, the sample and the controls.
// Scale is the only verdict that tells someone to spend more, so it is the
// hardest to reach: the whole 95% range must be positive AND confidence must
// clear Moderate. Everything short of that is Hold (we have a reading, it will
// not carry a budget) or Need more data (we do not have a reading).
function buildAction({ m, el, signal, spansZero, negative, missingMajor, unit }) {
  const caveat = missingMajor.length
    ? ` ${missingMajor.map((c) => c.label).join(' and ')} ${missingMajor.length === 1 ? 'is' : 'are'} not in the model, so read the size as a ceiling.`
    : '';

  if (!m.available) {
    return {
      verdict: NEXT_ACTIONS.more,
      tone: 'muted',
      detail: `An adjusted model needs about ${m.requiredObservations || 'more'} usable ${unit}s and this window has ${m.sampleSize || 0}. Widen the dates or switch view.`,
    };
  }
  if (el.lower == null || el.upper == null) {
    return {
      verdict: NEXT_ACTIONS.more,
      tone: 'muted',
      detail: 'No 95% range could be computed on this basis, so there is nothing firm enough to act on yet.',
    };
  }
  if (spansZero) {
    return {
      verdict: NEXT_ACTIONS.hold,
      tone: 'warn',
      detail: `The 95% range crosses zero, so the direction is unresolved. Hold spend where it is and add history before moving on this.${caveat}`,
    };
  }
  if (negative) {
    return {
      verdict: NEXT_ACTIONS.hold,
      tone: 'warn',
      detail: `Over this window the modelled relationship is negative. Hold, and look at what else changed, before reading it as a reason to scale.${caveat}`,
    };
  }
  if (confidenceRank(m.confidenceLabel) < confidenceRank('Directional')) {
    return {
      verdict: NEXT_ACTIONS.more,
      tone: 'muted',
      detail: `Confidence is "${m.confidenceLabel}", which is a direction at best. More history is what moves it.${caveat}`,
    };
  }
  if (confidenceRank(m.confidenceLabel) < confidenceRank('Moderate Confidence')) {
    return {
      verdict: NEXT_ACTIONS.hold,
      tone: 'warn',
      detail: `The direction is positive but confidence is only "${m.confidenceLabel}". Hold at current spend and use this as supporting evidence.${caveat}`,
    };
  }
  return {
    verdict: NEXT_ACTIONS.scale,
    tone: 'pos',
    detail: `The whole 95% range is positive at "${m.confidenceLabel}". Scale is defensible as a planning assumption, never as promised lift.${caveat}`,
  };
}
