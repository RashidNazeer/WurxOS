// ============================================================
// Halo V2 — the measurement ladder as visible progress (brief §J).
//
// Book 4 Module 15 describes halo measurement as six ordered stages. The tool
// implemented five of them but showed nothing about where a given brand had
// reached, so thin data read as failure: blank cards, a blocked model, no sense
// that Stage 1 had in fact completed and Stage 3 simply needed more history.
//
// Naming the stages and marking each Done / In progress / Needs data turns the
// same screen into a position on a journey. Nothing here computes measurement —
// it only reports what the analysis already decided.
//
// Stage 6 (geo / holdout / incrementality validation) is explicitly out of
// scope for this pass and is shown as a future stage, never as a failure. It is
// also the reason nothing in this tool may be called incremental.
// ============================================================

export const STAGE_STATUS = {
  done: 'Done',
  partial: 'In progress',
  needs_data: 'Needs data',
  later: 'Coming later',
};

export const STAGES = [
  { n: 1, key: 'descriptive',    title: 'Descriptive' },
  { n: 2, key: 'correlations',   title: 'Correlations' },
  { n: 3, key: 'regression',     title: 'Regression' },
  { n: 4, key: 'distributedLag', title: 'Distributed lag' },
  { n: 5, key: 'counterfactual', title: 'Counterfactual' },
  { n: 6, key: 'validation',     title: 'Validation' },
];

/**
 * Status of each stage for one analysis result.
 *
 * `periodsWithData` is passed separately because Stage 1 is about whether there
 * is anything to CHART, which is true even when every model refuses — and that
 * is the specific reassurance the guided empty state depends on.
 */
export function stageStatuses(result, { periodsWithData = 0 } = {}) {
  const model = result?.adjustedModel;
  const lagRows = result?.observed?.lagCorrelations || [];
  const anyCorrelation = lagRows.some((r) => r.correlation != null);
  const allCorrelations = lagRows.length > 0 && lagRows.every((r) => r.correlation != null);
  const contribution = result?.historicalContribution;

  const status = {};
  const detail = {};

  // 1 — Descriptive. Charts render whenever a series exists, so this completes
  // long before anything else and should be visibly ticked.
  if (periodsWithData >= 2) {
    status.descriptive = 'done';
    detail.descriptive = `${periodsWithData} periods charted.`;
  } else {
    status.descriptive = 'needs_data';
    detail.descriptive = 'Not enough periods to draw a series yet.';
  }

  // 2 — Correlations. Partial when only some lags have enough overlap: the
  // longer lags lose observations, so a short window can compute lag 0 and not
  // lag 3.
  if (allCorrelations) {
    status.correlations = 'done';
    detail.correlations = 'Signed correlations computed at every lag in the window.';
  } else if (anyCorrelation) {
    const got = lagRows.filter((r) => r.correlation != null).length;
    status.correlations = 'partial';
    detail.correlations = `${got} of ${lagRows.length} lags have enough overlapping periods.`;
  } else {
    status.correlations = 'needs_data';
    const need = lagRows[0]?.sufficiency?.computable === false ? lagRows[0] : null;
    detail.correlations = need?.reason || 'Not enough overlapping periods for a correlation.';
  }

  // 3 — Regression. The adjusted estimate exists, or it does not.
  if (model?.available) {
    status.regression = 'done';
    detail.regression = `Estimated on ${model.sampleSize} usable periods with ${model.parameterCount ?? '?'} parameters.`;
  } else {
    status.regression = 'needs_data';
    detail.regression = model?.message || 'The adjusted model could not be estimated.';
  }

  // 4 — Distributed lag. A fitted model with NO lags has not done this stage:
  // it measured same-period co-movement, which is the thing the lag window
  // exists to separate out. Marking that "done" would be the same overclaim the
  // rest of this work removes.
  if (model?.available && model.maxLag >= 1) {
    status.distributedLag = 'done';
    detail.distributedLag = model.laggedOnly?.spansZero
      ? `${model.maxLag}-lag window estimated, but the delayed effect is not distinguishable from zero.`
      : `${model.maxLag}-lag window estimated; delayed-only relationship is signed.`;
  } else if (model?.available) {
    status.distributedLag = 'partial';
    detail.distributedLag = 'Only a same-period model was estimated — no lag window, so no delayed effect has been looked for.';
  } else {
    status.distributedLag = 'needs_data';
    detail.distributedLag = 'Needs the adjusted model first.';
  }

  // 5 — Counterfactual. Available whenever the model is, but flagged partial
  // when the answer swings on which baseline was picked: a contribution that
  // changes sign on a dropdown is not a completed stage.
  if (contribution && result?.referenceSensitivity?.signFlip) {
    status.counterfactual = 'partial';
    detail.counterfactual = 'Computed, but the rules disagree about whether the contribution is positive or negative.';
  } else if (contribution) {
    status.counterfactual = 'done';
    detail.counterfactual = `Contribution measured against the ${contribution.referenceLabel.toLowerCase()}.`;
  } else {
    status.counterfactual = 'needs_data';
    detail.counterfactual = 'Needs the adjusted model first.';
  }

  // 6 — Validation. Out of scope by design, and the reason no output here may
  // be described as incremental.
  status.validation = 'later';
  detail.validation = 'Geo or holdout testing. Not part of this tool yet — which is why nothing here is labelled incremental.';

  return STAGES.map((s) => ({
    ...s,
    status: status[s.key],
    statusLabel: STAGE_STATUS[status[s.key]],
    detail: detail[s.key],
  }));
}

/** Short summary for a collapsed header, e.g. "Stage 3 of 5". */
export function stageProgress(statuses) {
  const scored = (statuses || []).filter((s) => s.status !== 'later');
  const done = scored.filter((s) => s.status === 'done').length;
  return { done, total: scored.length };
}
