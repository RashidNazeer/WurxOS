// Format a percentage-change value for display, capping the
// magnitude at 100%.
//
// A near-zero previous value (e.g. $0.01 → $76 = "768800%") makes the
// raw percentage explode and adds no real information. Cap the shown
// magnitude at 100% and suffix "+" so the reader can tell the actual
// change is larger.
//
// Examples:
//   formatPctChange(23.4)    → "+23.4%"
//   formatPctChange(-23.4)   → "-23.4%"
//   formatPctChange(768800)  → "+100%+"
//   formatPctChange(-200)    → "-100%+"
//   formatPctChange(23.4, { withSign: false }) → "23.4%"
//
// Returns '' for null/undefined/non-finite input so callers can drop
// the surrounding chip cleanly.
export function formatPctChange(pct, { withSign = true } = {}) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '';
  const abs = Math.abs(pct);
  const capped = abs > 100;
  const shown = capped ? '100' : abs.toFixed(1);
  const sign = !withSign ? '' : pct >= 0 ? '+' : '-';
  return `${sign}${shown}%${capped ? '+' : ''}`;
}
