// ============================================================
// Amazon Halo Effect — correlation math (bucketed model).
//
// One granularity switch drives everything (Daily / Weekly / Monthly). We bucket
// the daily rows into that unit, then correlate any two metrics on the shared
// buckets with a lag measured in that same unit (days / weeks / months).
//
// Branded Search Volume is weekly-only: it has no daily rows, so it's injected
// straight into the weekly (or monthly) buckets from dataset.weekly_keywords —
// never spread across days. That's why it only exists at Weekly/Monthly.
//
// Weeks are Sun–Sat, keyed by the ending SATURDAY, to line up exactly with the
// "Branded Demand" subsheet's Week Ending column.
// ============================================================

import { FIELD_BY_KEY, KSV_KEY } from './haloFields';

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

// bucket key + label for a date at a granularity.
export function bucketOf(dateStr, gran) {
  if (gran === 'month') return { key: dateStr.slice(0, 7), label: dateStr.slice(0, 7) };
  if (gran === 'week') { const k = weekEndingOf(dateStr); return { key: k, label: `wk ${k.slice(5)}` }; }
  return { key: dateStr, label: dateStr.slice(5) };
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
  return Number.isFinite(r) ? r : null;
}

// index date -> metrics map from raw rows
export function indexByDate(rows) {
  const m = {};
  for (const r of rows) m[r.date] = r.metrics;
  return m;
}

