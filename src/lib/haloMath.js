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
  if (!Number.isFinite(r)) return null;
  return Math.max(0, r); // floor negatives to 0 — a halo effect can't be negative
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
  return { points, r: pearson(points.map((p) => p.x), points.map((p) => p.y)), n: points.length };
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

export function strengthLabel(r) {
  if (r == null) return 'no data';
  const a = Math.max(0, r); // r is floored to [0,1]; no negative direction to label
  // "weak" starts at 10% to match the green colour threshold (< 10% reads as none).
  return a >= 0.8 ? 'very strong' : a >= 0.6 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.1 ? 'weak' : 'little/none';
}

export function directionSentence(fx, fy, r, n) {
  if (r == null) {
    if (n != null && n >= 3) return 'One of these series has no variation over this range — a correlation can’t be computed.';
    return 'Not enough overlapping periods to correlate these two yet (need at least 3).';
  }
  const lx = FIELD_BY_KEY[fx]?.label || fx;
  const ly = FIELD_BY_KEY[fy]?.label || fy;
  const t = Math.max(0, r);
  if (t < 0.1) return `No clear relationship between ${lx} and ${ly}${n ? ` (${n} points)` : ''}.`;
  return `${strengthLabel(r)} (${Math.round(t * 100)}%${n ? `, ${n} points` : ''}): higher ${lx} tends to go with more ${ly}.`;
}

// r floored to [0,1] -> heatmap fill. Green ≥ 10%, orange below 10%, light red at
// exactly 0% (includes anything that floored up from a negative r). Stronger = more saturated.
export function corrColor(r) {
  if (r == null) return 'var(--surface-2, #2a2a33)';
  const t = Math.max(0, Math.min(1, r));
  if (t === 0) return 'rgba(239, 68, 68, 0.14)';
  if (t < 0.10) return 'rgba(245, 158, 11, 0.20)';
  return `rgba(34, 197, 94, ${(0.18 + t * 0.6).toFixed(3)})`;
}

// Text/emphasis colour matching corrColor's buckets.
export function corrTextColor(r) {
  if (r == null) return 'var(--text-muted)';
  const t = Math.max(0, r);
  if (t === 0) return '#ef4444';
  if (t < 0.10) return '#f59e0b';
  return '#22c55e';
}

// Correlation as a floored percentage string, e.g. 0.28 -> "28%"; null -> null.
export function fmtCorrPct(r) {
  if (r == null) return null;
  return `${Math.round(Math.max(0, Math.min(1, r)) * 100)}%`;
}
