/**
 * PDF → Weekly Report parser.
 *
 * Reads a PDF (typically a Google Doc exported as PDF) and returns a partial
 * report object that can be merged into the form state. Heuristic / layout-aware
 * parsing — no AI required. Hyperlinks (Ctrl-K in Google Docs) survive the export
 * as PDF link annotations, so we extract them too and attach video URLs back to
 * the matching creator rows.
 *
 * Returned shape mirrors emptyReport() in reportingService.js. Any field we
 * couldn't find is left undefined so the caller can decide whether to overwrite.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';

// Use the legacy build's worker via unpkg so we don't have to fight CRA's
// webpack config to bundle a separate worker chunk.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/legacy/build/pdf.worker.min.mjs`;

const Y_TOLERANCE = 3;       // px — items within this Y-distance count as same row
const ROW_GAP = 18;          // px — vertical gap that ends a "table row run"

/* ── PDF → flat items ─────────────────────────────────────────────────────── */

async function extractItems(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const allItems = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const annotations = await page.getAnnotations();
    const links = annotations
      .filter(a => (a.subtype === 'Link' || a.subtype === 'Widget') && (a.url || a.unsafeUrl))
      .map(a => ({
        url: a.url || a.unsafeUrl,
        rect: a.rect, // [x1, y1, x2, y2]
      }));

    const pageHeight = page.view[3];

    tc.items.forEach(it => {
      const text = (it.str || '').trim();
      if (!text) return;
      const x = it.transform[4];
      const y = it.transform[5];
      const width = it.width || 0;
      const height = it.height || 12;

      // Find any link whose rect overlaps this text item.
      // PDF rect is in PDF coords (origin bottom-left), and item.transform
      // is also bottom-left origin so they're directly comparable.
      const link = links.find(l => {
        const [x1, y1, x2, y2] = l.rect;
        const cx = x + width / 2;
        const cy = y + height / 2;
        return cx >= x1 && cx <= x2 && cy >= y1 - 1 && cy <= y2 + 1;
      });

      allItems.push({
        text,
        x, y,
        page: p,
        // Convert to "from-top" Y for stable line grouping across pages
        sortY: (p - 1) * 100000 + (pageHeight - y),
        width,
        url: link?.url || null,
      });
    });
  }
  return allItems;
}

/* ── Group items into lines (rows) ────────────────────────────────────────── */

function groupIntoLines(items) {
  const sorted = [...items].sort((a, b) => a.sortY - b.sortY || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of sorted) {
    if (cur && Math.abs(it.sortY - cur.sortY) <= Y_TOLERANCE && it.page === cur.page) {
      cur.items.push(it);
    } else {
      if (cur) cur.items.sort((a, b) => a.x - b.x);
      cur = { sortY: it.sortY, page: it.page, items: [it] };
      lines.push(cur);
    }
  }
  if (cur) cur.items.sort((a, b) => a.x - b.x);
  // Build a `text` joined by tabs (preserve column structure) and `plain` joined by spaces
  return lines.map(l => ({
    ...l,
    items: l.items,
    plain: l.items.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(),
    columns: groupIntoColumns(l.items),
  }));
}

// Cluster items on a line into "cells" using X-gaps.
function groupIntoColumns(items) {
  if (!items.length) return [];
  const cols = [[items[0]]];
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    // Gap > ~1.5 char widths → new column
    const gap = cur.x - (prev.x + (prev.width || 0));
    if (gap > 8) cols.push([cur]);
    else cols[cols.length - 1].push(cur);
  }
  return cols.map(c => ({
    text: c.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(),
    url: c.find(i => i.url)?.url || null,
    x: c[0].x,
  }));
}

/* ── Heuristic helpers ────────────────────────────────────────────────────── */

const SECTION_PATTERNS = [
  { key: 'overall',         re: /\b(overall\s+performance|performance\s+overview|key\s+metrics)\b/i },
  { key: 'topCreators',     re: /\b(top\s+creators?|leading\s+creators?)\b/i },
  { key: 'topVideos',       re: /\b(top\s+videos?|leading\s+videos?|best\s+videos?)\b/i },
  { key: 'gmvMax',          re: /\b(gmv\s*max|paid\s+ads?|campaigns?\s+performance)\b/i },
  { key: 'productHighlights', re: /\b(product\s+highlights?|top\s+products?|best\s+products?)\b/i },
  { key: 'offsite',         re: /\b(offsite\s+performance|off[\s-]?site)\b/i },
  { key: 'upcomingCampaigns', re: /\b(current\s*&?\s*upcoming\s+campaigns?|upcoming\s+campaigns?|campaigns?)\b/i },
  { key: 'operationalUpdates', re: /\b(operational\s+updates?|operations?)\b/i },
  { key: 'recommendations', re: /\b(recommendations?|action\s+items?|next\s+steps?)\b/i },
  { key: 'insights',        re: /\b(insights?|key\s+takeaways?|summary)\b/i },
];

