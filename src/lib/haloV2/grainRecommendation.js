// ============================================================
// Halo V2 — which grain can actually answer the question (brief §A).
//
// The old explorer hardcoded "Weekly — recommended" onto the picker forever.
// That label was right in principle (§14: weekly is the model's natural
// frequency) and wrong in practice on a young brand: five weeks of history
// produces four empty correlation cards and a blocked model, while the SAME
// date range at daily grain produces a working estimate on ~32 observations.
// Users never discovered that, because nothing told them.
//
// So the recommendation is computed, per metric pair and lag window, from the
// data actually present — and every gate here comes from capacityOf, which is
// the code the regression itself runs. A recommender with its own copy of the
// sufficiency rules would eventually promise a grain the model then refuses.
// ============================================================

import { capacityOf, bestFeasibleLag, MAX_SUPPORTED_LAG } from './distributedLag.js';
import { MIN_CORRELATION_OBS } from './correlation.js';
import { PERIODS_PER_YEAR } from './controls.js';

export const GRAIN_LABEL = { day: 'Daily', week: 'Weekly', month: 'Monthly' };
export const GRAIN_UNIT = { day: 'day', week: 'week', month: 'month' };

// Within this fraction of the requirement, the status panel says "almost
// there" instead of only showing a gap — 23 of 24 is a different message from
// 5 of 20 (§A5).
export const ALMOST_THERE_FRACTION = 0.9;

/**
 * What one grain can support for this metric pair.
 *
 * `periods` are the aligned rows for that grain (from buildPeriods).
 */
export function assessGrain(grain, periods, { maxLag = MAX_SUPPORTED_LAG, controls = {} } = {}) {
  const rows = Array.isArray(periods) ? periods : [];
  // Seasonality's period is annual, so it depends on the grain being assessed —
  // NOT on whatever grain the caller happens to be viewing. Deriving it here
  // means assessGrains can loop over every grain with one controls object and
  // still get each grain's own seasonality gate right; a caller passing the
  // current view's value would make Daily assessed with a weekly cycle.
  const ctl = { ...controls, periodsPerYear: PERIODS_PER_YEAR[grain] ?? controls.periodsPerYear };

  // Correlation only needs both sides present in the same period. It is far
  // cheaper in data than the regression, which is why it stays available on
  // thin history and the model does not.
  const correlationObs = rows.filter((p) => p?.x != null && p?.y != null).length;
  const canCorrelate = correlationObs >= MIN_CORRELATION_OBS;

  // The requested window, and the best window this data can actually carry.
  const requested = capacityOf(rows, { maxLag, controls: ctl });
  const feasible = bestFeasibleLag(rows, { maxLag, controls: ctl });

  return {
    grain,
    label: GRAIN_LABEL[grain] || grain,
    unit: GRAIN_UNIT[grain] || 'period',
    periodsSupplied: requested.periodsSupplied,
    usable: requested.usable,
    droppedToLags: requested.droppedToLags,
    required: requested.required,
    shortfall: requested.shortfall,
    parameterCount: requested.parameterCount,
    // Can the model run at the window the user ASKED for?
    canModelAtRequested: requested.ok,
    // Can it run at all, and at what window?
    feasibleLag: feasible.lag,
    lagReduced: feasible.reduced,
    canModel: feasible.lag !== null,
    // Requirement at the feasible window, for the progress meter.
    feasibleRequired: feasible.capacity.required,
    feasibleUsable: feasible.capacity.usable,
    almostThere: !requested.ok && requested.required > 0
      && requested.usable >= requested.required * ALMOST_THERE_FRACTION,
    correlationObs,
    canCorrelate,
    correlationRequired: MIN_CORRELATION_OBS,
    controlsIncluded: requested.controlsIncluded,
    controlsUnavailable: requested.controlsUnavailable,
    // Surfaced so a grain can be described honestly BEFORE it is selected —
    // "Daily (no seasonality adjustment at this range)" is useful in the picker,
    // and capacityOf has already worked it out for this grain's own cycle.
    seasonalityIncluded: requested.seasonalityIncluded,
    seasonalityReason: requested.seasonalityReason,
    periodsPerYear: ctl.periodsPerYear ?? null,
  };
}

/**
 * Assess every grain that has data behind it.
 *
 * `periodsFor(grain)` must return the aligned rows for that grain — the caller
 * owns bucketing, so this stays free of any dependency on how sheets are
 * shaped.
 */
export function assessGrains(grains, periodsFor, opts = {}) {
  const out = {};
  for (const g of grains || []) out[g] = assessGrain(g, periodsFor(g), opts);
  return out;
}

