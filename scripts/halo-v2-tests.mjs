// ============================================================
// Halo V2 — the 11 tests the implementation brief requires (§33).
//
//   node scripts/halo-v2-tests.mjs
//
// Pure maths against synthetic data, no DB and no browser: these assert the
// behaviours the brief cares about most — that a negative relationship comes
// back negative, that a confounder moves the estimate, and that a small sample
// is refused rather than answered.
// ============================================================

import { pearson, signedCorrelation } from '../src/lib/haloV2/correlation.js';
import { lagCorrelations, bestObservedLag } from '../src/lib/haloV2/lagAnalysis.js';
import { fitDistributedLag, capacityOf, bestFeasibleLag } from '../src/lib/haloV2/distributedLag.js';
import { analyseHalo } from '../src/lib/haloV2/index.js';
import {
  historicalContribution, resolveReference, referenceSensitivity, marginalScenario,
} from '../src/lib/haloV2/counterfactual.js';
import {
  planningEligibility, modelDerivedAssumptions, planningModel, PLANNING_CONFIDENCE_FLOOR,
} from '../src/lib/haloV2/planningScenarios.js';
import { atLeastConfidence } from '../src/lib/haloV2/confidence.js';
import {
  assessGrain, recommendGrain, grainSwitchSuggestion,
} from '../src/lib/haloV2/grainRecommendation.js';
import { stageStatuses, stageProgress } from '../src/lib/haloV2/stages.js';

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

// Deterministic pseudo-random so runs are reproducible.
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const periods = (xs, ys, controls = []) =>
  xs.map((x, i) => ({ key: `w${i}`, x, y: ys[i], controls: controls[i] || {} }));

// ── Test 1 — perfect positive ────────────────────────────────────────
{
  const x = [100, 200, 300, 400, 500, 600, 700, 800];
  const y = x.map((v) => 1000 + v * 2);
  const r = pearson(x, y);
  check('1. Perfect positive relationship → r ≈ +1', near(r, 1, 1e-9), `r=${r?.toFixed(6)}`);
}

// ── Test 2 — perfect negative (must NOT be floored) ──────────────────
{
  const x = [100, 200, 300, 400, 500, 600, 700, 800];
  const y = x.map((v) => 5000 - v * 3);
  const r = pearson(x, y);
  check('2. Perfect negative relationship → r ≈ -1 (not floored to 0)', near(r, -1, 1e-9), `r=${r?.toFixed(6)}`);
}

// ── Test 3 — no relationship ─────────────────────────────────────────
{
  const x = Array.from({ length: 60 }, (_, i) => i + 1);
  const y = Array.from({ length: 60 }, () => 1000 + rnd() * 100);
  const r = pearson(x, y);
  check('3. No relationship → r near zero', Math.abs(r) < 0.3, `r=${r?.toFixed(4)}`);
}

