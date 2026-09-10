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

console.log('\nHalo V2 — brief §33 test suite\n');
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
