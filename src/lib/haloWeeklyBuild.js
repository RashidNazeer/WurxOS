// ============================================================
// Amazon Halo — build a WEEKLY dataset from the daily sheet + a "Weekly Search
// Volume — Brand Roll-Ups" sheet, WITHOUT hand-merging.
//
// The weekly Halo view is single-source: to show both the TikTok metrics AND the
// Amazon branded-search volume together, the weekly dataset must carry both. But
// search volume lives in a differently-shaped roll-up sheet (Week Ending | one
// column per product), which the normal parser can't read. So instead of forcing
// the user to reformat it, we compose the weekly dataset here:
//
//   1. Roll the brand's already-uploaded DAILY dataset up to weeks, aligned to
//      the roll-up's (Saturday) week-ending boundaries — using each field's `agg`
//      (sum for counts/money, avg for ratios).
//   2. Attach the brand's chosen column from the roll-up sheet as that week's
//      keyword_search_volume.
//
// Weeks: STRICT + small TAIL — every week that overlaps the daily coverage, plus
// up to `tailWeeks` weeks of search volume beyond the daily end (so a lagged halo
// — TikTok now → Amazon demand a few weeks later — can still show). Weeks entirely
// before the daily coverage (search volume but no TikTok metrics) are dropped:
// they can't correlate and just clutter the chart.
// ============================================================

import { parseNum, parseFlexibleDate } from './haloParse';
import { FIELD_BY_KEY, KSV_KEY } from './haloFields';

const pad2 = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Timezone-safe ISO date arithmetic (component math via the UTC epoch).
function addDaysISO(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function fmtDay(iso) { const [, m, d] = String(iso).split('-').map(Number); return `${d} ${MON[m - 1]}`; }
function weekLabel(startISO, endISO) { return `${fmtDay(startISO)} – ${fmtDay(endISO)} ${String(endISO).slice(0, 4)}`; }

// "Longevity Box (all variants)" -> "Longevity Box" for the keyword breakdown label.
function cleanCol(name) { return String(name ?? '').replace(/\([^)]*\)/g, '').trim() || String(name ?? '').trim(); }

// A grand-total column ("Total" / "All Products") — excluded from the sum so it
// isn't double-counted. NB "(all variants)" is per-PRODUCT, not a grand total.
function isGrandTotalCol(name) { return /^(total|all products?|overall|grand total)$/i.test(cleanCol(name)); }

// ---- 1) read the roll-up "Weekly Search Volume" sheet -----------------------
// Returns { columns:[name…], weeks:[{ endingISO, values:{name:num} }] }. The
// header row is the one carrying a "Week Ending" (or "Week of") cell; every other
// non-empty header is a product/brand column the user can pick from.
function extractSearchVolume(grid) {
  let headerIdx = -1;
  let dateCol = -1;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const cells = grid[i] || [];
    const j = cells.findIndex((c) => /week\s*end|week\s*of/i.test(String(c ?? '')));
    if (j >= 0) { headerIdx = i; dateCol = j; break; }
  }
  if (headerIdx < 0) return null;

  const headerCells = grid[headerIdx] || [];
  const cols = [];
  headerCells.forEach((c, idx) => {
    if (idx === dateCol) return;
    const name = String(c ?? '').trim();
    if (name) cols.push({ idx, name });
  });
  if (!cols.length) return null;

  const weeks = [];
  const seen = new Set();
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const dcell = cells[dateCol];
    if (dcell == null || /^\s*total/i.test(String(dcell))) continue; // skip the Total row
    const dm = parseFlexibleDate(dcell);
    if (!dm || dm.m0 == null || dm.d == null || dm.year == null) continue;
    const endingISO = `${dm.year}-${pad2(dm.m0 + 1)}-${pad2(dm.d)}`;
    if (seen.has(endingISO)) continue;
    seen.add(endingISO);
    const values = {};
    for (const { idx, name } of cols) {
      const n = parseNum(cells[idx]);
      if (n != null) values[name] = n;
    }
    weeks.push({ endingISO, values });
  }
  if (!weeks.length) return null;

  // Keyword columns that carry a non-zero value somewhere (skip any grand-total).
  const columns = cols
    .map((c) => c.name)
    .filter((name) => !isGrandTotalCol(name) && weeks.some((w) => w.values[name] != null && w.values[name] !== 0));
  if (!columns.length) return null;
  return { columns, weeks };
}

