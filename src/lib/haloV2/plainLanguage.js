// ============================================================
// Halo V2 — plain language.
//
// The reader is a brand CMO, not a data scientist. They need three answers in
// about thirty seconds: what moved, how sure we are, and what they must not
// claim. Everything in this file exists to produce those sentences.
//
// It is a SEPARATE layer from haloFields.js on purpose. That dictionary is
// shared with V1 and with the spreadsheet parser — its `label` values are
// matched against sheet headers on import, so renaming "GMV" there would break
// parsing. Plain-English names belong to the V2 presentation layer only.
// ============================================================

import { FIELD_BY_KEY, fmtValue } from '../haloFields.js';

// ── Metric names a client can read ──────────────────────────────────
// The rule the brief gives: translate on first use, and keep the acronym in
// parentheses so an analyst reading over their shoulder still recognises it.
const PLAIN = {
  gmv:                   'TikTok Shop sales (GMV)',
  items_sold:            'TikTok Shop items sold',
  orders:                'TikTok Shop orders',
  aov:                   'TikTok Shop average order value (AOV)',
  live_gmv:              'TikTok LIVE sales (GMV)',
  video_per_day:         'TikTok videos posted per day',
  product_impressions:   'TikTok product impressions',
  unique_impressions:    'TikTok unique viewers',
  product_clicks:        'TikTok product clicks',
  unique_clicks:         'TikTok unique clicks',
  cost:                  'TikTok ad spend',
  cpo:                   'TikTok cost per order (CPO)',
  gross_revenue:         'TikTok gross revenue',
  roi:                   'TikTok return on investment (ROI)',
  gmvmax_orders:         'GMV Max orders',
  ntb:                   'Amazon new-to-brand orders (NTB)',
  keyword_search_volume: 'Amazon branded search volume',
  revenue_per_day:       'Amazon revenue',
  keyword_search_rank:   'Amazon keyword search rank',
};

export function plainMetricLabel(key) {
  return PLAIN[key] || FIELD_BY_KEY[key]?.label || key;
}

/** "TikTok Shop sales (GMV)" vs "Amazon revenue" — the comparison, in words. */
export function comparisonSentence(xKey, yKey) {
  return `${plainMetricLabel(xKey)} vs ${plainMetricLabel(yKey)}`;
}

// ── Value formatting (builder-prompt Bug B) ─────────────────────────
// Chart tooltips rendered raw floats — 733.3333333333333. Recharts prints
// whatever it is handed, and the "Over time" tooltip had no formatter at all.
//
// A tooltip is where a client reads an actual number, so it has to carry the
// unit and stop at a sensible precision: money as currency, counts as whole
// numbers, rates to two decimals, and an indexed series to one with no unit
// (an index is not dollars).
export function formatMetricValue(v, key, { indexed = false } = {}) {
  // Non-FINITE, not merely non-NaN. A ratio metric (ROI, CPO, videos per day)
  // divided by a zero denominator arrives here as Infinity, and both
  // toLocaleString and toFixed render that verbatim — so a client tooltip could
  // read "Infinity". haloFields.fmtValue guards null and NaN but not this, and
  // it is shared with V1, so the guard belongs in the V2 presentation layer.
  if (v == null || !Number.isFinite(Number(v))) return '—';
  if (indexed) return Number(v).toFixed(1);
  const fmt = FIELD_BY_KEY[key]?.fmt || 'num';
  return fmtValue(Number(v), fmt);
}

/** Unit suffix for an axis or a legend, where one reads naturally. */
export function metricUnitHint(key) {
  const f = FIELD_BY_KEY[key];
  if (!f) return null;
  if (f.fmt === 'money') return 'currency';
  if (f.fmt === 'int') return 'count';
  return null;
}

// ── Glossary (brief §7) ─────────────────────────────────────────────
// Every term the page uses that a brand manager cannot be assumed to know.
// Definitions are deliberately about what the term means HERE, not textbook
// definitions — "attributed" means something specific in this tool.
export const GLOSSARY = [
  {
    term: 'GMV',
    short: 'TikTok Shop sales',
    def: 'Gross Merchandise Value — the total value of goods sold through TikTok Shop before returns, fees or discounts.',
  },
  {
    term: 'NTB',
    short: 'New-to-brand',
    def: 'New-to-brand orders on Amazon: purchases from customers who have not bought this brand on Amazon in the past year. A proxy for genuinely new demand rather than repeat buying.',
  },
  {
    term: 'Halo',
    short: 'Off-platform movement',
    def: 'The idea that TikTok activity moves demand on OTHER channels — here, Amazon. This tool measures whether the two move together; it cannot prove one caused the other.',
  },
  {
    term: 'Modelled',
    short: 'Estimated, not observed',
    def: 'A figure produced by a statistical model after adjusting for the other factors we have data for. It is an estimate of association, not a measured fact.',
  },
  {
    term: 'Incremental',
    short: 'Extra sales that would not have happened',
    def: 'Sales that genuinely would not have occurred without the activity. Establishing this needs a controlled test — a geo holdout or similar — which this tool does not run. Nothing here is incremental.',
  },
  {
    term: 'Attributed',
    short: 'Credited by a tracking rule',
    def: 'Sales a platform credits to an ad or a click by its own tracking rule. Different from both modelled association and incremental lift, and usually the largest of the three.',
  },
  {
    term: 'Lag',
    short: 'A delay before an effect shows',
    def: 'How many days, weeks or months later an effect might appear. A lag of 0 means the same period — which is co-movement, not a delay.',
  },
  {
    term: 'Counterfactual',
    short: 'What the model thinks would have happened otherwise',
    def: 'What the model estimates Amazon would have done if TikTok activity had stayed at a quiet baseline instead of what actually happened. The gap between the two is the modelled contribution.',
  },
  {
    term: 'Confidence',
    short: 'How much weight to put on the estimate',
    def: 'A rating that blends how much history there is, how wide the uncertainty is, whether the lags agree, and how much we could control for. It is capped when a major factor such as promotions is missing.',
  },
  {
    term: '95% interval',
    short: 'The plausible range',
    def: 'The range the true value is likely to sit in. If it includes zero, even the DIRECTION of the relationship is unresolved.',
  },
  {
    term: 'Correlation',
    short: 'Moving together',
    def: 'Two things rising and falling together. It can happen because one drives the other, because a third thing drives both, or by chance. It is never proof of cause.',
  },
  {
    term: 'Distributed lag',
    short: 'Effects spread over several periods',
    def: 'A model that allows an effect to show up over several days or weeks rather than all at once, and reports the total across that window.',
  },
];

