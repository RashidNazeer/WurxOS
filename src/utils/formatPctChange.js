// Percentage-change helpers for report cards / stat chips.
//
// Two concerns, kept together because they're always used as a pair:
//   pctChange()       — compute a current-vs-previous change ROBUSTLY,
//                       including the divide-by-zero cases that used to
//                       return null and hide the whole "vs prev week" graph.
//   formatPctChange() — render that number, capping the magnitude at 100%.
//
// A near-zero previous value (e.g. $0.01 → $76 = "768800%") makes the raw
// percentage explode and adds no real information. We cap the SHOWN magnitude
// at 100% and suffix "+" so the reader can tell the real change is larger.
// Growth from exactly zero is an infinite increase — we model that as
// Infinity and let the cap render it as "+100%+" (rather than dropping the
// chip, which is what the old `null` did and why some cards showed no graph).
//
// Examples:
//   formatPctChange(23.4)     → "+23.4%"
//   formatPctChange(-23.4)    → "-23.4%"
//   formatPctChange(768800)   → "+100%+"
//   formatPctChange(Infinity) → "+100%+"
//   formatPctChange(-200)     → "-100%+"
//   formatPctChange(0, { withSign: false }) → "0.0%"
//
// Returns '' for null/undefined/NaN input so callers can drop the chip cleanly.
export function formatPctChange(pct, { withSign = true } = {}) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '';
  const abs = Math.abs(pct);
  const capped = abs > 100; // also true for ±Infinity (growth/drop from zero)
  const shown = capped ? '100' : abs.toFixed(1);
  const sign = !withSign ? '' : pct >= 0 ? '+' : '-';
  return `${sign}${shown}%${capped ? '+' : ''}`;
}

// Robust percent change of `curr` vs `prev`.
//   hasPrev = false        → null  (no previous report — nothing to compare)
//   prev > 0               → exact ((curr - prev) / prev) * 100
//   prev = 0, curr > 0     → Infinity  (grew from nothing → renders "+100%+")
//   prev = 0, curr = 0     → 0         (flat — both periods empty)
//
// Pass `hasPrev` from whether a previous report actually exists (e.g.
// `!!findPreviousReport(...)`). Pair the result with formatPctChange for
// display; null is the ONLY value callers should treat as "no chip".
export function pctChange(curr, prev, hasPrev = true) {
  if (!hasPrev) return null;
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  if (p > 0) return ((c - p) / p) * 100;
  return c > 0 ? Infinity : 0;
}

// Direction of a change for color/arrow choice: 1 up, -1 down, 0 flat,
// null when there's no change value. Keeps the "flat = neutral, not green-up"
// styling consistent across cards.
export function pctChangeDir(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  return pct > 0 ? 1 : pct < 0 ? -1 : 0;
}
