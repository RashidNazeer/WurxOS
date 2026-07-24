// ============================================================
// Amazon Halo Effect — spreadsheet parser (per-brand, per-granularity).
//
// Each brand has up to THREE sheets, uploaded into separate slots: a DAILY, a
// WEEKLY and a MONTHLY sheet. All three share the SAME column layout — only the
// first column's values differ (a date / a week range / a month). We parse ONE
// sheet at a time, told which granularity it is:
//
//   … Date | GMV | Orders | … | NTB | <keyword-volume cols…>
//         | <per-product "… Revenue/Day" cols…> "All Products Revenue/Day"
//         | <keyword-rank cols…> | Product clicks | …
//
// Columns are FIXED through NTB; after NTB the layout is POSITIONAL:
//   keyword-VOLUME cols  = between NTB and the first "… Revenue/Day" column,
//   revenue cols         = the run of "… Revenue/Day" columns (All Products /
//                          Total = the total → revenue_per_day; others = products),
//   keyword-RANK cols    = between the last revenue column and Product clicks.
// A column's header names it; its cells are that period's value. Aggregates:
//   revenue_per_day = the Total (or SUM of per-product cols when absent),
//   keyword_search_volume = SUM of the volume cols, keyword_search_rank = AVG.
//
// DATES ARE READ VERBATIM AND TIMEZONE-SAFE: we extract {year,month,day} integer
// components and build the ISO string directly — never through a local `Date`
// (which would drift a day across timezones). Ambiguous all-numeric dates are
// DAY-FIRST (DD-MM-YYYY). Weekly rows are a range ("1 June - 7 June") → anchor =
// the START date + the raw label kept for display. Monthly rows ("June 2026") →
// anchor = the first of the month + the raw label.
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
const sum = (arr) => arr.reduce((s, x) => s + x, 0);
const avg = (arr) => (arr.length ? sum(arr) / arr.length : null);

// Strip a bracketed / ASIN-tagged product header to a clean name:
//   "[NMNH; B0DNKFBTNN]" -> "NMNH" ; "[Met4Min berberine; B0B..]" -> "Met4Min berberine"
function cleanProductName(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^\[+|\]+$/g, '').trim();  // strip surrounding brackets
  s = s.split(';')[0].trim();               // drop the "; ASIN" suffix
  return s;
}

// Strip a keyword header's qualifier: "NMNH (all variants)" -> "NMNH".
function cleanKeywordName(raw) {
  return String(raw ?? '').replace(/\([^)]*\)/g, '').trim();
}

// A "… Revenue/Day" column header -> the product name it belongs to:
//   "Amazon 2 Oz Revenue/Day" -> "2 Oz" ; "All Products Revenue/Day" -> "All Products"
function cleanRevenueProductName(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^amazon\s+/i, '');                       // drop "Amazon " prefix
  s = s.replace(/\s*revenue\s*\/?\s*(per\s*)?day\s*$/i, ''); // drop " Revenue/Day" suffix
  return s.trim();
}

