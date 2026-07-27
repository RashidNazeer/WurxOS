// ============================================================
// Amazon Halo Effect — correlation math (per-granularity source model).
//
// Each brand has up to three sheets (daily / weekly / monthly). The explorer
// picks ONE source for the chosen view granularity: the matching sheet if it was
// uploaded, otherwise the finest available FINER sheet rolled up. So a view is
// never a mix of a sheet's own rows and computed rows.
//
//   * source gran == view gran  → each row IS a bucket (the sheet's own value,
//     keyed by its anchor date, labelled by the sheet's raw period text).
//   * source finer than view    → aggregate the finer rows up (sum/avg per field);
//     partial edge periods are dropped (only when rolling up from DAILY).
//
// Correlation pairs two metrics on the shared buckets with a lag measured in the
// view's own unit (days / weeks / months). Weekly lag uses +lag*7 days on the
// anchor, which is exact for contiguous 7-day weeks; irregular weekly ranges just
// drop the mispaired bucket rather than mis-correlating.
// ============================================================

import { FIELD_BY_KEY, GRAN_ORDER } from './haloFields';

const pad2 = (n) => String(n).padStart(2, '0');
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isoOf = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;

export function addDays(s, n) { const dt = parseISO(s); dt.setUTCDate(dt.getUTCDate() + n); return isoOf(dt); }

// 'YYYY-MM' + n months.
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

// Calendar days in a 'YYYY-MM' month (leap-year aware, no Date needed).
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// The Sun–Sat week's ending SATURDAY for a date. getUTCDay: Sun=0 … Sat=6.
export function weekEndingOf(dateStr) {
  const dt = parseISO(dateStr);
  dt.setUTCDate(dt.getUTCDate() + (6 - dt.getUTCDay()));
  return isoOf(dt);
}

// bucket key + label for a date at a granularity (used when ROLLING UP a finer
// source). day → the date; week → the ending Saturday; month → YYYY-MM.
export function bucketOf(dateStr, gran) {
  if (gran === 'month') return { key: dateStr.slice(0, 7), label: dateStr.slice(0, 7) };
  if (gran === 'week') { const k = weekEndingOf(dateStr); return { key: k, label: `wk ${k.slice(5)}` }; }
  return { key: dateStr, label: dateStr.slice(5) };
}

// Key a row's own anchor at the view granularity (used when the source gran ==
// the view gran, so the sheet's own period is preserved). day/week keep the
// anchor date ISO; month collapses to YYYY-MM.
function bucketKeyOf(dateStr, gran) {
  if (gran === 'month') return dateStr.slice(0, 7);
  return dateStr;
}

// The bucket key `lag` units later (for the delayed-halo pairing).
export function bucketKeyAtLag(key, gran, lag) {
  if (!lag) return key;
  if (gran === 'month') return addMonths(key, lag);
  if (gran === 'week') return addDays(key, lag * 7);
  return addDays(key, lag);
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  // Mean-centered (two-pass) form — numerically stable, so a constant series
  // gives sxx/syy of exactly 0 (→ null, "no variation") rather than the
  // rounding-driven NaN the one-pass computational form can produce.
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? r : null; // raw r; sign-flip + floor happen in pairBuckets
}

/**
 * Bucket a source's rows at a target granularity.
 *  - sourceGran === targetGran → each row is a bucket (sheet value, own label).
 *  - sourceGran finer          → aggregate up (sum/avg per field), dropping
 *                                partial edge periods when rolling up from daily.
 * `rows` = [{ date, periodLabel?, metrics }] already scoped to the chosen
 * product/keyword. Returns Array<{ key, label, days, metrics }> sorted ascending.
 */
