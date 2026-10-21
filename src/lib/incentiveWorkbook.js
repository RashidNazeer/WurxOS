// ============================================================
// The brand incentive workbook: which options exist, and what TARGET each
// brand carries for a given month.
//
// TARGETS ONLY. The workbook holds a target and an achieved figure per month;
// only the target is read. Achieved already has a source in WurxOS -- the APC
// enters it at clock-in (mig 311) and the GMV-Max line derives it (mig 317) --
// and two sources for one number is how they drift.
//
// ── THE COLUMN LAYOUT, AND WHY IT IS READ POSITIONALLY ─────────────────────
// Each month occupies TWO columns, target first:
//
//     ... | Sep 26 | Sep 1-30 | Oct 26 |
//           target   achieved   target
//
// The labels cannot be trusted to say which is which. A target is usually a
// bare month ("Sep 26", "October", "December 2025") and an achieved is usually
// a date range ("Sep 1-30"), but Aurelia labels achieved columns "April" and
// "August", which look exactly like targets. So the columns are read by
// POSITION -- anchor on the rightmost header, step left in twos -- and the
// labels are used only to VERIFY that each step landed on the month expected.
// Any disagreement refuses that month rather than returning a number from the
// neighbouring column.
//
// Years are mostly absent ("January" vs "January 2" vs "jan1-31"), so the year
// is carried leftwards from the anchor and decremented when the month stops
// decreasing. An explicit year ("December 2025", "Oct 26") re-anchors it.
//
// Everything here is pure: it takes a 2-D grid of cells, never a File, so the
// rules are testable against the real workbook with no browser.
// ============================================================

// The five options, exactly as the sheets name them. 'Affiliate GMV' and the
// bare 'Total GMV' row are deliberately NOT options: Affiliate GMV is never an
// incentive, and 'Total GMV' is all-channel revenue, not the paid-ads figure
// that 'Total GMV from GMV Max' means.
export const INCENTIVE_OPTIONS = [
  {
    key: 'video_authorized',
    label: 'Video Authorized',
    section: 'incentives',
    // Two spellings across the workbook; same metric.
    rowAliases: ['video authorized', 'authorized videos'],
    // The target is a RATIO (0.85, 0.95) measured against the videos made that
    // month, not a count. Kept as a ratio; the form renders it as a percentage.
    unit: 'ratio',
  },
  {
    key: 'creators_3plus',
    label: 'Creators with more than three videos',
    section: 'incentives',
    rowAliases: ['creators with more than three video', 'creators with more than three videos'],
    unit: 'count',
  },
  {
    key: 'videos_100_gmv',
    label: 'Videos with $100+ GMV',
    section: 'incentives',
    rowAliases: ['videos with $100+ gmv'],
    unit: 'count',
  },
  {
    key: 'onboarding_l3',
    label: 'Onboarding L3+ creators',
    section: 'bonuses',
    rowAliases: ['onboarding l3+ creators'],
    unit: 'count',
  },
  {
    key: 'gmv_max',
    label: 'Total GMV from GMV Max',
    section: 'bonuses',
    rowAliases: ['total gmv from gmv max'],
    unit: 'money',
  },
];

export const OPTION_BY_KEY = Object.fromEntries(INCENTIVE_OPTIONS.map((o) => [o.key, o]));
export const MAX_SELECTIONS_PER_APC = 5;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

/** Month index (0-11) from a label like "Oct 26", "Sep 1-30", "jan1-31". */
function monthOf(label) {
  const s = norm(label);
  for (let i = 0; i < MONTHS.length; i++) {
    const full = MONTHS[i];
    if (s.startsWith(full)) return i;
    if (s.startsWith(full.slice(0, 3))) return i;
  }
  return -1;
}

/**
 * Explicit year in a header, or null.
 * "26" -> 2026, "2025" -> 2025. A LONE single digit ("January 2", "November 2")
 * is a disambiguator the author added for a repeated month, not a year.
 */
function yearHintOf(label) {
  const s = norm(label);
  const four = s.match(/\b(20\d{2})\b/);
  if (four) return Number(four[1]);
  const two = s.match(/\b([2-9]\d)\b/);
  if (two) return 2000 + Number(two[1]);
  return null;
}

const isPlaceholder = (label) => /^column\s*\d+$/.test(norm(label));

/**
 * A cell as a number, or a reason it is not one.
 *
 * Refuses "1.9M", "1.7 Million", "$1.296M". Those appear across the GMV rows
 * and parsing them into a precise-looking figure would be worse than refusing:
 * "1.9M" is not 1.9, and nobody would notice the difference in a form field.
 */
