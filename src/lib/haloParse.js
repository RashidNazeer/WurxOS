// ============================================================
// Amazon Halo Effect — spreadsheet parser.
//
// Boss uploads the whole Google Sheets workbook (.xlsx) or a single .csv. The
// workbook has TWO tabs we care about:
//
//   1. the DAILY performance tab — one row per day (TikTok + GMV Max metrics
//      plus Amazon revenue). Messy preamble (title row, a "Data overview"
//      super-header, blank rows), real column header a few rows down. As of the
//      2026-07 format change the Amazon side is: per-PRODUCT "Revenue (Amazon)"
//      columns (bracketed product headers) followed by a "Total Revenue/Day".
//      The "Keyword Search Volume" columns exist but are EMPTY here — that data
//      lives weekly in the other tab.
//
//   2. the WEEKLY "Branded Demand" tab — one row per week (Week Ending = a
//      Saturday), one column per product's branded search volume. This is the
//      only place keyword/search-volume numbers exist, and only weekly.
//
// We classify tabs by content (a "Date"+metrics header = daily; a "Week Ending"
// header = weekly), so tab names/order don't matter.
// ============================================================

import { headerKey, HALO_FIELDS, normHeader } from './haloFields';

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// "$1,503" / "£717" -> 1503 / 717 ; "11.56" -> 11.56 ; "" / "-" -> null
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$£€,%\s]/g, '').trim();
  if (s === '' || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const toISO = (y, m0, d) => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;

// Strip a bracketed / ASIN-tagged product header to a clean name:
//   "[NMNH; B0DNKFBTNN]" -> "NMNH" ; "[Met4Min berberine; B0B..]" -> "Met4Min berberine"
function cleanProductName(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^\[+|\]+$/g, '').trim();  // strip surrounding brackets
  s = s.split(';')[0].trim();               // drop the "; ASIN" suffix
  return s;
}

// Strip a weekly keyword header's qualifier: "NMNH (all variants)" -> "NMNH".
function cleanKeywordName(raw) {
  return String(raw ?? '').replace(/\([^)]*\)/g, '').trim();
}

// Parse a date cell into { m0, d, year? }. Returns null if not a date.
function parseDayMonth(cell) {
  if (cell == null || cell === '') return null;
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { m0: cell.getMonth(), d: cell.getDate(), year: cell.getFullYear() };
  }
  const s = String(cell).trim();
  // ISO-ish "2026-03-07" or "03/07/2026" (has an explicit year) — do this FIRST
  // so weekly Week-Ending ISO dates resolve exactly.
  if (/\d{4}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { m0: d.getMonth(), d: d.getDate(), year: d.getFullYear() };
  }
  // "1 Mar", "1-Mar", "10 June"
  let m = s.match(/^(\d{1,2})[\s./-]+([A-Za-z]+)/);
  if (m && MONTHS[m[2].toLowerCase()] != null) return { m0: MONTHS[m[2].toLowerCase()], d: Number(m[1]) };
  // "Mar 1", "June 10"
  m = s.match(/^([A-Za-z]+)[\s./-]+(\d{1,2})/);
  if (m && MONTHS[m[1].toLowerCase()] != null) return { m0: MONTHS[m[1].toLowerCase()], d: Number(m[2]) };
  return null;
}

// Find the daily header row: first row with a "Date" column + >=3 metrics.
function findDailyHeaderRow(grid) {
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const cells = grid[i] || [];
    let hasDate = false;
    let hits = 0;
    for (const c of cells) {
      const k = headerKey(c);
      if (k === 'date') hasDate = true;
      else if (k) hits += 1;
    }
    if (hasDate && hits >= 3) return i;
  }
  return -1;
}

// Find the weekly header row: first row containing a "Week Ending" cell.
function findWeeklyHeaderRow(grid) {
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    const cells = grid[i] || [];
    if (cells.some((c) => normHeader(c) === 'weekending')) return i;
  }
  return -1;
}

// Column-index -> field-key map. 'orders' appears twice (TikTok Orders, then
// GMV Max orders) — first hit = orders, second = gmvmax_orders.
function buildColumnMap(headerCells) {
  const map = {};
  const used = new Set();
  headerCells.forEach((cell, idx) => {
    let key = headerKey(cell);
    if (!key) return;
    if (key === 'orders' && used.has('orders')) key = 'gmvmax_orders';
    if (used.has(key)) return;
    map[idx] = key;
    used.add(key);
  });
  return map;
}