// A keyword/product slot header that's a "template placeholder" (empty, or the
// sheet's "[Input Keyword Name & Add Volume Below]" prompt) — not a real column.
function isPlaceholderHeader(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return true;
  if (/\binput\b/i.test(s)) return true;   // "[Input Keyword Name …]"
  if (/^\[\s*(input|add|paste|enter)\b/i.test(s)) return true;
  return false;
}

// Does a header look like a per-PRODUCT revenue column (bracketed / ASIN-tagged)
// rather than a plain keyword name? "[NMNH; B0DNKFBTNN]" → yes; "berberine" → no.
function looksLikeProductHeader(cell) {
  const s = String(cell ?? '').trim();
  if (/^\[.*\]$/.test(s)) return true;          // fully bracketed
  if (/\bB0[A-Z0-9]{8}\b/i.test(s)) return true; // contains an ASIN
  if (s.includes(';')) return true;              // "name; ASIN"
  return false;
}

// ---- flexible, timezone-safe date parsing -----------------------------------

// Given a year + two ambiguous day/month numbers, resolve the order. A token >12
// is unambiguously the day; otherwise fall back to `monthFirst` (true for ISO
// year-first strings; false = DAY-FIRST for everything else). Returns {m0,d,year?}
// or null if out of range.
function resolveDMY(year, x, y, monthFirst) {
  let month;
  let day;
  if (x > 12 && y <= 12) { day = x; month = y; }
  else if (y > 12 && x <= 12) { month = x; day = y; }
  else if (monthFirst) { month = x; day = y; }
  else { day = x; month = y; }
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  return { m0: month - 1, d: day, year };
}

// Parse a single date cell into { m0, d, year? } — TIMEZONE-SAFE (component
// extraction, never through a local Date). Handles Excel serials, month-name
// dates ("12 June 2026", "June 12 2026", "1 Mar"), and numeric dates
// ("2026-06-12" = ISO, "12-07-2026" = DAY-FIRST). Returns null if unparseable.
function parseFlexibleDate(cell) {
  if (cell == null || cell === '') return null;
  // Excel serial (we read with cellDates:false, so date cells arrive as numbers).
  // Convert via the UTC epoch — 25569 = days from 1899-12-30 to 1970-01-01.
  if (typeof cell === 'number') {
    if (cell > 20000 && cell < 80000) {
      const dt = new Date(Math.round((cell - 25569) * 86400000));
      return { m0: dt.getUTCMonth(), d: dt.getUTCDate(), year: dt.getUTCFullYear() };
    }
    return null;
  }
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { m0: cell.getUTCMonth(), d: cell.getUTCDate(), year: cell.getUTCFullYear() };
  }
  const s = String(cell).trim();
  if (!s) return null;

  // Month-name form: "12 June 2026", "June 12 2026", "12-Jun-2026", "1 Mar".
  const nameMatch = s.match(/[A-Za-z]{3,}/);
  if (nameMatch) {
    const mon = MONTHS[nameMatch[0].toLowerCase()];
    if (mon == null) return null;            // has letters but not a month → give up
    const nums = (s.match(/\d{1,4}/g) || []).map(Number);
    let day = null;
    let year;
    for (const t of nums) {
      if (t > 31 || String(t).length === 4) year = t;   // a 4-digit / >31 token = year
      else if (day == null) day = t;                     // first small number = day
      else if (year == null) year = t < 100 ? 2000 + t : t; // second small number = 2-digit year
    }
    return { m0: mon, d: day != null ? day : 1, year };
  }

  // All-numeric with separators: "2026-06-12", "12/07/2026", "12.07.26".
  const parts = s.split(/[/\-.]/).map((t) => t.trim()).filter(Boolean);
  const nums = parts.map(Number);
  if (parts.length >= 3 && nums.every(Number.isFinite)) {
    let yi = parts.findIndex((p) => p.length === 4);       // explicit 4-digit year
    if (yi === -1) yi = nums.findIndex((n) => n > 31);      // or a >31 token
    if (yi === 0) return resolveDMY(nums[0], nums[1], nums[2], true);   // YYYY-M-D (ISO)
    if (yi === 2) return resolveDMY(nums[2], nums[0], nums[1], false);  // D-M-YYYY (day-first)
    if (yi === -1) { const yy = nums[2] < 100 ? 2000 + nums[2] : nums[2]; return resolveDMY(yy, nums[0], nums[1], false); } // D-M-YY (2-digit year, day-first)
    // year in the middle (unusual) → best effort, day-first on the remainder
    const rest = nums.filter((_, i) => i !== yi);
    return resolveDMY(nums[yi], rest[0], rest[1], false);
  }
  // "12/07" (no year) — day-first.
  if (parts.length === 2 && nums.every(Number.isFinite)) {
    return resolveDMY(undefined, nums[0], nums[1], false);
  }
  return null;
}

