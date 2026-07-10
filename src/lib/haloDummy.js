// ============================================================
// Amazon Halo Effect — meaningful test data.
//
// Keyword Search Volume and Revenue/Day are empty in the real sheet today.
// For TESTING the correlation views we optionally backfill them with values
// that are deliberately *correlated* (not random), so the graphs show a real
// signal. The relationship intentionally mimics the halo hypothesis:
//   * Keyword Search Volume tracks TikTok reach (impressions + videos/day)
//     from ~2 days earlier — the delayed spillover.
//   * Revenue/Day tracks units sold (NTB) and GMV on the same day.
// Noise is deterministic (seeded by date) so re-parsing gives stable values.
//
// Every value produced this way is recorded in the row's dummyFields, so the
// UI can badge it and Boss knows it isn't real. Real data always wins.
// ============================================================

import { DUMMY_CAPABLE } from './haloFields';

// Fixed set of realistic dummy keywords the aggregate Keyword Search Volume
// is split across, each with a stable base share of the day's total. The
// shares are jittered per day+keyword (deterministic) so every keyword has
// its own believable daily curve that still sums back to the aggregate.
// Realistic dummy search terms for a pain-relief brand (Penetrex). The first
// is the branded query (steadiest, biggest share); the rest are generic
// category terms. Swap this list per brand if you test another one.
//   w = share of the day's total search VOLUME (biggest for the branded term)
//   r = the keyword's baseline search RANK (1 = top of results). Branded terms
//       rank best; broad terms rank worse. Daily rank improves (drops) on
//       high-reach days, so rank correlates INVERSELY with TikTok reach.
export const DUMMY_KEYWORDS = [
  { kw: 'penetrex',               w: 0.28, r: 3  },
  { kw: 'pain relief cream',      w: 0.22, r: 12 },
  { kw: 'muscle and joint cream', w: 0.18, r: 18 },
  { kw: 'arthritis pain relief',  w: 0.14, r: 23 },
  { kw: 'back pain relief cream', w: 0.10, r: 29 },
  { kw: 'nerve pain cream',       w: 0.08, r: 35 },
];

// mulberry32 seeded from a string → stable pseudo-random in [0,1).
function seededRand(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// noise multiplier around 1.0, +/- `amp`
const jitter = (seed, amp) => 1 + (seededRand(seed) * 2 - 1) * amp;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Split a day's aggregate Keyword Search Volume across the fixed dummy
// keywords. Base shares are jittered per day+keyword (deterministic) then
// renormalised; the last keyword absorbs the rounding remainder so the parts
// sum EXACTLY back to the aggregate. Returns { keyword: dailyVolume }.
function splitKeywords(agg, date) {
  if (!agg || agg <= 0) return {};
  const weighted = DUMMY_KEYWORDS.map(({ kw, w }) => ({
    kw,
    w: Math.max(0, w * jitter(date + 'kw' + kw, 0.32)),
  }));
  const total = weighted.reduce((s, x) => s + x.w, 0) || 1;
  const out = {};
  let assigned = 0;
  weighted.forEach((x, i) => {
    if (i < weighted.length - 1) {
      const v = Math.round((agg * x.w) / total);
      out[x.kw] = v;
      assigned += v;
    } else {
      out[x.kw] = Math.max(0, agg - assigned); // remainder → exact sum
    }
  });
  return out;
}

// Is a field effectively empty across the dataset? (present in <10% of rows)
function isEmptyColumn(rows, key) {
  const present = rows.filter((r) => r.metrics[key] != null).length;
  return present < rows.length * 0.1;
}

/**
 * @param {Array<{date, metrics}>} rows  parsed rows, sorted by date
 * @param {{ fields?: string[] }} opts    which empty columns to fill
 * @returns {{ rows: Array<{date, metrics, dummyFields}>, filled: string[] }}
 */
export function fillDummyColumns(rows, opts = {}) {
  const want = (opts.fields || DUMMY_CAPABLE).filter((k) => isEmptyColumn(rows, k));
  // Preserve any REAL per-keyword breakdowns already parsed from the sheet —
  // dummy only ever fills columns that were empty across the dataset.
  const out = rows.map((r) => ({
    date: r.date,
    metrics: { ...r.metrics },
    dummyFields: [],
    keywords: { ...(r.keywords || {}) },
    keywordRanks: { ...(r.keywordRanks || {}) },
  }));
  if (want.length === 0) return { rows: out, filled: [] };

  const LAG = 2; // halo delay in days (index-based; sheet is daily)
  for (let i = 0; i < out.length; i++) {
    const m = out[i].metrics;
    const src = out[Math.max(0, i - LAG)].metrics; // lagged TikTok drivers

    if (want.includes('keyword_search_volume')) {
      const reach = (src.unique_impressions ?? src.product_impressions ?? 0);
      const vids = (src.video_per_day ?? 0);
      const base = 0.004 * reach + 8 * vids + 120;
      const agg = Math.max(0, Math.round(base * jitter(out[i].date + 'ksv', 0.15)));
      m.keyword_search_volume = agg;
      out[i].keywords = splitKeywords(agg, out[i].date); // per-keyword breakdown
      out[i].dummyFields.push('keyword_search_volume');
    }
    if (want.includes('keyword_search_rank')) {
      // Per-keyword rank IMPROVES (drops toward 1) as lagged TikTok reach rises,
      // so keyword rank correlates inversely with reach. reachScore ∈ [0,1].
      const reach = (src.unique_impressions ?? src.product_impressions ?? 0);
      const vids = (src.video_per_day ?? 0);
      const reachScore = clamp01(0.55 * (reach / 80000) + 0.45 * (vids / 40));
      const ranks = {};
      for (const { kw, r } of DUMMY_KEYWORDS) {
        const improved = r * (1 - 0.55 * reachScore);
        ranks[kw] = Math.max(1, Math.round(improved * jitter(out[i].date + 'rank' + kw, 0.18)));
      }
      out[i].keywordRanks = ranks;
      const vals = Object.values(ranks);
      m.keyword_search_rank = Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 100) / 100;
      out[i].dummyFields.push('keyword_search_rank');
    }
    if (want.includes('revenue_per_day')) {
      const ntb = (m.ntb ?? 0);
      const gmv = (m.gmv ?? 0);
      const base = 3.2 * ntb + 0.4 * gmv + 150;
      m.revenue_per_day = Math.max(0, Math.round(base * jitter(out[i].date + 'rev', 0.12)));
      out[i].dummyFields.push('revenue_per_day');
    }
  }
  return { rows: out, filled: want };
}