const sum = (arr) => arr.reduce((s, x) => s + x, 0);

// Detect the currency symbol used in the grid (first of £/€/$ seen), default $.
function detectCurrency(grid) {
  for (const row of grid) {
    for (const cell of row || []) {
      if (typeof cell !== 'string') continue;
      if (cell.includes('£')) return '£';
      if (cell.includes('€')) return '€';
      if (cell.includes('$')) return '$';
    }
  }
  return '$';
}

// ---- daily tab --------------------------------------------------------------
function parseDailyTab(grid, opts) {
  const headerIdx = findDailyHeaderRow(grid);
  if (headerIdx < 0) {
    throw new Error('Could not find the daily header row (needs a "Date" column plus metrics like GMV, Orders, ROI).');
  }
  const headerCells = grid[headerIdx];
  const colMap = buildColumnMap(headerCells);
  const dateColKey = Object.keys(colMap).find((idx) => colMap[idx] === 'date');
  if (dateColKey == null) throw new Error('No "Date" column found in the daily header.');
  const dateCol = Number(dateColKey);

  const idxOf = (k) => {
    const hit = Object.keys(colMap).find((i) => colMap[i] === k);
    return hit == null ? null : Number(hit);
  };
  const revIdx = idxOf('revenue_per_day'); // "Total Revenue/Day" anchor

  // Per-PRODUCT revenue columns live between the last recognised fixed column
  // before "Total Revenue/Day" and the total itself. Keep the unmapped columns
  // in that region that actually carry data. We do NOT stop at the first empty
  // column: the empty "Keyword Search Volume" placeholder columns sit in this
  // same region, and a real product could also be blank for the window — SKIP
  // (not break) on empties so a blank column can't hide the filled product
  // columns to its left. Requires a first data pass for fill counts.
  const dataRows = grid.slice(headerIdx + 1);
  const fillCount = (idx) => dataRows.reduce((n, r) => n + (parseNum((r || [])[idx]) != null ? 1 : 0), 0);

  const productCols = [];
  if (revIdx != null) {
    const mappedBefore = Object.keys(colMap).map(Number).filter((i) => i < revIdx);
    const leftBound = mappedBefore.length ? Math.max(...mappedBefore) : dateCol;
    for (let idx = leftBound + 1; idx < revIdx; idx++) {
      if (colMap[idx]) continue;          // a recognised fixed column (shouldn't occur here)
      if (fillCount(idx) === 0) continue; // empty (KSV placeholder / product with no data) → skip
      productCols.push({ idx, name: cleanProductName(headerCells[idx]) });
    }
  }

  const defaultYear = opts.defaultYear || new Date().getFullYear();
  const rows = [];
  let prevM0 = null;
  let year = defaultYear;
  const seen = new Set();

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const dm = parseDayMonth(cells[dateCol]);
    if (!dm) continue;

    if (dm.year) { year = dm.year; }
    else if (prevM0 != null && dm.m0 < prevM0) { year += 1; }
    prevM0 = dm.m0;

    const iso = toISO(year, dm.m0, dm.d);
    if (seen.has(iso)) continue;
    seen.add(iso);

    const metrics = {};
    for (const [idx, key] of Object.entries(colMap)) {
      if (key === 'date') continue;
      const n = parseNum(cells[idx]);
      if (n != null) metrics[key] = n;
    }
    const productRevenue = {};
    for (const { idx, name } of productCols) {
      const n = parseNum(cells[idx]);
      if (n != null && name) productRevenue[name] = n;
    }
    // If "Total Revenue/Day" was absent but per-product columns exist, derive it.
    const prodVals = Object.values(productRevenue);
    if (metrics.revenue_per_day == null && prodVals.length) metrics.revenue_per_day = sum(prodVals);

    if (Object.keys(metrics).length === 0 && prodVals.length === 0) continue;
    rows.push({ date: iso, metrics, productRevenue });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));

  const presentKeys = new Set(Object.values(colMap));
  const missingColumns = HALO_FIELDS
    .filter((f) => f.key !== 'date' && !presentKeys.has(f.key))
    .map((f) => ({ key: f.key, label: f.label }));
  const missingAnchors = missingColumns.filter((m) => m.key === 'revenue_per_day');

  return {
    rows,
    products: productCols.map((c) => c.name),
    foundKeys: [...new Set(Object.values(colMap).filter((k) => k !== 'date'))],
    missingColumns,
    missingAnchors,
  };
}