// ── Test 4 — one-week halo ───────────────────────────────────────────
{
  const n = 60;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 900);
  const y = x.map((_, t) => 5000 + (t >= 1 ? 0.8 * x[t - 1] : 0) + rnd() * 40);
  const rows = lagCorrelations(periods(x, y).map((p) => ({ x: p.x, y: p.y })), 'gmv', 'revenue_per_day', 3);
  const l0 = rows[0].correlation, l1 = rows[1].correlation;
  check('4. One-week halo → lag-1 correlation beats lag-0', l1 > l0, `lag0=${l0.toFixed(3)} lag1=${l1.toFixed(3)}`);

  const fit = fitDistributedLag(periods(x, y), { maxLag: 3, controls: { trend: false, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' });
  const b0 = fit.lagCoefficients[0].coefficient, b1 = fit.lagCoefficients[1].coefficient;
  check('4b. One-week halo → regression β1 > β0', b1 > b0, `β0=${b0.toFixed(3)} β1=${b1.toFixed(3)}`);
  check('4c. Best observed lag is 1', bestObservedLag(rows) === 1, `best=${bestObservedLag(rows)}`);
}

// ── Test 5 — distributed halo, cumulative ≈ known truth ──────────────
{
  const n = 90;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const TRUE = { b0: 0.20, b1: 0.30, b2: 0.15 };
  const y = x.map((_, t) => 4000
    + TRUE.b0 * x[t]
    + (t >= 1 ? TRUE.b1 * x[t - 1] : 0)
    + (t >= 2 ? TRUE.b2 * x[t - 2] : 0)
    + (rnd() - 0.5) * 20);
  const fit = fitDistributedLag(periods(x, y), { maxLag: 3, controls: { trend: false, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' });
  const truth = TRUE.b0 + TRUE.b1 + TRUE.b2;
  check('5. Distributed halo → cumulative ≈ true total effect',
    near(fit.cumulativeCoefficient, truth, 0.05),
    `cumulative=${fit.cumulativeCoefficient?.toFixed(4)} truth=${truth}`);
  check('5b. Cumulative interval covers the truth',
    fit.confidenceInterval.lower <= truth && fit.confidenceInterval.upper >= truth,
    `[${fit.confidenceInterval.lower?.toFixed(3)}, ${fit.confidenceInterval.upper?.toFixed(3)}]`);
}

// ── Test 6 — promotion confounder ────────────────────────────────────
{
  const n = 80;
  const promo = Array.from({ length: n }, (_, i) => (i % 7 === 0 ? 1 : 0));
  // TikTok rises in promo weeks; Amazon rises because of the PROMO, not TikTok.
  const x = promo.map((p) => 1000 + p * 900 + rnd() * 120);
  const y = promo.map((p) => 5000 + p * 4000 + rnd() * 120);
  const naive = pearson(x, y);
  const adjusted = fitDistributedLag(
    periods(x, y, promo.map((p) => ({ promo: p }))),
    { maxLag: 0, controls: { trend: false, seasonality: false, promo: true }, xKey: 'gmv', yKey: 'revenue_per_day' },
  );
  const unadjusted = fitDistributedLag(
    periods(x, y),
    { maxLag: 0, controls: { trend: false, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' },
  );
  check('6. Promo confounder → naive correlation is positive', naive > 0.5, `r=${naive.toFixed(3)}`);
  check('6b. Controlling for promo materially shrinks the TikTok coefficient',
    Math.abs(adjusted.cumulativeCoefficient) < Math.abs(unadjusted.cumulativeCoefficient) * 0.5,
    `unadjusted=${unadjusted.cumulativeCoefficient?.toFixed(3)} adjusted=${adjusted.cumulativeCoefficient?.toFixed(3)}`);
}

// ── Test 7 — stock-out ───────────────────────────────────────────────
{
  const n = 80;
  const stock = Array.from({ length: n }, (_, i) => (i >= 30 && i < 40 ? 1 : 0));
  const x = Array.from({ length: n }, (_, i) => 1000 + i * 12 + rnd() * 60);
  // Real halo of +0.5, wiped out during the stock-out window.
  const y = x.map((v, i) => 4000 + 0.5 * v - stock[i] * 5000 + rnd() * 50);
  const raw = pearson(x, y);
  const withCtl = fitDistributedLag(
    periods(x, y, stock.map((s) => ({ stockout: s }))),
    { maxLag: 0, controls: { trend: false, seasonality: false, stockout: true }, xKey: 'gmv', yKey: 'revenue_per_day' },
  );
  const without = fitDistributedLag(
    periods(x, y),
    { maxLag: 0, controls: { trend: false, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' },
  );
  check('7. Stock-out control materially changes the estimate',
    Math.abs(withCtl.cumulativeCoefficient - without.cumulativeCoefficient) > 0.05,
    `without=${without.cumulativeCoefficient?.toFixed(3)} with=${withCtl.cumulativeCoefficient?.toFixed(3)} (truth 0.5, raw r=${raw.toFixed(2)})`);
  check('7b. With the control, the estimate lands near the true 0.5',
    near(withCtl.cumulativeCoefficient, 0.5, 0.08), `with=${withCtl.cumulativeCoefficient?.toFixed(3)}`);
}

// ── Test 8 — small sample must be refused ────────────────────────────
{
  const n = 10;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = Array.from({ length: n }, () => 4000 + rnd() * 500);
  const ctl = Array.from({ length: n }, (_, i) => ({ promo: i % 3 === 0 ? 1 : 0, stockout: i % 4 === 0 ? 1 : 0 }));
  const fit = fitDistributedLag(periods(x, y, ctl), { maxLag: 3, controls: { promo: true, stockout: true }, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('8. 10 weeks + 3 lags + controls → regression refused', fit.available === false && fit.reason === 'insufficient_data', `reason=${fit.reason}`);
  check('8b. Refusal still explains itself', typeof fit.message === 'string' && fit.message.length > 40);
  const rows = lagCorrelations(periods(x, y).map((p) => ({ x: p.x, y: p.y })), 'gmv', 'revenue_per_day', 3);
  check('8c. Signed correlations are still available at small n', rows.some((r) => r.correlation != null));
}

// ── Test 9 — inverse metric ──────────────────────────────────────────
{
  const x = [100, 200, 300, 400, 500, 600, 700, 800];
  const rank = [20, 18, 15, 13, 10, 8, 6, 5];       // improving = falling
  const c = signedCorrelation(x, rank, 'gmv', 'keyword_search_rank');
  check('9. Inverse metric → raw correlation negative', c.rawCorrelation < -0.9, `raw=${c.rawCorrelation?.toFixed(3)}`);
  check('9b. Inverse metric → business-adjusted positive', c.businessAdjustedCorrelation > 0.9, `adj=${c.businessAdjustedCorrelation?.toFixed(3)}`);
  check('9c. Both values are retained, not one silently flipped', c.inverted === true && c.rawCorrelation !== c.businessAdjustedCorrelation);
}

// ── Test 10 — missing weeks are not zeros ────────────────────────────
{
  const x = [100, null, 300, 400, 500, 600, 700, 800, 900, 1000];
  const y = [1000, 1200, null, 1600, 1800, 2000, 2200, 2400, 2600, 2800];
  const rows = lagCorrelations(x.map((v, i) => ({ x: v, y: y[i] })), 'gmv', 'revenue_per_day', 0);
  check('10. Missing values are dropped, not zero-filled', rows[0].numberOfObservations === 8, `n=${rows[0].numberOfObservations}`);
  const withZeros = pearson(x.map((v) => v ?? 0), y.map((v) => v ?? 0));
  check('10b. Zero-filling would have changed the answer (so it matters)',
    Math.abs(withZeros - rows[0].rawCorrelation) > 0.01,
    `zero-filled=${withZeros.toFixed(4)} correct=${rows[0].rawCorrelation.toFixed(4)}`);
}

// ── Test 11 — constant metric ────────────────────────────────────────
{
  const x = [5, 5, 5, 5, 5, 5, 5, 5];
  const y = [1, 2, 3, 4, 5, 6, 7, 8];
  const c = signedCorrelation(x, y, 'gmv', 'revenue_per_day');
  check('11. Constant series → correlation unavailable', c.rawCorrelation === null, `raw=${c.rawCorrelation}`);
  check('11b. …with a stated reason', typeof c.reason === 'string' && /never changes/i.test(c.reason), c.reason);
}

// ── Extra: the brief's headline rule — no manufactured positives ─────
{
  const n = 70;
  const x = Array.from({ length: n }, (_, i) => 1000 + i * 10 + rnd() * 50);
  const y = x.map((v) => 8000 - 0.3 * v + rnd() * 60);      // genuinely negative
  const fit = fitDistributedLag(periods(x, y), { maxLag: 2, controls: { trend: false, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('12. A negative relationship survives the model (never floored)',
    fit.cumulativeCoefficient < 0, `cumulative=${fit.cumulativeCoefficient?.toFixed(3)}`);
}

// ── Extra: the §36 result CONTRACT ───────────────────────────────────
// Regression guard. The 11 brief tests all call the maths modules directly, so
// none of them ever built the result object the UI actually consumes. That gap
// shipped a crash: adjustedModel had no `warnings` key while the Layer B panel
// mapped over it, and because Layer B declines on thin data the bad line only
// ran once a brand finally had enough history. Assert every array the UI maps
// over really is an array — on BOTH the available and refused paths.
{
  const n = 80;
  const x = Array.from({ length: n }, (_, i) => 1200 + i * 8 + rnd() * 40);
  const y = x.map((v, i) => 5000 + 0.55 * v + i * 3 + rnd() * 80);

  const arrayFields = ['lagCoefficients', 'controls', 'controlsUnavailable', 'confidenceReasons', 'warnings'];

  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3 });
  check('13. Enough history → Layer B is available', full.adjustedModel.available === true,
    full.adjustedModel.message || '');
  for (const f of arrayFields) {
    check(`13.${f} is an array when the model is available`,
      Array.isArray(full.adjustedModel[f]), `typeof=${typeof full.adjustedModel[f]}`);
  }
  check('13. Layer A lagCorrelations is an array', Array.isArray(full.observed.lagCorrelations));
  check('13. Layer A warnings is an array', Array.isArray(full.observed.warnings));

  // Same contract must hold when the model REFUSES — the refusal path renders
  // a different branch today, but the shape should not depend on the verdict.
  const thin = analyseHalo(periods(x.slice(0, 10), y.slice(0, 10)), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3 });
  check('14. Thin data → Layer B refuses', thin.adjustedModel.available === false);
  for (const f of arrayFields) {
    check(`14.${f} is still an array when refused`,
      Array.isArray(thin.adjustedModel[f]), `typeof=${typeof thin.adjustedModel[f]}`);
  }
}

// ════════════════════════════════════════════════════════════════════
// Measurement-upgrade tests (lagged-only, capacity, graceful degradation)
// ════════════════════════════════════════════════════════════════════
const NO_CTL = { trend: false, seasonality: false };

// ── 15 — capacity accounting must not drift from the fit ─────────────
// The whole reason capacityOf exists is that the status panel and the grain
// recommender must agree with the model about what "usable" means. If these
// two ever disagree the UI promises an estimate the model then refuses.
{
  const n = 60;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((v) => 4000 + 0.4 * v + rnd() * 50);
  const p = periods(x, y);
  for (const L of [0, 1, 2, 3]) {
    const cap = capacityOf(p, { maxLag: L, controls: NO_CTL });
    const fit = fitDistributedLag(p, { maxLag: L, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
    check(`15.L${L} capacity usable === fit sampleSize`, cap.usable === fit.sampleSize,
      `capacity=${cap.usable} fit=${fit.sampleSize}`);
    check(`15.L${L} capacity parameterCount === fit parameterCount`, cap.parameterCount === fit.parameterCount,
      `capacity=${cap.parameterCount} fit=${fit.parameterCount}`);
    check(`15.L${L} capacity.ok agrees with fit.available`, cap.ok === fit.available,
      `capacity.ok=${cap.ok} available=${fit.available}`);
  }
}

// ── 16 — lagged-only EXCLUDES the same-period term ───────────────────
// The headline measurement fix. Known truth b0=0.20, b1=0.30, b2=0.15:
// cumulative must recover 0.65 and lagged-only must recover 0.45, NOT 0.65.
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const TRUE = { b0: 0.20, b1: 0.30, b2: 0.15 };
  const y = x.map((_, t) => 4000
    + TRUE.b0 * x[t]
    + (t >= 1 ? TRUE.b1 * x[t - 1] : 0)
    + (t >= 2 ? TRUE.b2 * x[t - 2] : 0)
    + (rnd() - 0.5) * 20);
  const fit = fitDistributedLag(periods(x, y), { maxLag: 2, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  const fullTruth = TRUE.b0 + TRUE.b1 + TRUE.b2;      // 0.65
  const laggedTruth = TRUE.b1 + TRUE.b2;              // 0.45

  check('16. full cumulative ≈ b0+b1+b2', near(fit.cumulativeCoefficient, fullTruth, 0.05),
    `cumulative=${fit.cumulativeCoefficient?.toFixed(4)} truth=${fullTruth}`);
  check('16b. lagged-only ≈ b1+b2 (same-period excluded)',
    near(fit.laggedOnly?.coefficient, laggedTruth, 0.05),
    `laggedOnly=${fit.laggedOnly?.coefficient?.toFixed(4)} truth=${laggedTruth}`);
  check('16c. lagged-only is STRICTLY smaller than full cumulative here',
    fit.laggedOnly.coefficient < fit.cumulativeCoefficient - 0.1,
    `lagged=${fit.laggedOnly.coefficient.toFixed(3)} full=${fit.cumulativeCoefficient.toFixed(3)}`);
  check('16d. same-period coefficient ≈ b0', near(fit.samePeriodCoefficient, TRUE.b0, 0.05),
    `b0=${fit.samePeriodCoefficient?.toFixed(4)}`);
  check('16e. same-period share ≈ b0 / total', near(fit.samePeriodShare, TRUE.b0 / fullTruth, 0.06),
    `share=${(fit.samePeriodShare * 100).toFixed(1)}% expected=${((TRUE.b0 / fullTruth) * 100).toFixed(1)}%`);
  check('16f. lagged-only interval is reported', fit.laggedOnly.lower != null && fit.laggedOnly.upper != null,
    `[${fit.laggedOnly.lower?.toFixed(3)}, ${fit.laggedOnly.upper?.toFixed(3)}]`);
}

// ── 17 — a PURE same-period relationship must expose itself ──────────
// This is the case the old UI hid: no delayed effect at all, yet the cumulative
// figure was published as "the halo". Share must be ~100% and lagged-only ~0
// with an interval spanning zero.
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((v) => 4000 + 0.5 * v + (rnd() - 0.5) * 30);   // same-period ONLY
  const fit = fitDistributedLag(periods(x, y), { maxLag: 2, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('17. pure same-period → share ≈ 100%', fit.samePeriodShare > 0.9,
    `share=${(fit.samePeriodShare * 100).toFixed(1)}%`);
  check('17b. pure same-period → lagged-only ≈ 0', Math.abs(fit.laggedOnly.coefficient) < 0.05,
    `laggedOnly=${fit.laggedOnly.coefficient.toFixed(4)}`);
  check('17c. pure same-period → lagged-only interval spans zero', fit.laggedOnly.spansZero === true,
    `[${fit.laggedOnly.lower?.toFixed(3)}, ${fit.laggedOnly.upper?.toFixed(3)}]`);
  check('17d. …and it warns that no delayed effect is established',
    fit.warnings.some((w) => w.code === 'lagged_only_spans_zero'));
  check('17e. …and that same-period dominates',
    fit.warnings.some((w) => w.code === 'same_period_dominant'));
}

// ── 18 — L=0 has no lagged-only quantity ─────────────────────────────
// Reporting zero would read as "measured no delayed effect" when we simply
// never looked for one.
{
  const n = 60;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((v) => 4000 + 0.4 * v + rnd() * 40);
  const fit = fitDistributedLag(periods(x, y), { maxLag: 0, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('18. maxLag 0 → laggedOnlyAvailable is false', fit.laggedOnlyAvailable === false);
  check('18b. maxLag 0 → laggedOnly is null, not 0', fit.laggedOnly === null, `laggedOnly=${JSON.stringify(fit.laggedOnly)}`);
  check('18c. maxLag 0 → same-period share is 100%', near(fit.samePeriodShare, 1, 1e-6),
    `share=${fit.samePeriodShare}`);
}

// ── 19 — mixed lag signs withhold the share rather than exceed 100% ──
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  // b0 strongly positive, b1 strongly negative → parts exceed the whole.
  const y = x.map((_, t) => 5000 + 0.9 * x[t] - (t >= 1 ? 0.6 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const fit = fitDistributedLag(periods(x, y), { maxLag: 1, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('19. opposing lag signs are detected', fit.mixedLagSigns === true,
    `b0=${fit.samePeriodCoefficient?.toFixed(3)} b1=${fit.lagCoefficients[1]?.coefficient?.toFixed(3)}`);
  check('19b. share is withheld rather than printed above 100%', fit.samePeriodShare === null,
    `share=${fit.samePeriodShare}`);
  check('19c. the negative lag is NOT floored away', fit.lagCoefficients[1].coefficient < -0.3,
    `b1=${fit.lagCoefficients[1].coefficient.toFixed(3)}`);
}

// ── 20 — graceful lag degradation at the knife-edge (§F) ─────────────
// n=21 with no controls: L=3 needs 20 and has 18; L=2 has 19; L=1 has 20 and
// needs 20 — so stepping down succeeds where the requested window fails.
// Reducing the window drops a parameter AND recovers a row, moving both sides.
{
  const n = 21;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((v) => 4000 + 0.4 * v + rnd() * 40);
  const p = periods(x, y);
  const best = bestFeasibleLag(p, { maxLag: 3, controls: NO_CTL });
  check('20. n=21 → requested 3 lags is reduced, not refused', best.lag === 1 && best.reduced === true,
    `lag=${best.lag} reduced=${best.reduced}`);
  check('20b. the reduced window actually fits',
    fitDistributedLag(p, { maxLag: best.lag, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' }).available === true);
  check('20c. the requested window genuinely did NOT fit',
    fitDistributedLag(p, { maxLag: 3, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' }).available === false);

  // And when even same-period cannot be supported, say so instead of pretending.
  const tiny = periods(x.slice(0, 19), y.slice(0, 19));
  const none = bestFeasibleLag(tiny, { maxLag: 3, controls: NO_CTL });
  check('20d. n=19 → no feasible lag at all', none.lag === null, `lag=${none.lag}`);
  check('20e. …and the shortfall is reported for the progress meter',
    none.capacity.shortfall > 0, `shortfall=${none.capacity.shortfall}`);
}

// ── 21 — the refusal must not say the same sentence twice ────────────
// The explorer renders a bold headline followed by `message`; the message used
// to open with the identical sentence, so users saw it duplicated.
{
  const x = Array.from({ length: 10 }, () => 1000 + rnd() * 500);
  const y = Array.from({ length: 10 }, () => 4000 + rnd() * 500);
  const fit = fitDistributedLag(periods(x, y), { maxLag: 3, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('21. refusal exposes a separate headline', typeof fit.headline === 'string' && fit.headline.length > 10, fit.headline);
  check('21b. message does NOT repeat the headline',
    !fit.message.includes(fit.headline), fit.message.slice(0, 60) + '…');
  check('21c. message still states the arithmetic', /usable period/.test(fit.message) && /needs about/.test(fit.message));
  check('21d. requiredObservations is exposed on the refusal', typeof fit.requiredObservations === 'number' && fit.requiredObservations >= 20,
    `required=${fit.requiredObservations}`);
}

// ── 22 — controls honesty: seasonality must not be claimed falsely ───
// The explorer printed "adjusted for trend and seasonality" whenever promo and
// stock-out were absent, regardless of whether seasonality was estimable.
{
  const short = 40, long = 120;   // 40 sits BELOW the ~52-period seasonality gate
  const mk = (n) => {
    const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
    return periods(x, x.map((v) => 4000 + 0.4 * v + rnd() * 40));
  };
  const below = fitDistributedLag(mk(short), { maxLag: 1, controls: { trend: true, seasonality: true }, xKey: 'gmv', yKey: 'revenue_per_day' });
  const above = fitDistributedLag(mk(long), { maxLag: 1, controls: { trend: true, seasonality: true }, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('22. below ~52 periods → seasonality NOT included', below.seasonalityIncluded === false,
    `included=${below.seasonalityIncluded}`);
  check('22b. …and it says why', typeof below.seasonalityReason === 'string' && /52/.test(below.seasonalityReason),
    below.seasonalityReason);
  check('22c. …and it is not in the included list', !below.controls.some((c) => /season/i.test(c)),
    below.controls.join(', '));
  check('22d. above ~52 periods → seasonality IS included', above.seasonalityIncluded === true);
  check('22e. …and appears in the included list', above.controls.some((c) => /season/i.test(c)),
    above.controls.join(', '));
}

// ── 23 — a flat control is dropped AND stops being advertised ────────
// The removal looked a column's `name` up in a list of LABELS, so it never
// matched: a promotions column that never varied was dropped from the
// regression and still rendered as an included control.
{
  const n = 80;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((v) => 4000 + 0.4 * v + rnd() * 40);
  const flat = Array.from({ length: n }, () => ({ promo: 1 }));   // constant
  const fit = fitDistributedLag(periods(x, y, flat), { maxLag: 1, controls: { trend: true, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('23. a constant control is NOT listed as included', !fit.controls.includes('Promotions'),
    fit.controls.join(', '));
  check('23b. …it is listed as unavailable, with the reason',
    fit.controlsUnavailable.some((u) => /Promotions/.test(u) && /no variation/.test(u)),
    fit.controlsUnavailable.join(' | '));
  check('23c. …and it still counts as a MISSING major control',
    fit.controlsMissingMajor.some((m) => m.name === 'promo'),
    JSON.stringify(fit.controlsMissingMajor.map((m) => m.name)));
}

// ── 24 — a registered control is used without being opted in (§E5) ───
{
  const n = 80;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const ads = Array.from({ length: n }, () => ({ amazon_ads_spend: 200 + rnd() * 400 }));
  const y = x.map((v, i) => 4000 + 0.4 * v + 1.5 * ads[i].amazon_ads_spend + rnd() * 30);
  // NOTE: amazon_ads_spend is never mentioned in the options.
  const fit = fitDistributedLag(periods(x, y, ads), { maxLag: 1, controls: { trend: true, seasonality: false }, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('24. a registered control present in the sheet is auto-included',
    fit.controls.includes('Amazon Ads spend'), fit.controls.join(', '));
  check('24b. …and no longer counts as missing',
    !fit.controlsMissingMajor.some((m) => m.name === 'amazon_ads_spend'));
  check('24c. an explicit false still switches it off',
    !fitDistributedLag(periods(x, y, ads), { maxLag: 1, controls: { trend: true, seasonality: false, amazon_ads_spend: false }, xKey: 'gmv', yKey: 'revenue_per_day' })
      .controls.includes('Amazon Ads spend'));
}

// ── 25 — confidence ceiling: missing confounders cap at Moderate ─────
// A long history with a tight interval and nothing controlled for but a time
// trend would otherwise score "Strong Evidence" — which is exactly the shape a
// promotion calendar both series respond to produces.
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.20 * x[t] + (t >= 1 ? 0.30 * x[t - 1] : 0) + (t >= 2 ? 0.15 * x[t - 2] : 0) + (rnd() - 0.5) * 20);
  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 2, controls: { trend: true, seasonality: false } });
  const m = full.adjustedModel;
  check('25. the score alone would have said Strong Evidence', m.confidenceEarned === 'Strong Evidence',
    `earned=${m.confidenceEarned}`);
  check('25b. …but it is capped at Moderate Confidence', m.confidenceLabel === 'Moderate Confidence',
    `label=${m.confidenceLabel} ceiling=${m.confidenceCeiling}`);
  check('25c. …and the cap explains itself', m.confidenceCappedBy.length > 0 && /not in the model/.test(m.confidenceCappedBy[0]),
    m.confidenceCappedBy[0]);
  check('25d. a ceiling never RAISES a label',
    analyseHalo(periods(x.slice(0, 30), y.slice(0, 30)), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: { trend: true, seasonality: false } })
      .adjustedModel.confidenceLabel !== 'Strong Evidence');
}

// ── 26 — confidence ceiling: an unsigned delay caps at Directional ───
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((v) => 4000 + 0.5 * v + (rnd() - 0.5) * 30);   // same-period ONLY
  const m = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 2, controls: { trend: true, seasonality: false } }).adjustedModel;
  check('26. lagged-only spanning zero caps confidence at Directional',
    m.confidenceCeiling === 'Directional' && m.confidenceLabel === 'Directional',
    `ceiling=${m.confidenceCeiling} label=${m.confidenceLabel}`);
  check('26b. …and the stricter of two ceilings wins',
    m.confidenceCappedBy.some((r) => /lagged-only interval includes zero/.test(r)),
    m.confidenceCappedBy.join(' | '));
}

// ── 27 — Stage 5: the contribution interval is exact, not invented ───
// amount (sum of per-period differences) and totalFromContrast (the same
// quantity as a linear combination of the lag betas) are algebraically
// identical. If they diverge, the design and the contrast weights have fallen
// out of step — which is exactly the bug an invented band would have hidden.
{
  const n = 100;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.20 * x[t] + (t >= 1 ? 0.30 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const model = fitDistributedLag(periods(x, y), { maxLag: 1, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  const c = historicalContribution(model, { method: 'period_median' });

  check('27. contribution is available', c != null && Number.isFinite(c.amount), `amount=${c?.amount?.toFixed(2)}`);
  check('27b. the two derivations of the total agree',
    near(c.amount, c.totalFromContrast, Math.max(1e-6, Math.abs(c.amount) * 1e-9)),
    `sum=${c.amount?.toFixed(6)} contrast=${c.totalFromContrast?.toFixed(6)}`);
  check('27c. the total carries a real interval', c.lower != null && c.upper != null && c.lower < c.upper,
    `[${c.lower?.toFixed(0)}, ${c.upper?.toFixed(0)}]`);
  check('27d. per-period rows carry both predicted series for the chart',
    c.perPeriod.every((p) => Number.isFinite(p.predictedActual) && Number.isFinite(p.predictedBaseline)));
  check('27e. per-period contribution is exactly the difference of the two series',
    c.perPeriod.every((p) => near(p.contribution, p.predictedActual - p.predictedBaseline, 1e-9)));
  check('27f. per-period rows carry their own interval for the band',
    c.perPeriod.every((p) => p.lower != null && p.upper != null));

  // Negative periods must survive (§9): below-reference periods pull down.
  check('27g. below-reference periods contribute negatively',
    c.perPeriod.some((p) => p.contribution < 0) && c.negativeAmount < 0,
    `negative=${c.negativeAmount?.toFixed(0)}`);
}

// ── 28 — the low-activity baseline rule, and its documented fallback ─
{
  // Deliberately skewed: a long quiet stretch then a spike, so the quartile
  // median and the window median are meaningfully different.
  const quiet = Array.from({ length: 60 }, () => 100 + rnd() * 20);
  const loud  = Array.from({ length: 40 }, () => 900 + rnd() * 200);
  const xs = [...quiet, ...loud];

  const low = resolveReference(xs, 'low_activity');
  const med = resolveReference(xs, 'period_median');
  const avg = resolveReference(xs, 'period_average');
  check('28. low-activity baseline sits below the window median',
    low.value < med.value, `low=${low.value?.toFixed(1)} median=${med.value?.toFixed(1)}`);
  check('28b. low-activity baseline comes from the quiet stretch',
    low.value >= 100 && low.value <= 130, `low=${low.value?.toFixed(1)}`);
  check('28c. it did not fall back', low.fellBack === false && low.method === 'low_activity');
  check('28d. the average is dragged up by the spike', avg.value > med.value,
    `avg=${avg.value?.toFixed(1)} median=${med.value?.toFixed(1)}`);

  // Too few points for a quartile → documented fallback, not a silent one.
  const tiny = resolveReference([10, 20, 30, 40, 50], 'low_activity');
  check('28e. below the minimum it falls back to the window median',
    tiny.method === 'period_median' && tiny.fellBack === true, `method=${tiny.method}`);
  check('28f. …and says so', typeof tiny.note === 'string' && /at least 8 periods/.test(tiny.note), tiny.note);

  // A custom method with no value must not silently become zero.
  const noCustom = resolveReference(xs, 'custom', null);
  check('28g. custom with no value falls back rather than using zero',
    noCustom.fellBack === true && noCustom.value > 0, `value=${noCustom.value}`);
}

// ── 29 — reference sensitivity is surfaced, not buried ───────────────
{
  const n = 100;
  // Skewed activity so median and average genuinely disagree.
  const x = Array.from({ length: n }, (_, i) => (i % 10 === 0 ? 4000 + rnd() * 500 : 300 + rnd() * 80));
  const y = x.map((v) => 5000 + 0.5 * v + (rnd() - 0.5) * 40);
  const model = fitDistributedLag(periods(x, y), { maxLag: 1, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  const s = referenceSensitivity(model);
  check('29. sensitivity reports every non-custom rule', s != null && s.entries.length === 3,
    `entries=${s?.entries?.length}`);
  check('29b. the rules produce different totals on skewed activity',
    new Set(s.entries.map((e) => Math.round(e.amount))).size > 1,
    s.entries.map((e) => `${e.method}=${Math.round(e.amount)}`).join(' '));
  check('29c. a material spread is flagged with a message',
    !s.sensitive || (typeof s.message === 'string' && s.message.length > 20),
    `sensitive=${s.sensitive} spread=${(s.spread * 100).toFixed(0)}%`);

  // A flat, well-behaved series should NOT be flagged as sensitive.
  const fx = Array.from({ length: n }, () => 1000 + rnd() * 60);
  const fy = fx.map((v) => 4000 + 0.4 * v + rnd() * 20);
  const flatModel = fitDistributedLag(periods(fx, fy), { maxLag: 1, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  const fs = referenceSensitivity(flatModel);
  check('29d. an unskewed series is not falsely flagged as sensitive',
    fs != null && fs.signFlip === false, `signFlip=${fs?.signFlip} spread=${(fs?.spread * 100).toFixed(0)}%`);
}

// ── 30 — the what-if leads on the DELAYED basis, and says which ──────
// "Spend more on TikTok, get more on Amazon" is a halo claim, so it must not be
// answered with a coefficient that includes same-period co-movement.
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.60 * x[t] + (t >= 1 ? 0.10 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const model = fitDistributedLag(periods(x, y), { maxLag: 1, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });

  const lagged = marginalScenario(model, 1400, { type: 'percent', value: 10 });
  const cumul  = marginalScenario(model, 1400, { type: 'percent', value: 10 }, { basis: 'cumulative' });
  check('30. the what-if defaults to the lagged-only basis', lagged.basis === 'lagged_only', `basis=${lagged.basis}`);
  check('30b. …and names the basis it used', /lagged-only/.test(lagged.basisLabel), lagged.basisLabel);
  check('30c. same-period-heavy data → the lagged answer is much smaller',
    Math.abs(lagged.estimated) < Math.abs(cumul.estimated) * 0.5,
    `lagged=${lagged.estimated.toFixed(0)} cumulative=${cumul.estimated.toFixed(0)}`);

  // With no lags there IS no delayed basis — it must fall back and say so.
  const same = fitDistributedLag(periods(x, y), { maxLag: 0, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  const fallback = marginalScenario(same, 1400, { type: 'percent', value: 10 });
  check('30d. with no lags it falls back to cumulative and labels it',
    fallback.basis === 'cumulative' && /same-period included/.test(fallback.basisLabel), fallback.basisLabel);
}

// ── 31 — analyseHalo picks the recommended reference by default ──────
{
  const n = 100;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.2 * x[t] + (t >= 1 ? 0.3 * x[t - 1] : 0) + rnd() * 20);
  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  check('31. the recommended reference is the low-activity baseline at this n',
    full.recommendedReference === 'low_activity', `recommended=${full.recommendedReference}`);
  check('31b. …and the contribution actually used it',
    full.historicalContribution.referenceMethod === 'low_activity',
    `used=${full.historicalContribution.referenceMethod}`);
  check('31c. an explicit reference still overrides it',
    analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL, reference: { method: 'period_average' } })
      .historicalContribution.referenceMethod === 'period_average');
  check('31d. sensitivity is exposed on the result', full.referenceSensitivity != null);
}

// ── 32 — planning: all three scenarios come from the interval ────────
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  // A real DELAYED effect, so the lagged-only interval excludes zero.
  const y = x.map((_, t) => 4000 + 0.10 * x[t] + (t >= 1 ? 0.35 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const model = fitDistributedLag(periods(x, y), { maxLag: 1, controls: NO_CTL, xKey: 'gmv', yKey: 'revenue_per_day' });
  // Confidence has to be computed for the floor gate to be meaningful.
  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  // The confidence label is computed alongside the model, not on it — attach it
  // so the floor gate has something to read (see test 38 for the explicit path).
  const m = { ...full.adjustedModel._model, confidenceLabel: full.adjustedModel.confidenceLabel };

  const el = planningEligibility(m, { xIsMonetary: true, yIsMonetary: true });
  check('32. a fitted, signed, monetary model is eligible', el.eligible === true,
    el.blockers.map((b) => b.code).join(',') || 'no blockers');
  check('32b. …on the lagged-only basis', el.basis === 'lagged_only', `basis=${el.basis}`);

  const d = modelDerivedAssumptions(m, { xIsMonetary: true, yIsMonetary: true, grainLabel: 'Daily', rangeLabel: '2026-01-01 to 2026-05-20' });
  check('32c. all three scenarios are derived', d.usable === true
    && Number.isFinite(d.assumptions.conservative)
    && Number.isFinite(d.assumptions.base)
    && Number.isFinite(d.assumptions.upside),
    JSON.stringify(d.assumptions));
  check('32d. Conservative < Base < Upside', d.assumptions.conservative < d.assumptions.base
    && d.assumptions.base < d.assumptions.upside,
    `${d.assumptions.conservative} / ${d.assumptions.base} / ${d.assumptions.upside}`);
  check('32e. Base is the point estimate, not a round number',
    near(d.assumptions.base, m.laggedOnly.coefficient * 100, 0.2),
    `base=${d.assumptions.base} point=${(m.laggedOnly.coefficient * 100).toFixed(1)}`);
  check('32f. Conservative is the lower bound', near(d.assumptions.conservative, m.laggedOnly.lower * 100, 0.2),
    `cons=${d.assumptions.conservative} lower=${(m.laggedOnly.lower * 100).toFixed(1)}`);
  check('32g. Upside is the upper bound', near(d.assumptions.upside, m.laggedOnly.upper * 100, 0.2),
    `up=${d.assumptions.upside} upper=${(m.laggedOnly.upper * 100).toFixed(1)}`);
  check('32h. the scenarios are NOT the 50/100/150 placeholders',
    !(d.assumptions.conservative === 50 && d.assumptions.base === 100 && d.assumptions.upside === 150));
  check('32i. the source names the basis, grain and range',
    /lagged-only/.test(d.source) && /Daily/.test(d.source) && /2026/.test(d.source), d.source);
}

// ── 33 — THE regression the brief calls out by name ──────────────────
// "If full cumulative is 167% but lagged-only is much lower, never push 167%
// into Base by default." Same-period-heavy data: the old one-click button would
// have put the full cumulative into Base.
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 1.30 * x[t] + (t >= 1 ? 0.30 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  // The confidence label is computed alongside the model, not on it — attach it
  // so the floor gate has something to read (see test 38 for the explicit path).
  const m = { ...full.adjustedModel._model, confidenceLabel: full.adjustedModel.confidenceLabel };
  const d = modelDerivedAssumptions(m, { xIsMonetary: true, yIsMonetary: true });

  const fullPct = m.cumulativeCoefficient * 100;      // ≈ 160
  const laggedPct = m.laggedOnly.coefficient * 100;   // ≈ 30
  check('33. the full cumulative really is much larger here', fullPct > laggedPct * 2,
    `full=${fullPct.toFixed(0)}% lagged=${laggedPct.toFixed(0)}%`);
  check('33b. Base is the LAGGED figure, not the full cumulative',
    d.usable && Math.abs(d.assumptions.base - laggedPct) < 2 && Math.abs(d.assumptions.base - fullPct) > 50,
    `base=${d.assumptions.base}% (lagged=${laggedPct.toFixed(0)}%, full=${fullPct.toFixed(0)}%)`);
}

// ── 34 — every gate refuses, and says why + how to fix it ────────────
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);

  // (a) interval spans zero → not eligible.
  const noise = analyseHalo(periods(x, x.map(() => 5000 + rnd() * 400)),
    { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  const elNoise = planningEligibility(noise.adjustedModel._model, { xIsMonetary: true, yIsMonetary: true });
  check('34. an interval spanning zero blocks planning', elNoise.eligible === false
    && elNoise.blockers.some((b) => b.code === 'ci_spans_zero'),
    elNoise.blockers.map((b) => b.code).join(','));

  // (b) non-monetary metrics → a "halo %" would be dollars per view.
  const y = x.map((_, t) => 4000 + 0.1 * x[t] + (t >= 1 ? 0.35 * x[t - 1] : 0) + rnd() * 20);
  const good = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  const elUnit = planningEligibility(good.adjustedModel._model, { xIsMonetary: false, yIsMonetary: true });
  check('34b. non-monetary metrics block planning', elUnit.eligible === false
    && elUnit.blockers.some((b) => b.code === 'not_monetary'));

  // (c) no model at all.
  const thin = analyseHalo(periods(x.slice(0, 10), y.slice(0, 10)), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3 });
  const elThin = planningEligibility(thin.adjustedModel._model, { xIsMonetary: true, yIsMonetary: true });
  check('34c. no model blocks planning', elThin.eligible === false
    && elThin.blockers.some((b) => b.code === 'no_model'));

  // Every blocker must be actionable, not just a refusal.
  const allBlockers = [...elNoise.blockers, ...elUnit.blockers, ...elThin.blockers];
  check('34d. every blocker carries a message AND a fix',
    allBlockers.every((b) => typeof b.message === 'string' && b.message.length > 25
      && typeof b.fix === 'string' && b.fix.length > 10),
    `${allBlockers.length} blockers checked`);

  // And an ineligible model must NOT hand back usable scenarios.
  check('34e. an ineligible model yields no derived scenarios',
    modelDerivedAssumptions(elNoise.eligible ? null : noise.adjustedModel._model, { xIsMonetary: true, yIsMonetary: true }).usable === false);
}

// ── 35 — a same-period-only window is allowed but badged weak ────────
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((v) => 4000 + 0.55 * v + (rnd() - 0.5) * 20);
  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 0, controls: NO_CTL });
  // The confidence label is computed alongside the model, not on it — attach it
  // so the floor gate has something to read (see test 38 for the explicit path).
  const m = { ...full.adjustedModel._model, confidenceLabel: full.adjustedModel.confidenceLabel };
  const el = planningEligibility(m, { xIsMonetary: true, yIsMonetary: true });
  check('35. max lag 0 → basis is same-period', el.basis === 'cumulative' && el.basisLabel === 'same-period');
  check('35b. …and it is flagged as a weak halo claim', el.weakHaloClaim === true);
  const d = modelDerivedAssumptions(m, { xIsMonetary: true, yIsMonetary: true });
  check('35c. …scenarios are still derivable', d.usable === true, JSON.stringify(d.assumptions || {}));
  check('35d. …and the note says it is a weak halo claim', /weak halo claim/.test(d.note || ''), d.note);
}

// ── 36 — planningModel labels the mode honestly ──────────────────────
{
  const modelled = planningModel({ ttsRevenue: 100000, marketingSpend: 30000, assumptions: { conservative: 12, base: 34, upside: 56 }, mode: 'model', source: 'From adjusted model · lagged-only · Daily' });
  check('36. model mode carries its source', modelled.mode === 'model' && /adjusted model/.test(modelled.source));
  check('36b. …and still disclaims that it is not incremental', /not incremental/i.test(modelled.disclaimer), modelled.disclaimer);
  check('36c. arithmetic is unchanged: 34% of 100k is 34k off-platform',
    near(modelled.base.offPlatformRevenue, 34000, 1), `off=${modelled.base.offPlatformRevenue}`);
  check('36d. blended multiple uses total influenced revenue',
    near(modelled.base.blendedMultiple, 134000 / 30000, 1e-9), `blended=${modelled.base.blendedMultiple}`);

  const override = planningModel({ ttsRevenue: 100000, marketingSpend: 30000, assumptions: { conservative: 10, base: 20, upside: 30 }, mode: 'override' });
  check('36e. an override never claims to be from the model',
    override.source === null && !/adjusted model/.test(override.disclaimer), override.disclaimer);

  const assumed = planningModel({ ttsRevenue: 100000, marketingSpend: 30000 });
  check('36f. assumptions mode uses the placeholders and says so',
    assumed.base.haloPercent === 100 && /not measured results/.test(assumed.disclaimer));
}

// ── 37 — the confidence floor gates auto-apply ───────────────────────
{
  check('37. Moderate meets the floor', atLeastConfidence('Moderate Confidence', PLANNING_CONFIDENCE_FLOOR) === true);
  check('37b. Strong meets the floor', atLeastConfidence('Strong Evidence', PLANNING_CONFIDENCE_FLOOR) === true);
  check('37c. Directional does NOT', atLeastConfidence('Directional', PLANNING_CONFIDENCE_FLOOR) === false);
  check('37d. Low does NOT', atLeastConfidence('Low Confidence', PLANNING_CONFIDENCE_FLOOR) === false);
  check('37e. an unknown label fails closed', atLeastConfidence('Excellent', PLANNING_CONFIDENCE_FLOOR) === false);
}

// ── 38 — the confidence label must be passed, and fail closed ────────
// Regression guard. planningEligibility read `model.confidenceLabel`, which the
// raw fit object never carries (confidence is computed from the model PLUS the
// lag correlations PLUS the control lists). Because the floor check fails
// closed, that silently refused planning for every model ever fitted — the
// feature would have shipped permanently stuck in assumptions mode.
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.10 * x[t] + (t >= 1 ? 0.35 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const full = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  const raw = full.adjustedModel._model;          // deliberately WITHOUT the label

  const explicit = planningEligibility(raw, {
    xIsMonetary: true, yIsMonetary: true, confidenceLabel: full.adjustedModel.confidenceLabel,
  });
  check('38. passing the confidence label explicitly makes the model eligible',
    explicit.eligible === true, explicit.blockers.map((b) => b.code).join(',') || 'none');

  const missing = planningEligibility(raw, { xIsMonetary: true, yIsMonetary: true });
  check('38b. a missing label fails CLOSED, not open',
    missing.eligible === false && missing.blockers.some((b) => b.code === 'low_confidence'),
    missing.blockers.map((b) => b.code).join(','));

  // And the wiring in analyseHalo must actually pass it.
  check('38c. analyseHalo wires the label through to eligibility',
    full.planningEligibility.eligible === true,
    full.planningEligibility.blockers.map((b) => b.code).join(',') || 'none');
  check('38d. analyseHalo exposes usable derived scenarios',
    full.planningDerived.usable === true, JSON.stringify(full.planningDerived.assumptions || {}));
  check('38e. …and defaults planning to model mode, not assumptions',
    full.planning.mode === 'model', `mode=${full.planning.mode}`);
}

// ── 39 — the grain ladder: Daily gets discovered ─────────────────────
// The pain point by name: ~5 weeks of history blanks the weekly view while the
// SAME date range at daily grain carries a working model, and nothing told the
// user. 35 days is 5 weeks.
{
  const days = 35;
  const dx = Array.from({ length: days }, () => 1000 + rnd() * 500);
  const dy = dx.map((_, t) => 4000 + 0.2 * dx[t] + (t >= 1 ? 0.3 * dx[t - 1] : 0) + rnd() * 30);
  const dailyPeriods = periods(dx, dy);
  // The same span bucketed weekly: 5 periods.
  const weeklyPeriods = periods(dx.slice(0, 5), dy.slice(0, 5));

  const assessments = {
    day: assessGrain('day', dailyPeriods, { maxLag: 3, controls: NO_CTL }),
    week: assessGrain('week', weeklyPeriods, { maxLag: 3, controls: NO_CTL }),
  };
  check('39. weekly cannot model 5 periods', assessments.week.canModel === false,
    `usable=${assessments.week.usable} required=${assessments.week.required}`);
  check('39b. daily CAN model the same span', assessments.day.canModel === true,
    `usable=${assessments.day.usable} feasibleLag=${assessments.day.feasibleLag}`);

  const rec = recommendGrain(assessments);
  check('39c. the recommendation is Daily, not a hardcoded Weekly', rec.grain === 'day', `grain=${rec.grain}`);
  check('39d. it is not guided mode — a model IS available', rec.guided === false);
  check('39e. the reason names both grains and the date range', /Weekly/.test(rec.reason) && /Daily/.test(rec.reason), rec.reason);

  const sug = grainSwitchSuggestion('week', assessments, rec);
  check('39f. a concrete switch CTA is offered', sug != null && /Switch to Daily/.test(sug.cta), sug?.cta);
  check('39g. …and it is silent when already on the recommendation',
    grainSwitchSuggestion('day', assessments, rec) === null);
}

// ── 40 — weekly wins outright when it can carry the full window ──────
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((_, t) => 4000 + 0.2 * x[t] + (t >= 1 ? 0.3 * x[t - 1] : 0) + rnd() * 30);
  const p = periods(x, y);
  const assessments = {
    day: assessGrain('day', p, { maxLag: 3, controls: NO_CTL }),
    week: assessGrain('week', p, { maxLag: 3, controls: NO_CTL }),
  };
  const rec = recommendGrain(assessments);
  check('40. weekly is recommended when it supports the requested window',
    rec.grain === 'week' && rec.guided === false, `grain=${rec.grain}`);
  check('40b. …and says so', /natural frequency/.test(rec.reason), rec.reason);
}

// ── 41 — guided mode when NO grain can model ─────────────────────────
{
  const tiny = periods([100, 200, 300, 400, 500, 600], [1, 2, 3, 4, 5, 6]);
  const assessments = { week: assessGrain('week', tiny, { maxLag: 3, controls: NO_CTL }) };
  const rec = recommendGrain(assessments);
  check('41. no modellable grain → guided mode', rec.guided === true);
  check('41b. …but a grain is still recommended for the charts', rec.grain === 'week');
  check('41c. …and correlations are acknowledged as still meaningful',
    /correlations are still meaningful/.test(rec.reason), rec.reason);
  check('41d. correlations ARE computable at n=6', assessments.week.canCorrelate === true,
    `obs=${assessments.week.correlationObs} need=${assessments.week.correlationRequired}`);
  check('41e. no grains at all → guided with a null grain',
    recommendGrain({}).guided === true && recommendGrain({}).grain === null);
}

// ── 42 — "almost there" fires near the threshold, not far from it ─────
{
  const mk = (n) => {
    const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
    return periods(x, x.map((v) => 4000 + 0.4 * v + rnd() * 30));
  };
  // maxLag 3, no controls → 5 params, required 20, usable = n-3.
  const edge = assessGrain('week', mk(22), { maxLag: 3, controls: NO_CTL });   // usable 19 of 20
  const far  = assessGrain('week', mk(8),  { maxLag: 3, controls: NO_CTL });   // usable 5 of 20
  check('42. 19 of 20 is "almost there"', edge.almostThere === true,
    `usable=${edge.usable} required=${edge.required}`);
  check('42b. 5 of 20 is not', far.almostThere === false,
    `usable=${far.usable} required=${far.required}`);
  check('42c. the shortfall is exposed for a progress meter',
    edge.shortfall === 1 && far.shortfall === 15, `edge=${edge.shortfall} far=${far.shortfall}`);
  check('42d. the knife-edge case still offers a reduced window',
    edge.canModel === true && edge.lagReduced === true && edge.feasibleLag < 3,
    `feasibleLag=${edge.feasibleLag} reduced=${edge.lagReduced}`);
}

// ── 43 — the stage ladder reports position, not just failure ─────────
{
  const n = 140;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.1 * x[t] + (t >= 1 ? 0.35 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const healthy = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, controls: NO_CTL });
  const st = stageStatuses(healthy, { periodsWithData: n });
  const byKey = Object.fromEntries(st.map((s) => [s.key, s]));

  check('43. six stages are reported', st.length === 6);
  check('43b. descriptive is done', byKey.descriptive.status === 'done');
  check('43c. correlations are done', byKey.correlations.status === 'done');
  check('43d. regression is done', byKey.regression.status === 'done');
  check('43e. distributed lag is done with a real lag window', byKey.distributedLag.status === 'done');
  check('43f. counterfactual is done', byKey.counterfactual.status === 'done', byKey.counterfactual.detail);
  check('43g. validation is "coming later", never a failure',
    byKey.validation.status === 'later' && /not part of this tool/i.test(byKey.validation.detail));
  check('43h. …and validation is why nothing is called incremental',
    /incremental/i.test(byKey.validation.detail));
  check('43i. progress excludes the out-of-scope stage',
    stageProgress(st).total === 5 && stageProgress(st).done === 5, JSON.stringify(stageProgress(st)));

  // Thin data: Stage 1 must still be DONE, so the page reads as progress.
  const thin = analyseHalo(periods(x.slice(0, 8), y.slice(0, 8)), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3 });
  const thinSt = Object.fromEntries(stageStatuses(thin, { periodsWithData: 8 }).map((s) => [s.key, s]));
  check('43j. thin data still completes Stage 1', thinSt.descriptive.status === 'done');
  check('43k. …regression needs data, and explains what is missing',
    thinSt.regression.status === 'needs_data' && /usable period/.test(thinSt.regression.detail),
    thinSt.regression.detail);
  check('43l. …and the later stages say "needs the model first" rather than failing',
    /needs the adjusted model/i.test(thinSt.counterfactual.detail), thinSt.counterfactual.detail);

  // A same-period-only model has NOT completed the distributed-lag stage.
  const samePeriod = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 0, controls: NO_CTL });
  const spSt = Object.fromEntries(stageStatuses(samePeriod, { periodsWithData: n }).map((s) => [s.key, s]));
  check('43m. a lag-0 model marks distributed lag as only in progress',
    spSt.distributedLag.status === 'partial', `status=${spSt.distributedLag.status}`);
  check('43n. …and says no delayed effect was looked for',
    /no delayed effect has been looked for/.test(spSt.distributedLag.detail), spSt.distributedLag.detail);
}

console.log('\nHalo V2 — brief §33 test suite\n');
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