export function buildBucketsFromSource({ rows, sourceGran, targetGran, minWeekDays = 7 }) {
  if (!rows || !rows.length) return [];
  const so = GRAN_ORDER[sourceGran];
  const to = GRAN_ORDER[targetGran];
  if (so == null || to == null || so > to) return []; // can't synthesise a finer view

  if (so === to) {
    return rows
      .filter((r) => r && r.date && r.metrics)
      .map((r) => ({
        key: bucketKeyOf(r.date, targetGran),
        label: r.periodLabel || bucketOf(r.date, targetGran).label,
        days: 1,
        metrics: r.metrics,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  const map = new Map();
  for (const r of rows) {
    const m = r && r.metrics;
    if (!m || !r.date) continue;
    const b = bucketOf(r.date, targetGran);
    if (!map.has(b.key)) map.set(b.key, { key: b.key, label: b.label, days: 0, acc: {} });
    const slot = map.get(b.key);
    slot.days += 1;
    for (const k in m) { const v = m[k]; if (v == null) continue; (slot.acc[k] = slot.acc[k] || []).push(v); }
  }
  const reduce = (arr, agg) => (agg === 'avg' ? arr.reduce((s, v) => s + v, 0) / arr.length : arr.reduce((s, v) => s + v, 0));
  let buckets = [];
  for (const slot of map.values()) {
    const metrics = {};
    for (const k in slot.acc) metrics[k] = reduce(slot.acc[k], FIELD_BY_KEY[k]?.agg || 'sum');
    buckets.push({ key: slot.key, label: slot.label, days: slot.days, metrics });
  }
  // Drop partial edge periods (they under-count) — only meaningful when the
  // source is DAILY and we know each bucket's day-count.
  if (sourceGran === 'day') {
    if (targetGran === 'week') buckets = buckets.filter((b) => b.days >= minWeekDays);
    else if (targetGran === 'month') buckets = buckets.filter((b) => b.days >= daysInMonth(b.key) * 0.85);
  }
  buckets.sort((a, b) => (a.key < b.key ? -1 : 1));
  return buckets;
}

// Which side is the lagging "effect"? amazon lags tiktok. Same group → no lag.
function lagRoles(fx, fy) {
  const gx = FIELD_BY_KEY[fx]?.group, gy = FIELD_BY_KEY[fy]?.group;
  return {
    xIsEffect: gx === 'amazon' && gy === 'tiktok',
    yIsEffect: gy === 'amazon' && gx === 'tiktok',
  };
}

// Pair two metric columns across the buckets, with the amazon "effect" sampled
// `lag` buckets after the tiktok "cause". Returns { points:[{label,x,y}], r, n }.
export function pairBuckets(buckets, fx, fy, lag, gran) {
  const byKey = new Map(buckets.map((b) => [b.key, b.metrics]));
  const { xIsEffect, yIsEffect } = lagRoles(fx, fy);
  const points = [];
  for (const b of buckets) {
    const xKey = xIsEffect ? bucketKeyAtLag(b.key, gran, lag) : b.key;
    const yKey = yIsEffect ? bucketKeyAtLag(b.key, gran, lag) : b.key;
    const x = byKey.get(xKey)?.[fx];
    const y = byKey.get(yKey)?.[fy];
    if (x == null || y == null) continue;
    points.push({ label: b.label, x, y });
  }
  // For an INVERSE metric (e.g. Keyword Search Rank, where lower = better) a real
  // halo shows up as a NEGATIVE Pearson. When exactly one side is inverse, flip the
  // sign so an "improving together" relationship reads as a positive halo; THEN floor
  // to 0 (a halo can't be negative). Both/neither inverse → no flip.
  const raw = pearson(points.map((p) => p.x), points.map((p) => p.y));
  const oneInverse = (!!FIELD_BY_KEY[fx]?.inverse) !== (!!FIELD_BY_KEY[fy]?.inverse);
  const r = raw == null ? null : Math.max(0, oneInverse ? -raw : raw);
  return { points, r, n: points.length };
}

// Correlation matrix over rowKeys x colKeys (for the heatmap).
export function correlationMatrix(buckets, rowKeys, colKeys, lag, gran) {
  return rowKeys.map((rk) =>
    colKeys.map((ck) => {
      if (rk === ck) return { r: 1, n: 0 };
      const { points, r } = pairBuckets(buckets, rk, ck, lag, gran);
      return { r, n: points.length };
    }),
  );
}

// Time series for the multi-metric overlay, min-max normalised to 0..100 so
// differently-scaled metrics share one axis (raw kept for the tooltip).
export function overlaySeries(buckets, keys) {
  const raw = buckets.map((b) => {
    const row = { label: b.label };
    for (const k of keys) row[k] = b.metrics[k] ?? null;
    return row;
  });
  const norm = raw.map((r) => ({ label: r.label }));
  for (const k of keys) {
    const vals = raw.map((r) => r[k]).filter((v) => v != null);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    raw.forEach((r, i) => { norm[i][k] = r[k] == null ? null : ((r[k] - min) / span) * 100; norm[i][`${k}__raw`] = r[k]; });
  }
  return norm;
}

// Single source of truth for the integer % shown for a correlation. FLOORED so the
// displayed number never crosses a threshold the raw r doesn't — colour, label and
// the "linked" wording all derive from THIS, so they can never disagree with the
// number on screen (e.g. "10%" is never painted below-threshold orange).
export function corrPct(r) {
  if (r == null) return null;
  return Math.floor(Math.max(0, Math.min(1, r)) * 100);
}

export function strengthLabel(r) {
  const p = corrPct(r);
  if (p == null) return 'no data';
  return p >= 80 ? 'very strong' : p >= 60 ? 'strong' : p >= 40 ? 'moderate' : p >= 10 ? 'weak' : 'little/none';
}

export function directionSentence(fx, fy, r, n) {
  if (r == null) {
    if (n != null && n >= 3) return 'One of these series has no variation over this range — a correlation can’t be computed.';
    return 'Not enough overlapping periods to correlate these two yet (need at least 3).';
  }
  const fX = FIELD_BY_KEY[fx], fY = FIELD_BY_KEY[fy];
  const lx = fX?.label || fx;
  const ly = fY?.label || fy;
  const p = corrPct(r);
  if (p < 10) return `${lx} and ${ly}: ${p}% correlation${n ? ` over ${n} points` : ''}.`;
  // r is sign-adjusted so positive = the BENEFICIAL direction for each side (an
  // inverse metric like Keyword Search Rank improves as its number goes DOWN).
  const goodX = fX?.inverse ? `a lower (better) ${lx}` : `higher ${lx}`;
  const goodY = fY?.inverse ? `a lower (better) ${ly}` : `more ${ly}`;
  return `${p}% correlation${n ? ` over ${n} points` : ''} — ${goodX} tends to go with ${goodY}.`;
}

// Heatmap/badge fill, driven off the DISPLAYED integer % (corrPct) so colour can
// never disagree with the number: green ≥ 10%, orange 1–9%, light red at 0%. Stronger = more saturated.
export function corrColor(r) {
  const p = corrPct(r);
  if (p == null) return 'var(--surface-2, #2a2a33)';
  if (p === 0) return 'rgba(239, 68, 68, 0.14)';
  if (p < 10) return 'rgba(245, 158, 11, 0.20)';
  return `rgba(34, 197, 94, ${(0.18 + (p / 100) * 0.6).toFixed(3)})`;
}

// Text/emphasis colour matching corrColor's buckets (also off the displayed %).
export function corrTextColor(r) {
  const p = corrPct(r);
  if (p == null) return 'var(--text-muted)';
  if (p === 0) return '#ef4444';
  if (p < 10) return '#f59e0b';
  return '#22c55e';
}

// Correlation as the displayed percentage string, e.g. 0.28 -> "28%"; null -> null.
export function fmtCorrPct(r) {
  const p = corrPct(r);
  return p == null ? null : `${p}%`;
}

// INCREMENTAL halo (regression method). Fit Amazon (Y) = intercept + slope·TikTok(X)
// by least squares. slope = extra Amazon per 1 unit of TikTok; lift = slope·totalX =
// the Amazon the fit attributes to TikTok, FLOORED at 0 (a flat/negative slope = no
// halo). baseline (per period) = the intercept = (totalY − lift)/n. Crucially, when X
// and Y don't move together the slope ~ 0 so lift ~ 0 — the number CANNOT be inflated
// by baseline noise (the quiet-period-average method wrongly produced a large "lift"
// at 0% correlation because the quietest periods' average rarely equals the overall
// average). Returns { baseline, lift, totalX, totalY, n, slope } or null (<3 pts or X
// has no variation).
export function incrementalHalo(buckets, xKey, yKey) {
  const pts = [];
  for (const b of buckets) {
    const x = b.metrics?.[xKey], y = b.metrics?.[yKey];
    if (x == null || y == null) continue;
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) pts.push({ x: nx, y: ny });
  }
  const n = pts.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0;
  for (const p of pts) { const dx = p.x - mx; sxx += dx * dx; sxy += dx * (p.y - my); }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const lift = Math.max(0, slope * sx);
  return { baseline: (sy - lift) / n, lift, totalX: sx, totalY: sy, n, slope };
}