// Weekly date cell → { anchorISO, label }. Handles "1 June - 7 June",
// "1 - 7 June 2026", "June 1 - 7", "2026-06-01 - 2026-06-07", or a single date
// (treated as the week's anchor). Anchor = the START date; label = the raw cell.
function parseWeekRange(cell, defaultYear) {
  if (cell == null || cell === '') return null;
  const label = String(cell).trim();
  if (!label) return null;
  const halves = label.split(/\s+(?:-|–|—|to)\s+/i).filter(Boolean);
  const endRaw = halves.length > 1 ? halves[halves.length - 1] : null;
  const startRaw = halves[0];

  const end = endRaw ? parseFlexibleDate(endRaw) : null;
  let start = parseFlexibleDate(startRaw);
  // "1 - 7 June": the start half is a bare day → inherit month/year from the end.
  if (!start && end && /^\d{1,2}$/.test(startRaw)) {
    start = { m0: end.m0, d: Number(startRaw), year: end.year };
  }
  if (!start || start.m0 == null) return null;
  if (start.m0 != null && start.d != null && start.year == null) {
    start = { ...start, year: (end && end.year) || defaultYear || new Date().getFullYear() };
  }
  return { anchorISO: toISO(start.year, start.m0, start.d), label };
}

// Monthly date cell → { anchorISO, label }. Handles "June 2026", "Jun 2026",
// "2026-06", "06/2026". Anchor = the first of the month; label = the raw cell.
function parseMonthCell(cell, defaultYear) {
  if (cell == null || cell === '') return null;
  const label = String(cell).trim();
  if (!label) return null;
  let m0;
  let year;
  const nameMatch = label.match(/[A-Za-z]{3,}/);
  if (nameMatch && MONTHS[nameMatch[0].toLowerCase()] != null) {
    m0 = MONTHS[nameMatch[0].toLowerCase()];
    const y = label.match(/\d{4}/);
    year = y ? Number(y[0]) : (defaultYear || new Date().getFullYear());
  } else {
    const nums = (label.match(/\d{1,4}/g) || []).map(Number);
    const y = nums.find((n) => n > 12 || String(n).length === 4);
    const mo = nums.find((n) => n >= 1 && n <= 12 && n !== y);
    if (y == null || mo == null) return null;
    year = y;
    m0 = mo - 1;
  }
  if (m0 == null) return null;
  return { anchorISO: toISO(year, m0, 1), label };
}

// ---- column / region layout -------------------------------------------------

