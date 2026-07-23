// ============================================================
// Amazon Halo Effect — spreadsheet parser.
//
// Boss uploads the whole workbook (.xlsx) or a single .csv. We read EVERY tab
// and classify each by content, so tab names/order don't matter:
//
//   1. the DAILY performance tab — one row per day. Messy preamble (title row,
//      a super-header, blank rows), real header a few rows down. The Amazon side
//      is positional (richer single-sheet format restored 2026-07):
//         … NTB | <keyword-volume cols…> | <per-product revenue cols…>
//               "Total Revenue/Day" | <keyword-rank cols…> | Product clicks …
//      Each keyword/product column's header names it; its cells are the daily
//      value. Aggregates: keyword_search_volume = SUM of the volume cols,
//      keyword_search_rank = AVG of the rank cols, revenue_per_day = the Total
//      (or SUM of the per-product cols when the Total is absent).
//
//   2. a WEEKLY "Branded Demand" tab — one row per week (Week Ending = Saturday),
//      one column per keyword's branded search volume. When the daily tab has no
//      daily keyword-volume columns, this is where branded search lives, and it
//      is WEEKLY-native.
//
//   3. (forward-looking) any other weekly/monthly metric tab — a date/period
//      column plus recognised metric columns. Those metrics become week/month
//      native and are injected into the coarser buckets by the math.
//
// PER-METRIC NATIVE GRANULARITY: we detect each metric's finest granularity from
// the data (daily rows → 'day'; only in a weekly tab → 'week'; only monthly →
// 'month') and return a `metricGran` map. The explorer gates each metric to its
// native granularity and coarser (day < week < month).
// ============================================================

import { headerKey, HALO_FIELDS, normHeader, GRAN_ORDER } from './haloFields';

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

