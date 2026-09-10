// ============================================================
// Halo V2 — analytics entry point (brief §36).
//
// Produces the three layers the brief insists stay separate (§32, §37):
//   observed            — what the data shows (signed correlation, lags)
//   adjustedModel       — the regression estimate, or an honest refusal
//   historicalContribution / marginal — modelled counterfactual outputs
//   planning            — assumptions the user sets, never auto-filled
//
// Nothing in V1 is imported except the read-only field dictionary, and nothing
// here writes anything. V2 is additive by construction.
// ============================================================

import { signedCorrelation } from './correlation.js';
import { lagCorrelations, bestObservedLag, lagWarnings, DEFAULT_MAX_LAG } from './lagAnalysis.js';
import { fitDistributedLag } from './distributedLag.js';
import {
  historicalContribution, marginalScenario, referenceSensitivity, recommendedReferenceMethod,
} from './counterfactual.js';
import { modelConfidence } from './confidence.js';
import {
  planningModel, DEFAULT_ASSUMPTIONS, planningEligibility, modelDerivedAssumptions,
} from './planningScenarios.js';
import { isMonetaryMetric, metricLabel } from './metricMetadata.js';
import { mean } from './matrix.js';

export * from './correlation.js';
export * from './lagAnalysis.js';
export * from './distributedLag.js';
export * from './counterfactual.js';
export * from './confidence.js';
export * from './planningScenarios.js';
export * from './metricMetadata.js';
export * from './grainRecommendation.js';
export * from './stages.js';

/**
 * Run the whole V2 analysis for one metric pair.
 *
 * periods: [{ key, x, y, controls? }] ascending, one row per period, with
 *          missing values left as null (never coerced to 0 — brief §29).
 */
