// ============================================================
// ACHIEVED figures from the brand incentive workbook.
//
// incentiveWorkbook.js reads the TARGET half of each month's column pair; this
// reads the other half. The layout (see that file's header) is
//
//     ... | Oct 26 | Oct 1-31 |
//           target   achieved
//
// so a month's achieved cell sits in the column immediately RIGHT of its target
// column. That column is only trusted when its header agrees (a day range, or --
// Aurelia -- a bare label naming the same month); otherwise the month refuses
// rather than returning a neighbour's number.
//
// THE RULE (the sheet is edited month by month, so this is what must stay true):
//   * Each month is a PAIR of columns. LEFT = the month's GOAL, headed with the
//     month ("Oct 26"). RIGHT = what was ACHIEVED, headed with the day range
//     ("Oct 1-31"). Both are read from the same row of the brand's tab.
//   * Video Authorized achieved is a COUNT; the figure we store is
//     authorized ÷ "Total Videos Made" × 100 (JoyMode Oct: 377 / 422 = 89.34%).
//   * A month whose achieved column is missing or blank is skipped, never zeroed:
//     as a brand's sheet gains its "Oct 1-31" column the next fetch picks it up.
//
// Pure: no supabase, no DOM. Safe to import in plain node.
// ============================================================
import { OPTION_BY_KEY, parseCell, looksAchieved, yearHintOf } from './incentiveWorkbook.js';

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

// The workbook spells these several ways ('Video Authorized ', 'Authorized Videos',
// 'Videos Authorized'); the target reader knows only the first two, so the extra
// spelling is added here without touching it.
const AUTHORIZED_ALIASES = ['video authorized', 'authorized videos', 'videos authorized'];
const TOTAL_ALIASES = ['total videos made'];

const MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthIdx = (label) => MONTH_PREFIXES.findIndex((m) => norm(label).startsWith(m));

const round2 = (n) => Math.round(n * 100) / 100;

function findRow(sheet, aliases) {
  const grid = sheet.grid || [];
  for (let r = sheet.headerRowIndex + 1; r < grid.length; r++) {
    if (aliases.includes(norm((grid[r] || [])[0]))) return r;
  }
  return -1;
}

/** Column of the month's ACHIEVED half, or { unavailable }. */
function achievedColumn(sheet, monthKey) {
  const tcol = sheet.targets[monthKey];
  if (tcol === undefined) {
    const near = (sheet.issues || []).find((i) => i.col !== undefined);
    return { unavailable: `no target column resolved for ${monthKey}${near ? ` (nearest problem: ${near.reason})` : ''}, so its achieved column cannot be located` };
  }
  // Most headers carry no year; the walk fills it in from the nearest explicit
  // one to the RIGHT, falling back to the current calendar year. A month with no
  // explicit year at or right of it may be a whole year out, and an achieved
  // figure from the wrong year is still a wrong number in somebody's pay.
  const anchored = Object.values(sheet.targets)
    .some((c) => c >= tcol && yearHintOf((sheet.headerCells || [])[c]) != null);
  if (!anchored) {
    return { unavailable: `the sheet's headers never state the year for ${monthKey} (no explicit year at or after it), so it may belong to another year` };
  }
  const acol = tcol + 1;
  const label = (sheet.headerCells || [])[acol];
  if (!norm(label)) return { unavailable: `the sheet has no achieved column for ${monthKey} yet` };
  if (Object.values(sheet.targets).includes(acol)) {
    return { unavailable: `the column after the ${monthKey} target is another month's target, not its achieved column` };
  }
  const targetMonth = Number(monthKey.slice(5)) - 1;
  const ok = looksAchieved(label) || monthIdx(label) === targetMonth;
  if (!ok) return { unavailable: `the column after the ${monthKey} target is headed "${String(label).trim()}", which does not look like its achieved column` };
  return { col: acol };
}

/**
 * The achieved figure for one option in one month.
 * Returns { value, unit, detail } or { unavailable: '<why>' }.
 */
