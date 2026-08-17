// ============================================================
// Halo V2 — metric metadata (brief §35).
//
// Derived FROM the existing V1 field dictionary rather than duplicating it, so
// the two versions can never disagree about what a metric is. haloFields.js is
// imported read-only and is not modified: V1 keeps working exactly as it does.
//
// V1 already carries key/label/group/agg/fmt/inverse. This layer adds the
// vocabulary the brief asks for — platform, aggregationType, unit, direction,
// isMonetary, isRate, isInverse — without renaming anything underneath.
// ============================================================

import { HALO_FIELDS, FIELD_BY_KEY } from '../haloFields.js';

export function metricMeta(key) {
  const f = FIELD_BY_KEY[key];
  if (!f) return null;
  return {
    key: f.key,
    name: f.label,
    platform: f.group,                                   // 'tiktok' | 'amazon'
    aggregationType: f.agg === 'avg' ? 'average' : 'sum',
    unit: f.fmt === 'money' ? 'currency' : f.fmt === 'int' ? 'count' : 'number',
    direction: f.inverse ? 'lower_is_better' : 'higher_is_better',
    isMonetary: f.fmt === 'money',
    isRate: f.agg === 'avg',
    isInverse: !!f.inverse,
    hidden: !!f.hidden,
  };
}

export const ALL_METRIC_META = HALO_FIELDS.map((f) => metricMeta(f.key));

export const isInverseMetric = (key) => !!FIELD_BY_KEY[key]?.inverse;
export const isMonetaryMetric = (key) => FIELD_BY_KEY[key]?.fmt === 'money';
export const metricLabel = (key) => FIELD_BY_KEY[key]?.label || key;
export const metricPlatform = (key) => FIELD_BY_KEY[key]?.group || null;

// The sentence the UI shows next to an inverse metric so a negative raw
// correlation isn't read as bad news (brief §3, §27).
export function inverseNote(key) {
  if (!isInverseMetric(key)) return null;
  return `${metricLabel(key)} improves as its number falls, so a negative raw correlation here means the business outcome improved.`;
}
