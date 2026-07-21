// ============================================================
// Amazon Halo Effect — correlation math.
//
// Everything the explorer needs to turn daily rows into correlations:
//   * date bucketing (day / week / month)
//   * lag pairing — the Amazon "effect" field is sampled `lag` days AFTER
//     the TikTok "cause" day, so the delayed halo lines up
//   * per-bucket aggregation (sum for counts/money, avg for ratios)
//   * Pearson r + a plain-English read of it
//   * a full correlation matrix (for the heatmap)
//   * min-max normalisation (for the multi-metric overlay)
// ============================================================

import { FIELD_BY_KEY } from './haloFields';

const pad2 = (n) => String(n).padStart(2, '0');
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isoOf = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;

export function addDays(s, n) { const dt = parseISO(s); dt.setUTCDate(dt.getUTCDate() + n); return isoOf(dt); }

// bucket key + human label for a date at a given granularity.
export function bucketOf(dateStr, gran) {
  if (gran === 'month') return { key: dateStr.slice(0, 7), label: dateStr.slice(0, 7) };
  if (gran === 'week') {
    const dt = parseISO(dateStr);
    const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
    dt.setUTCDate(dt.getUTCDate() - dow);
    const k = isoOf(dt);
    return { key: k, label: `wk ${k.slice(5)}` };
  }
  return { key: dateStr, label: dateStr.slice(5) };
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  const cov = n * sxy - sx * sy;
  const dx = Math.sqrt(n * sxx - sx * sx);
  const dy = Math.sqrt(n * syy - sy * sy);
  if (dx === 0 || dy === 0) return null;
  return cov / (dx * dy);
}

// index date -> metrics map from raw rows
export function indexByDate(rows) {
  const m = {};
  for (const r of rows) m[r.date] = r.metrics;
  return m;
}

// Which side is the lagging "effect"? amazon lags tiktok. Same group → no lag.
function lagRoles(fx, fy) {
  const gx = FIELD_BY_KEY[fx]?.group, gy = FIELD_BY_KEY[fy]?.group;
  return {
    xIsEffect: gx === 'amazon' && gy === 'tiktok',
    yIsEffect: gy === 'amazon' && gx === 'tiktok',
  };
}

// Build per-bucket aggregated (x, y) points for a field pair with a day lag.
export function pairSeries(byDate, dates, fx, fy, lag, gran) {
  const { xIsEffect, yIsEffect } = lagRoles(fx, fy);
  const aggX = FIELD_BY_KEY[fx]?.agg || 'sum';
  const aggY = FIELD_BY_KEY[fy]?.agg || 'sum';
  const buckets = new Map(); // key -> { label, xs:[], ys:[] }

  for (const d of dates) {
    const xDate = xIsEffect ? addDays(d, lag) : d;
    const yDate = yIsEffect ? addDays(d, lag) : d;
    const x = byDate[xDate]?.[fx];
    const y = byDate[yDate]?.[fy];
    if (x == null || y == null) continue;
    const b = bucketOf(d, gran);
    if (!buckets.has(b.key)) buckets.set(b.key, { label: b.label, xs: [], ys: [] });
    const slot = buckets.get(b.key);
    slot.xs.push(x); slot.ys.push(y);
  }

  const reduce = (arr, agg) => (agg === 'avg' ? arr.reduce((s, v) => s + v, 0) / arr.length : arr.reduce((s, v) => s + v, 0));
  const points = [];
  for (const [, slot] of buckets) {
    points.push({ label: slot.label, x: reduce(slot.xs, aggX), y: reduce(slot.ys, aggY) });
  }
  const r = pearson(points.map((p) => p.x), points.map((p) => p.y));
  return { points, r };
}

// Correlation matrix over rowKeys x colKeys (for the heatmap).
export function correlationMatrix(byDate, dates, rowKeys, colKeys, lag, gran) {
  return rowKeys.map((rk) =>
    colKeys.map((ck) => {
      if (rk === ck) return { r: 1, n: 0 };
      const { points, r } = pairSeries(byDate, dates, rk, ck, lag, gran);
      return { r, n: points.length };
    }),
  );
}

// Time series for the multi-metric overlay, min-max normalised to 0..100
// so differently-scaled metrics can share one axis (raw kept for tooltip).
export function overlaySeries(byDate, dates, keys, gran) {
  const buckets = new Map();
  for (const d of dates) {
    const m = byDate[d];
    if (!m) continue;
    const b = bucketOf(d, gran);
    if (!buckets.has(b.key)) buckets.set(b.key, { label: b.label, acc: {} });
    const slot = buckets.get(b.key);
    for (const k of keys) {
      if (m[k] == null) continue;
      (slot.acc[k] = slot.acc[k] || []).push(m[k]);
    }
  }
  const reduce = (arr, agg) => (agg === 'avg' ? arr.reduce((s, v) => s + v, 0) / arr.length : arr.reduce((s, v) => s + v, 0));
  const raw = [];
  for (const [, slot] of buckets) {
    const row = { label: slot.label };
    for (const k of keys) {
      row[k] = slot.acc[k] ? reduce(slot.acc[k], FIELD_BY_KEY[k]?.agg || 'sum') : null;
    }
    raw.push(row);
  }
  // normalise each key across buckets
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
  const a = Math.abs(r);
  const strength = a >= 0.8 ? 'very strong' : a >= 0.6 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'little/none';
  if (a < 0.2) return strength;
  return `${strength} ${r >= 0 ? 'positive' : 'negative'}`;
}