// Parse a date cell into { m0, d, year? }. Returns null if not a date.
function parseDayMonth(cell) {
  if (cell == null || cell === '') return null;
  // Excel serial date (we read with cellDates:false, so date cells arrive as
  // numbers). Convert via the UTC epoch — timezone-independent, so it never
  // drifts a day the way SheetJS's local-midnight Date objects do. 25569 = days
  // from the 1900 date system's epoch (1899-12-30) to 1970-01-01.
  if (typeof cell === 'number' && cell > 20000 && cell < 80000) {
    const dt = new Date(Math.round((cell - 25569) * 86400000));
    return { m0: dt.getUTCMonth(), d: dt.getUTCDate(), year: dt.getUTCFullYear() };
  }
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { m0: cell.getUTCMonth(), d: cell.getUTCDate(), year: cell.getUTCFullYear() };
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

// Median consecutive gap (in days) → granularity of a set of ISO dates.
function granFromDates(isoDates) {
  const uniq = [...new Set(isoDates)].sort();
  if (uniq.length < 2) return 'day';
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const gaps = [];
  for (let i = 1; i < uniq.length; i++) gaps.push((parse(uniq[i]) - parse(uniq[i - 1])) / 86400000);
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med <= 2) return 'day';
  if (med <= 10) return 'week';
  return 'month';
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
  const ntbIdx = idxOf('ntb');                 // left anchor of the keyword-volume region
  const pcIdx = idxOf('product_clicks');       // right anchor of the keyword-rank region

  const dataRows = grid.slice(headerIdx + 1);
  const fillCount = (idx) => dataRows.reduce((n, r) => n + (parseNum((r || [])[idx]) != null ? 1 : 0), 0);
  const colSum = (idx) => dataRows.reduce((s, r) => s + (parseNum((r || [])[idx]) || 0), 0);

  // ---- locate the Amazon "… Revenue/Day" columns by SHAPE, not a fixed name --
  // The revenue region is any run of "… Revenue/Day" columns (real sheets name
  // them "Amazon 2 Oz Revenue/Day", "Amazon All Products Revenue/Day", …; older
  // sheets / our own export use "Total Revenue/Day"). The TOTAL (→ revenue_per_day)
  // is the "All Products"/"Total" column — or the only revenue column, or the
  // largest-summing one. Every OTHER revenue column is one product's daily line.
  // This replaces the old single "Total Revenue/Day" anchor, whose absence on the
  // real sheet used to drop the ENTIRE Amazon side (revenue + keywords + ranks).
  const revCols = [];
  headerCells.forEach((cell, idx) => {
    if (isPlaceholderHeader(cell)) return;
    const n = normHeader(cell);
    if (colMap[idx] === 'revenue_per_day' || n.endsWith('revenueday') || n.endsWith('revenueperday')) {
      revCols.push({ idx, header: cell, norm: n });
    }
  });

  const productCols = [];
  let revIdx = null;                            // TOTAL revenue column = region anchor
  if (revCols.length) {
    const isTotal = (c) => colMap[c.idx] === 'revenue_per_day'
      || c.norm.includes('allproduct') || c.norm.includes('total') || c.norm.includes('overall');
    let total = revCols.find(isTotal);
    if (!total) {
      total = revCols.length === 1
        ? revCols[0]
        : revCols.reduce((a, b) => (colSum(b.idx) > colSum(a.idx) ? b : a));
    }
    revIdx = total.idx;
    if (!colMap[revIdx]) colMap[revIdx] = 'revenue_per_day'; // total feeds metrics.revenue_per_day
    for (const c of revCols) {
      if (c.idx === revIdx) continue;
      const name = cleanRevenueProductName(c.header);
      if (name) productCols.push({ idx: c.idx, name });
    }
  }
  const firstRevIdx = revCols.length ? Math.min(...revCols.map((c) => c.idx)) : null;
  const lastRevIdx = revCols.length ? Math.max(...revCols.map((c) => c.idx)) : null;

  // ---- keyword-VOLUME region: between NTB and the first revenue column -------
  // The OLD format also parks bracketed/ASIN per-product revenue columns in this
  // gap — still split by header shape (bracketed/ASIN = product, plain = keyword).
  // Daily keyword volume only exists with an NTB anchor.
  const volKwCols = [];
  const seenVol = new Set();
  {
    const leftBound = ntbIdx != null ? ntbIdx : dateCol;
    const rightBound = firstRevIdx != null ? firstRevIdx
      : (pcIdx != null ? pcIdx : headerCells.length);
    for (let idx = leftBound + 1; idx < rightBound; idx++) {
      if (colMap[idx]) continue;               // a recognised fixed column
      if (isPlaceholderHeader(headerCells[idx])) continue;
      if (fillCount(idx) === 0) continue;       // empty slot → skip
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

  // ---- keyword-RANK region: between the last revenue column and Product clicks
  const rankKwCols = [];
  const seenRank = new Set();
  if (lastRevIdx != null && pcIdx != null && pcIdx > lastRevIdx + 1) {
    for (let idx = lastRevIdx + 1; idx < pcIdx; idx++) {
      if (colMap[idx]) continue;
      if (isPlaceholderHeader(headerCells[idx])) continue;
      if (fillCount(idx) === 0) continue;
      let name = cleanKeywordName(headerCells[idx]) || String(headerCells[idx]).trim();
      if (seenRank.has(name)) name = `${name} (${idx})`;
      seenRank.add(name);
      rankKwCols.push({ idx, name });
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
    const keywords = {};
    for (const { idx, name } of volKwCols) {
      const n = parseNum(cells[idx]);
      if (n != null && name) keywords[name] = n;
    }
    const keywordRanks = {};
    for (const { idx, name } of rankKwCols) {
      const n = parseNum(cells[idx]);
      if (n != null && name) keywordRanks[name] = n;
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
    rows.push({ date: iso, metrics, productRevenue, keywords, keywordRanks });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : 1));

  // Which metrics actually carry daily data (for metricGran).
  const dayKeys = new Set();
  for (const r of rows) for (const k in r.metrics) if (r.metrics[k] != null) dayKeys.add(k);

  // Standard columns we expected but didn't find (a UI warning). Optional Amazon
  // fields (NTB / branded search / rank) are exempt — they're derived/positional
  // and may legitimately be absent or live in another tab.
  const OPTIONAL = new Set(['ntb', 'keyword_search_volume', 'keyword_search_rank']);
  const presentKeys = new Set([...Object.values(colMap), ...dayKeys]);
  const missingColumns = HALO_FIELDS
    .filter((f) => f.key !== 'date' && !OPTIONAL.has(f.key) && !presentKeys.has(f.key))
    .map((f) => ({ key: f.key, label: f.label }));
  const missingAnchors = missingColumns.filter((m) => m.key === 'revenue_per_day');

  return {
    rows,
    products: productCols.map((c) => c.name),
    volumeKeywords: volKwCols.map((c) => c.name),
    rankKeywords: rankKwCols.map((c) => c.name),
    dayKeys: [...dayKeys],
    foundKeys: [...new Set([...Object.values(colMap).filter((k) => k !== 'date'), ...dayKeys])],
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

// ---- generic weekly/monthly metric tab (forward-looking) --------------------
// A tab with a date/period column + recognised metric columns whose date rows
// are spaced weekly or monthly. Produces [{period_end, metrics}] plus the set of
// metric keys it carries. Returns null if it can't be read.
function parseMetricTab(grid, opts = {}) {
  const headerIdx = findDailyHeaderRow(grid); // reuse: Date-like + >=3 metrics
  if (headerIdx < 0) return null;
  const headerCells = grid[headerIdx];
  const colMap = buildColumnMap(headerCells);
  const dateColKey = Object.keys(colMap).find((idx) => colMap[idx] === 'date');
  if (dateColKey == null) return null;
  const dateCol = Number(dateColKey);

  const isoDates = [];
  const raw = [];
  const defaultYear = opts.defaultYear || new Date().getFullYear();
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
    if (Object.keys(metrics).length) { isoDates.push(iso); raw.push({ period_end: iso, metrics }); }
  }
  if (raw.length < 2) return null;
  const gran = granFromDates(isoDates);
  const keys = new Set();
  for (const r of raw) for (const k in r.metrics) keys.add(k);
  return { gran, periods: raw, keys: [...keys] };
}

/**
 * Parse an uploaded workbook.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ rows, weeklyKeywords, products, keywords, volumeKeywords,
 *             rankKeywords, currency, periodStart, periodEnd, foundKeys,
 *             missingColumns, missingAnchors, metricGran, weeklyMetrics,
 *             monthlyMetrics, warnings }}
 */
export async function parseHaloSheet(arrayBuffer, opts = {}) {
  const warnings = [];
  const XLSX = await import('xlsx'); // heavy — loaded only on upload
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  if (!wb.SheetNames.length) throw new Error('The file has no sheets.');

  // Read every sheet as a grid, then classify by content.
  const grids = wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }));

  let dailyGrid = null;
  let weekly = null;
  const otherGrids = [];
  for (const grid of grids) {
    if (!dailyGrid && findDailyHeaderRow(grid) >= 0) { dailyGrid = grid; continue; }
    if (!weekly) { const w = parseWeeklyTab(grid); if (w) { weekly = w; continue; } }
    otherGrids.push(grid);
  }
  if (!dailyGrid) throw new Error('No daily performance sheet found (needs a "Date" column plus metrics like GMV, Orders, ROI).');

  // The daily tab's dates are year-less text ("May 1"), so infer the year.
  // Anchor it to the weekly "Branded Demand" tab, which DOES carry real ISO
  // years — so a workbook uploaded in a later calendar year is still labelled
  // with the data's own year (and the daily↔weekly week-join lines up).
  const anchorYear = opts.defaultYear
    || (weekly?.weeks?.length ? Number(weekly.weeks[0].week_ending.slice(0, 4)) : undefined);
  const daily = parseDailyTab(dailyGrid, { defaultYear: anchorYear });

  const { rows } = daily;
  if (rows.length === 0) throw new Error('No data rows found under the daily header.');

  const currency = detectCurrency(dailyGrid);
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;

  // ---- per-metric native granularity -----------------------------------------
  const metricGran = {};
  const setFinest = (k, g) => { if (!metricGran[k] || GRAN_ORDER[g] < GRAN_ORDER[metricGran[k]]) metricGran[k] = g; };
  // An all-ZERO daily keyword-volume column is "not available" (per the sheet's
  // convention 0 = no data), so it must NOT claim day-native and pre-empt a real
  // WEEKLY Branded Demand tab. Other metrics keep genuine zeros (e.g. NTB).
  const dailyKsvHasData = rows.some((r) => r.metrics.keyword_search_volume); // truthy = non-zero
  for (const k of daily.dayKeys) {
    if (k === 'keyword_search_volume' && !dailyKsvHasData) continue;
    setFinest(k, 'day');
  }

  // Weekly branded search (current format): only if it isn't already daily.
  const weeklyMetrics = [];
  const monthlyMetrics = [];
  if (weekly && !metricGran.keyword_search_volume) {
    setFinest('keyword_search_volume', 'week');
    for (const w of weekly.weeks) {
      const vals = Object.values(w.keywords || {});
      weeklyMetrics.push({
        period_end: w.week_ending,
        metrics: vals.length ? { keyword_search_volume: sum(vals) } : {},
        keywords: w.keywords || {},
        keywordRanks: {},
        productRevenue: {},
      });
    }
  }

  // Forward-looking: any remaining tab that carries recognised metrics at a
  // weekly or monthly cadence. Its metrics become week/month native (unless
  // already finer) and feed the coarser buckets via the math.
  for (const grid of otherGrids) {
    const t = parseMetricTab(grid, { defaultYear: anchorYear });
    if (!t || t.gran === 'day') continue; // a stray daily-shaped tab is ignored here
    const bucket = t.gran === 'month' ? monthlyMetrics : weeklyMetrics;
    for (const p of t.periods) {
      bucket.push({ period_end: p.period_end, metrics: p.metrics, keywords: {}, keywordRanks: {}, productRevenue: {} });
    }
    for (const k of t.keys) setFinest(k, t.gran);
  }

  if (!weekly && !metricGran.keyword_search_volume) {
    warnings.push('No daily keyword-volume columns and no weekly "Branded Demand" tab — Branded Search Volume will be unavailable. Upload the whole workbook (.xlsx), not just the daily sheet.');
  }

  return {
    rows: rows.map((r) => ({
      date: r.date, metrics: r.metrics, productRevenue: r.productRevenue,
      keywords: r.keywords, keywordRanks: r.keywordRanks,
    })),
    weeklyKeywords: weekly ? weekly.weeks : [],
    products: daily.products,
    keywords: weekly ? weekly.keywords : daily.volumeKeywords,
    volumeKeywords: daily.volumeKeywords,
    rankKeywords: daily.rankKeywords,
    currency,
    periodStart: first,
    periodEnd: last,
    foundKeys: daily.foundKeys,
    missingColumns: daily.missingColumns,
    missingAnchors: daily.missingAnchors,
    metricGran,
    weeklyMetrics,
    monthlyMetrics,
    warnings,
  };
}

export { parseNum, parseDayMonth };
