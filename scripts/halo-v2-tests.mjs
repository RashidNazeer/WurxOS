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

import { register } from 'node:module';
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
import { atLeastConfidence, historyPhrase } from '../src/lib/haloV2/confidence.js';
import {
  assessGrain, recommendGrain, grainSwitchSuggestion,
} from '../src/lib/haloV2/grainRecommendation.js';
import { stageStatuses, stageProgress } from '../src/lib/haloV2/stages.js';
import {
  plainMetricLabel, comparisonSentence, formatMetricValue, keyTakeaway, coverageNote,
  GLOSSARY, glossaryFor,
} from '../src/lib/haloV2/plainLanguage.js';
import { buildHaloV2Csv, haloV2CsvFilename } from '../src/lib/haloV2/exportCsv.js';
import { HALO_FIELDS } from '../src/lib/haloFields.js';
import { fillFromDaily } from '../src/lib/haloV2/dailyFill.js';

// dataAdapter reaches V1's haloMath, whose imports are extensionless (Vite
// resolves them). Resolve them the same way here so the adapter can be tested
// end to end; static imports are hoisted, so the adapter loads afterwards.
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (e) { if (spec.startsWith('.') && !/\\.m?js$/.test(spec)) return next(spec + '.js', ctx); throw e; }
}`));
const { buildPeriods } = await import('../src/lib/haloV2/dataAdapter.js');

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
  check('43g. validation is a future stage, never a failure',
    byKey.validation.status === 'later' && /not part of this tool/i.test(byKey.validation.detail));
  check('43g2. …and its label does not imply it is queued or nearly done',
    !/coming/i.test(byKey.validation.statusLabel) && /needs a controlled test/i.test(byKey.validation.statusLabel),
    byKey.validation.statusLabel);
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

// ════════════════════════════════════════════════════════════════════
// QA SCENARIOS — the brief's acceptance checklist, end to end.
//
// Tests 1-43 check units. These walk the three data shapes the checklist names
// and assert the UI-VISIBLE outcome for each line of it, so there is one place
// that maps the checklist to evidence.
// ════════════════════════════════════════════════════════════════════

// ── QA-A — thin data (Apothecary-like: ~5 weeks, Weekly) ─────────────
{
  const weeks = 5;
  const wx = Array.from({ length: weeks }, () => 7000 + rnd() * 2000);
  const wy = wx.map((v) => 30000 + 0.4 * v + rnd() * 800);
  const weekly = periods(wx, wy);

  // The same span at daily grain.
  const days = 35;
  const dx = Array.from({ length: days }, () => 1000 + rnd() * 500);
  const dy = dx.map((_, t) => 4000 + 0.15 * dx[t] + (t >= 1 ? 0.30 * dx[t - 1] : 0) + rnd() * 40);
  const daily = periods(dx, dy);

  const assess = {
    week: assessGrain('week', weekly, { maxLag: 3, controls: NO_CTL }),
    day: assessGrain('day', daily, { maxLag: 3, controls: NO_CTL }),
  };
  const rec = recommendGrain(assess);
  const res = analyseHalo(weekly, { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3, controls: NO_CTL });
  const st = Object.fromEntries(stageStatuses(res, { periodsWithData: weeks }).map((s) => [s.key, s]));

  // "Page does not look broken (no wall of em dashes)."
  // With 5 periods and a 3-lag window every correlation is uncomputable, which
  // is EXACTLY when the UI must collapse to one explanatory row instead of
  // rendering four blank cards. Assert the collapse condition holds.
  const anyCorrelation = res.observed.lagCorrelations.some((r) => r.correlation != null);
  check('QA-A1. thin weekly → the collapsed correlation row is what renders',
    anyCorrelation === false, `anyCorrelation=${anyCorrelation}`);
  check('QA-A2. …and every card would have had a stated reason, not a bare dash',
    res.observed.lagCorrelations.every((r) => typeof r.reason === 'string' && r.reason.length > 20));

  // "Status panel explains n vs required."
  check('QA-A3. the shortfall is quantified for the status panel',
    assess.week.usable < assess.week.required && assess.week.shortfall > 0,
    `usable=${assess.week.usable} required=${assess.week.required} short=${assess.week.shortfall}`);

  // "One-click switch to Daily (or auto-recommend)."
  check('QA-A4. Daily is auto-recommended', rec.grain === 'day' && rec.guided === false);
  const sug = grainSwitchSuggestion('week', assess, rec);
  check('QA-A5. …and a one-click switch is offered', sug != null && /Switch to Daily/.test(sug.cta));

  // "Descriptive charts still useful." / "Stage stepper shows 2-5 needs data, Stage 1 done."
  check('QA-A6. Stage 1 is DONE on thin data', st.descriptive.status === 'done');
  check('QA-A7. Stages 2-5 read "needs data", not "failed"',
    ['correlations', 'regression', 'distributedLag', 'counterfactual']
      .every((k) => st[k].status === 'needs_data'),
    ['correlations', 'regression', 'distributedLag', 'counterfactual'].map((k) => `${k}=${st[k].status}`).join(' '));

  // "Planning is Assumptions mode, not fake model %."
  check('QA-A8. planning refuses to run on the model', res.planningDerived.usable === false);
  check('QA-A9. …and falls back to the ASSUMED placeholders', res.planning.mode === 'assumptions');
  check('QA-A10. …with actionable blockers', res.planningEligibility.blockers.length > 0
    && res.planningEligibility.blockers.every((b) => b.fix),
    res.planningEligibility.blockers.map((b) => b.code).join(','));
}

// ── QA-B — adequate daily data ───────────────────────────────────────
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.25 * x[t] + (t >= 1 ? 0.40 * x[t - 1] : 0) + (rnd() - 0.5) * 25);
  const res = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 2, controls: { trend: true, seasonality: false } });
  const m = res.adjustedModel;
  const st = Object.fromEntries(stageStatuses(res, { periodsWithData: n }).map((s) => [s.key, s]));

  check('QA-B1. correlations populate with signs',
    res.observed.lagCorrelations.every((r) => r.correlation != null));
  check('QA-B2. the model shows BOTH full cumulative and lagged-only',
    m.cumulativeCoefficient != null && m.laggedOnly?.coefficient != null,
    `full=${m.cumulativeCoefficient?.toFixed(3)} lagged=${m.laggedOnly?.coefficient?.toFixed(3)}`);
  check('QA-B3. same-period share is visible', m.samePeriodShare != null,
    `${(m.samePeriodShare * 100).toFixed(0)}%`);
  // Controls honesty = the panel states what the regression ACTUALLY did.
  // Here seasonality was switched off by the caller, so the honest report is
  // "switched off" — not "needs 52 periods" (test 22 covers that case) and
  // certainly not a claim that it was adjusted for.
  check('QA-B4. controls honesty matches the actual regression',
    m.controls.includes('Trend')
      && m.seasonalityIncluded === false
      && !m.controls.some((c) => /season/i.test(c))
      && m.controlsMissingMajor.length === 3,
    m.controls.join(',') + ' | missingMajor=' + m.controlsMissingMajor.map((c) => c.name).join(','));
  check('QA-B5. seasonality copy states what actually happened',
    m.seasonalityReason === 'switched off', m.seasonalityReason);
  check('QA-B6. Stage 5 gives an actual-vs-counterfactual series',
    res.historicalContribution.perPeriod.length > 0
      && res.historicalContribution.perPeriod.every((p) => Number.isFinite(p.predictedActual) && Number.isFinite(p.predictedBaseline)));
  check('QA-B7. …and a contribution with an interval',
    res.historicalContribution.lower != null && res.historicalContribution.upper != null);
  check('QA-B8. reference sensitivity is computed for the warning',
    res.referenceSensitivity != null && typeof res.referenceSensitivity.sensitive === 'boolean');
  check('QA-B9. the model is eligible to drive planning',
    res.planningEligibility.eligible === true,
    res.planningEligibility.blockers.map((b) => b.code).join(',') || 'none');
  check('QA-B10. Apply model sets all THREE scenarios from the interval',
    res.planningDerived.usable === true
      && res.planningDerived.assumptions.conservative < res.planningDerived.assumptions.base
      && res.planningDerived.assumptions.base < res.planningDerived.assumptions.upside,
    JSON.stringify(res.planningDerived.assumptions));
  check('QA-B11. …on the lagged-only basis', res.planningDerived.basis === 'lagged_only');
  check('QA-B12. every stage except validation is complete',
    ['descriptive', 'correlations', 'regression', 'distributedLag', 'counterfactual']
      .every((k) => st[k].status === 'done'),
    ['descriptive', 'correlations', 'regression', 'distributedLag', 'counterfactual'].map((k) => `${k}=${st[k].status}`).join(' '));

  // A manual edit must stop the "from adjusted model" label.
  const overridden = analyseHalo(periods(x, y), {
    xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 2, controls: { trend: true, seasonality: false },
    planning: { ttsRevenue: 100000, marketingSpend: 30000, mode: 'override', assumptions: { conservative: 1, base: 2, upside: 3 } },
  });
  check('QA-B13. a manual edit is labelled an override, not the model',
    overridden.planning.mode === 'override' && overridden.planning.source === null
      && !/adjusted model/.test(overridden.planning.disclaimer),
    overridden.planning.disclaimer);
}

// ── QA-C — edge weekly (23 usable vs ~24 needed) ─────────────────────
// The brief: "Progress 'almost there' OR auto-reduce lag/params with note —
// not opaque hard fail only."
{
  // maxLag 3 + trend → 6 params → required 24. n=26 gives usable 23.
  const n = 26;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((v) => 4000 + 0.4 * v + rnd() * 40);
  const p = periods(x, y);
  const a = assessGrain('week', p, { maxLag: 3, controls: { trend: true, seasonality: false } });
  check('QA-C1. the knife-edge really is 23 of 24', a.usable === 23 && a.required === 24,
    `usable=${a.usable} required=${a.required}`);
  check('QA-C2. it is flagged "almost there", not an opaque failure', a.almostThere === true);
  check('QA-C3. …AND a reduced window is offered instead of a hard fail',
    a.canModel === true && a.lagReduced === true, `feasibleLag=${a.feasibleLag}`);
  check('QA-C4. the reduced window genuinely fits',
    analyseHalo(p, { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: a.feasibleLag, controls: { trend: true, seasonality: false } })
      .adjustedModel.available === true);
}

// ── QA-D — negatives survive everywhere ──────────────────────────────
{
  const n = 90;
  const x = Array.from({ length: n }, (_, i) => 1000 + i * 10 + rnd() * 50);
  const y = x.map((v) => 9000 - 0.35 * v + rnd() * 60);
  const res = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 2, controls: NO_CTL });
  check('QA-D1. negative correlations are shown, not floored',
    res.observed.lagCorrelations.some((r) => r.correlation < -0.2),
    res.observed.lagCorrelations.map((r) => r.correlation?.toFixed(2)).join(' '));
  check('QA-D2. the model reports a negative cumulative',
    res.adjustedModel.cumulativeCoefficient < 0, `${res.adjustedModel.cumulativeCoefficient?.toFixed(3)}`);
  check('QA-D3. the contribution can be negative and is not floored',
    res.historicalContribution.negativeAmount < 0 || res.historicalContribution.amount < 0,
    `amount=${res.historicalContribution.amount?.toFixed(0)}`);

  const finder = haloFinderTest(res);
  check('QA-D4. Halo Finder keeps negative rows', finder, 'checked via lagCorrelations sign retention');
}
function haloFinderTest(res) {
  return res.observed.lagCorrelations.some((r) => r.correlation != null && r.correlation < 0);
}

// ── QA-E — nothing is ever called incremental ───────────────────────
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.2 * x[t] + (t >= 1 ? 0.4 * x[t - 1] : 0) + rnd() * 25);
  const res = analyseHalo(periods(x, y), {
    xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 2, controls: NO_CTL,
    planning: { ttsRevenue: 100000, marketingSpend: 30000 },
  });
  const st = stageStatuses(res, { periodsWithData: n });
  const allText = JSON.stringify(res) + JSON.stringify(st);

  // The word may appear ONLY where it is being denied. The context window has
  // to be wide enough to contain the denial — at 60 chars it clipped
  // "…not part of this tool yet — which is why nothing here is labelled
  // incremental" down to a fragment that looked like an unqualified claim.
  const claims = (allText.match(/[^"]{0,130}incremental[^"]{0,60}/gi) || []);
  const DENIALS = /not incremental|requires geo|not part of this tool|Incremental requires|labelled incremental|why nothing/i;
  const badClaims = claims.filter((c) => !DENIALS.test(c));
  check('QA-E1. "incremental" appears only as a denial, never as a claim',
    badClaims.length === 0, badClaims.join(' || ') || `${claims.length} guarded mentions`);
  check('QA-E2. no output claims to prove or cause anything',
    !/\b(proves|proven|causes|causal lift)\b/i.test(allText));
  check('QA-E3. validation stage states why nothing is incremental',
    /incremental/i.test(st.find((s) => s.key === 'validation').detail));
}

// ════════════════════════════════════════════════════════════════════
// CLIENT-UX REWRITE — the builder prompt's confirmed bugs
// ════════════════════════════════════════════════════════════════════

// ── Bug A — the empty state must name the SELECTED view ──────────────
// Repro: brand with limited monthly history, View = Monthly, and the warning
// body said "Weekly does not have enough history…" — a stale sentence about a
// view nobody had chosen.
{
  const mk = (n) => {
    const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
    return periods(x, x.map((v, i) => 4000 + 0.2 * v + (i >= 1 ? 0.3 * x[i - 1] : 0) + rnd() * 30));
  };
  const assess = {
    day: assessGrain('day', mk(120), { maxLag: 3, controls: NO_CTL }),
    week: assessGrain('week', mk(5), { maxLag: 3, controls: NO_CTL }),
    month: assessGrain('month', mk(4), { maxLag: 3, controls: NO_CTL }),
  };

  const onMonthly = recommendGrain(assess, { currentGrain: 'month' });
  check('BugA. viewing Monthly → the reason names Monthly',
    /Monthly does not have enough history/.test(onMonthly.reason), onMonthly.reason);
  check('BugA2. …and does NOT mention Weekly',
    !/Weekly/.test(onMonthly.reason), onMonthly.reason);
  check('BugA3. …and quotes the MONTHLY shortfall, not the weekly one',
    new RegExp(`${assess.month.usable} of about ${assess.month.required} usable months`).test(onMonthly.reason),
    onMonthly.reason);

  const onWeekly = recommendGrain(assess, { currentGrain: 'week' });
  check('BugA4. viewing Weekly still says Weekly',
    /Weekly does not have enough history/.test(onWeekly.reason) && !/Monthly does not/.test(onWeekly.reason),
    onWeekly.reason);

  // No currentGrain supplied → falls back to the weekly phrasing, unchanged.
  check('BugA5. omitting currentGrain keeps the previous behaviour',
    /Weekly does not have enough history/.test(recommendGrain(assess).reason));
}

// ── Bug C — usable-period copy must match the grain ──────────────────
// Repro: model details on a short DAILY window claimed "52 usable periods —
// about a year of history". 52 days is seven weeks.
{
  check('BugC. 52 weeks reads as about a year',
    /about a year/.test(historyPhrase(52, 'week')), historyPhrase(52, 'week'));
  check('BugC2. 52 DAYS does not claim a year',
    !/year/.test(historyPhrase(52, 'day')), historyPhrase(52, 'day'));
  check('BugC3. …it is described in weeks instead',
    /about 7 weeks/.test(historyPhrase(52, 'day')), historyPhrase(52, 'day'));
  check('BugC4. 365 days reads as about a year',
    /about a year/.test(historyPhrase(365, 'day')), historyPhrase(365, 'day'));
  check('BugC5. 12 months reads as about a year',
    /about a year/.test(historyPhrase(12, 'month')), historyPhrase(12, 'month'));
  check('BugC6. 104 weeks reads as about two years',
    /about 2\.0 years/.test(historyPhrase(104, 'week')), historyPhrase(104, 'week'));
  check('BugC7. the unit is always named and pluralised',
    historyPhrase(1, 'day').startsWith('1 usable day') && historyPhrase(2, 'day').startsWith('2 usable days'),
    `${historyPhrase(1, 'day')} | ${historyPhrase(2, 'day')}`);

  // End to end: the confidence reasons on a daily view must not say "year".
  const n = 60;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((_, t) => 4000 + 0.2 * x[t] + (t >= 1 ? 0.3 * x[t - 1] : 0) + rnd() * 25);
  const daily = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: NO_CTL });
  check('BugC8. a 60-day model never claims a year of history',
    !daily.adjustedModel.confidenceReasons.some((r) => /year/.test(r)),
    daily.adjustedModel.confidenceReasons[0]);
  check('BugC9. …and names days explicitly',
    daily.adjustedModel.confidenceReasons.some((r) => /usable day/.test(r)),
    daily.adjustedModel.confidenceReasons[0]);

  const weekly = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'week', controls: NO_CTL });
  check('BugC10. the same 60 periods as WEEKS do claim about a year',
    weekly.adjustedModel.confidenceReasons.some((r) => /about a year/.test(r)),
    weekly.adjustedModel.confidenceReasons[0]);
}

// ── Bug C (model side) — annual seasonality is grain-dependent ───────
// A flat 52 fitted a 52-DAY cycle on daily data and called it annual
// seasonality, switching itself on at 52 days — two parameters spent on a
// seven-and-a-half-week wave that does not exist, on the grain now recommended
// for young brands.
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 500);
  const y = x.map((v) => 4000 + 0.4 * v + rnd() * 30);
  const p = periods(x, y);

  const asWeeks = analyseHalo(p, { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'week', controls: { trend: true, seasonality: true } });
  const asDays = analyseHalo(p, { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: { trend: true, seasonality: true } });

  check('BugC11. 120 WEEKS clears the annual gate → seasonality included',
    asWeeks.adjustedModel.seasonalityIncluded === true);
  check('BugC12. 120 DAYS does NOT → a 52-day "annual" cycle is not fitted',
    asDays.adjustedModel.seasonalityIncluded === false);
  check('BugC13. …and it says why, in days',
    /365 days/.test(asDays.adjustedModel.seasonalityReason || ''), asDays.adjustedModel.seasonalityReason);
  check('BugC14. not fitting it also costs fewer parameters',
    asDays.adjustedModel.parameterCount < asWeeks.adjustedModel.parameterCount,
    `days=${asDays.adjustedModel.parameterCount} weeks=${asWeeks.adjustedModel.parameterCount}`);

  // 400 days DOES clear a real annual cycle.
  const long = 400;
  const lx = Array.from({ length: long }, () => 1000 + rnd() * 500);
  const ly = lx.map((v) => 4000 + 0.4 * v + rnd() * 30);
  const longDaily = analyseHalo(periods(lx, ly), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: { trend: true, seasonality: true } });
  check('BugC15. 400 days DOES clear the annual gate',
    longDaily.adjustedModel.seasonalityIncluded === true);

  // assessGrain must use each grain's own cycle, not the caller's.
  const aDay = assessGrain('day', p, { maxLag: 1, controls: { trend: true, seasonality: true } });
  const aWeek = assessGrain('week', p, { maxLag: 1, controls: { trend: true, seasonality: true } });
  check('BugC16. assessGrain gives each grain its own seasonality gate',
    aDay.seasonalityIncluded === false && aWeek.seasonalityIncluded === true,
    `day=${aDay.seasonalityIncluded} week=${aWeek.seasonalityIncluded}`);
}

// ── Bug B — tooltip values must be readable, with units ──────────────
// Repro: hovering the "Over time" chart showed 733.3333333333333.
{
  check('BugB. money is formatted as currency, not a raw float',
    /^\$?[\d,]+(\.\d{1,2})?$/.test(formatMetricValue(733.3333333333333, 'gmv').replace(/^\$/, '$')),
    formatMetricValue(733.3333333333333, 'gmv'));
  check('BugB2. …and never shows more than 2 decimals',
    !/\.\d{3}/.test(formatMetricValue(733.3333333333333, 'gmv')), formatMetricValue(733.3333333333333, 'gmv'));
  check('BugB3. counts are whole numbers',
    formatMetricValue(41.7, 'ntb') === '42', formatMetricValue(41.7, 'ntb'));
  check('BugB4. rates keep at most 2 decimals',
    !/\.\d{3}/.test(formatMetricValue(3.14159, 'keyword_search_rank')), formatMetricValue(3.14159, 'keyword_search_rank'));
  check('BugB5. an indexed series shows 1 decimal and no currency',
    formatMetricValue(733.3333333333333, 'gmv', { indexed: true }) === '733.3',
    formatMetricValue(733.3333333333333, 'gmv', { indexed: true }));
  check('BugB6. missing stays a dash, not NaN',
    formatMetricValue(null, 'gmv') === '—' && formatMetricValue(undefined, 'gmv') === '—');
  check('BugB7. no formatted value anywhere contains NaN',
    !['gmv', 'ntb', 'keyword_search_rank', 'video_per_day'].some((k) => /NaN/.test(formatMetricValue(0, k))));
}

// ── Plain language — a client can read the metric names ──────────────
{
  check('PL1. GMV is translated on first use',
    plainMetricLabel('gmv') === 'TikTok Shop sales (GMV)', plainMetricLabel('gmv'));
  check('PL2. NTB is translated and keeps its acronym',
    /new-to-brand/i.test(plainMetricLabel('ntb')) && /NTB/.test(plainMetricLabel('ntb')), plainMetricLabel('ntb'));
  check('PL3. an unknown key degrades to the dictionary label rather than blank',
    plainMetricLabel('nonsense_key') === 'nonsense_key');
  check('PL4. every non-hidden field has a plain label that is not just its key',
    HALO_FIELDS.filter((f) => !f.hidden).every((f) => plainMetricLabel(f.key) !== f.key),
    HALO_FIELDS.filter((f) => !f.hidden && plainMetricLabel(f.key) === f.key).map((f) => f.key).join(',') || 'all covered');
  check('PL5. the comparison reads as a sentence',
    comparisonSentence('gmv', 'revenue_per_day') === 'TikTok Shop sales (GMV) vs Amazon revenue',
    comparisonSentence('gmv', 'revenue_per_day'));
}

// ── Glossary — every term the brief lists must be defined ────────────
{
  const REQUIRED = ['GMV', 'NTB', 'Halo', 'incremental', 'attributed', 'lag',
    'counterfactual', 'confidence', '95% interval', 'modelled'];
  const missing = REQUIRED.filter((t) => !glossaryFor(t));
  check('GL1. every required glossary term is defined', missing.length === 0, missing.join(', ') || 'all present');
  check('GL2. lookup is case-insensitive', !!glossaryFor('gmv') && !!glossaryFor('GMV'));
  check('GL3. every definition is a real sentence, not a stub',
    GLOSSARY.every((g) => g.def.length > 40 && g.short.length > 3),
    GLOSSARY.filter((g) => g.def.length <= 40).map((g) => g.term).join(',') || 'all substantial');
  check('GL4. "incremental" is defined as something this tool does NOT do',
    /does not run|not run|cannot/i.test(glossaryFor('incremental').def), glossaryFor('incremental').def);
  check('GL5. an unknown term returns null so a typo cannot ship a dead tooltip',
    glossaryFor('sparkle') === null);
}

// ── Key takeaway — the first-viewport answer ─────────────────────────
{
  const n = 120;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.15 * x[t] + (t >= 1 ? 0.35 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const healthy = analyseHalo(periods(x, y), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: NO_CTL });
  const t1 = keyTakeaway(healthy, { unit: 'day', xKey: 'gmv', yKey: 'revenue_per_day' });

  check('KT1. the headline is one plain sentence naming both metrics',
    /TikTok Shop sales/.test(t1.headline) && /Amazon revenue/.test(t1.headline) && (t1.headline.match(/\./g) || []).length === 1,
    t1.headline);
  check('KT2. it states a signed percentage', /[+-]\d+%/.test(t1.headline), t1.headline);
  check('KT3. it says whether it was the same period or later',
    /same day|days later|day later/.test(t1.headline), t1.headline);
  check('KT4. the caveat is always present and says correlation',
    /correlation, not proof/i.test(t1.caveat), t1.caveat);
  check('KT5. confidence and observation count are carried',
    t1.confidenceLabel != null && t1.observations > 0, `${t1.confidenceLabel} / ${t1.observations}`);
  check('KT6. the "so what" matches the planning gate',
    t1.canPlan === healthy.planningEligibility.eligible, `canPlan=${t1.canPlan} eligible=${healthy.planningEligibility.eligible}`);
  check('KT7. …and does not invite planning when planning is locked',
    t1.canPlan || !/can use this for spend/i.test(t1.soWhat), t1.soWhat);

  // A negative relationship must be described as such, not softened.
  const ny = x.map((v) => 9000 - 0.4 * v + rnd() * 40);
  const neg = analyseHalo(periods(x, ny), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: NO_CTL });
  const t2 = keyTakeaway(neg, { unit: 'day', xKey: 'gmv', yKey: 'revenue_per_day' });
  check('KT8. a negative relationship says "opposite directions"',
    /opposite directions/.test(t2.headline) && t2.direction === 'negative', t2.headline);
  check('KT9. …with a negative percentage', /-\d+%/.test(t2.headline), t2.headline);

  // Thin data must still produce a readable sentence, not a blank.
  const thin = analyseHalo(periods(x.slice(0, 4), y.slice(0, 4)), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3, unit: 'week' });
  const t3 = keyTakeaway(thin, { unit: 'week', xKey: 'gmv', yKey: 'revenue_per_day' });
  check('KT10. thin data still yields a sentence, not an empty headline',
    typeof t3.headline === 'string' && t3.headline.length > 40, t3.headline);
  check('KT11. …which names what is missing', /Not enough overlapping weeks/.test(t3.headline), t3.headline);
  check('KT12. …and refuses to invite planning', t3.canPlan === false && !/can use this/i.test(t3.soWhat), t3.soWhat);
  check('KT13. the caveat survives even with no finding', /correlation/i.test(t3.caveat));
}

// ── Coverage note (§3) ───────────────────────────────────────────────
{
  const full = coverageNote({ periodsSupplied: 30, completeObservations: 30, unit: 'day' });
  const gappy = coverageNote({ periodsSupplied: 30, completeObservations: 24, unit: 'day' });
  check('CN1. a complete window says so without alarm',
    /30 of 30/.test(full) && !/missing/.test(full), full);
  check('CN2. gaps are stated as left out, never as zeros',
    /6 days are missing one side/.test(gappy) && /rather than counted as zero/.test(gappy), gappy);
}

// ── CSV export (§6) ──────────────────────────────────────────────────
{
  const n = 90;
  const x = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const y = x.map((_, t) => 4000 + 0.15 * x[t] + (t >= 1 ? 0.35 * x[t - 1] : 0) + (rnd() - 0.5) * 20);
  const p = periods(x, y).map((r, i) => ({ ...r, label: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` }));
  const res = analyseHalo(p, { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: NO_CTL });
  const csv = buildHaloV2Csv({ result: res, periods: p, gran: 'day', range: { start: '2026-01-01', end: '2026-03-31' }, xKey: 'gmv', yKey: 'revenue_per_day', brandName: 'Acme, Inc.' });

  check('CSV1. it names the tool AND the not-incremental caveat up front',
    /Amazon Halo V2/.test(csv) && /NOT incremental/.test(csv));
  check('CSV2. it has both a SUMMARY and a SERIES block', /SUMMARY/.test(csv) && /SERIES/.test(csv));
  check('CSV3. the summary carries n, the interval and the controls',
    /Usable periods,\d+/.test(csv) && /95% interval/.test(csv) && /Controls included/.test(csv));
  check('CSV4. the same-period share is carried', /Same-period share of cumulative/.test(csv));
  check('CSV5. a brand name containing a comma is quoted',
    /"Acme, Inc\."/.test(csv), (csv.match(/.*Acme.*/) || [''])[0]);
  check('CSV6. the series has one row per period plus a header',
    csv.split('\r\n').filter((l) => /^2026-01-/.test(l)).length === p.length,
    `${csv.split('\r\n').filter((l) => /^2026-01-/.test(l)).length} of ${p.length}`);
  check('CSV7. the series includes both predicted columns',
    /predicted_actual,predicted_at_reference/.test(csv));
  check('CSV8. no NaN or undefined leaks into the file',
    !/NaN|undefined/.test(csv), (csv.match(/.*(NaN|undefined).*/) || [''])[0]);
  check('CSV9. the filename is safe and descriptive',
    haloV2CsvFilename({ brandName: 'Acme, Inc.', gran: 'day', range: { start: '2026-01-01', end: '2026-03-31' } })
      === 'halo-v2_acme-inc_day_2026-01-01_2026-03-31.csv',
    haloV2CsvFilename({ brandName: 'Acme, Inc.', gran: 'day', range: { start: '2026-01-01', end: '2026-03-31' } }));

  // A refused model must still export the series, with the reason recorded.
  const thin = analyseHalo(p.slice(0, 8), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3, unit: 'day' });
  const thinCsv = buildHaloV2Csv({ result: thin, periods: p.slice(0, 8), gran: 'day', range: {}, xKey: 'gmv', yKey: 'revenue_per_day' });
  check('CSV10. a refused model still exports the series',
    /SERIES/.test(thinCsv) && thinCsv.split('\r\n').filter((l) => /^2026-01-/.test(l)).length === 8);
  check('CSV11. …and records WHY there is no estimate',
    /not estimated/.test(thinCsv) && /Reason,/.test(thinCsv));
}