export async function parseSearchVolumeSheet(arrayBuffer) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
    const res = extractSearchVolume(grid);
    if (res) return res;
  }
  throw new Error('Could not find a weekly search-volume table (needs a "Week Ending" column with one column per product).');
}

// ---- 2) roll daily metrics up to one week -----------------------------------
function rollupMetrics(days) {
  const out = {};
  const avgSum = {};
  const avgCnt = {};
  for (const d of days) {
    for (const [k, v] of Object.entries(d.metrics || {})) {
      if (v == null) continue;
      const f = FIELD_BY_KEY[k];
      if (f && f.agg === 'avg') { avgSum[k] = (avgSum[k] || 0) + v; avgCnt[k] = (avgCnt[k] || 0) + 1; }
      else out[k] = (out[k] || 0) + v; // sum (the default for counts / money)
    }
  }
  for (const k in avgSum) if (avgCnt[k]) out[k] = Math.round((avgSum[k] / avgCnt[k]) * 100) / 100;
  return out;
}

// ---- compose the weekly rows -------------------------------------------------
export function buildWeeklyFromDaily({ dailyRows, searchWeeks, columns, tailWeeks = 3 }) {
  const dates = (dailyRows || []).map((r) => r.date).filter(Boolean).sort();
  if (!dates.length) throw new Error('The daily dataset has no rows to roll up.');
  const dailyStart = dates[0];
  const dailyEnd = dates[dates.length - 1];

  const weeks = [...(searchWeeks || [])].sort((a, b) => (a.endingISO < b.endingISO ? -1 : 1));

  // Every search-volume column is one of THIS brand's keywords/products, so sum
  // them into a single branded-search-volume figure per week (matching how the
  // daily sheet sums its keyword columns) and keep the per-keyword split too.
  const cols = (columns && columns.length)
    ? columns.filter((c) => !isGrandTotalCol(c))
    : [...new Set(weeks.flatMap((w) => Object.keys(w.values || {})))].filter((c) => !isGrandTotalCol(c));
  const hasAnyVol = (w) => cols.some((c) => w.values[c] != null);

  // STRICT: the week [E-6, E] overlaps the daily coverage.
  const overlaps = (E) => addDaysISO(E, -6) <= dailyEnd && E >= dailyStart;
  const strict = weeks.filter((w) => overlaps(w.endingISO));
  if (!strict.length) {
    throw new Error(`No search-volume weeks overlap the daily data (${dailyStart} → ${dailyEnd}). Check the dates line up.`);
  }
  // TAIL: up to `tailWeeks` weeks of search volume beyond the last strict week.
  const lastStrictE = strict[strict.length - 1].endingISO;
  const tailLimit = addDaysISO(lastStrictE, tailWeeks * 7);
  const tail = weeks.filter((w) => w.endingISO > lastStrictE && w.endingISO <= tailLimit && hasAnyVol(w));

  const rows = [...strict, ...tail].map((w) => {
    const start = addDaysISO(w.endingISO, -6);
    const daysIn = (dailyRows || []).filter((r) => r.date >= start && r.date <= w.endingISO);
    const metrics = rollupMetrics(daysIn);
    const keywords = {};
    let volSum = 0;
    let anyVol = false;
    for (const c of cols) {
      const v = w.values[c];
      if (v != null) { keywords[cleanCol(c)] = v; volSum += v; anyVol = true; }
    }
    if (anyVol) metrics[KSV_KEY] = volSum;
    return { date: start, periodLabel: weekLabel(start, w.endingISO), metrics, productRevenue: {}, keywords, keywordRanks: {} };
  }).filter((r) => Object.keys(r.metrics).length > 0);

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) throw new Error('Nothing to build — no weeks had metrics or search volume.');

  return {
    rows,
    periodStart: rows[0].date,
    periodEnd: rows[rows.length - 1].date,
    weeksBuilt: rows.length,
    strictCount: strict.length,
    tailCount: tail.length,
    columnsUsed: cols,
  };
}
