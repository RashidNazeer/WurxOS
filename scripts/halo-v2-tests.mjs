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
import { fitDistributedLag } from '../src/lib/haloV2/distributedLag.js';
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

console.log('\nHalo V2 — brief §33 test suite\n');
console.log(results.join('\n'));
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
