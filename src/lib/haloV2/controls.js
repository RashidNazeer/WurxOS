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
    columns.push({ name: 'trend', values: periods.map((_, i) => i + 1), source: 'derived' });
    included.push('Trend');
  }

  for (const [flag, name, label] of [
    [options.promo, 'promo', 'Promotions'],
    [options.stockout, 'stockout', 'Stock-outs'],
  ]) {
    if (flag === false) continue;
    if (has(name)) {
      columns.push({ name, values: periods.map((p) => Number(p?.controls?.[name]) || 0), source: 'data' });
      included.push(label);
    } else {
      unavailable.push(`${label} — data unavailable`);
    }
  }

  for (const name of (options.optional || [])) {
    if (has(name)) {
      columns.push({ name, values: periods.map((p) => Number(p?.controls?.[name]) || 0), source: 'data' });
      included.push(name);
    } else {
      unavailable.push(`${name} — data unavailable`);
    }
  }

  // Fourier seasonality — two parameters per harmonic instead of eleven month
  // dummies, which matters enormously at these sample sizes (§12).
  if (options.seasonality !== false) {
    if (n >= SEASONALITY_MIN_WEEKS) {
      const t = periods.map((_, i) => i + 1);
      columns.push({ name: 'season_sin1', values: t.map((v) => Math.sin((2 * Math.PI * v) / 52)), source: 'derived' });
      columns.push({ name: 'season_cos1', values: t.map((v) => Math.cos((2 * Math.PI * v) / 52)), source: 'derived' });
      included.push('Annual seasonality');
      if (n >= SEASONALITY_SECOND_HARMONIC_MIN_WEEKS) {
        columns.push({ name: 'season_sin2', values: t.map((v) => Math.sin((4 * Math.PI * v) / 52)), source: 'derived' });
        columns.push({ name: 'season_cos2', values: t.map((v) => Math.cos((4 * Math.PI * v) / 52)), source: 'derived' });
        included.push('Seasonality (2nd harmonic)');
      }
    } else {
      unavailable.push('Seasonality — limited history (needs ~52 weeks)');
    }
  }

  // A control that never varies explains nothing and only costs a degree of
  // freedom, so drop it and say so.
  const kept = [];
  for (const c of columns) {
    const first = c.values[0];
    if (c.values.every((v) => v === first)) {
      const i = included.indexOf(c.name);
      if (i >= 0) included.splice(i, 1);
      unavailable.push(`${c.name} — no variation in this period`);
      continue;
    }
    kept.push(c);
  }

  return { columns: kept, included, unavailable };
}
