// ============================================================
// Amazon Halo Effect — spreadsheet parser.
//
// Boss uploads the daily performance sheet (Google Sheets export, .xlsx or
// .csv). The sheet has a messy preamble (a title row, a "GMV_Max" super-
// header, blank rows) with the real column header a few rows down, so we:
//   1. scan for the header row (the one that has a "Date" + "GMV" column),
//   2. map each column to a canonical field key (HALO_FIELDS),
//   3. read each following day row into { date, metrics }.
//
// Dates may arrive as real Excel dates OR as plain text like "1 Mar" (no
// year), so we infer the year (rolling it forward if the month wraps).
// ============================================================

import { headerKey } from './haloFields';

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

// "$1,503" -> 1503 ; "11.56" -> 11.56 ; "" / "-" -> null
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[$,%\s]/g, '').trim();
  if (s === '' || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
const toISO = (y, m0, d) => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;

// Parse a date cell into { m0, d } (month index + day). Returns null if the
// cell isn't a date. Year is resolved later by the caller (rolling forward).
function parseDayMonth(cell) {
  if (cell == null || cell === '') return null;
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { m0: cell.getMonth(), d: cell.getDate(), year: cell.getFullYear() };
  }
  const s = String(cell).trim();
  // "1 Mar", "1-Mar", "Mar 1", "10 June"
  let m = s.match(/^(\d{1,2})[\s./-]+([A-Za-z]+)/);
  if (m && MONTHS[m[2].toLowerCase()] != null) return { m0: MONTHS[m[2].toLowerCase()], d: Number(m[1]) };
  m = s.match(/^([A-Za-z]+)[\s./-]+(\d{1,2})/);
  if (m && MONTHS[m[1].toLowerCase()] != null) return { m0: MONTHS[m[1].toLowerCase()], d: Number(m[2]) };
  // ISO-ish "2026-03-01" or "03/01/2026"
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && /\d{4}/.test(s)) return { m0: d.getMonth(), d: d.getDate(), year: d.getFullYear() };
  return null;
}

// Find the header row: the first row containing a "Date" column plus at
// least 3 other recognised metric columns.
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = rows[i] || [];
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

// Build column-index -> field-key map. 'orders' appears twice (TikTok Orders,
// then GMV Max orders) — first hit = orders, second = gmvmax_orders.
function buildColumnMap(headerCells) {
  const map = {};
  const used = new Set();
  headerCells.forEach((cell, idx) => {
    let key = headerKey(cell);
    if (!key) return;
    if (key === 'orders' && used.has('orders')) key = 'gmvmax_orders';
    if (used.has(key)) return; // ignore further duplicates
    map[idx] = key;
    used.add(key);
  });
  return map;
}

// A keyword slot header is a "template placeholder" (empty, or the sheet's
// "[Input Keyword Name & Add Volume Below]" prompt) — not a real keyword. Such
// columns carry no data and are skipped so the dummy filler can seed them.
function isPlaceholderHeader(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return true;
  if (/\binput\b/i.test(s)) return true;      // "[Input Keyword Name …]"
  if (/^\[.*\]$/.test(s)) return true;         // any fully-bracketed prompt
  return false;
}

// Discover the dynamic keyword columns that sit BETWEEN two anchor columns.
// Header text = the keyword name. Columns already mapped to a fixed field
// (incl. a literal aggregate "Keyword Search Volume/Rank" column, old format)
// and placeholder slots are excluded. Returns [{ idx, name }] left→right.
function keywordColumnsBetween(headerCells, colMap, startIdx, endIdx) {
  if (startIdx == null || endIdx == null || endIdx <= startIdx + 1) return [];
  const out = [];
  const seen = new Set();
  for (let idx = startIdx + 1; idx < endIdx; idx++) {
    if (colMap[idx]) continue;                 // a recognised fixed/aggregate column
    if (isPlaceholderHeader(headerCells[idx])) continue;
    let name = String(headerCells[idx]).trim();
    if (seen.has(name)) name = `${name} (${idx})`; // de-collide duplicate headers
    seen.add(name);
    out.push({ idx, name });
  }
  return out;
}

const sum = (arr) => arr.reduce((s, x) => s + x, 0);
const avg = (arr) => (arr.length ? sum(arr) / arr.length : null);

/**
 * Parse an uploaded sheet.
 * @param {ArrayBuffer} arrayBuffer
 * @param {{ defaultYear?: number }} opts
 * @returns {{ rows, periodStart, periodEnd, foundKeys, warnings }}
 *   rows: [{ date: 'YYYY-MM-DD', metrics: {key:number} }]
 */
