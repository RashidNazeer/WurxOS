// The Product Highlights figure changed meaning on 2026-07-06. Reports authored
// BEFORE that date recorded per-product "units / items sold"; from that date on
// the figure is Euka ORDERS (typically a smaller number). Labelling every report
// "Orders" would mislead readers of older reports — a historical units-sold value
// (higher) would appear under an "Orders" header. So we label each report by WHEN
// it was authored: older reports keep "Units Sold", new ones say "Orders".
//
// `createdAt` may be a Firestore-shim object ({toMillis|seconds|toDate}), a Date,
// an ISO string, or null (a brand-new, unsaved report → use the going-forward
// label "Orders").
export const ORDERS_LABEL_SINCE = Date.UTC(2026, 6, 6); // 2026-07-06 00:00 UTC

function toMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const n = new Date(v).getTime();
  return Number.isNaN(n) ? null : n;
}

// 'Orders' for reports created on/after the cutoff (and for brand-new reports);
// 'Units Sold' for reports authored before it.
export function productUnitsLabel(createdAt) {
  const ms = toMillis(createdAt);
  if (ms == null) return 'Orders';
  return ms >= ORDERS_LABEL_SINCE ? 'Orders' : 'Units Sold';
}