// ── P0 gate — Items sold vs NTB must lock planning ──────────────────
// The builder prompt names this pair explicitly: neither side is money, so a
// "halo %" of items per order is not a percentage of anything.
{
  const n = 120;
  const x = Array.from({ length: n }, () => 400 + rnd() * 200);
  const y = x.map((_, t) => 30 + 0.05 * x[t] + (t >= 1 ? 0.08 * x[t - 1] : 0) + rnd() * 2);
  const res = analyseHalo(periods(x, y), { xKey: 'items_sold', yKey: 'ntb', maxLag: 1, unit: 'day', controls: NO_CTL });
  check('P0-1. Items sold vs NTB → planning is NOT eligible',
    res.planningEligibility.eligible === false);
  check('P0-2. …because neither metric is money',
    res.planningEligibility.blockers.some((b) => b.code === 'not_monetary'));
  check('P0-3. …so no scenarios are derivable at all',
    res.planningDerived.usable === false);
  check('P0-4. …and the fix names a money-to-money pair',
    /monetary|money/i.test(res.planningEligibility.blockers.find((b) => b.code === 'not_monetary').fix),
    res.planningEligibility.blockers.find((b) => b.code === 'not_monetary').fix);
  check('P0-5. the key takeaway still renders for this pair',
    keyTakeaway(res, { unit: 'day', xKey: 'items_sold', yKey: 'ntb' }).headline.length > 40);
  check('P0-6. …and does not invite spend scenarios',
    keyTakeaway(res, { unit: 'day', xKey: 'items_sold', yKey: 'ntb' }).canPlan === false);

  // Money x money on the SAME data shape stays eligible, so the gate is about
  // the metrics and not an accident of this series.
  const mx = Array.from({ length: n }, () => 1000 + rnd() * 800);
  const my = mx.map((_, t) => 4000 + 0.15 * mx[t] + (t >= 1 ? 0.35 * mx[t - 1] : 0) + (rnd() - 0.5) * 20);
  check('P0-7. a money-to-money pair on comparable data IS eligible',
    analyseHalo(periods(mx, my), { xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 1, unit: 'day', controls: NO_CTL })
      .planningEligibility.eligible === true);
}