export async function parseHaloSheet(arrayBuffer, opts = {}) {
  const warnings = [];
  const XLSX = await import('xlsx'); // heavy — loaded only when an upload happens
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('The file has no sheets.');

  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) {
    throw new Error('Could not find the header row (needs a "Date" column plus metrics like GMV, Orders, ROI).');
  }

  const headerCells = grid[headerIdx];
  const colMap = buildColumnMap(headerCells);
  const dateCol = Object.keys(colMap).find((idx) => colMap[idx] === 'date');
  if (dateCol == null) throw new Error('No "Date" column found in the header.');

  // Anchor columns that bracket the dynamic keyword regions. The sheet layout
  // is: … NTB | <keyword-volume cols…> | Revenue/Day | <keyword-rank cols…> |
  // Product clicks … So keyword-VOLUME columns live between NTB and Revenue/Day,
  // and keyword-RANK columns between Revenue/Day and Product clicks. Each such
  // column's header is a keyword; the cells below are that keyword's daily
  // volume / rank. There can be any number (0..N) of them.
  const idxOf = (k) => {
    const hit = Object.keys(colMap).find((i) => colMap[i] === k);
    return hit == null ? null : Number(hit);
  };
  const ntbIdx = idxOf('ntb');
  const revIdx = idxOf('revenue_per_day');
  const pcIdx = idxOf('product_clicks');

  const volKwCols = keywordColumnsBetween(headerCells, colMap, ntbIdx, revIdx);
  const rankKwCols = keywordColumnsBetween(headerCells, colMap, revIdx, pcIdx);
  if (ntbIdx != null && revIdx == null) {
    warnings.push('No "Revenue/Day" column found — keyword volume columns could not be located.');
  }
  if (revIdx != null && pcIdx == null) {
    warnings.push('No "Product clicks" column found — keyword rank columns could not be located.');
  }

  const defaultYear = opts.defaultYear || new Date().getFullYear();
  const foundKeys = new Set(Object.values(colMap).filter((k) => k !== 'date'));
  if (volKwCols.length) foundKeys.add('keyword_search_volume');
  if (rankKwCols.length) foundKeys.add('keyword_search_rank');

  const rows = [];
  let prevM0 = null;
  let year = defaultYear;
  const seen = new Set();

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const dm = parseDayMonth(cells[dateCol]);
    if (!dm) continue; // blank / totals / notes row → skip

    // Resolve year: honour an explicit year in the cell; otherwise roll the
    // running year forward when the month wraps backwards (Dec -> Jan).
    if (dm.year) { year = dm.year; }
    else if (prevM0 != null && dm.m0 < prevM0) { year += 1; }
    prevM0 = dm.m0;

    const iso = toISO(year, dm.m0, dm.d);
    if (seen.has(iso)) continue; // one row per date
    seen.add(iso);

    const metrics = {};
    for (const [idx, key] of Object.entries(colMap)) {
      if (key === 'date') continue;
      const n = parseNum(cells[idx]);
      if (n != null) metrics[key] = n;
    }

    // Per-keyword breakdowns from the dynamic columns, plus derived aggregates
    // (volume sums, rank averages) — unless the sheet already had a literal
    // aggregate column mapped above.
    const keywords = {};
    for (const { idx, name } of volKwCols) {
      const n = parseNum(cells[idx]);
      if (n != null) keywords[name] = n;
    }
    const keywordRanks = {};
    for (const { idx, name } of rankKwCols) {
      const n = parseNum(cells[idx]);
      if (n != null) keywordRanks[name] = n;
    }
    const volVals = Object.values(keywords);
    if (volVals.length && metrics.keyword_search_volume == null) metrics.keyword_search_volume = sum(volVals);
    const rankVals = Object.values(keywordRanks);
    if (rankVals.length && metrics.keyword_search_rank == null) {
      metrics.keyword_search_rank = Math.round(avg(rankVals) * 100) / 100;
    }

    // Ignore an all-empty row that happened to have a stray date.
    if (Object.keys(metrics).length === 0 && volVals.length === 0 && rankVals.length === 0) continue;

    rows.push({ date: iso, metrics, keywords, keywordRanks });
  }

  if (rows.length === 0) throw new Error('No data rows found under the header.');

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    rows,
    periodStart: rows[0].date,
    periodEnd: rows[rows.length - 1].date,
    foundKeys: [...foundKeys],
    keywordColumns: {
      volume: volKwCols.map((c) => c.name),
      rank: rankKwCols.map((c) => c.name),
    },
    warnings,
  };
}

export { parseNum, parseDayMonth };