export const GLOSSARY_BY_TERM = Object.fromEntries(GLOSSARY.map((g) => [g.term.toLowerCase(), g]));
export const glossaryFor = (term) => GLOSSARY_BY_TERM[String(term || '').toLowerCase()] || null;

// ── The key takeaway (brief §1) ─────────────────────────────────────
// One plain-English sentence answering "what happened?", plus how sure we are
// and what must not be claimed.
//
// The headline is built from the strongest OBSERVED correlation rather than the
// model, because it must render even when the model refuses — thin data is
// exactly when a client most needs a readable answer instead of a blank panel.

const pct = (r) => `${r > 0 ? '+' : ''}${Math.round(r * 100)}%`;

/**
 * @returns {{
 *   headline: string, strength: string|null, direction: 'positive'|'negative'|'none',
 *   confidenceLabel: string|null, observations: number, observationUnit: string,
 *   caveat: string, soWhat: string, canPlan: boolean, hasFinding: boolean,
 * }}
 */
export function keyTakeaway(result, { unit = 'period', xKey, yKey } = {}) {
  const o = result?.observed || {};
  const m = result?.adjustedModel || {};
  const rows = o.lagCorrelations || [];
  const best = rows.find((r) => r.lag === o.bestObservedLag) || null;
  const r = best?.correlation ?? null;

  const xName = plainMetricLabel(xKey);
  const yName = plainMetricLabel(yKey);
  const unitWord = unit === 'period' ? 'period' : unit;
  const obs = best?.numberOfObservations ?? 0;

  // No computable correlation — say what is missing, not nothing.
  if (r == null) {
    return {
      headline: `Not enough overlapping ${unitWord}s yet to say how ${xName} and ${yName} moved together.`,
      strength: null,
      direction: 'none',
      confidenceLabel: m.available ? m.confidenceLabel : null,
      observations: obs,
      observationUnit: unitWord,
      // Still carries the correlation-is-not-causation phrase the brief
      // requires to stay visible. Phrased conditionally because on this branch
      // no correlation has been computed yet — but the caveat has to be on
      // screen BEFORE the first number arrives, not after.
      caveat: 'Even where these move together, that is correlation — not proof TikTok caused Amazon sales.',
      soWhat: 'Widen the date range or switch view to get a first read. The charts below still show what data there is.',
      canPlan: false,
      hasFinding: false,
    };
  }

  const together = r > 0 ? 'moved together' : 'moved in opposite directions';
  const when = best.lag === 0
    ? `on the same ${unitWord}`
    : `strongest ${best.lag} ${unitWord}${best.lag === 1 ? '' : 's'} later`;

  const strength = Math.abs(r) >= 0.7 ? 'strong'
    : Math.abs(r) >= 0.4 ? 'moderate'
    : Math.abs(r) >= 0.15 ? 'weak'
    : 'negligible';

  const canPlan = !!result?.planningEligibility?.eligible;

  // The "so what" has to change with the gates, or it is decoration. A client
  // reading "use this for planning" next to a locked planning section learns
  // that the page contradicts itself.
  const soWhat = canPlan
    ? 'You can use this for spend scenarios — as a planning assumption, not a forecast of lift.'
    : m.available
      ? 'Treat this as supporting evidence, not a basis for spend scenarios yet — the planning section explains what is missing.'
      : 'Treat this as a first look. There is not enough history for a modelled estimate, so no spend scenarios.';

  return {
    headline: `${xName} and ${yName} ${together} ${pct(r)} ${when}.`,
    strength,
    direction: r > 0 ? 'positive' : 'negative',
    confidenceLabel: m.available ? m.confidenceLabel : null,
    observations: obs,
    observationUnit: unitWord,
    caveat: 'This is correlation, not proof TikTok caused Amazon sales.',
    soWhat,
    canPlan,
    hasFinding: strength !== 'negligible',
  };
}

// ── Plain-English data-limit warnings (brief §3) ────────────────────
// The coverage note under the primary chart. Soft, factual, and never phrased
// as an error — a young brand has thin data, which is a fact about the brand
// and not a fault in the page.
export function coverageNote({ periodsSupplied, completeObservations, unit = 'period' }) {
  const missing = Math.max(0, (periodsSupplied || 0) - (completeObservations || 0));
  const parts = [
    `${completeObservations || 0} of ${periodsSupplied || 0} ${unit}s have both metrics.`,
  ];
  if (missing > 0) {
    parts.push(`${missing} ${missing === 1 ? `${unit} is` : `${unit}s are`} missing one side and left out rather than counted as zero.`);
  }
  return parts.join(' ');
}
