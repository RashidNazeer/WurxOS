// ============================================================
// Halo V2 — isolated lag correlations (brief §4, §5, §26).
//
// Answers "which single lag looks strongest?" and — just as importantly — makes
// the answer hard to over-read. Testing four lags means the best of four is
// biased upward by construction, so we always return ALL of them, and we warn
// when the pattern looks like noise rather than a response curve.
//
// Wording rule (§4): "strongest observed relationship at +2 weeks", never "the
// halo delay is 2 weeks".
// ============================================================

import { signedCorrelation } from './correlation.js';

export const DEFAULT_MAX_LAG = 3;

// series: [{ key, x, y }] aligned and sorted ascending, one entry per period.
// A lag of L pairs TikTok at t with Amazon at t+L.
export function lagCorrelations(series, xKey, yKey, maxLag = DEFAULT_MAX_LAG) {
  const out = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    const xs = [], ys = [];
    for (let t = 0; t + lag < series.length; t++) {
      const x = series[t]?.x;
      const y = series[t + lag]?.y;
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      xs.push(x); ys.push(y);
    }
    const c = signedCorrelation(xs, ys, xKey, yKey);
    out.push({
      lag,
      correlation: c.businessAdjustedCorrelation,   // what the UI leads with
      rawCorrelation: c.rawCorrelation,
      businessAdjustedCorrelation: c.businessAdjustedCorrelation,
      numberOfObservations: c.n,
      sufficiency: c.sufficiency,
      inverted: c.inverted,
      reason: c.reason,
    });
  }
  return out;
}

// Strongest by ABSOLUTE size — a strong negative is as much a finding as a
// strong positive, and picking by signed maximum would quietly hide it.
export function bestObservedLag(rows) {
  const usable = rows.filter((r) => r.correlation != null);
  if (!usable.length) return null;
  return usable.reduce((best, r) =>
    (Math.abs(r.correlation) > Math.abs(best.correlation) ? r : best), usable[0]).lag;
}

/**
 * Warnings that stop a lucky lag being read as a discovery (brief §5).
 *  - dominant: the winner towers over the rest (classic multiple-comparison luck)
 *  - unstable: the sign flips across lags — a real response curve rarely does
 *  - small_sample: too few observations for any of it to mean much
 */
export function lagWarnings(rows) {
  const warnings = [];
  const usable = rows.filter((r) => r.correlation != null);
  if (usable.length < 2) return warnings;

  const sorted = [...usable].sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  const top = Math.abs(sorted[0].correlation);
  const runnerUp = Math.abs(sorted[1].correlation);
  if (top >= 0.3 && top > runnerUp * 2.5) {
    warnings.push({
      code: 'dominant_lag',
      message: 'One lag is far stronger than the others. Testing several lags makes an occasional strong result likely by chance — treat this as a lead to investigate, not a finding.',
    });
  }

  const signs = new Set(usable.filter((r) => Math.abs(r.correlation) >= 0.1).map((r) => Math.sign(r.correlation)));
  if (signs.size > 1) {
    warnings.push({
      code: 'unstable_signs',
      message: `Lag pattern is unstable: ${usable.map((r) => (r.correlation > 0 ? '+' : '') + r.correlation.toFixed(2)).join(' / ')}. Interpret cautiously.`,
    });
  }

  const minN = Math.min(...usable.map((r) => r.numberOfObservations));
  if (minN < 12) {
    warnings.push({
      code: 'small_sample',
      message: `Some lags rest on as few as ${minN} overlapping periods. Small samples move a lot on one unusual week.`,
    });
  }
  return warnings;
}

// Halo Finder V2 (§26): every TikTok metric against one Amazon metric, keeping
// negative rows. seriesFor(metricKey) -> [{ x, y }] aligned to the same periods.
export function haloFinder(metricKeys, yKey, seriesFor, maxLag = DEFAULT_MAX_LAG) {
  return metricKeys.map((xKey) => {
    const rows = lagCorrelations(seriesFor(xKey), xKey, yKey, maxLag);
    const best = bestObservedLag(rows);
    const bestRow = rows.find((r) => r.lag === best) || null;
    return {
      metric: xKey,
      bestLag: best,
      correlation: bestRow?.correlation ?? null,
      rawCorrelation: bestRow?.rawCorrelation ?? null,
      numberOfObservations: bestRow?.numberOfObservations ?? 0,
      direction: bestRow?.correlation == null ? 'none' : bestRow.correlation > 0 ? 'positive' : 'negative',
      inverted: !!bestRow?.inverted,
      lags: rows,
      warnings: lagWarnings(rows),
    };
  });
}
