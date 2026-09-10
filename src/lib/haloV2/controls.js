// ============================================================
// Halo V2 — control variables (brief §10, §11, §12).
//
// The point of controls is to stop the model crediting TikTok for movement
// something else caused. Three matter most:
//   trend     — a brand growing anyway would otherwise show a positive halo
//               purely because both series rise over time
//   promotion — promotions move Amazon on their own
//   stock-out — TikTok can rise while Amazon revenue falls simply because the
//               ASIN was unavailable, which reads as a negative halo
//
// Nothing here is mandatory (§11). A control with no data is reported as
// unavailable rather than quietly assumed to be zero — the model states what it
// did and did not adjust for.
// ============================================================

// Seasonality needs a year of history before it means anything (§12).
export const SEASONALITY_MIN_WEEKS = 52;
export const SEASONALITY_SECOND_HARMONIC_MIN_WEEKS = 104;

// ── The control column register (brief §E5) ─────────────────────────
// ONE place that names every control the model will look for, what to call it
// on screen, which raw sheet column can stand in for it, and whether missing it
// caps how much confidence the model is allowed to claim.
//
// Why a register rather than parameters at the call site: a sheet that starts
// carrying `amazon_ads_spend` should get it used automatically. Previously the
// explorer passed only `promo` and `stockout`, so the other columns were read
// off the sheet, carried all the way through the adapter, and then silently
// never entered the regression — present in the data and absent from the model,
// with nothing on screen saying so.
//
// `major: true` means "leaving this out is a serious threat to the estimate".
// Promotions and stock-outs are the classic confounders (a promotion lifts both
// series; a stock-out drops Amazon while TikTok runs on), and paid Amazon media
// is the obvious rival explanation for Amazon revenue. Missing any of them caps
// confidence — see confidence.js.
export const CONTROL_SPECS = [
  { name: 'promo',            label: 'Promotions',       major: true,  aliases: ['discount_pct'] },
  { name: 'stockout',         label: 'Stock-outs',       major: true,  aliases: ['stockout_days'] },
  { name: 'amazon_ads_spend', label: 'Amazon Ads spend', major: true,  aliases: [] },
  { name: 'meta_spend',       label: 'Meta spend',       major: false, aliases: [] },
  { name: 'google_spend',     label: 'Google spend',     major: false, aliases: [] },
  { name: 'amazon_price',     label: 'Amazon price',     major: false, aliases: [] },
  { name: 'tiktok_price',     label: 'TikTok price',     major: false, aliases: [] },
  { name: 'dtc_price',        label: 'DTC price',        major: false, aliases: [] },
];

export const CONTROL_SPEC_BY_NAME = Object.fromEntries(CONTROL_SPECS.map((s) => [s.name, s]));
export const MAJOR_CONTROL_SPECS = CONTROL_SPECS.filter((s) => s.major);
// Every column name the adapter should carry through from a sheet, so
// dataAdapter and the regression can never disagree about the vocabulary.
export const ALL_CONTROL_COLUMNS = CONTROL_SPECS
  .flatMap((s) => [s.name, ...s.aliases]);

/**
 * Build the control design columns for a set of periods.
 *
 * periods: [{ key, controls?: { promo, stockout, ...optional } }]
 * options: { trend, promo, stockout, seasonality, optional: [names] }
 *
 * Returns { columns: [{ name, values, source }], included: [], unavailable: [] }
 */
