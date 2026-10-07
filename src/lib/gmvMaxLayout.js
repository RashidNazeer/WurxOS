// TikTok Shop's GMV Max campaign-list column layout.
//
// The paste is one value per line with no header row, so the parser has to work
// out what each number is. It does that from the column ORDER — which TikTok
// changes without warning (the 2026 change inserted Offers, Target ROI and Net
// Cost, which silently shifted orders/CPO/GMV one place).
//
// Rather than wait for someone to notice wrong numbers in a client report, the
// layout lives here and can be replaced from the UI: copy TikTok's header row,
// paste it in, and the parser re-maps itself.
//
// Stored per browser. It is a display/parsing aid, not report data, so it never
// touches the database — but that does mean each person updates their own copy.

const KEY = 'wurxos.gmvMaxColumns';

/** The layout as of 2026-10 (the owner's paste). Order matters; names don't
 *  have to match exactly, they're matched loosely. */
export const DEFAULT_COLUMNS = [
  'On/Off',
  'Campaign name',
  'Status',
  'Current budget',
  'Recommendations',
  'Offers',
  'Cost',
  'ROI protection',
  'Active upgrades',
  'Schedule',
  'Creative boost budget',
  'Target ROI',
  'Net Cost',
  'SKU orders',
  'Cost per order',
  'Gross revenue',
  'ROI',
  'Cross-placement coupon gross revenue',
];

/** Accepts a pasted header row: newline, tab or comma separated. */
export function parseColumnList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n\r\t]+|,(?![^(]*\))/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function loadColumns() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_COLUMNS;
    const cols = JSON.parse(raw);
    return Array.isArray(cols) && cols.length >= 4 ? cols : DEFAULT_COLUMNS;
  } catch { return DEFAULT_COLUMNS; }
}

export function saveColumns(cols) {
  try {
    if (!cols || !cols.length) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(cols));
  } catch { /* private window / storage blocked — fall back to the default */ }
}

export function resetColumns() { saveColumns(null); }

export function isCustom() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}

/**
 * Which report field a column feeds, or null if we don't collect it.
 * Matched loosely so renames ("Spend" for "Cost", "GMV" for "Gross revenue")
 * keep working. Order of the checks matters: the more specific names first,
 * so "Cost per order" and "Net Cost" never win the plain "Cost" slot.
 */
export function fieldForColumn(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return null;
  if (/protection|target/.test(n)) return null;          // ROI protection, Target ROI
  if (/cost per order|^cpo\b/.test(n)) return 'cpo';
  if (/coupon|cross-?placement/.test(n)) return null;    // not the campaign's own GMV
  if (/net cost/.test(n)) return null;                   // we report gross Cost
  if (/\border(s)?\b|units sold|sku orders/.test(n)) return 'orders';
  if (/^roi$/.test(n)) return 'roi';
  if (/gross revenue|^gmv$|\bgmv\b|revenue/.test(n)) return 'gmv';
  if (/budget/.test(n)) return null;                     // budgets are not spend
  if (/^cost$|^spend$|^net spend$|amount spent/.test(n)) return 'spend';
  return null;
}

/** The value shape a column is expected to produce in the paste. */
export function typeForColumn(name) {
  const n = String(name || '').toLowerCase().trim();
  if (/^roi$|target roi/.test(n)) return 'decimal';
  // Money is checked BEFORE counts on purpose: "Cost per order" and "Avg order
  // value" both contain "order" but hold money, and mis-typing one column
  // misaligns every column after it.
  if (/cost|revenue|budget|spend|price|gmv|value|amount|cpo/.test(n)) return 'money';
  if (/\border(s)?\b|units|quantity|count/.test(n)) return 'int';
  return 'text';
}

/** Columns after the schedule — the per-period metric tail. */
export function splitAtSchedule(cols) {
  const i = cols.findIndex(c => /schedule/i.test(c));
  return i < 0
    ? { header: cols, tail: [] }
    : { header: cols.slice(0, i), tail: cols.slice(i + 1) };
}
