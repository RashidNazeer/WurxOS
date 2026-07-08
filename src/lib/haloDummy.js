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
  const out = rows.map((r) => ({ date: r.date, metrics: { ...r.metrics }, dummyFields: [] }));
  if (want.length === 0) return { rows: out, filled: [] };

  const LAG = 2; // halo delay in days (index-based; sheet is daily)
  for (let i = 0; i < out.length; i++) {
    const m = out[i].metrics;
    const src = out[Math.max(0, i - LAG)].metrics; // lagged TikTok drivers

    if (want.includes('keyword_search_volume')) {
      const reach = (src.unique_impressions ?? src.product_impressions ?? 0);
      const vids = (src.video_per_day ?? 0);
      const base = 0.004 * reach + 8 * vids + 120;
      m.keyword_search_volume = Math.max(0, Math.round(base * jitter(out[i].date + 'ksv', 0.15)));
      out[i].dummyFields.push('keyword_search_volume');
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