export function parseCell(raw) {
  if (raw === null || raw === undefined) return { empty: true };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : { error: 'not a number' };
  const s = String(raw).trim();
  if (!s) return { empty: true };
  if (/\d\s*(m|mil|mill|million|k)\b/i.test(s) || /\d\s*m$/i.test(s)) {
    return { error: `"${s}" is an abbreviated figure, not an exact number` };
  }
  const cleaned = s.replace(/[$£€,\s]/g, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return { error: `"${s}" is not a number` };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { error: `"${s}" is not a number` };
  return { value: n };
}

/**
 * Locate the header row: the first row holding at least two cells that name a
 * month. The brand's own name sits in the first cell, which is why the row is
 * found by content rather than assumed to be row 1.
 */
function findHeaderRow(grid) {
  for (let r = 0; r < Math.min(grid.length, 8); r++) {
    const row = grid[r] || [];
    let months = 0;
    for (let c = 1; c < row.length; c++) if (monthOf(row[c]) >= 0) months++;
    if (months >= 2) return r;
  }
  return -1;
}

/**
 * Map 'YYYY-MM' -> the column index holding that month's TARGET.
 *
 * Anchors on the rightmost header cell and steps left in twos. Each step must
 * land on the month one earlier than the last; where the label disagrees, that
 * column is recorded in `issues` and contributes no month, so a caller asking
 * for it gets "not available" instead of a neighbour's number.
 */
export function resolveTargetColumns(headerCells) {
  const targets = {};
  const issues = [];
  let last = headerCells.length - 1;
  while (last >= 1 && !norm(headerCells[last])) last--;
  if (last < 1) return { targets, issues: [{ reason: 'no month headers found' }] };

  const anchorMonth = monthOf(headerCells[last]);
  if (anchorMonth < 0) {
    return { targets, issues: [{ col: last, label: headerCells[last], reason: 'the last column does not name a month' }] };
  }
  let year = yearHintOf(headerCells[last]) ?? new Date().getFullYear();
  let month = anchorMonth;

  for (let col = last; col >= 1; col -= 2) {
    const label = headerCells[col];
    if (isPlaceholder(label)) {
      issues.push({ col, label, reason: 'placeholder header, no month named' });
    } else {
      const got = monthOf(label);
      const hint = yearHintOf(label);
      if (got < 0) {
        issues.push({ col, label, reason: 'header names no month' });
      } else if (got !== month) {
        issues.push({ col, label, reason: `expected ${MONTHS[month]}, header says ${MONTHS[got]}` });
      } else {
        if (hint != null) year = hint;        // an explicit year re-anchors the walk
        const key = `${year}-${String(month + 1).padStart(2, '0')}`;
        if (targets[key] === undefined) targets[key] = col;
      }
    }
    // Step one month back regardless, so a bad column costs that month only.
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return { targets, issues };
}

/** Map option key -> row index, by matching the first cell against the aliases. */
export function resolveOptionRows(grid, headerRowIndex) {
  const rows = {};
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const label = norm((grid[r] || [])[0]);
    if (!label) continue;
    for (const opt of INCENTIVE_OPTIONS) {
      if (rows[opt.key] === undefined && opt.rowAliases.includes(label)) rows[opt.key] = r;
    }
  }
  return rows;
}

/**
 * Everything one brand sheet offers: which options it carries, which months
 * resolve, and the issues that stopped the rest.
 */
export function readBrandSheet(grid) {
  const headerRowIndex = findHeaderRow(grid);
  if (headerRowIndex < 0) {
    return { ok: false, reason: 'No header row naming months was found on this sheet.', options: {}, targets: {}, issues: [] };
  }
  const headerCells = grid[headerRowIndex] || [];
  const { targets, issues } = resolveTargetColumns(headerCells);
  const optionRows = resolveOptionRows(grid, headerRowIndex);
  return { ok: true, headerRowIndex, headerCells, targets, optionRows, issues, grid };
}

/**
 * The target for one option in one month.
 * Returns { value } or { unavailable: '<why>' } -- never a number from another
 * month, another option, or a neighbouring column.
 */
export function getTarget(sheet, optionKey, monthKey) {
  if (!sheet || !sheet.ok) return { unavailable: sheet?.reason || 'sheet could not be read' };
  const opt = OPTION_BY_KEY[optionKey];
  if (!opt) return { unavailable: `unknown option "${optionKey}"` };

  const row = sheet.optionRows[optionKey];
  if (row === undefined) return { unavailable: `this brand's sheet has no "${opt.label}" row` };

  const col = sheet.targets[monthKey];
  if (col === undefined) {
    const near = sheet.issues.find((i) => i.col !== undefined);
    return { unavailable: `no target column resolved for ${monthKey}${near ? ` (nearest problem: ${near.reason})` : ''}` };
  }
  const parsed = parseCell((sheet.grid[row] || [])[col]);
  if (parsed.empty) return { unavailable: `the ${monthKey} target cell is blank` };
  if (parsed.error) return { unavailable: parsed.error };
  return { value: parsed.value, unit: opt.unit };
}

/** Months a sheet can answer for, newest first — drives the month picker. */
export function availableMonths(sheet) {
  if (!sheet || !sheet.ok) return [];
  return Object.keys(sheet.targets).sort().reverse();
}

/** Display helper: ratios render as percentages, money with separators. */
export function formatTarget(value, unit) {
  if (value == null) return '—';
  if (unit === 'ratio') return `${Math.round(value * 1000) / 10}%`;
  if (unit === 'money') return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return Number(value).toLocaleString();
}