// Find the header row: first row with a "Date" column + >=3 recognised metrics.
function findHeaderRow(grid) {
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

// Map the fixed + positional columns of a sheet. Returns the date column plus
// the per-product revenue, keyword-volume and keyword-rank column lists. The
// revenue region is detected by header SHAPE ("… Revenue/Day"), so real sheets
// ("Amazon All Products Revenue/Day" + "Amazon 2 Oz Revenue/Day") and our own
// exports ("Total Revenue/Day") both work.
function mapSheetColumns(grid, headerIdx) {
  const headerCells = grid[headerIdx];
  const colMap = buildColumnMap(headerCells);
  const dateColKey = Object.keys(colMap).find((idx) => colMap[idx] === 'date');
  if (dateColKey == null) throw new Error('No "Date" column found in the header.');
  const dateCol = Number(dateColKey);

  const idxOf = (k) => {
    const hit = Object.keys(colMap).find((i) => colMap[i] === k);
    return hit == null ? null : Number(hit);
  };
  const ntbIdx = idxOf('ntb');           // left anchor of the keyword-volume region
  const pcIdx = idxOf('product_clicks'); // right anchor of the keyword-rank region

  const dataRows = grid.slice(headerIdx + 1);
  // "0 = not available" (sheet convention): a real-header column that is entirely
  // blank OR entirely zero is not a keyword/product column.
  const hasNonZero = (idx) => dataRows.some((r) => parseNum((r || [])[idx]));
  const colSum = (idx) => dataRows.reduce((s, r) => s + (parseNum((r || [])[idx]) || 0), 0);

  // Revenue columns by header shape. TOTAL = "All Products"/"Total" (or the only
  // one, or the largest-summing); every other revenue col is one product's line.
  const revCols = [];
  headerCells.forEach((cell, idx) => {
    if (isPlaceholderHeader(cell)) return;
    const n = normHeader(cell);
    if (colMap[idx] === 'revenue_per_day' || n.endsWith('revenueday') || n.endsWith('revenueperday')) {
      revCols.push({ idx, header: cell, norm: n });
    }
  });

  const productCols = [];
  if (revCols.length) {
    const isTotal = (c) => colMap[c.idx] === 'revenue_per_day'
      || c.norm.includes('allproduct') || c.norm.includes('total') || c.norm.includes('overall');
    let total = revCols.find(isTotal);
    if (!total) {
      total = revCols.length === 1
        ? revCols[0]
        : revCols.reduce((a, b) => (colSum(b.idx) > colSum(a.idx) ? b : a));
    }
    if (!colMap[total.idx]) colMap[total.idx] = 'revenue_per_day'; // total → metrics.revenue_per_day
    for (const c of revCols) {
      if (c.idx === total.idx) continue;
      const name = cleanRevenueProductName(c.header);
      if (name) productCols.push({ idx: c.idx, name });
    }
  }
  const firstRevIdx = revCols.length ? Math.min(...revCols.map((c) => c.idx)) : null;
  const lastRevIdx = revCols.length ? Math.max(...revCols.map((c) => c.idx)) : null;

  // Keyword-VOLUME region: between NTB and the first revenue column. (Old-format
  // bracketed per-product revenue cols may also live here — split by shape.)
  const volKwCols = [];
  const seenVol = new Set();
  {
    const leftBound = ntbIdx != null ? ntbIdx : dateCol;
    const rightBound = firstRevIdx != null ? firstRevIdx
      : (pcIdx != null ? pcIdx : headerCells.length);
    for (let idx = leftBound + 1; idx < rightBound; idx++) {
      if (colMap[idx]) continue;
      if (isPlaceholderHeader(headerCells[idx])) continue;
      if (!hasNonZero(idx)) continue;
      if (looksLikeProductHeader(headerCells[idx])) {
        productCols.push({ idx, name: cleanProductName(headerCells[idx]) });
      } else if (ntbIdx != null) {
        let name = cleanKeywordName(headerCells[idx]) || String(headerCells[idx]).trim();
        if (seenVol.has(name)) name = `${name} (${idx})`;
        seenVol.add(name);
        volKwCols.push({ idx, name });
      }
    }
  }

  // Keyword-RANK region: between the last revenue column and Product clicks.
  const rankKwCols = [];
  const seenRank = new Set();
  if (lastRevIdx != null && pcIdx != null && pcIdx > lastRevIdx + 1) {
    for (let idx = lastRevIdx + 1; idx < pcIdx; idx++) {
      if (colMap[idx]) continue;
      if (isPlaceholderHeader(headerCells[idx])) continue;
      if (!hasNonZero(idx)) continue;
      let name = cleanKeywordName(headerCells[idx]) || String(headerCells[idx]).trim();
      if (seenRank.has(name)) name = `${name} (${idx})`;
      seenRank.add(name);
      rankKwCols.push({ idx, name });
    }
  }

  return { headerCells, colMap, dateCol, productCols, volKwCols, rankKwCols };
}

// Parse a grid at a given granularity → { rows, products, volumeKeywords,
// rankKeywords, foundKeys, missingColumns, missingAnchors }.
function parseSheetGrid(grid, granularity, opts = {}) {
  const headerIdx = findHeaderRow(grid);
  if (headerIdx < 0) {
    throw new Error('Could not find the header row (needs a "Date" column plus metrics like GMV, Orders, ROI).');
  }
  const layout = mapSheetColumns(grid, headerIdx);
  const { colMap, dateCol, productCols, volKwCols, rankKwCols } = layout;

  const defaultYear = opts.defaultYear || new Date().getFullYear();
  const rows = [];
  const seen = new Set();
  let prevM0 = null;    // year-carry for year-less daily dates ("May 1" … "Jan 3")
  let year = defaultYear;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] || [];
    const dateCell = cells[dateCol];
    let iso = null;
    let periodLabel = null;

    if (granularity === 'week') {
      const wr = parseWeekRange(dateCell, defaultYear);
      if (!wr) continue;
      iso = wr.anchorISO;
      periodLabel = wr.label;
    } else if (granularity === 'month') {
      const mc = parseMonthCell(dateCell, defaultYear);
      if (!mc) continue;
      iso = mc.anchorISO;
      periodLabel = mc.label;
    } else {
      const dm = parseFlexibleDate(dateCell);
      if (!dm || dm.m0 == null || dm.d == null) continue;
      if (dm.year) { year = dm.year; }
      else if (prevM0 != null && dm.m0 < prevM0) { year += 1; }
      prevM0 = dm.m0;
      iso = toISO(year, dm.m0, dm.d);
    }
    if (!iso || seen.has(iso)) continue;
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
    const keywords = {};
    for (const { idx, name } of volKwCols) {
      const n = parseNum(cells[idx]);
      if (n != null && name) keywords[name] = n;
    }
    const keywordRanks = {};
    for (const { idx, name } of rankKwCols) {
      const n = parseNum(cells[idx]);
      if (n != null && n > 0 && name) keywordRanks[name] = n; // rank is 1-based; 0 = not ranked
    }

    // Derived aggregates (unless the sheet already had a literal mapped column).
    const prodVals = Object.values(productRevenue);
    if (metrics.revenue_per_day == null && prodVals.length) metrics.revenue_per_day = sum(prodVals);
    const volVals = Object.values(keywords);
    if (metrics.keyword_search_volume == null && volVals.length) metrics.keyword_search_volume = sum(volVals);
    const rankVals = Object.values(keywordRanks);
    if (metrics.keyword_search_rank == null && rankVals.length) {
      metrics.keyword_search_rank = Math.round(avg(rankVals) * 100) / 100;
    }

    if (Object.keys(metrics).length === 0 && prodVals.length === 0 && volVals.length === 0 && rankVals.length === 0) continue;
    rows.push({ date: iso, periodLabel, metrics, productRevenue, keywords, keywordRanks });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));

  const presentKeys = new Set(Object.values(colMap).filter((k) => k !== 'date'));
  for (const r of rows) for (const k in r.metrics) if (r.metrics[k] != null) presentKeys.add(k);

  // Standard columns we expected but didn't find (a soft UI warning). Optional
  // Amazon fields (NTB / branded search / rank) are exempt — they're positional
  // and may legitimately be absent from a given sheet.
  const OPTIONAL = new Set(['ntb', 'keyword_search_volume', 'keyword_search_rank']);
  const missingColumns = HALO_FIELDS
    .filter((f) => f.key !== 'date' && !OPTIONAL.has(f.key) && !presentKeys.has(f.key))
    .map((f) => ({ key: f.key, label: f.label }));
  const missingAnchors = missingColumns.filter((m) => m.key === 'revenue_per_day');

  return {
    rows,
    products: productCols.map((c) => c.name),
    volumeKeywords: volKwCols.map((c) => c.name),
    rankKeywords: rankKwCols.map((c) => c.name),
    foundKeys: [...presentKeys],
    missingColumns,
    missingAnchors,
  };
}