function detectSection(line) {
  // A section heading line is usually short, no commas, and matches a pattern.
  const t = line.plain;
  if (t.length > 60) return null;
  for (const s of SECTION_PATTERNS) {
    if (s.re.test(t)) return s.key;
  }
  return null;
}

const NUM_RE = /-?\$?\s*[\d,]+(?:\.\d+)?%?/;

function parseNum(str) {
  if (!str) return '';
  const s = String(str).trim();
  // Handle K/M suffix (17.07K → 17070, 1.2M → 1200000)
  const km = s.match(/(-?\$?\s*[\d,]+(?:\.\d+)?)\s*([KkMm])\b/);
  if (km) {
    const base = parseFloat(km[1].replace(/[$,\s]/g, ''));
    const mult = km[2].toLowerCase() === 'k' ? 1000 : 1000000;
    if (!Number.isNaN(base)) return String(Math.round(base * mult));
  }
  const m = s.match(NUM_RE);
  if (!m) return '';
  return m[0].replace(/[$,\s%]/g, '');
}

// Find the value adjacent to a label inside a flat lines array.
// Looks for the label inside any line and returns the first numeric token
// either in the same line (after the label) or in the next non-empty line.
function findLabeledValue(lines, labelRe) {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].plain;
    if (!labelRe.test(t)) continue;
    const after = t.replace(labelRe, '').trim();
    const inSame = after.match(NUM_RE);
    if (inSame) return parseNum(inSame[0]);
    // Try next 1–2 lines
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const m = lines[j].plain.match(NUM_RE);
      if (m) return parseNum(m[0]);
    }
  }
  return '';
}

/* ── Section parsers ──────────────────────────────────────────────────────── */

function parseOverall(lines) {
  return {
    gmv:                 findLabeledValue(lines, /\bGMV\b(?!\s*Max)/i),
    affiliateGmv:        findLabeledValue(lines, /\baffiliate\s*GMV\b/i),
    orders:              findLabeledValue(lines, /\borders\b/i),
    samplesApproved:     findLabeledValue(lines, /\bsamples?\s+approved\b/i),
    roi:                 findLabeledValue(lines, /\bROI\b/i),
    shopPerformanceScore: findLabeledValue(lines, /\bshop\s+performance\s+score\b/i),
    videosPosted:        findLabeledValue(lines, /\bvideos?\s+posted\b/i),
  };
}

function parseOffsite(lines) {
  return {
    offsiteGmv:     findLabeledValue(lines, /\boffsite\s+GMV\b/i),
    tiktokShopGmv:  findLabeledValue(lines, /\btiktok\s+shop\s+GMV\b/i),
    offsiteEffect:  findLabeledValue(lines, /\boffsite\s+effect\b/i),
  };
}

