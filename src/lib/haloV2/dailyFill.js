// ============================================================
// Halo V2 — weekly / monthly values taken from the DAILY sheet.
//
// A weekly or monthly view reads the matching sheet when one exists, and with
// no monthly sheet the monthly view is rolled up from the weekly one. But the
// weekly sheet is usually a snapshot BUILT from the daily sheet on the day it
// was built (haloWeeklyBuild), and re-uploading the daily sheet does not
// rebuild it. So both views kept showing what the daily sheet held back then:
// Longevity's weekly sheet had no Amazon revenue before 26 Apr and zeros from
// July, while the daily sheet has "Total Revenue/Day" for every day from 1 Mar.
//
// For the metrics being charted, a period's value is therefore rolled up from
// the daily rows whenever the daily sheet covers the period (see `enough`). The
// coarse sheet still supplies what the daily sheet does not carry (weekly
// search volume, NTB) and any period the daily sheet does not cover. Periods
// the daily sheet covers beyond the coarse sheet's own span are added on the
// same anchors, so the view is not cut short by a sheet built before the
// latest daily upload.
//
// Imports carry explicit extensions so the test suite can load this in node.
// ============================================================

import { FIELD_BY_KEY } from '../haloFields.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

// Dates as whole days since the epoch, so a span is a plain integer range.
const toDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const toISO = (day) => {
  const dt = new Date(day * 86400000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
};
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;
};
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The days a bucket covers, [first, last]. Week buckets are keyed by the
// sheet's anchor, which is the week's START date (haloParse); months by YYYY-MM.
function spanOf(key, gran) {
  if (gran === 'week') { const s = toDay(key); return [s, s + 6]; }
  const s = toDay(`${key}-01`);
  return [s, s + daysInMonth(key) - 1];
}

// Whether `count` days of daily data can stand for the period [s, e]: 85% of
// its days (V1's month rule — 6 of 7 for a week, so one row missing from the
// middle of the daily sheet does not throw a week back to a stale figure). A
// week must also lie inside the daily sheet's span: one the sheet only partly
// reaches is a partial edge week, which V1 drops rather than under-counts.
const enough = (gran, count, [s, e], [first, last]) =>
  count > 0 && count >= (e - s + 1) * 0.85 && (gran !== 'week' || (s >= first && e <= last));

function rollDaily(byDay, key, span, gran, bounds) {
  const vals = [];
  for (let d = span[0]; d <= span[1]; d++) {
    const v = num(byDay.get(d)?.[key]);
    if (v != null) vals.push(v);
  }
  if (!enough(gran, vals.length, span, bounds)) return null;
  const sum = vals.reduce((a, v) => a + v, 0);
  return FIELD_BY_KEY[key]?.agg === 'avg' ? sum / vals.length : sum;
}

function labelOf(key, gran) {
  if (gran !== 'week') return key;
  const [s, e] = spanOf(key, gran).map(toISO);
  const day = (iso) => `${Number(iso.slice(8))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
  return `${day(s)} – ${day(e)} ${e.slice(0, 4)}`;
}

/**
 * buckets   — the coarse sheet's buckets for this view: [{ key, label, days, metrics }]
 * dailyRows — the daily sheet's rows, scoped the same way as the coarse rows
 * gran      — the view: 'week' or 'month'
 * keys      — the metrics to take from the daily sheet (the charted pair)
 * range     — { start, end }; only daily rows inside it are used, exactly as
 *             only coarse rows inside it are
 *
 * Returns { buckets, filled }: filled lists the keys that took at least one
 * value from the daily sheet that differs from the coarse sheet's.
 */
export function fillFromDaily({ buckets, dailyRows, gran, keys, range = {} }) {
  const none = { buckets: buckets || [], filled: [] };
  if ((gran !== 'week' && gran !== 'month') || !buckets?.length) return none;

  const byDay = new Map();
  for (const r of dailyRows || []) {
    if (!r?.date || !r.metrics) continue;
    if ((range.start && r.date < range.start) || (range.end && r.date > range.end)) continue;
    byDay.set(toDay(r.date), r.metrics);
  }
  // Only metrics the daily sheet actually carries: all zeros is how a sheet
  // writes a column it does not track (availSetForRows), so that is no source.
  const wanted = [...new Set(keys)].filter((k) => k && [...byDay.values()].some((m) => num(m[k])));
  if (!wanted.length) return none;

  const days = [...byDay.keys()].sort((a, b) => a - b);
  const bounds = [days[0], days[days.length - 1]];
  const covers = (key) => {
    const span = spanOf(key, gran);
    const anchor = gran === 'week' ? key : `${key}-01`;
    if ((range.start && anchor < range.start) || (range.end && anchor > range.end)) return false;
    return enough(gran, Math.min(span[1], bounds[1]) - Math.max(span[0], bounds[0]) + 1, span, bounds);
  };
  const step = (key, n) => (gran === 'week' ? toISO(toDay(key) + 7 * n) : addMonths(key, n));

  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const added = (key) => ({ key, label: labelOf(key, gran), days: 0, metrics: {} });
  for (let k = step(buckets[0].key, -1); covers(k); k = step(k, -1)) byKey.set(k, added(k));
  for (let k = step(buckets[buckets.length - 1].key, 1); covers(k); k = step(k, 1)) byKey.set(k, added(k));

  const filled = new Set();
  const out = [];
  for (const b of byKey.values()) {
    const span = spanOf(b.key, gran);
    let metrics = null;
    for (const k of wanted) {
      const daily = rollDaily(byDay, k, span, gran, bounds);
      if (daily == null) continue;
      const own = num(b.metrics?.[k]);
      // 0 is how these sheets write "not tracked" (availSetForRows), so a daily
      // zero never replaces a real figure the coarse sheet was filled with.
      if ((daily === 0 && own) || daily === own) continue;
      metrics = metrics || { ...b.metrics };
      metrics[k] = daily;
      filled.add(k);
    }
    const next = metrics ? { ...b, metrics } : b;
    if (Object.keys(next.metrics || {}).length) out.push(next);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { buckets: out, filled: [...filled] };
}
