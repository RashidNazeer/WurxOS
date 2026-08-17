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
import { historicalContribution, marginalScenario } from './counterfactual.js';
import { modelConfidence } from './confidence.js';
import { planningModel, DEFAULT_ASSUMPTIONS } from './planningScenarios.js';
import { isMonetaryMetric, metricLabel } from './metricMetadata.js';
import { mean } from './matrix.js';

export * from './correlation.js';
export * from './lagAnalysis.js';
export * from './distributedLag.js';
export * from './counterfactual.js';
export * from './confidence.js';
export * from './planningScenarios.js';
export * from './metricMetadata.js';

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
  reference = { method: 'period_median', customValue: null },
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
  });

  // ── Modelled outputs ──────────────────────────────────────────────
  const contribution = historicalContribution(model, reference);
  const avgX = mean(series.filter((p) => p.x != null).map((p) => p.x));
  const marginal = marginalScenario(model, avgX, scenarioSpec);

  // ── Layer C — planning (only what the user supplied) ──────────────
  const planningOut = planning
    ? planningModel({
        ttsRevenue: planning.ttsRevenue,
        marketingSpend: planning.marketingSpend,
        assumptions: planning.assumptions || DEFAULT_ASSUMPTIONS,
      })
    : { conservative: null, base: null, upside: null };

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
      message: model.message,
      sampleSize: model.sampleSize,
      droppedToLags: model.droppedToLags,
      maxLag: model.maxLag,
      lagCoefficients: model.lagCoefficients || [],
      cumulativeCoefficient: model.cumulativeCoefficient ?? null,
      confidenceInterval: model.confidenceInterval || { lower: null, upper: null },
      adjustedR2: model.adjustedR2 ?? null,
      covarianceKind: model.covarianceKind ?? null,
      controls: model.controls || [],
      controlsUnavailable: model.controlsUnavailable || [],
      maxVif: model.maxVif ?? null,
      // Model-specific warnings (interval spans zero, influential observation,
      // collinear lags). These also flow into the combined `warnings` array
      // below, but Layer B renders them itself — the influential-observation
      // one carries the row `index` that drives the "Run without it" refit, so
      // it has to reach the model panel rather than only the summary list.
      warnings: model.warnings || [],
      confidenceLabel: confidence.label,
      confidenceReasons: confidence.reasons,
      _model: model,          // for the sensitivity refit; not for display
    },
    historicalContribution: contribution,
    marginal,
    planning: planningOut,
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