export function analyseHalo(periods, {
  xKey,
  yKey,
  maxLag = DEFAULT_MAX_LAG,
  controls = {},
  // null → use the recommended rule for this model (a low-activity baseline
  // where there is enough history for a quietest-quarter to mean anything, the
  // window median otherwise). Passing an explicit method overrides that.
  reference = null,
  scenarioSpec = { type: 'percent', value: 10 },
  planning = null,
} = {}) {
  const rows = Array.isArray(periods) ? periods : [];

  // ── Layer A — observed ────────────────────────────────────────────
  const series = rows.map((p) => ({ key: p.key, x: numOrNull(p.x), y: numOrNull(p.y) }));
  const lagRows = lagCorrelations(series, xKey, yKey, maxLag);
  const bestLag = bestObservedLag(lagRows);
  const sameWeek = lagRows.find((r) => r.lag === 0) || null;

  const observed = {
    lagCorrelations: lagRows,
    bestObservedLag: bestLag,
    rawCorrelation: sameWeek?.rawCorrelation ?? null,
    businessAdjustedCorrelation: sameWeek?.businessAdjustedCorrelation ?? null,
    inverted: !!sameWeek?.inverted,
    warnings: lagWarnings(lagRows),
    xLabel: metricLabel(xKey),
    yLabel: metricLabel(yKey),
  };

  // ── Layer B — adjusted model ──────────────────────────────────────
  const complete = series.filter((p) => p.x != null && p.y != null).length;
  const model = fitDistributedLag(
    rows.map((p) => ({ key: p.key, x: numOrNull(p.x), y: numOrNull(p.y), controls: p.controls })),
    { maxLag, controls, xKey, yKey },
  );

  const confidence = modelConfidence({
    model,
    lagRows,
    controlsIncluded: model.controls || [],
    controlsUnavailable: model.controlsUnavailable || [],
    // Passed structurally so the ceiling rule doesn't have to parse English out
    // of the display strings.
    missingMajor: model.controlsMissingMajor || [],
  });

  // ── Modelled outputs ──────────────────────────────────────────────
  const recommendedReference = recommendedReferenceMethod(model);
  const refOpts = reference || { method: recommendedReference, customValue: null };
  const contribution = historicalContribution(model, refOpts);
  // How much the contribution moves if a different reference rule is chosen.
  // The brief flags this because median vs average can flip the sign, and a
  // number that swings on an unconsidered dropdown is not a finding.
  const sensitivity = referenceSensitivity(model);
  const avgX = mean(series.filter((p) => p.x != null).map((p) => p.x));
  const marginal = marginalScenario(model, avgX, scenarioSpec);

  // ── Layer C — planning ────────────────────────────────────────────
  // Whether the model is ALLOWED to drive scenarios, and what they would be,
  // are computed regardless of whether revenue figures have been entered — the
  // UI needs to know before it decides what to render, and the blockers are
  // what it shows instead when the answer is no.
  // confidence.label is passed EXPLICITLY: it is computed above from the model
  // plus the lag correlations plus the control lists, so the raw model object
  // does not carry it, and the floor check fails closed on a missing label.
  const monetary = {
    xIsMonetary: isMonetaryMetric(xKey),
    yIsMonetary: isMonetaryMetric(yKey),
    confidenceLabel: confidence.label,
  };
  const eligibility = planningEligibility(model, monetary);
  const derived = modelDerivedAssumptions(model, {
    ...monetary,
    grainLabel: planning?.grainLabel || null,
    rangeLabel: planning?.rangeLabel || null,
  });

  // Mode and the live assumption values are the COMPONENT's state — a user can
  // override any figure and only the component knows whether they have. It
  // passes both in; this does the arithmetic and carries the labelling through,
  // so "From adjusted model" can never sit next to numbers someone has edited.
  const planningMode = planning?.mode || (derived.usable ? 'model' : 'assumptions');
  const planningOut = planning
    ? planningModel({
        ttsRevenue: planning.ttsRevenue,
        marketingSpend: planning.marketingSpend,
        assumptions: planning.assumptions || (derived.usable ? derived.assumptions : DEFAULT_ASSUMPTIONS),
        mode: planningMode,
        source: planningMode === 'model' ? derived.source : null,
        blockers: eligibility.blockers,
        weakHaloClaim: eligibility.weakHaloClaim,
      })
    : {
        conservative: null, base: null, upside: null,
        mode: planningMode, blockers: eligibility.blockers, weakHaloClaim: eligibility.weakHaloClaim,
      };

  const warnings = [
    ...observed.warnings,
    ...(model.warnings || []),
    ...(complete < rows.length
      ? [{ code: 'missing_periods', message: `${rows.length - complete} period${rows.length - complete === 1 ? '' : 's'} had a missing value on one side and were left out rather than treated as zero.` }]
      : []),
  ];

  return {
    observed,
    adjustedModel: {
      available: model.available,
      reason: model.reason,
      // Separate from `message` on purpose — see the comment in
      // distributedLag.js. The UI prints headline THEN message; if the message
      // repeated the headline the user saw the same sentence twice.
      headline: model.headline ?? null,
      message: model.message,
      sampleSize: model.sampleSize,
      droppedToLags: model.droppedToLags,
      requiredObservations: model.requiredObservations ?? null,
      shortfall: model.shortfall ?? null,
      parameterCount: model.parameterCount ?? null,
      maxLag: model.maxLag,
      lagCoefficients: model.lagCoefficients || [],
      cumulativeCoefficient: model.cumulativeCoefficient ?? null,
      confidenceInterval: model.confidenceInterval || { lower: null, upper: null },
      // §F — the delayed-only relationship is the halo claim; the full
      // cumulative includes same-period co-movement and is labelled as such.
      laggedOnlyAvailable: !!model.laggedOnlyAvailable,
      laggedOnly: model.laggedOnly || null,
      samePeriodCoefficient: model.samePeriodCoefficient ?? null,
      samePeriodShare: model.samePeriodShare ?? null,
      mixedLagSigns: !!model.mixedLagSigns,
      adjustedR2: model.adjustedR2 ?? null,
      covarianceKind: model.covarianceKind ?? null,
      controls: model.controls || [],
      controlsUnavailable: model.controlsUnavailable || [],
      // §E — the controls panel must state what was ACTUALLY in the regression.
      controlsMissingMajor: model.controlsMissingMajor || [],
      seasonalityIncluded: !!model.seasonalityIncluded,
      seasonalityReason: model.seasonalityReason ?? null,
      trendIncluded: !!model.trendIncluded,
      maxVif: model.maxVif ?? null,
      // Model-specific warnings (interval spans zero, influential observation,
      // collinear lags). These also flow into the combined `warnings` array
      // below, but Layer B renders them itself — the influential-observation
      // one carries the row `index` that drives the "Run without it" refit, so
      // it has to reach the model panel rather than only the summary list.
      warnings: model.warnings || [],
      confidenceLabel: confidence.label,
      confidenceReasons: confidence.reasons,
      // What the score alone would have said, and why it was held below that.
      confidenceEarned: confidence.earnedLabel ?? confidence.label,
      confidenceCeiling: confidence.ceiling ?? null,
      confidenceCappedBy: confidence.cappedBy || [],
      _model: model,          // for the sensitivity refit; not for display
    },
    historicalContribution: contribution,
    // §G1 — the contribution is a comparison against a baseline, so which
    // baseline is part of the claim. This says whether that choice matters here.
    referenceSensitivity: sensitivity,
    recommendedReference,
    marginal,
    planning: planningOut,
    // §H — may the model drive Conservative/Base/Upside, and what would they
    // be? Kept beside `planning` rather than inside it because the UI needs the
    // verdict to choose what to render at all.
    planningEligibility: eligibility,
    planningDerived: derived,
    meta: {
      xKey, yKey,
      xIsMonetary: isMonetaryMetric(xKey),
      yIsMonetary: isMonetaryMetric(yKey),
      periodsSupplied: rows.length,
      completeObservations: complete,
    },
    warnings,
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;         // missing stays missing (§29)
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