// Generic table parser:
//   Given the lines belonging to a section, find a header line whose columns
//   match `headerKeywords` (e.g. ["creator", "videos", "items", "gmv"]) and
//   parse subsequent lines as rows where each row maps columns to schema keys.
//
//   `columnMap` is an array of { match: regex, key: schemaKey } in column order.
//
// Handles two PDF quirks Google Docs creates:
//   1. Header text wrapping: "Items\nSold" or "Videos Posted\n(This week)" —
//      we merge non-numeric short lines that align with header X-positions.
//   2. Multi-line data cells: "Clinical Wand" stacked below "1729...365" —
//      we merge lone-column non-numeric lines into the previous row.
function parseTable(sectionLines, columnMap) {
  // Find header row: a line whose columns include enough matchers
  let headerIdx = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const cols = sectionLines[i].columns;
    if (cols.length < 2) continue;
    const colTexts = cols.map(c => c.text.toLowerCase());
    const hits = columnMap.filter(cm =>
      colTexts.some(t => cm.match.test(t))
    );
    if (hits.length >= Math.max(2, Math.floor(columnMap.length * 0.5))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  // Build mutable header columns (we may merge sub-header text into them)
  const headerCols = sectionLines[headerIdx].columns.map(c => ({ x: c.x, text: c.text }));

  // Merge sub-header continuation lines (next 1–2 non-numeric lines that align
  // with header column X-positions). This catches "(This week)", "Sold",
  // "Generated", "(Video URL Linked)", "(Focus products)" etc.
  let dataStartIdx = headerIdx + 1;
  for (let i = headerIdx + 1; i < Math.min(headerIdx + 3, sectionLines.length); i++) {
    const line = sectionLines[i];
    if (line.columns.length === 0) break;
    // Sub-header criteria: every column is non-numeric (or parenthetical)
    // AND every column aligns with some header X within tolerance.
    const allNonNumeric = line.columns.every(c => !/\$|\d/.test(c.text) || /^\(.*\)$/.test(c.text.trim()));
    const allAligned = line.columns.every(c => headerCols.some(hc => Math.abs(hc.x - c.x) < 35));
    if (!allNonNumeric || !allAligned) break;

    // Merge each sub-header column's text into the nearest header column
    for (const subCol of line.columns) {
      const target = headerCols.reduce((best, hc) => {
        const d = Math.abs(hc.x - subCol.x);
        return d < best.d ? { hc, d } : best;
      }, { hc: null, d: Infinity });
      if (target.hc) {
        target.hc.text = (target.hc.text + ' ' + subCol.text).trim();
      }
    }
    dataStartIdx = i + 1;
  }

  // Re-match column → schema key with merged headers
  const xToKey = headerCols.map(hc => {
    const text = hc.text.toLowerCase();
    const cm = columnMap.find(c => c.match.test(text));
    return { x: hc.x, key: cm?.key || null };
  });

  // Walk data rows
  const rows = [];
  for (let i = dataStartIdx; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    if (line.columns.length === 0) break;
    if (detectSection(line)) break;

    // Multi-line cell continuation: a single-column line with no $/digit content
    // belongs to the cell directly above it. Append to the previous row's
    // cell at that column position.
    if (line.columns.length === 1 && rows.length > 0) {
      const c = line.columns[0];
      const isContinuation = !/\$|\d{2,}/.test(c.text);
      if (isContinuation) {
        const nearest = xToKey.reduce((best, h) => {
          const d = Math.abs(h.x - c.x);
          return d < best.d ? { h, d } : best;
        }, { h: null, d: Infinity });
        if (nearest.h && nearest.h.key && nearest.d < 50) {
          const prev = rows[rows.length - 1];
          prev[nearest.h.key] = (prev[nearest.h.key] || '') + '\n' + c.text;
          if (c.url) prev.__links = [...(prev.__links || []), c.url];
          continue;
        }
      }
    }

    const row = {};
    const allLinks = [];
    for (const col of line.columns) {
      const nearest = xToKey.reduce((best, h) => {
        const d = Math.abs(h.x - col.x);
        return d < best.d ? { h, d } : best;
      }, { h: null, d: Infinity });
      if (nearest.h && nearest.h.key && nearest.d < 60) {
        const k = nearest.h.key;
        row[k] = (row[k] ? row[k] + ' ' : '') + col.text;
        if (col.url && !row[`${k}__url`]) row[`${k}__url`] = col.url;
      }
      if (col.url) allLinks.push(col.url);
    }
    if (Object.keys(row).filter(k => !k.startsWith('__')).length === 0) continue;
    row.__links = allLinks;
    rows.push(row);
  }
  return rows;
}

/* ── Section-driven slicing ───────────────────────────────────────────────── */

// Split lines into sections. Each section contains the lines from its header
// (exclusive) up to the next header or end of doc.
function sliceSections(lines) {
  const sections = [];
  let current = { key: '__preamble', lines: [] };
  for (const line of lines) {
    const k = detectSection(line);
    if (k) {
      sections.push(current);
      current = { key: k, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function sectionLines(sections, key) {
  return sections.find(s => s.key === key)?.lines || [];
}

function sectionText(sections, key) {
  const ls = sectionLines(sections, key);
  return ls.map(l => l.plain).filter(Boolean).join('\n');
}

/* ── Public API ───────────────────────────────────────────────────────────── */

export async function parsePdfToReport(file) {
  const items = await extractItems(file);
  const lines = groupIntoLines(items);
  const sections = sliceSections(lines);

  // Overall performance
  const overallPerformance = parseOverall(
    [...sectionLines(sections, 'overall'), ...sectionLines(sections, '__preamble')]
  );

  // Top Creators
  const creatorsRows = parseTable(sectionLines(sections, 'topCreators'), [
    { match: /creator|name/i,        key: 'name' },
    { match: /videos?/i,             key: 'videosPosted' },
    { match: /items?\s*sold|units/i, key: 'itemsSold' },
    { match: /gmv|revenue/i,         key: 'gmv' },
    { match: /notes?|remark/i,       key: 'notes' },
  ]);
  const topCreators = creatorsRows.length
    ? creatorsRows.map(r => ({
        name: r.name || '',
        videosPosted: parseNum(r.videosPosted),
        itemsSold: parseNum(r.itemsSold),
        gmv: parseNum(r.gmv),
        notes: r.notes || '',
      }))
    : null;

  // Top Videos — capture videoLink from any URL in the row (prefer tiktok.com)
  const videoRows = parseTable(sectionLines(sections, 'topVideos'), [
    { match: /creator|name|account/i, key: 'creatorName' },
    { match: /video|link/i,           key: 'videoLink' },
    { match: /items?\s*sold|units/i,  key: 'itemsSold' },
    { match: /gmv|revenue/i,          key: 'gmv' },
    { match: /views?/i,               key: 'views' },
    { match: /clicks?/i,              key: 'productClicks' },
    { match: /notes?|remark/i,        key: 'notes' },
  ]);
  const topVideos = videoRows.length
    ? videoRows.map(r => {
        const tiktokLink = (r.__links || []).find(u => /tiktok\.com|youtube|youtu\.be/i.test(u));
        return {
          creatorName: r.creatorName || '',
          videoLink: tiktokLink || r.videoLink__url || (r.videoLink && /^https?:\/\//.test(r.videoLink) ? r.videoLink : ''),
          itemsSold: parseNum(r.itemsSold),
          gmv: parseNum(r.gmv),
          views: parseNum(r.views),
          productClicks: parseNum(r.productClicks),
          notes: r.notes || '',
        };
      })
    : null;

  // GMV Max
  const gmvMaxRows = parseTable(sectionLines(sections, 'gmvMax'), [
    { match: /campaign|name/i,    key: 'campaign' },
    { match: /spend|cost/i,       key: 'spend' },
    { match: /roi/i,              key: 'roi' },
    { match: /orders?/i,          key: 'orders' },
    { match: /cpo|cost.?per/i,    key: 'cpo' },
    { match: /gmv|revenue/i,      key: 'gmv' },
    { match: /notes?|remark/i,    key: 'notes' },
  ]);
  const gmvMax = gmvMaxRows.length
    ? gmvMaxRows.map(r => ({
        campaign: r.campaign || '',
        spend: parseNum(r.spend),
        roi: parseNum(r.roi),
        orders: parseNum(r.orders),
        cpo: parseNum(r.cpo),
        gmv: parseNum(r.gmv),
        notes: r.notes || '',
      }))
    : null;

  // Product Highlights
  const productRows = parseTable(sectionLines(sections, 'productHighlights'), [
    { match: /product\s*id|sku/i,   key: 'productId' },
    { match: /product\s*name|name/i, key: 'productName' },
    { match: /units?\s*sold|units/i, key: 'unitsSold' },
    { match: /gmv|revenue/i,         key: 'gmv' },
    { match: /new\s*videos?|videos?/i, key: 'newVideos' },
    { match: /notes?|remark/i,       key: 'notes' },
  ]);
  const productHighlights = productRows.length
    ? productRows.map(r => {
        let productId = r.productId || '';
        let productName = r.productName || '';
        // Google Docs often stacks Product ID and Product Name in the SAME
        // cell (vertically). After the multi-line merge in parseTable, both
        // end up in `productId` separated by '\n'. Split them: digit-only
        // line = ID, the rest = name.
        if (productId && !productName) {
          const lines = productId.split('\n').map(s => s.trim()).filter(Boolean);
          const idLine = lines.find(l => /^\d{8,}$/.test(l));
          if (idLine) {
            productId = idLine;
            productName = lines.filter(l => l !== idLine).join(' ');
          }
        }
        return {
          productId,
          productName,
          unitsSold: parseNum(r.unitsSold),
          gmv: parseNum(r.gmv),
          newVideos: parseNum(r.newVideos),
          notes: r.notes || '',
        };
      })
    : null;

  // Offsite
  const offsitePerformance = parseOffsite([
    ...sectionLines(sections, 'offsite'),
    ...sectionLines(sections, '__preamble'),
  ]);

  // Combine ALL narrative content into a single blob at the end. Different
  // people write the narrative differently — sometimes everything is under
  // "Insights", sometimes it's split into Operational/Recommendations/etc.
  // Easier for the user to have one dumping ground and split manually than
  // for us to guess wrong. Section labels are preserved as headings.
  const upcomingCampaigns  = sectionText(sections, 'upcomingCampaigns');
  const operationalUpdates = sectionText(sections, 'operationalUpdates');
  const recommendations    = sectionText(sections, 'recommendations');
  const insightsText       = sectionText(sections, 'insights');

  const blocks = [];
  if (insightsText)       blocks.push('Performance Summary:\n' + insightsText);
  if (operationalUpdates) blocks.push('Operational Updates:\n' + operationalUpdates);
  if (recommendations)    blocks.push('Recommendations & Action Items:\n' + recommendations);
  if (upcomingCampaigns)  blocks.push('Current & Upcoming Campaigns:\n' + upcomingCampaigns);
  const combinedNarrative = blocks.join('\n\n');

  // Strip empty values so the merge doesn't overwrite defaults with "".
  const result = {
    overallPerformance: stripEmpty(overallPerformance),
    offsitePerformance: stripEmpty(offsitePerformance),
  };
  if (topCreators) result.topCreators = topCreators;
  if (topVideos) result.topVideos = topVideos;
  if (gmvMax) result.gmvMax = gmvMax;
  if (productHighlights) result.productHighlights = productHighlights;
  if (combinedNarrative) {
    result.recommendations = `<p>${combinedNarrative.replace(/\n/g, '</p><p>')}</p>`;
  }

  // Diagnostic: what got filled, for the toast in the UI
  result.__diagnostics = {
    overallFields: Object.keys(result.overallPerformance).length,
    creators: topCreators?.length || 0,
    videos: topVideos?.length || 0,
    videosWithLink: topVideos?.filter(v => v.videoLink).length || 0,
    gmvMax: gmvMax?.length || 0,
    products: productHighlights?.length || 0,
    hasNarrative: !!combinedNarrative,
  };

  return result;
}

function stripEmpty(obj) {
  const out = {};
  for (const k in obj) {
    if (obj[k] !== '' && obj[k] != null) out[k] = obj[k];
  }
  return out;
}

/* ── Monthly Report parsing (verbatim port of v1 commit 47cbe1d) ─────────────
 *
 * Monthly PDFs follow the format used by reporting@wurxcrew (Aurelia Apr 26
 * is the canonical example). They differ from weekly:
 *   - Most KPI tables have a "This Month | Last Month" pair of columns; we
 *     only want This Month.
 *   - Top Creators / Top Videos / Product Analytics are 2× side-by-side
 *     tables; we take the LEFT half.
 *   - Key Metrics is a chart widget — labels on one line, values on the next,
 *     aligned by X-position.
 *   - Narrative comes in two named sections: "Strategy & Insights" →
 *     keyWinsInsights, and "Action for <Month>" → recommendations.
 * ────────────────────────────────────────────────────────────────────────── */

const MONTHLY_SECTION_PATTERNS = [
  { key: 'totalSales',          re: /^total\s+sales\b/i },
  { key: 'keyMetrics',          re: /^key\s+metrics\b/i },
  { key: 'kpis',                re: /^kpi'?s?\b/i },
  { key: 'gmvBreakdown',        re: /^gmv\s+breakdown\b/i },
  { key: 'topCreators',         re: /^top\s+creators?\b/i },
  { key: 'topVideos',           re: /^top\s+videos?\b/i },
  { key: 'videoPerformance',    re: /^video\s+performance\b/i },
  { key: 'creatorsPerformance', re: /^creators'?\s+performance\b/i },
  { key: 'paidCollabs',         re: /^paid\s+collabs?\s+performance\b/i },
  { key: 'productAnalytics',    re: /^product\s+analytics\b/i },
  { key: 'gmvMaxPerformance',   re: /^gmv\s+max\s+performance\b/i },
  { key: 'customers',           re: /^customers\b\s*:?\s*$/i },
  { key: 'insights',            re: /^strategy\s*&\s*insights\b/i },
  { key: 'action',              re: /^action\s+for\b/i },
];

function detectMonthlySection(line) {
  const t = line.plain.trim().replace(/[:!]+$/, '').trim();
  if (!t || t.length > 60) return null;
  for (const s of MONTHLY_SECTION_PATTERNS) {
    if (s.re.test(t)) return s.key;
  }
  return null;
}

function sliceMonthlySections(lines) {
  const sections = [];
  let current = { key: '__preamble', lines: [] };
  for (const line of lines) {
    const k = detectMonthlySection(line);
    if (k) {
      sections.push(current);
      current = { key: k, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

// Pull the four Key Metrics values (GMV / Orders / Customers / Items sold)
// from the chart widget. Labels live on one line, values on a following line,
// and we match values to labels by X-position.
function parseKeyMetricsBlock(sectionLines) {
  let labelIdx = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const cols = sectionLines[i].columns;
    if (cols.length < 3) continue;
    const colTexts = cols.map(c => c.text.toLowerCase());
    const hits = ['gmv', 'orders', 'customers', 'items'].filter(t =>
      colTexts.some(c => c.includes(t))
    );
    if (hits.length >= 3) { labelIdx = i; break; }
  }
  if (labelIdx < 0) return {};

  const labelMap = [];
  for (const c of sectionLines[labelIdx].columns) {
    const t = c.text.toLowerCase();
    if (/^gmv\b/.test(t)) labelMap.push({ key: 'gmv', x: c.x });
    else if (t.includes('orders'))    labelMap.push({ key: 'orders', x: c.x });
    else if (t.includes('customers')) labelMap.push({ key: 'customers', x: c.x });
    else if (t.includes('items'))     labelMap.push({ key: 'itemsSold', x: c.x });
  }
  if (labelMap.length === 0) return {};

  const out = {};
  for (let i = labelIdx + 1; i < Math.min(labelIdx + 6, sectionLines.length); i++) {
    const line = sectionLines[i];
    if (line.columns.length === 0) continue;
    let assigned = 0;
    for (const col of line.columns) {
      const m = col.text.match(NUM_RE);
      if (!m) continue;
      let best = null, bestD = 50;
      for (const lm of labelMap) {
        const d = Math.abs(lm.x - col.x);
        if (d < bestD) { bestD = d; best = lm; }
      }
      if (best && !out[best.key]) {
        out[best.key] = parseNum(m[0]);
        assigned++;
      }
    }
    if (assigned > 0) break;
  }
  return out;
}

// Parse a "Top Creators" or "Top Videos" table: header has Username/Video Link
// in col 0 and GMV in col 1, with a mirrored "Last Month" pair on the right.
// Take only the left half (This Month).
function parseTopList(sectionLines, kind /* 'creator' | 'video' */) {
  let headerIdx = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const cols = sectionLines[i].columns;
    if (cols.length < 2) continue;
    const c0 = cols[0].text.toLowerCase();
    const c1 = cols[1].text.toLowerCase();
    const c0ok = kind === 'creator'
      ? /username|^name$|creator/.test(c0)
      : /video|link/.test(c0);
    const c1ok = /gmv|generated|revenue|amount/.test(c1);
    if (c0ok && c1ok) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];

  const headerCols = sectionLines[headerIdx].columns;
  const x0 = headerCols[0].x;
  const x1 = headerCols[1].x;
  // Right edge of the "This Month" half: midpoint between col[1] and col[2]
  // (the "Last Month" username column). If absent, no upper bound.
  const midX = headerCols.length >= 3
    ? (headerCols[1].x + headerCols[2].x) / 2
    : Infinity;

  const rows = [];
  for (let i = headerIdx + 1; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    if (line.columns.length === 0) continue;
    if (detectMonthlySection(line)) break;

    let firstText = '', firstUrl = null, secondText = '';
    for (const col of line.columns) {
      if (col.x >= midX) continue;
      const d0 = Math.abs(col.x - x0);
      const d1 = Math.abs(col.x - x1);
      if (d0 <= d1) {
        firstText = (firstText ? firstText + ' ' : '') + col.text;
        if (col.url && !firstUrl) firstUrl = col.url;
      } else {
        secondText = (secondText ? secondText + ' ' : '') + col.text;
      }
    }
    firstText = firstText.trim();
    secondText = secondText.trim();
    if (!firstText && !secondText) continue;
    // Skip stray "Username / GMV Generated" sub-header rows
    if (/^(username|video\s*link|gmv\s+generated|name|creator)$/i.test(firstText)) continue;

    if (kind === 'creator') {
      rows.push({ username: firstText, gmv: parseNum(secondText) });
    } else {
      // Prefer the hyperlink target; fall back to whatever text is in the
      // cell (the form will flag a non-URL entry on validation).
      rows.push({ videoLink: firstUrl || firstText, gmv: parseNum(secondText) });
    }
  }
  return rows;
}

// Product Analytics: header has Product (ID) | Units Sold | GMV | Samples
// Approved twice (this month + last month). Take the left 4 columns; the
// product cell is stacked vertically with name + numeric ID, so we collect
// continuation lines into the same row's productId field and split after.
function parseProductAnalyticsTable(sectionLines) {
  let headerIdx = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const t = sectionLines[i].plain.toLowerCase();
    if (sectionLines[i].columns.length < 3) continue;
    if (/product/.test(t) && /units?\s*sold/.test(t) && /gmv/.test(t) && /samples?/.test(t)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  // Header may span two physical rows ("Units Sold" wraps to "Sold").
  // Collect "This Month" left-half X positions: take the first 4 column X's
  // up to (but not crossing) the midpoint of the row width.
  const headerCols = sectionLines[headerIdx].columns;
  if (headerCols.length < 4) return [];
  const xs = headerCols.slice(0, 4).map(c => c.x);
  const rightLimit = headerCols.length >= 5 ? headerCols[4].x : Infinity;

  const rows = [];
  let dataStartIdx = headerIdx + 1;
  // Skip immediate sub-header continuation rows ("Sold", "Approved", etc.)
  for (let j = headerIdx + 1; j < Math.min(headerIdx + 3, sectionLines.length); j++) {
    const line = sectionLines[j];
    const allNonNum = line.columns.every(c => !/\d/.test(c.text));
    if (!allNonNum) break;
    dataStartIdx = j + 1;
  }

  for (let i = dataStartIdx; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    if (line.columns.length === 0) continue;
    if (detectMonthlySection(line)) break;

    const cells = ['', '', '', ''];
    for (const c of line.columns) {
      if (c.x >= rightLimit) continue;
      let bestIdx = -1, bestD = 60;
      for (let j = 0; j < xs.length; j++) {
        const d = Math.abs(xs[j] - c.x);
        if (d < bestD) { bestD = d; bestIdx = j; }
      }
      if (bestIdx === -1) continue;
      cells[bestIdx] = (cells[bestIdx] ? cells[bestIdx] + ' ' : '') + c.text;
    }

    // Continuation: only col 0 has text → append to previous row's productId
    const onlyFirst = cells[0] && !cells[1] && !cells[2] && !cells[3];
    if (onlyFirst && rows.length > 0) {
      const prev = rows[rows.length - 1];
      prev.__rawId = ((prev.__rawId || '') + '\n' + cells[0]).trim();
      continue;
    }
    if (!cells[0] && !cells[1] && !cells[2] && !cells[3]) continue;

    rows.push({
      __rawId: cells[0],
      unitsSold: parseNum(cells[1]),
      gmv: parseNum(cells[2]),
      samplesApproved: parseNum(cells[3]),
    });
  }

  // Split product name and numeric SKU id from the stacked first cell
  return rows.map(r => {
    const parts = (r.__rawId || '').split('\n').map(s => s.trim()).filter(Boolean);
    const idLine = parts.find(l => /^\d{8,}$/.test(l));
    const productId = idLine || '';
    const productName = parts.filter(l => l !== idLine).join(' ').trim();
    return {
      productId,
      productName,
      unitsSold: r.unitsSold || '',
      gmv: r.gmv || '',
      samplesApproved: r.samplesApproved || '',
    };
  }).filter(r => r.productId || r.productName);
}

// GMV Max Performance: simple table with a single row in the canonical doc.
// Use the existing parseTable. Some PDFs have "Note: Not created" with no
// metrics — we still keep the campaign name so the user sees the row.
function parseMonthlyGmvMax(sectionLines) {
  const rows = parseTable(sectionLines, [
    { match: /campaign|name/i, key: 'campaign' },
    { match: /spend|cost/i,    key: 'spend' },
    { match: /roi/i,           key: 'roi' },
    { match: /orders?/i,       key: 'orders' },
    { match: /cpo|cost.?per/i, key: 'cpo' },
    { match: /gmv|revenue/i,   key: 'gmv' },
    { match: /notes?|remark/i, key: 'notes' },
  ]);
  return rows.map(r => ({
    campaign: (r.campaign || '').trim(),
    spend:    parseNum(r.spend),
    roi:      parseNum(r.roi),
    orders:   parseNum(r.orders),
    cpo:      parseNum(r.cpo),
    gmv:      parseNum(r.gmv),
    notes:    (r.notes || '').trim(),
  })).filter(r => r.campaign || r.spend || r.gmv);
}

export async function parseMonthlyPdfToReport(file) {
  const items = await extractItems(file);
  const lines = groupIntoLines(items);
  const sections = sliceMonthlySections(lines);

  const ls = key => sections.find(s => s.key === key)?.lines || [];
  const txt = key => ls(key).map(l => l.plain).filter(Boolean).join('\n');

  // Total Sales — bullets like "MONTH: $0" / "All time: $X". Search the
  // section first, then fall back to the preamble in case the bullets sit
  // above the "Total Sales" heading on page 1.
  const totalSrc = [...ls('totalSales'), ...ls('__preamble')];
  const totalSales = stripEmpty({
    monthGmv:   findLabeledValue(totalSrc, /^\s*(this\s*)?month\b\s*:?/im),
    allTimeGmv: findLabeledValue(totalSrc, /\ball.?time\b\s*:?/i),
  });

  // Key Metrics widget
  const keyMetrics = stripEmpty(parseKeyMetricsBlock(ls('keyMetrics')));

  // KPI table (label + ThisMonth + LastMonth on each row)
  const kpiL = ls('kpis');
  const kpis = stripEmpty({
    completedCollabs:    findLabeledValue(kpiL, /\bcompleted\s*collabs?\b/i),
    contentPending:      findLabeledValue(kpiL, /\bcontent\s*pending\b/i),
    totalOrders:         findLabeledValue(kpiL, /\btotal\s*orders?\b/i),
    freeSamplesApproved: findLabeledValue(kpiL, /\b(?:free\s+)?samples?\s+approved\b/i),
  });

  // GMV Breakdown
  const gbL = ls('gmvBreakdown');
  const gmvBreakdown = stripEmpty({
    affiliateGmv:   findLabeledValue(gbL, /\baffiliate\s*GMV\b/i),
    organicGmv:     findLabeledValue(gbL, /\borganic\s*GMV\b/i),
    liveGmv:        findLabeledValue(gbL, /\blive\s*GMV\b/i),
    videoGmv:       findLabeledValue(gbL, /\bvideo\s*GMV\b/i),
    productCardGmv: findLabeledValue(gbL, /\bproduct\s*card\s*GMV\b/i),
  });

  // Top Creators / Top Videos
  const topCreators = parseTopList(ls('topCreators'), 'creator');
  const topVideos   = parseTopList(ls('topVideos'),   'video');

  // Video Performance — labelled rows
  const vpL = ls('videoPerformance');
  const videoPerformance = stripEmpty({
    productImpressions: findLabeledValue(vpL, /\bproduct\s*impressions?\b/i),
    productClicks:      findLabeledValue(vpL, /\bproduct\s*clicks?\b/i),
    videoViews:         findLabeledValue(vpL, /\bvideo\s*v[il]ews?\b/i),
    ctr:                findLabeledValue(vpL, /\bCTR\b/i),
    ctor:               findLabeledValue(vpL, /\bCTOR\b/i),
    skuOrders:          findLabeledValue(vpL, /\bsku\s*orders?\b/i),
    gmv:                findLabeledValue(vpL, /^\s*GMV\s*(?:\d|$)/im),
    videos1MViews:      findLabeledValue(vpL, /videos?\s+with\s+1m\+\s*views/i),
    videos100kViews:    findLabeledValue(vpL, /videos?\s+with\s+100k\+\s*views/i),
    videos10kViews:     findLabeledValue(vpL, /videos?\s+with\s+10k\+\s*views/i),
    videos1000Gmv:      findLabeledValue(vpL, /videos?\s+with\s+\$?1[,.]?000\+/i),
    videos100Gmv:       findLabeledValue(vpL, /videos?\s+with\s+\$?100\+(?!0)/i),
    newVideosPosted:    findLabeledValue(vpL, /(?:new\s+)?videos?\s*posted/i),
  });

  // Creators Performance
  const cpL = ls('creatorsPerformance');
  const creatorsPerformance = stripEmpty({
    creators1Plus:  findLabeledValue(cpL, /creators?\s*posted\s*1\+/i),
    creators3Plus:  findLabeledValue(cpL, /creators?\s*posted\s*3\+/i),
    creators10Plus: findLabeledValue(cpL, /creators?\s*posted\s*10\+/i),
    creators1kGmv:  findLabeledValue(cpL, /creators?\s*generated\s*\$?1k\+/i),
    creators100Gmv: findLabeledValue(cpL, /creators?\s*generated\s*\$?100\+/i),
  });

  // Customers
  const cuL = ls('customers');
  const customers = stripEmpty({
    awareCustomers:        findLabeledValue(cuL, /\baware\s*customers?\b/i),
    newCustomers:          findLabeledValue(cuL, /\bnew\s*customers?\b/i),
    potentialNewCustomers: findLabeledValue(cuL, /\bpotential\s*new\s*customers?\b/i),
    crmMessagesSent:       findLabeledValue(cuL, /\bcrm\s*messages?\s*sent\b/i),
    convertedCustomers:    findLabeledValue(cuL, /\bconverted\s*customers?\b/i),
  });

  // Product Analytics
  const productAnalytics = parseProductAnalyticsTable(ls('productAnalytics'));

  // GMV Max Performance
  const gmvMax = parseMonthlyGmvMax(ls('gmvMaxPerformance'));

  // Narrative blocks — Strategy & Insights → keyWinsInsights, Action for X →
  // recommendations. Paid Collabs Performance has no Monthly schema field
  // (the GMV Max table is the closest), so we append it to recommendations
  // as plain text rather than dropping it on the floor.
  const insightsRaw   = txt('insights');
  const actionRaw     = txt('action');
  const paidCollabRaw = txt('paidCollabs');

  const recoBlocks = [];
  if (actionRaw)     recoBlocks.push(actionRaw);
  if (paidCollabRaw) recoBlocks.push('Paid Collabs Performance:\n' + paidCollabRaw);
  const recommendations = recoBlocks.join('\n\n');

  const result = {};
  if (Object.keys(totalSales).length)          result.totalSales          = totalSales;
  if (Object.keys(keyMetrics).length)          result.keyMetrics          = keyMetrics;
  if (Object.keys(kpis).length)                result.kpis                = kpis;
  if (Object.keys(gmvBreakdown).length)        result.gmvBreakdown        = gmvBreakdown;
  if (Object.keys(videoPerformance).length)    result.videoPerformance    = videoPerformance;
  if (Object.keys(creatorsPerformance).length) result.creatorsPerformance = creatorsPerformance;
  if (Object.keys(customers).length)           result.customers           = customers;
  if (topCreators.length)       result.topCreators       = topCreators;
  if (topVideos.length)         result.topVideos         = topVideos;
  if (productAnalytics.length)  result.productAnalytics  = productAnalytics;
  if (gmvMax.length)            result.gmvMax            = gmvMax;
  if (insightsRaw)              result.keyWinsInsights   = `<p>${insightsRaw.replace(/\n/g, '</p><p>')}</p>`;
  if (recommendations)          result.recommendations   = `<p>${recommendations.replace(/\n/g, '</p><p>')}</p>`;

  result.__diagnostics = {
    totalSalesFields:        Object.keys(totalSales).length,
    keyMetricFields:         Object.keys(keyMetrics).length,
    kpiFields:               Object.keys(kpis).length,
    gmvBreakdownFields:      Object.keys(gmvBreakdown).length,
    videoPerformanceFields:  Object.keys(videoPerformance).length,
    creatorsPerformanceFields: Object.keys(creatorsPerformance).length,
    customerFields:          Object.keys(customers).length,
    creators:                topCreators.length,
    videos:                  topVideos.length,
    videosWithLink:          topVideos.filter(v => /^https?:\/\//.test(v.videoLink || '')).length,
    products:                productAnalytics.length,
    gmvMax:                  gmvMax.length,
    hasInsights:             !!insightsRaw,
    hasRecommendations:      !!recommendations,
  };

  return result;
}