// A week's branded search volume for one keyword, or the sum of ALL keywords
// when keyword is null. For the all-keywords total we require every EXPECTED
// keyword to be present that week (the parser drops blank cells, so summing only
// the present keys would understate the total and fake a dip) — an incomplete
// week returns null and is skipped. Falls back to present keys if no set given.
export function ksvWeekValue(keywordsObj, keyword, allKeywords) {
  if (!keywordsObj) return null;
  if (keyword) return keywordsObj[keyword] ?? null;
  const keys = allKeywords && allKeywords.length ? allKeywords : Object.keys(keywordsObj);
  if (!keys.length) return null;
  let sum = 0;
  for (const k of keys) {
    const v = keywordsObj[k];
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

// Which side is the lagging "effect"? amazon lags tiktok. Same group → no lag.
function lagRoles(fx, fy) {
  const gx = FIELD_BY_KEY[fx]?.group, gy = FIELD_BY_KEY[fy]?.group;
  return {
    xIsEffect: gx === 'amazon' && gy === 'tiktok',
    yIsEffect: gy === 'amazon' && gx === 'tiktok',
  };
}

/**
 * Bucket the daily rows into the chosen granularity and (at week/month) inject
 * any WEEKLY-native metrics (from weeklyMetrics) and, at month, MONTHLY-native
 * metrics (from monthlyMetrics). Branded search (KSV) keeps its own per-keyword
 * path via ksvByWeek so the keyword picker still works.
 *
 * A metric only exists in a bucket at granularities >= its native one: daily
 * metrics are aggregated up from the daily rows here; weekly/monthly-native
 * metrics have no daily rows and are injected straight into the coarser buckets.
 *
 * @returns Array<{ key, label, days, metrics:{fieldKey:value} }> sorted ascending
 */
export function buildBuckets({
  byDate, dates, gran, metricGran, weeklyMetrics, monthlyMetrics,
  ksvByWeek, keyword, allKeywords, minWeekDays = 7,
}) {
  const map = new Map();
  for (const d of dates) {
    const m = byDate[d];
    if (!m) continue;
    const b = bucketOf(d, gran);
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
  // Drop partial edge periods so their under-counted sums don't bias the
  // correlation: a partial week (weekly) or a month missing much of its days.
  if (gran === 'week') buckets = buckets.filter((b) => b.days >= minWeekDays);
  else if (gran === 'month') buckets = buckets.filter((b) => b.days >= daysInMonth(b.key) * 0.85);

  if (gran !== 'day') {
    const first = dates[0], last = dates[dates.length - 1];
    // KSV is weekly-native ONLY when it isn't in the daily rows (metricGran says
    // 'week', or there's no daily KSV and a ksvByWeek exists). When daily, it's
    // already bucketed above and must not be overwritten by the weekly total.
    const ksvNative = metricGran ? metricGran[KSV_KEY] : undefined;
    const ksvIsWeekly = !!(ksvByWeek && ksvByWeek.size) && ksvNative !== 'day';
    // A metric already aggregated from DAILY rows must never be overwritten by a
    // weekly/monthly injector — the daily aggregate honours the range-bound and
    // partial-edge completeness filters; the coarse value bypasses both.
    const isDayNative = (k) => !!(metricGran && metricGran[k] === 'day');

    // Weekly-native metrics keyed by their week-ending Saturday (matches bucketOf
    // at week granularity).
    const weekMap = new Map();
    for (const w of weeklyMetrics || []) if (w && w.period_end) weekMap.set(w.period_end, w.metrics || {});

    if (gran === 'week') {
      for (const b of buckets) {
        if (ksvIsWeekly) {
          const v = ksvWeekValue(ksvByWeek.get(b.key), keyword, allKeywords);
          if (v != null) b.metrics[KSV_KEY] = v;
        }
        const wm = weekMap.get(b.key);
        if (wm) for (const k in wm) { if (k === KSV_KEY && ksvIsWeekly) continue; if (isDayNative(k)) continue; if (wm[k] != null) b.metrics[k] = wm[k]; }
      }
    } else if (gran === 'month') {
      // Only weeks whose Week Ending falls inside the daily data span count, so
      // out-of-range demand can't contaminate an edge month and flip the sign.
      if (ksvIsWeekly) {
        const byMonth = {};
        for (const [we, kw] of ksvByWeek) {
          if ((first && we < first) || (last && we > last)) continue;
          const v = ksvWeekValue(kw, keyword, allKeywords);
          if (v == null) continue;
          const mk = we.slice(0, 7);
          byMonth[mk] = (byMonth[mk] || 0) + v;
        }
        for (const b of buckets) if (byMonth[b.key] != null) b.metrics[KSV_KEY] = byMonth[b.key];
      }
      // Other weekly-native metrics roll up to months by each field's agg.
      const monthAcc = {};
      for (const [we, wm] of weekMap) {
        if ((first && we < first) || (last && we > last)) continue;
        const mk = we.slice(0, 7);
        for (const k in wm) {
          if (k === KSV_KEY && ksvIsWeekly) continue;
          if (isDayNative(k)) continue;
          if (wm[k] == null) continue;
          (monthAcc[mk] = monthAcc[mk] || {});
          (monthAcc[mk][k] = monthAcc[mk][k] || []).push(wm[k]);
        }
      }
      for (const b of buckets) {
        const acc = monthAcc[b.key];
        if (acc) for (const k in acc) b.metrics[k] = reduce(acc[k], FIELD_BY_KEY[k]?.agg || 'sum');
      }
      // Monthly-native metrics inject directly (keyed by YYYY-MM).
      const monMap = new Map();
      for (const m of monthlyMetrics || []) if (m && m.period_end) monMap.set(String(m.period_end).slice(0, 7), m.metrics || {});
      for (const b of buckets) { const mm = monMap.get(b.key); if (mm) for (const k in mm) { if (isDayNative(k)) continue; if (mm[k] != null) b.metrics[k] = mm[k]; } }
    }
  }
  buckets.sort((a, b) => (a.key < b.key ? -1 : 1));
  return buckets;
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
  const a = Math.abs(r);
  const strength = a >= 0.8 ? 'very strong' : a >= 0.6 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'little/none';
  if (a < 0.2) return strength;
  return `${strength} ${r >= 0 ? 'positive' : 'negative'}`;
}

export function directionSentence(fx, fy, r, n) {
  if (r == null) {
    if (n != null && n >= 3) return 'One of these series has no variation over this range — a correlation can’t be computed.';
    return 'Not enough overlapping periods to correlate these two yet (need at least 3).';
  }
  const lx = FIELD_BY_KEY[fx]?.label || fx;
  const ly = FIELD_BY_KEY[fy]?.label || fy;
  const a = Math.abs(r);
  if (a < 0.2) return `No clear relationship between ${lx} and ${ly}${n ? ` (${n} points)` : ''}.`;
  const dir = r >= 0 ? 'more' : 'less';
  return `${strengthLabel(r)} (r = ${r.toFixed(2)}${n ? `, ${n} points` : ''}): higher ${lx} tends to go with ${dir} ${ly}.`;
}

// r in [-1,1] -> a red↔neutral↔green colour for the heatmap.
export function corrColor(r) {
  if (r == null) return 'var(--surface-2, #2a2a33)';
  const t = Math.max(-1, Math.min(1, r));
  const alpha = 0.12 + Math.abs(t) * 0.7;
  return t >= 0
    ? `rgba(34, 197, 94, ${alpha.toFixed(3)})`
    : `rgba(239, 68, 68, ${alpha.toFixed(3)})`;
}