// ---- weekly "Branded Demand" tab -------------------------------------------
function parseWeeklyTab(grid) {
  const headerIdx = findWeeklyHeaderRow(grid);
  if (headerIdx < 0) return null;
  const headerCells = grid[headerIdx] || [];
  const weekCol = headerCells.findIndex((c) => normHeader(c) === 'weekending');
  if (weekCol < 0) return null;

  // Every non-empty header to the right of "Week Ending" is a keyword column.
  const kwCols = [];
  for (let idx = weekCol + 1; idx < headerCells.length; idx++) {
    const name = cleanKeywordName(headerCells[idx]);
    if (name) kwCols.push({ idx, name });
  }
  if (!kwCols.length) return null;

  const weeks = [];
  const seen = new Set();
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const dm = parseDayMonth(cells[weekCol]); // ISO week-ending dates
    if (!dm || !dm.year) continue;            // skips the "Total" row + blanks
    const iso = toISO(dm.year, dm.m0, dm.d);
    if (seen.has(iso)) continue;
    seen.add(iso);
    const keywords = {};
    for (const { idx, name } of kwCols) {
      const n = parseNum(cells[idx]);
      if (n != null) keywords[name] = n;
    }
    if (Object.keys(keywords).length) weeks.push({ week_ending: iso, keywords });
  }
  weeks.sort((a, b) => (a.week_ending < b.week_ending ? -1 : 1));
  if (!weeks.length) return null;
  return { weeks, keywords: kwCols.map((c) => c.name) };
}

/**
 * Parse an uploaded workbook.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ rows, weeklyKeywords, products, keywords, currency,
 *             periodStart, periodEnd, foundKeys, missingColumns,
 *             missingAnchors, warnings }}
 */
export async function parseHaloSheet(arrayBuffer, opts = {}) {
  const warnings = [];
  const XLSX = await import('xlsx'); // heavy — loaded only on upload
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  if (!wb.SheetNames.length) throw new Error('The file has no sheets.');

  // Read every sheet as a grid, then classify by content.
  const grids = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }));

  let dailyGrid = null;
  let weekly = null;
  for (const grid of grids) {
    if (!dailyGrid && findDailyHeaderRow(grid) >= 0) { dailyGrid = grid; continue; }
    if (!weekly) { const w = parseWeeklyTab(grid); if (w) weekly = w; }
  }
  if (!dailyGrid) throw new Error('No daily performance sheet found (needs a "Date" column plus metrics like GMV, Orders, ROI).');

  // The daily tab's dates are year-less text ("May 1"), so we must infer the
  // year. Anchor it to the weekly "Branded Demand" tab, which DOES carry real
  // ISO years — that way a workbook uploaded in a later calendar year is still
  // labelled with the data's own year (and the daily↔weekly week-join lines up).
  const anchorYear = opts.defaultYear
    || (weekly?.weeks?.length ? Number(weekly.weeks[0].week_ending.slice(0, 4)) : undefined);
  const daily = parseDailyTab(dailyGrid, { defaultYear: anchorYear });

  const { rows } = daily;
  if (rows.length === 0) throw new Error('No data rows found under the daily header.');

  const currency = detectCurrency(dailyGrid);
  if (!weekly) {
    warnings.push('No weekly "Branded Demand" tab found — the Search-demand view will have no keyword data. Upload the whole workbook (.xlsx), not just the daily sheet.');
  }

  return {
    rows: rows.map((r) => ({ date: r.date, metrics: r.metrics, productRevenue: r.productRevenue })),
    weeklyKeywords: weekly ? weekly.weeks : [],
    products: daily.products,
    keywords: weekly ? weekly.keywords : [],
    currency,
    periodStart: rows[0].date,
    periodEnd: rows[rows.length - 1].date,
    foundKeys: daily.foundKeys,
    missingColumns: daily.missingColumns,
    missingAnchors: daily.missingAnchors,
    warnings,
  };
}

export { parseNum, parseDayMonth };