/**
 * Which grain to recommend, and why.
 *
 * THE LADDER, in the brief's order (§A2):
 *
 *   1. Weekly, if it supports the model at the REQUESTED lag window. Weekly is
 *      the model's natural frequency (§14): daily is noisy and monthly leaves
 *      too few observations, so when weekly can carry the full window it wins
 *      outright.
 *   2. Otherwise Daily, if it supports a model at all — even a same-period or
 *      one-lag one. This is the rung that was missing: a working daily estimate
 *      beats an em-dash-filled weekly view, and the whole complaint was that
 *      nobody found it.
 *   3. Otherwise Weekly again, at a reduced window, if it can carry one.
 *      Preferred over monthly because a week is still an interpretable halo
 *      window and a month is barely one.
 *   4. Otherwise Monthly, if it can carry a model.
 *   5. Otherwise GUIDED mode: no grain can model. Recommend whichever has the
 *      most usable periods so the descriptive charts are as rich as possible,
 *      and let the UI explain what is missing.
 *
 * Returns `guided: true` in case 5 — that is the flag the UI uses to switch
 * from "here is your model" to "here is what is needed", which is the
 * difference between the page feeling broken and feeling like a next step.
 */
export function recommendGrain(assessments, { currentGrain = null } = {}) {
  const list = Object.values(assessments || {});
  if (!list.length) {
    return { grain: null, guided: true, reason: 'No sheet data is available for any grain.', assessment: null };
  }

  const byGrain = (g) => assessments[g] || null;
  const week = byGrain('week');
  const day = byGrain('day');
  const month = byGrain('month');
  const current = currentGrain ? byGrain(currentGrain) : null;

  // "N of about M usable weeks" for whichever grain is being described.
  const shortOf = (a) => (a ? `${a.usable} of about ${a.required} usable ${a.unit}s` : 'no data at that grain');

  if (week?.canModelAtRequested) {
    return {
      grain: 'week', guided: false, assessment: week,
      reason: `Weekly supports the full model here (${week.usable} usable weeks, about ${week.required} needed). Weekly is the model's natural frequency.`,
    };
  }
  if (day?.canModel) {
    // Name the grain the USER IS ON, not always Weekly. Selecting Monthly used
    // to produce "Weekly does not have enough history…" in the Monthly empty
    // state — a stale sentence about a view nobody had chosen.
    const blocked = (current && current.grain !== 'day') ? current : week;
    return {
      grain: 'day', guided: false, assessment: day,
      reason: `${blocked?.label || 'This view'} does not have enough history yet (${shortOf(blocked)}), but Daily does: ${day.usable} usable days supports a ${day.feasibleLag === 0 ? 'same-day' : `${day.feasibleLag}-day`} model over this same date range.`,
    };
  }
  if (week?.canModel) {
    return {
      grain: 'week', guided: false, assessment: week,
      reason: `Weekly can support a reduced ${week.feasibleLag === 0 ? 'same-week' : `${week.feasibleLag}-week`} window (${week.usable} usable weeks). The full window needs about ${week.required}.`,
    };
  }
  if (month?.canModel) {
    return {
      grain: 'month', guided: false, assessment: month,
      reason: `Only Monthly can carry a model over this range (${month.usable} usable months). Monthly is exploratory — few observations make the estimate move easily.`,
    };
  }

  // Nothing can model. Recommend the richest grain for the descriptive stage.
  const richest = list.reduce((a, b) => (b.usable > (a?.usable ?? -1) ? b : a), null);
  return {
    grain: richest?.grain ?? null,
    guided: true,
    assessment: richest,
    reason: 'No grain has enough history for an adjusted model over this date range yet. The descriptive charts and — where there is enough overlap — the signed correlations are still meaningful.',
  };
}

/**
 * The concrete next action to offer, given where the user currently is.
 *
 * Returns null when the current grain is already the recommendation, so the UI
 * can stay quiet rather than nagging.
 */
export function grainSwitchSuggestion(currentGrain, assessments, recommendation) {
  if (!recommendation?.grain || recommendation.grain === currentGrain) return null;
  const target = assessments?.[recommendation.grain];
  if (!target) return null;
  return {
    grain: recommendation.grain,
    label: target.label,
    // Phrased around the fact that matters: it works with what is already
    // loaded, so switching costs nothing and needs no new data.
    cta: `Switch to ${target.label} (works with this date range)`,
    detail: target.canModel
      ? `${target.usable} usable ${target.unit}s — enough for a ${target.feasibleLag === 0 ? `same-${target.unit}` : `${target.feasibleLag}-${target.unit}`} model.`
      : `${target.usable} usable ${target.unit}s — more history than the current view.`,
  };
}