// ════════════════════════════════════════════════════════════════════
// SMOKE — degenerate inputs must not produce NaN, Infinity or "undefined"
//
// Checklist item 12 ("no NaN, blank charts, or dead controls") is partly a
// browser question, but the NaN half is not: every one of those leaks starts as
// a number the maths produced and the UI then printed. These feed the shapes a
// real sheet actually throws — an empty window, one row, a flat series, all
// nulls, zeros, a single non-zero spike — through every function whose output
// reaches the screen, and assert nothing unrenderable comes back.
// ════════════════════════════════════════════════════════════════════
{
  const BAD = /NaN|Infinity|undefined|\[object/;

  // Every user-visible string this result can produce, flattened.
  const visibleStrings = (res, unit) => {
    const t = keyTakeaway(res, { unit, xKey: 'gmv', yKey: 'revenue_per_day' });
    const st = stageStatuses(res, { periodsWithData: res.meta.periodsSupplied });
    const m = res.adjustedModel;
    return [
      t.headline, t.caveat, t.soWhat, String(t.observations),
      m.headline, m.message, m.confidenceLabel, m.seasonalityReason,
      ...(m.confidenceReasons || []), ...(m.controls || []), ...(m.controlsUnavailable || []),
      ...(m.warnings || []).map((w) => w.message),
      ...(res.warnings || []).map((w) => w.message),
      ...(res.planningEligibility?.blockers || []).flatMap((b) => [b.message, b.fix]),
      res.referenceSensitivity?.message,
      res.historicalContribution?.referenceLabel,
      res.historicalContribution?.referenceNote,
      ...st.flatMap((s) => [s.statusLabel, s.detail]),
      coverageNote({ periodsSupplied: res.meta.periodsSupplied, completeObservations: res.meta.completeObservations, unit }),
    ].filter((s) => typeof s === 'string');
  };

  const CASES = {
    'empty window':      [],
    'one row':           [{ key: 'a', label: 'a', x: 100, y: 200 }],
    'two rows':          [{ key: 'a', label: 'a', x: 100, y: 200 }, { key: 'b', label: 'b', x: 110, y: 210 }],
    'all x null':        Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: null, y: 100 + i })),
    'all y null':        Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: 100 + i, y: null })),
    'all zeros':         Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: 0, y: 0 })),
    'flat series':       Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: 5, y: 9 })),
    'single spike':      Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: i === 20 ? 9999 : 0, y: i === 20 ? 5000 : 0 })),
    'negative values':   Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: -100 - i, y: -50 - i })),
    'alternating gaps':  Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, x: i % 2 ? null : 100 + i, y: i % 3 ? 200 + i : null })),
  };

  let clean = 0;
  for (const [name, rows] of Object.entries(CASES)) {
    for (const unit of ['day', 'week', 'month']) {
      let res, strings, csv;
      try {
        res = analyseHalo(rows, {
          xKey: 'gmv', yKey: 'revenue_per_day', maxLag: 3, unit,
          controls: { trend: true, seasonality: true },
          planning: { ttsRevenue: 100000, marketingSpend: 30000 },
        });
        strings = visibleStrings(res, unit);
        csv = buildHaloV2Csv({ result: res, periods: rows, gran: unit, range: {}, xKey: 'gmv', yKey: 'revenue_per_day' });
      } catch (e) {
        check(`SMOKE. "${name}" @ ${unit} does not throw`, false, String(e.message || e));
        continue;
      }
      const bad = strings.filter((s) => BAD.test(s));
      check(`SMOKE. "${name}" @ ${unit} produces no NaN/undefined in visible text`,
        bad.length === 0, bad.slice(0, 2).join(' || '));
      if (BAD.test(csv)) check(`SMOKE. "${name}" @ ${unit} CSV is clean`, false, (csv.match(/.*(NaN|undefined).*/) || [''])[0]);
      else clean++;

      // A grain assessment must survive the same shapes — it drives the picker
      // labels and the status panel, so a throw here is a dead control.
      try {
        const a = assessGrain(unit, rows, { maxLag: 3, controls: { trend: true, seasonality: true } });
        check(`SMOKE. "${name}" @ ${unit} assessment yields finite counts`,
          Number.isFinite(a.usable) && Number.isFinite(a.required) && Number.isFinite(a.correlationObs),
          `usable=${a.usable} required=${a.required} obs=${a.correlationObs}`);
      } catch (e) {
        check(`SMOKE. "${name}" @ ${unit} assessment does not throw`, false, String(e.message || e));
      }
    }
  }
  check(`SMOKE. all ${Object.keys(CASES).length} shapes x 3 grains exported clean CSV`, clean === 30, `${clean}/30`);

  // Formatters, fed the values that actually break them.
  const NASTY = [0, -0, null, undefined, NaN, Infinity, -Infinity, 1e21, -1e-9, 0.005, 733.3333333333333];
  const keys = ['gmv', 'ntb', 'keyword_search_rank', 'video_per_day', 'revenue_per_day'];
  const formatted = [];
  for (const k of keys) for (const v of NASTY) {
    formatted.push(formatMetricValue(v, k));
    formatted.push(formatMetricValue(v, k, { indexed: true }));
  }
  check('SMOKE. no formatter output contains NaN or undefined',
    !formatted.some((s) => /NaN|undefined/.test(s)),
    formatted.filter((s) => /NaN|undefined/.test(s)).slice(0, 3).join(' | '));
  check('SMOKE. every formatter output is a non-empty string',
    formatted.every((s) => typeof s === 'string' && s.length > 0));
  check('SMOKE. Infinity is not printed raw',
    !formatted.some((s) => /Infinity|∞/.test(s)),
    formatted.filter((s) => /Infinity/.test(s)).slice(0, 2).join(' | '));

  // historyPhrase across the whole plausible range and every unit.
  const phrases = [];
  for (const u of ['day', 'week', 'month', 'period']) {
    for (const n of [0, 1, 2, 5, 6, 11, 12, 20, 21, 25, 26, 51, 52, 60, 77, 78, 104, 365, 366, 1000]) {
      phrases.push(historyPhrase(n, u));
    }
  }
  check('SMOKE. historyPhrase never emits NaN or a bare "1 weeks"',
    !phrases.some((s) => /NaN|undefined|\b1 weeks\b|\b1 days\b|\b1 months\b/.test(s)),
    phrases.filter((s) => /NaN|undefined|\b1 weeks\b/.test(s)).slice(0, 3).join(' | '));
  check('SMOKE. historyPhrase only claims a year when the span really is one',
    phrases.filter((s) => /about a year/.test(s)).every((s) => {
      const n = Number((s.match(/^(\d+)/) || [])[1]);
      const u = (s.match(/usable (\w+?)s? /) || [])[1];
      const per = { day: 365, week: 52, month: 12 }[u];
      return per ? n / per >= 0.85 : false;
    }),
    phrases.filter((s) => /about a year/.test(s)).slice(0, 3).join(' | '));
}

