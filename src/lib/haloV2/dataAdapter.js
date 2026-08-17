// ============================================================
// Halo V2 — turn the existing halo datasets into the model's period rows.
//
// Deliberately reuses V1's bucketing (buildBucketsFromSource) rather than
// re-implementing it: brief §15 says the aggregation rules — SUM totals, AVERAGE
// rates, drop partial edge periods — are correct and must not change. Importing
// them means V1 and V2 can never disagree about what "week 12" contains.
//
// Everything here is READ-ONLY against V1. No V1 module is modified.
// ============================================================

import { buildBucketsFromSource } from '../haloMath';
import { KSV_KEY, KSR_KEY, PRODUCT_REVENUE_FIELD, availSetForRows, fieldsAvail } from '../haloFields';

// Control columns the model will look for on each row, if a sheet ever carries
// them. Absent → reported as unavailable rather than assumed zero (§11).
export const CONTROL_KEYS = ['promo', 'discount_pct', 'stockout', 'stockout_days',
  'amazon_ads_spend', 'meta_spend', 'google_spend', 'amazon_price', 'tiktok_price', 'dtc_price'];

// Same source-selection rule as the V1 explorer: exact sheet for the view
// granularity, else the finest FINER sheet rolled up.
export function sourceForGran(datasets, gran) {
  const byGran = {};
  for (const d of (datasets || [])) if (d?.granularity) byGran[d.granularity] = d;
  if (gran === 'day') return byGran.day ? { dataset: byGran.day, sourceGran: 'day' } : null;
  if (gran === 'week') {
    if (byGran.week) return { dataset: byGran.week, sourceGran: 'week' };
    if (byGran.day) return { dataset: byGran.day, sourceGran: 'day' };
    return null;
  }
  if (byGran.month) return { dataset: byGran.month, sourceGran: 'month' };
  if (byGran.week) return { dataset: byGran.week, sourceGran: 'week' };
  if (byGran.day) return { dataset: byGran.day, sourceGran: 'day' };
  return null;
}

export function availableGrans(datasets) {
  return ['day', 'week', 'month'].filter((g) => sourceForGran(datasets, g));
}

export function availableFields(rows) {
  return fieldsAvail(availSetForRows(rows));
}

/**
 * Build the aligned period rows the V2 engine consumes.
 *
 *   rows        — raw dataset rows from getHaloRows()
 *   sourceGran  — the sheet's own granularity
 *   gran        — the view granularity
 *   xKey / yKey — TikTok metric and Amazon metric
 *   range       — { start, end } ISO bounds, optional
 *   scope       — { product, keyword, rankKeyword } optional column scoping
 *
 * Returns { periods, buckets }. A period's x or y is null when that metric has
 * no value for the bucket — missing stays missing (§29), never zero.
 */
export function buildPeriods({ rows, sourceGran, gran, xKey, yKey, range = {}, scope = {} }) {
  if (!rows || !rows.length || !sourceGran) return { periods: [], buckets: [] };

  const scoped = rows
    .filter((r) => (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end))
    .map((r) => {
      const metrics = { ...r.metrics };
      if (scope.product) metrics[PRODUCT_REVENUE_FIELD] = r.productRevenue?.[scope.product] ?? null;
      if (scope.keyword) metrics[KSV_KEY] = r.keywords?.[scope.keyword] ?? null;
      if (scope.rankKeyword) metrics[KSR_KEY] = r.keywordRanks?.[scope.rankKeyword] ?? null;
      // Carry any control columns straight through so the regression can use
      // them the moment a sheet starts providing them.
      for (const k of CONTROL_KEYS) if (r.metrics?.[k] != null) metrics[k] = r.metrics[k];
      return { date: r.date, periodLabel: r.periodLabel, metrics };
    });

  const buckets = buildBucketsFromSource({ rows: scoped, sourceGran, targetGran: gran });

  const periods = buckets.map((b) => {
    const controls = {};
    for (const k of CONTROL_KEYS) if (b.metrics?.[k] != null) controls[k] = Number(b.metrics[k]);
    // stockout_days / discount_pct stand in for their 0/1 flags when only the
    // richer column exists, so a sheet doesn't have to provide both.
    if (controls.stockout == null && controls.stockout_days != null) controls.stockout = controls.stockout_days > 0 ? 1 : 0;
    if (controls.promo == null && controls.discount_pct != null) controls.promo = controls.discount_pct > 0 ? 1 : 0;
    return {
      key: b.key,
      label: b.label,
      x: numOrNull(b.metrics?.[xKey]),
      y: numOrNull(b.metrics?.[yKey]),
      controls,
    };
  });

  return { periods, buckets };
}

// Which controls actually have data across these periods — drives the
// "Controls included / unavailable" list the brief insists on (§11).
export function detectControls(periods) {
  const found = {};
  for (const k of CONTROL_KEYS) {
    found[k] = (periods || []).some((p) => Number.isFinite(Number(p?.controls?.[k])));
  }
  return found;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