/**
 * Parse ONE uploaded sheet as a specific granularity.
 * @param {ArrayBuffer} arrayBuffer
 * @param {'day'|'week'|'month'} granularity
 * @returns {{ rows:Array<{date, periodLabel, metrics, productRevenue, keywords,
 *   keywordRanks}>, granularity, products, volumeKeywords, rankKeywords,
 *   currency, periodStart, periodEnd, foundKeys, missingColumns, missingAnchors,
 *   warnings }}
 */
export async function parseHaloGranularitySheet(arrayBuffer, granularity) {
  if (!['day', 'week', 'month'].includes(granularity)) {
    throw new Error(`Unknown granularity "${granularity}" (expected day, week or month).`);
  }
  const XLSX = await import('xlsx'); // heavy — loaded only on upload
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  if (!wb.SheetNames.length) throw new Error('The file has no sheets.');

  const grids = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }));
  const grid = grids.find((g) => findHeaderRow(g) >= 0);
  if (!grid) throw new Error('No data sheet found (needs a "Date" column plus metrics like GMV, Orders, ROI).');

  const currency = detectCurrency(grid);
  const parsed = parseSheetGrid(grid, granularity, {});
  if (!parsed.rows.length) throw new Error('No data rows found under the header.');

  const warnings = [];
  if (parsed.missingAnchors.length) {
    warnings.push('No "Revenue/Day" column found — Amazon Revenue will be unavailable for this sheet.');
  }

  return {
    ...parsed,
    granularity,
    currency,
    periodStart: parsed.rows[0].date,
    periodEnd: parsed.rows[parsed.rows.length - 1].date,
    warnings,
  };
}

export { parseNum, parseFlexibleDate };