// ── DAILY FILL — weekly/monthly take the charted metrics from the daily sheet ─
// Longevity's shape: a weekly sheet built from an older daily upload (revenue
// missing, zero or stale) beside a daily sheet with "Total Revenue/Day" every
// day. Weekly and monthly must show the daily totals, not the stale snapshot.
{
  const iso = (d) => d.toISOString().slice(0, 10);
  const dailyFrom = (start, end, metricsFor, skip = []) => {
    const out = [];
    for (let d = new Date(`${start}T00:00:00Z`); iso(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (!skip.includes(iso(d))) out.push({ date: iso(d), metrics: metricsFor(iso(d)) });
    }
    return out;
  };
  // 1 Mar 2026 is a Sunday, so the weekly sheet's anchors are Sundays, as built.
  const daily = dailyFrom('2026-03-01', '2026-04-30',
    () => ({ revenue_per_day: 100, gmv: 10, aov: 20, ntb: 0 }), ['2026-03-18']);
  const weekSheet = [
    { key: '2026-03-01', label: 'wk1', metrics: { gmv: 70, keyword_search_volume: 5000, ntb: 7 } },        // no revenue key
    { key: '2026-03-08', label: 'wk2', metrics: { gmv: 70, revenue_per_day: 0, keyword_search_volume: 5000, ntb: 7 } },
    { key: '2026-03-15', label: 'wk3', metrics: { gmv: 70, revenue_per_day: 155, keyword_search_volume: 5000, ntb: 7 } },
    { key: '2026-03-22', label: 'wk4', metrics: { gmv: 70, revenue_per_day: 999, keyword_search_volume: 5000, ntb: 7 } },
  ];
  const run = (opts) => fillFromDaily({ buckets: weekSheet, dailyRows: daily, gran: 'week', keys: ['gmv', 'revenue_per_day'], ...opts });
  const at = (res, key) => res.buckets.find((b) => b.key === key)?.metrics || {};

  const r = run();
  check('FILL 1. a week the weekly sheet has no revenue for takes the daily total',
    at(r, '2026-03-01').revenue_per_day === 700, `got ${at(r, '2026-03-01').revenue_per_day}`);
  check('FILL 2. a weekly-sheet 0 ("not tracked") is replaced by the daily total',
    at(r, '2026-03-08').revenue_per_day === 700, `got ${at(r, '2026-03-08').revenue_per_day}`);
  check('FILL 3. a stale weekly figure is replaced by the daily total',
    at(r, '2026-03-22').revenue_per_day === 700, `got ${at(r, '2026-03-22').revenue_per_day}`);
  check('FILL 4. one row missing mid-sheet still fills the week (6 of 7 days)',
    at(r, '2026-03-15').revenue_per_day === 600, `got ${at(r, '2026-03-15').revenue_per_day}`);
  check('FILL 5. weekly-only metrics (search volume, NTB) are left as the weekly sheet has them',
    at(r, '2026-03-01').keyword_search_volume === 5000 && at(r, '2026-03-01').ntb === 7);
  check('FILL 6. full weeks the daily sheet covers past the weekly sheet are added, on the same Sunday anchors',
    r.buckets.map((b) => b.key).join(',') === '2026-03-01,2026-03-08,2026-03-15,2026-03-22,2026-03-29,2026-04-05,2026-04-12,2026-04-19',
    r.buckets.map((b) => b.key).join(','));
  check('FILL 7. an added week carries the daily totals and a readable label',
    at(r, '2026-04-19').revenue_per_day === 700 && r.buckets.at(-1).label === '19 Apr – 25 Apr 2026',
    `${at(r, '2026-04-19').revenue_per_day} "${r.buckets.at(-1).label}"`);
  check('FILL 8. filled reports the metrics the daily sheet changed',
    r.filled.includes('revenue_per_day') && !r.filled.includes('ntb'), JSON.stringify(r.filled));
  check('FILL 9. the input buckets are not mutated',
    weekSheet[0].metrics.revenue_per_day === undefined && weekSheet[3].metrics.revenue_per_day === 999);

  const zero = run({ keys: ['ntb'] });
  check('FILL 10. a daily zero never overwrites a real weekly figure',
    at(zero, '2026-03-01').ntb === 7 && !zero.filled.length, JSON.stringify(zero.filled));

  const avg = fillFromDaily({ buckets: weekSheet, dailyRows: daily, gran: 'week', keys: ['aov'] });
  check('FILL 11. an average metric is averaged over the week, not summed',
    at(avg, '2026-03-01').aov === 20, `got ${at(avg, '2026-03-01').aov}`);

  const lateDaily = daily.filter((d) => d.date >= '2026-03-03');
  const edge = fillFromDaily({ buckets: weekSheet, dailyRows: lateDaily, gran: 'week', keys: ['revenue_per_day'] });
  check('FILL 12. a week the daily sheet only partly reaches keeps the weekly sheet value',
    at(edge, '2026-03-01').revenue_per_day === undefined && at(edge, '2026-03-22').revenue_per_day === 700);

  const ranged = run({ range: { start: '2026-03-01', end: '2026-03-10' } });
  check('FILL 13. daily rows outside the date range are not used, and nothing is added past it',
    at(ranged, '2026-03-08').revenue_per_day === 0 && ranged.buckets.length === 4
      && at(ranged, '2026-03-01').revenue_per_day === 700);

  const months = fillFromDaily({
    buckets: [{ key: '2026-03', label: '2026-03', metrics: { revenue_per_day: 50, keyword_search_volume: 20000 } }],
    dailyRows: daily, gran: 'month', keys: ['revenue_per_day'],
  });
  check('FILL 14. monthly is the calendar-month daily total (30 of 31 days present)',
    at(months, '2026-03').revenue_per_day === 3000 && at(months, '2026-03').keyword_search_volume === 20000,
    `got ${at(months, '2026-03').revenue_per_day}`);
  check('FILL 15. a later month the daily sheet covers is added',
    months.buckets.map((b) => b.key).join(',') === '2026-03,2026-04' && at(months, '2026-04').revenue_per_day === 3000);

  const same = fillFromDaily({
    buckets: [{ key: '2026-03-01', label: 'wk1', metrics: { revenue_per_day: 700 } }],
    dailyRows: daily.filter((d) => d.date <= '2026-03-07'), gran: 'week', keys: ['revenue_per_day'],
  });
  check('FILL 16. a weekly sheet that already agrees with the daily sheet is reported as unchanged',
    !same.filled.length && at(same, '2026-03-01').revenue_per_day === 700);
  check('FILL 17. a daily view is never filled',
    fillFromDaily({ buckets: weekSheet, dailyRows: daily, gran: 'day', keys: ['revenue_per_day'] }).buckets === weekSheet);

  // End to end through buildPeriods, which the explorer calls.
  const weekRows = weekSheet.map((b) => ({ date: b.key, periodLabel: b.label, metrics: b.metrics }));
  const base = { rows: weekRows, sourceGran: 'week', gran: 'week', xKey: 'gmv', yKey: 'revenue_per_day', range: {} };
  const without = buildPeriods(base);
  const withDaily = buildPeriods({ ...base, dailyRows: daily });
  check('FILL 18. buildPeriods without daily rows behaves exactly as before',
    without.periods[0].y === null && without.periods.length === 4 && !without.filledFromDaily.length);
  check('FILL 19. buildPeriods with daily rows shows revenue from the first week',
    withDaily.periods[0].y === 700 && withDaily.periods[0].x === 70 && withDaily.filledFromDaily.includes('revenue_per_day'),
    `y=${withDaily.periods[0].y} filled=${JSON.stringify(withDaily.filledFromDaily)}`);
  const monthly = buildPeriods({ ...base, gran: 'month', dailyRows: daily });
  check('FILL 20. buildPeriods monthly from a weekly sheet uses the daily month totals',
    monthly.periods.map((p) => `${p.key}=${p.y}`).join(',') === '2026-03=3000,2026-04=3000',
    monthly.periods.map((p) => `${p.key}=${p.y}`).join(','));
  const fromDaily = buildPeriods({ ...base, rows: daily, sourceGran: 'day', dailyRows: daily });
  check('FILL 21. a view already rolled up from the daily sheet is not filled a second time',
    fromDaily.periods.find((p) => p.key === '2026-03-07')?.y === 700 && !fromDaily.filledFromDaily.length);
}

console.log('\nHalo V2 — brief §33 test suite\n');
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