export function getAchieved(sheet, optionKey, monthKey) {
  if (!sheet || sheet.missing) return { unavailable: 'this brand has no tab in the workbook (the tab name must match the brand name in WurxOS exactly)' };
  if (!sheet.ok) return { unavailable: sheet.reason || 'this brand\'s tab could not be read' };
  const opt = OPTION_BY_KEY[optionKey];
  if (!opt) return { unavailable: `unknown option "${optionKey}"` };

  const isVA = optionKey === 'video_authorized';
  const row = isVA ? findRow(sheet, AUTHORIZED_ALIASES) : sheet.optionRows[optionKey];
  if (row === undefined || row < 0) return { unavailable: `this brand's sheet has no "${opt.label}" row` };

  const a = achievedColumn(sheet, monthKey);
  if (a.unavailable) return a;
  const cell = (r) => parseCell(((sheet.grid[r]) || [])[a.col]);

  const got = cell(row);
  if (got.empty) return { unavailable: `the ${monthKey} achieved cell is blank` };
  if (got.error) return { unavailable: got.error };
  if (got.value < 0) return { unavailable: `the ${monthKey} achieved cell is negative (${got.value})` };

  if (!isVA) return { value: got.value, unit: opt.unit, detail: `${monthKey} achieved cell` };

  const trow = findRow(sheet, TOTAL_ALIASES);
  if (trow < 0) return { unavailable: 'this brand\'s sheet has no "Total Videos Made" row to divide by' };
  const tot = cell(trow);
  if (tot.empty) return { unavailable: `"Total Videos Made" is blank for ${monthKey}` };
  if (tot.error) return { unavailable: `"Total Videos Made": ${tot.error}` };
  if (!(tot.value > 0)) return { unavailable: `"Total Videos Made" is ${tot.value} for ${monthKey}, cannot divide` };
  if (got.value > tot.value) {
    return { unavailable: `${got.value} videos authorized is more than the ${tot.value} made — the sheet looks wrong, not applying it` };
  }
  return {
    value: round2((got.value / tot.value) * 100),
    unit: 'percent',
    detail: `${got.value} of ${tot.value} videos authorized`,
  };
}

// Mirrors autoComplete() in incentivesApi.js. That file imports supabase and so
// cannot load in plain node; scripts/test-incentive-achieved.mjs asserts parity
// against its real source text.
export function autoCompleteLike(item) {
  const t = Number(item.targetValue), a = Number(item.achievedValue);
  if (!t || t <= 0) return !!item.completed;
  return (a / t) >= 0.9;
}

const DERIVED_SOURCES = {
  gmv_max: 'achieved is derived from the brand\'s GMV (single source of truth)',
  attendance: 'achieved is derived from attendance',
  ol_brands: 'achieved is derived from the OL brands roll-up',
};

/**
 * Work out which plan lines the workbook can fill in, without touching anything.
 * `autoComplete` is injectable so a caller may pass the real one.
 */
export function buildAchievedUpdates({ plans, sheetsByBrand = {}, month, autoComplete = autoCompleteLike }) {
  const changes = [];
  const skipped = [];

  for (const plan of plans || []) {
    if (plan.payoutCleared === true) {
      skipped.push({ userName: plan.userName, brandName: '', label: '(whole plan)', reason: 'payout already cleared, plan is frozen' });
      continue;
    }
    for (const section of ['incentives', 'bonuses']) {
      for (const item of plan[section] || []) {
        if (!item || !item.wbOption || !item.brandId) continue;
        const label = item.text || OPTION_BY_KEY[item.wbOption]?.label || item.wbOption;
        const skip = (reason) => skipped.push({ userName: plan.userName, brandName: item.brandName, label, reason });

        if (item.source) {
          skip(DERIVED_SOURCES[item.source] || `line is auto-filled (${item.source})`);
          continue;
        }
        const sheet = sheetsByBrand[item.brandId];
        if (!sheet || sheet.missing) { skip('no sheet for this brand in the workbook'); continue; }

        const res = getAchieved(sheet, item.wbOption, month);
        if (res.unavailable) { skip(res.unavailable); continue; }

        const before = Number(item.achievedValue) || 0;
        const after = res.value;
        if (after === before) continue;
        changes.push({
          userId: plan.userId,
          userName: plan.userName,
          section,
          lineId: item.id,
          brandId: item.brandId,
          brandName: item.brandName,
          optionKey: item.wbOption,
          label,
          before,
          after,
          completedBefore: !!item.completed,
          completedAfter: autoComplete({ ...item, achievedValue: after }),
          detail: res.detail,
          wasVerified: !!plan.verified,
        });
      }
    }
  }
  return { changes, skipped };
}

/**
 * Apply changes to one plan, immutably. Only matching lines change; completedBy
 * is cleared when a line stops being complete (as every editor save does) and
 * otherwise left alone.
 */
export function applyChangesToPlan(plan, changes) {
  const mine = (changes || []).filter((c) => c.userId === undefined || c.userId === plan.userId);
  const apply = (section) => (plan[section] || []).map((item) => {
    const c = mine.find((x) => x.section === section && x.lineId === item.id);
    if (!c) return item;
    return {
      ...item,
      achievedValue: c.after,
      completed: c.completedAfter,
      ...(c.completedAfter ? {} : { completedBy: null }),
    };
  });
  return { incentives: apply('incentives'), bonuses: apply('bonuses') };
}