export function directionSentence(fx, fy, r) {
  if (r == null) return 'Not enough overlapping data to correlate these two yet.';
  const lx = FIELD_BY_KEY[fx]?.label || fx;
  const ly = FIELD_BY_KEY[fy]?.label || fy;
  const a = Math.abs(r);
  if (a < 0.2) return `No clear relationship between ${lx} and ${ly}.`;
  const dir = r >= 0 ? 'more' : 'less';
  return `${strengthLabel(r)} (r = ${r.toFixed(2)}): higher ${lx} tends to go with ${dir} ${ly}.`;
}

// ============================================================
// Weekly-native "search demand" correlation.
//
// Keyword Search Volume is only available WEEKLY (the Branded Demand subsheet,
// Week Ending = a Saturday). Correlating a weekly series against daily TikTok
// activity at a daily lag would be dishonest, so instead we roll the TikTok side
// up to the SAME Sun–Sat weeks and correlate week-over-week (lag in WEEKS). Only
// weeks with enough daily coverage count, so a half-populated edge week can't
// distort a sum. This lives apart from the daily pairSeries above.
// ============================================================

// The Sun–Sat week's ending SATURDAY for a date (matches the subsheet's
// "Week Ending" column). getUTCDay: Sun=0 … Sat=6, so add (6 - dow) days.
export function weekEndingOf(dateStr) {
  const dt = parseISO(dateStr);
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (6 - dow));
  return isoOf(dt);
}

// Roll daily rows up into Sun–Sat weeks keyed by their ending Saturday.
// Returns [{ week_ending, days, metrics:{field:aggregated} }] sorted ascending.
// `days` = how many daily rows fell in the week (used to drop partial weeks).
export function rollupWeeklyTikTok(rows, fields) {
  const buckets = new Map(); // week_ending -> { acc:{field:[]}, days }
  for (const r of rows || []) {
    const wk = weekEndingOf(r.date);
    if (!buckets.has(wk)) buckets.set(wk, { acc: {}, days: 0 });
    const slot = buckets.get(wk);
    slot.days += 1;
    for (const f of fields) {
      const v = r.metrics?.[f];
      if (v == null) continue;
      (slot.acc[f] = slot.acc[f] || []).push(v);
    }
  }
  const reduce = (arr, agg) => (agg === 'avg' ? arr.reduce((s, v) => s + v, 0) / arr.length : arr.reduce((s, v) => s + v, 0));
  const out = [];
  for (const [week_ending, slot] of buckets) {
    const metrics = {};
    for (const f of fields) {
      metrics[f] = slot.acc[f]?.length ? reduce(slot.acc[f], FIELD_BY_KEY[f]?.agg || 'sum') : null;
    }
    out.push({ week_ending, days: slot.days, metrics });
  }
  out.sort((a, b) => (a.week_ending < b.week_ending ? -1 : 1));
  return out;
}

// A week's branded search volume for one keyword, or the sum of ALL keywords
// when keyword is null. For the all-keywords total we require every EXPECTED
// keyword (allKeywords) to be present that week: the parser drops blank cells,
// so summing only the present keys would understate the total and fake a dip —
// an incomplete week returns null instead, so it's skipped rather than
// distorting the correlation. (Falls back to the present keys if no expected
// set is supplied.)
export function ksvWeekValue(keywordsObj, keyword, allKeywords) {
  if (!keywordsObj) return null;
  if (keyword) return keywordsObj[keyword] ?? null;
  const keys = allKeywords && allKeywords.length ? allKeywords : Object.keys(keywordsObj);
  if (!keys.length) return null;
  let sum = 0;
  for (const k of keys) {
    const v = keywordsObj[k];
    if (v == null) return null; // missing a component → can't total this week
    sum += v;
  }
  return sum;
}

// Pair weekly TikTok (rolled up) against weekly branded search, offset by
// `weekLag` weeks (TikTok week W → search week W+lag). Only weeks with
// >= minDays of daily coverage are used. `allKeywords` is the expected keyword
// set for the "All keywords" total. Returns { points:[{label,x,y}], r, n }.
export function weeklySearchPairs({ weeklyTikTok, ksvByWeek, tiktokKey, keyword, weekLag, minDays = 5, allKeywords }) {
  const points = [];
  for (const wk of weeklyTikTok) {
    if (wk.days < minDays) continue;
    const x = wk.metrics?.[tiktokKey];
    if (x == null) continue;
    const searchWeek = addDays(wk.week_ending, weekLag * 7);
    const y = ksvWeekValue(ksvByWeek.get(searchWeek), keyword, allKeywords);
    if (y == null) continue;
    points.push({ label: `wk ${wk.week_ending.slice(5)}`, x, y, week_ending: wk.week_ending });
  }
  return { points, r: pearson(points.map((p) => p.x), points.map((p) => p.y)), n: points.length };
}

// r in [-1,1] -> a red↔neutral↔green colour for the heatmap.
export function corrColor(r) {
  if (r == null) return 'var(--surface-2, #2a2a33)';
  const t = Math.max(-1, Math.min(1, r));
  // green for positive, red for negative, faint for near-zero
  const alpha = 0.12 + Math.abs(t) * 0.7;
  return t >= 0
    ? `rgba(34, 197, 94, ${alpha.toFixed(3)})`
    : `rgba(239, 68, 68, ${alpha.toFixed(3)})`;
}