export function buildControls(periods, options = {}) {
  const n = periods.length;
  const columns = [];
  const included = [];
  const unavailable = [];

  const has = (name) => periods.some((p) => Number.isFinite(Number(p?.controls?.[name])));

  if (options.trend !== false) {
    // 1..n. Centred would be equivalent for fit; kept literal so the printed
    // coefficient reads as "per period".
    columns.push({ name: 'trend', label: 'Trend', values: periods.map((_, i) => i + 1), source: 'derived' });
    included.push('Trend');
  }

  // Every registered control is considered automatically. A caller can still
  // switch one off explicitly (options[name] === false), but nothing has to be
  // opted IN — so a sheet that gains a column starts being adjusted for it
  // without a code change, which is the point of the register.
  //
  // `missingMajor` is tracked structurally rather than only as display text,
  // because confidence.js has to make a decision on it and parsing English out
  // of the `unavailable` strings to do that would be absurd.
  const missingMajor = [];
  for (const spec of CONTROL_SPECS) {
    if (options[spec.name] === false) continue;
    if (has(spec.name)) {
      columns.push({ name: spec.name, label: spec.label, values: periods.map((p) => Number(p?.controls?.[spec.name]) || 0), source: 'data' });
      included.push(spec.label);
    } else {
      unavailable.push(`${spec.label} — data unavailable`);
      if (spec.major) missingMajor.push({ name: spec.name, label: spec.label, reason: 'data unavailable' });
    }
  }

  // Escape hatch kept for any column not in the register.
  for (const name of (options.optional || [])) {
    if (CONTROL_SPEC_BY_NAME[name]) continue;      // already handled above
    if (has(name)) {
      columns.push({ name, values: periods.map((p) => Number(p?.controls?.[name]) || 0), source: 'data' });
      included.push(name);
    } else {
      unavailable.push(`${name} — data unavailable`);
    }
  }

  // Fourier seasonality — two parameters per harmonic instead of eleven month
  // dummies, which matters enormously at these sample sizes (§12).
  //
  // `seasonalityIncluded` is returned as a fact rather than left to be inferred,
  // because the explorer was printing "adjusted for trend and seasonality"
  // whenever promotions and stock-outs were absent -- regardless of whether
  // seasonality had actually been estimated. Below 52 periods it had not been,
  // so the UI claimed an adjustment the model never made.
  let seasonalityIncluded = false;
  let seasonalityReason = null;
  if (options.seasonality === false) {
    seasonalityReason = 'switched off';
  } else if (n >= SEASONALITY_MIN_WEEKS) {
    const t = periods.map((_, i) => i + 1);
    columns.push({ name: 'season_sin1', label: 'Annual seasonality', values: t.map((v) => Math.sin((2 * Math.PI * v) / 52)), source: 'derived' });
    columns.push({ name: 'season_cos1', label: 'Annual seasonality', values: t.map((v) => Math.cos((2 * Math.PI * v) / 52)), source: 'derived' });
    included.push('Annual seasonality');
    seasonalityIncluded = true;
    if (n >= SEASONALITY_SECOND_HARMONIC_MIN_WEEKS) {
      columns.push({ name: 'season_sin2', label: 'Seasonality (2nd harmonic)', values: t.map((v) => Math.sin((4 * Math.PI * v) / 52)), source: 'derived' });
      columns.push({ name: 'season_cos2', label: 'Seasonality (2nd harmonic)', values: t.map((v) => Math.cos((4 * Math.PI * v) / 52)), source: 'derived' });
      included.push('Seasonality (2nd harmonic)');
    }
  } else {
    seasonalityReason = `needs about ${SEASONALITY_MIN_WEEKS} periods, this window has ${n}`;
    unavailable.push(`Seasonality — limited history (needs ~${SEASONALITY_MIN_WEEKS} periods)`);
  }

  // A control that never varies explains nothing and only costs a degree of
  // freedom, so drop it and say so.
  //
  // The removal used to look the column's `name` up in `included`, which holds
  // LABELS -- so it never matched. A promotions column that happened to be flat
  // across the window was dropped from the regression and still rendered as
  // "checkmark Promotions" in the controls panel: the exact dishonesty this
  // section of the brief exists to remove. Columns now carry their own label.
  const kept = [];
  for (const c of columns) {
    const first = c.values[0];
    if (c.values.every((v) => v === first)) {
      const label = c.label || c.name;
      const i = included.indexOf(label);
      if (i >= 0) included.splice(i, 1);
      unavailable.push(`${label} — no variation in this period`);
      const spec = CONTROL_SPEC_BY_NAME[c.name];
      if (spec?.major && !missingMajor.some((m) => m.name === spec.name)) {
        missingMajor.push({ name: spec.name, label: spec.label, reason: 'no variation in this period' });
      }
      if (c.name.startsWith('season_')) { seasonalityIncluded = false; seasonalityReason = 'no variation in this period'; }
      continue;
    }
    kept.push(c);
  }

  return {
    columns: kept,
    included,
    unavailable,
    // Structural facts the UI and confidence.js act on, rather than prose.
    missingMajor,
    seasonalityIncluded,
    seasonalityReason,
    trendIncluded: included.includes('Trend'),
  };
}
