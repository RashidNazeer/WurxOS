/**
 * Word (.docx) exporter for weekly reports — matches the format of the
 * reference PDF the user provided: header + bordered tables + bullet
 * insights, no images or graphs. Code-split: this whole module is lazy-
 * imported from WeeklyReportView so the `docx` dependency (~150KB
 * gzipped) only loads when a user clicks Export Word.
 *
 * The output deliberately stays plain — single black border on every
 * table, gray header row, no colors elsewhere. Opens cleanly in Word,
 * Google Docs, and Pages.
 */
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
  ShadingType,
} from 'docx';
import { productUnitsLabel } from '../lib/reportUnitsLabel';

// --- helpers -----------------------------------------------------------

function htmlToPlainText(s) {
  if (!s) return '';
  if (typeof s !== 'string') return '';
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  const d = document.createElement('div');
  d.innerHTML = s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ');
  return (d.textContent || d.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(v, sym = '$') {
  const n = num(v);
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtN(v) {
  const n = num(v);
  return n.toLocaleString('en-US');
}

// Black hairline border on every side, consistent with the reference PDF.
const HAIRLINE = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const TABLE_BORDERS = {
  top: HAIRLINE, bottom: HAIRLINE, left: HAIRLINE, right: HAIRLINE,
  insideHorizontal: HAIRLINE, insideVertical: HAIRLINE,
};

function txt(text, opts = {}) {
  return new TextRun({ text: text == null ? '' : String(text), ...opts });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: [txt(text, opts)],
    spacing: opts.spacing,
    alignment: opts.alignment,
  });
}

function cell({ text = '', bold = false, header = false, align } = {}) {
  return new TableCell({
    children: [
      new Paragraph({
        children: [txt(text, { bold })],
        alignment: align,
      }),
    ],
    shading: header
      ? { type: ShadingType.SOLID, color: 'D9D9D9', fill: 'D9D9D9' }
      : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}

function table(rows, columnWidthsPct) {
  // columnWidthsPct: optional array of percentages summing to 100. When
  // omitted, the table auto-fits.
  const opts = {
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: TABLE_BORDERS,
  };
  if (columnWidthsPct && columnWidthsPct.length) {
    opts.columnWidths = columnWidthsPct.map((p) => Math.round(p * 90)); // dxa
  }
  return new Table(opts);
}

function sectionHeading(label) {
  return new Paragraph({
    children: [txt(label, { bold: true, size: 24 })],
    spacing: { before: 360, after: 120 },
  });
}

function bulletList(text) {
  // Split on newlines, drop empties. Lines starting with "•" already in
  // the text get cleaned so we don't end up with "• •  …".
  const lines = (text || '')
    .split(/\n+/)
    .map((l) => l.replace(/^\s*[•\-\*]\s*/, '').trim())
    .filter(Boolean);
  return lines.map(
    (line) =>
      new Paragraph({
        children: [txt(line)],
        bullet: { level: 0 },
        spacing: { before: 60, after: 60 },
      }),
  );
}

// --- per-section table builders --------------------------------------

function buildOverallTable(report, previousReport, sym) {
  const p = report.overallPerformance || {};
  const pp = (previousReport && previousReport.overallPerformance) || {};
  const notes = report.overallNotes || {};

  const header = new TableRow({
    children: [
      cell({ text: 'Metric', bold: true, header: true }),
      cell({ text: 'This Week', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Last Week', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Notes', bold: true, header: true }),
    ],
  });

  const rows = [
    { metric: 'GMV (Gross Merchandise Value)', cur: fmtMoney(p.gmv, sym), prev: fmtMoney(pp.gmv, sym), note: '' },
    { metric: 'Affiliate GMV', cur: fmtMoney(p.affiliateGmv, sym), prev: fmtMoney(pp.affiliateGmv, sym), note: '' },
    { metric: 'Orders', cur: fmtN(p.orders), prev: fmtN(pp.orders), note: '' },
    {
      metric: 'Samples Approved',
      cur: fmtN(p.samplesApproved),
      prev: fmtN(pp.samplesApproved),
      note: notes.samplesApproved ? `MTD Approved: ${fmtN(notes.samplesApproved)}` : '',
    },
    { metric: 'ROI', cur: num(p.roi).toFixed(2), prev: num(pp.roi).toFixed(2), note: 'Target: 1.00' },
    {
      metric: 'Shop Performance Score',
      cur: num(p.shopPerformanceScore).toFixed(1),
      prev: num(pp.shopPerformanceScore).toFixed(1),
      note: '',
    },
    {
      metric: 'Videos Posted this week',
      cur: fmtN(p.videosPosted),
      prev: fmtN(pp.videosPosted),
      note: notes.videosPosted ? `Total Videos: ${fmtN(notes.videosPosted)}` : '',
    },
  ];

  return table(
    [
      header,
      ...rows.map(
        (r) =>
          new TableRow({
            children: [
              cell({ text: r.metric }),
              cell({ text: r.cur, align: AlignmentType.CENTER }),
              cell({ text: r.prev, align: AlignmentType.CENTER }),
              cell({ text: r.note }),
            ],
          }),
      ),
    ],
    [40, 15, 15, 30],
  );
}

function buildTopCreatorsTable(report, sym) {
  const creators = (report.topCreators || []).filter((c) => c && (c.name || c.gmv || c.itemsSold));
  if (creators.length === 0) return null;

  const header = new TableRow({
    children: [
      cell({ text: 'Creator Name', bold: true, header: true }),
      cell({ text: 'Videos Posted (This week)', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Items Sold', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'GMV Generated', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Notes', bold: true, header: true }),
    ],
  });

  return table(
    [
      header,
      ...creators.map(
        (c) =>
          new TableRow({
            children: [
              cell({ text: c.name || '' }),
              cell({ text: fmtN(c.videosPosted), align: AlignmentType.CENTER }),
              cell({ text: fmtN(c.itemsSold), align: AlignmentType.CENTER }),
              cell({ text: fmtMoney(c.gmv, sym), align: AlignmentType.CENTER }),
              cell({ text: c.notes || '' }),
            ],
          }),
      ),
    ],
    [28, 18, 14, 18, 22],
  );
}

function buildTopVideosTable(report, sym) {
  const videos = (report.topVideos || []).filter((v) => v && (v.creatorName || v.gmv || v.views));
  if (videos.length === 0) return null;

  const header = new TableRow({
    children: [
      cell({ text: 'Creator Name (Video URL Linked)', bold: true, header: true }),
      cell({ text: 'Items Sold', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'GMV Generated', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Views', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Product Clicks', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Notes', bold: true, header: true }),
    ],
  });

  return table(
    [
      header,
      ...videos.map((v) => {
        // Creator name renders as a hyperlink when a videoLink is present.
        const link = (v.videoLink || '').trim();
        const nameCell = new TableCell({
          children: [
            new Paragraph({
              children: [
                link
                  ? txt(v.creatorName || '', { style: 'Hyperlink', color: '2563EB', underline: {} })
                  : txt(v.creatorName || ''),
              ],
            }),
          ],
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        });
        return new TableRow({
          children: [
            nameCell,
            cell({ text: fmtN(v.itemsSold), align: AlignmentType.CENTER }),
            cell({ text: fmtMoney(v.gmv, sym), align: AlignmentType.CENTER }),
            cell({ text: fmtN(v.views), align: AlignmentType.CENTER }),
            cell({ text: fmtN(v.productClicks), align: AlignmentType.CENTER }),
            cell({ text: v.notes || '' }),
          ],
        });
      }),
    ],
    [26, 12, 16, 12, 14, 20],
  );
}

function buildGmvMaxTable(report, sym) {
  const camps = (report.gmvMax || []).filter((g) => g && (g.campaign || g.gmv || g.spend));
  if (camps.length === 0) return null;

  // Totals row (matches the reference PDF "Overall" footer).
  const totals = camps.reduce(
    (acc, g) => {
      acc.spend += num(g.spend);
      acc.orders += num(g.orders);
      acc.gmv += num(g.gmv);
      return acc;
    },
    { spend: 0, orders: 0, gmv: 0 },
  );
  const overallRoi = totals.spend > 0 ? totals.gmv / totals.spend : 0;
  const overallCpo = totals.orders > 0 ? totals.spend / totals.orders : 0;

  const header = new TableRow({
    children: [
      cell({ text: 'Campaign', bold: true, header: true }),
      cell({ text: 'Cost', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'ROI', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Orders', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'CPO', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'GMV', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Notes', bold: true, header: true }),
    ],
  });

  const rows = camps.map(
    (g) =>
      new TableRow({
        children: [
          cell({ text: g.campaign || '' }),
          cell({ text: fmtMoney(g.spend, sym), align: AlignmentType.CENTER }),
          cell({ text: num(g.roi).toFixed(2), align: AlignmentType.CENTER }),
          cell({ text: fmtN(g.orders), align: AlignmentType.CENTER }),
          cell({ text: fmtMoney(g.cpo, sym), align: AlignmentType.CENTER }),
          cell({ text: fmtMoney(g.gmv, sym), align: AlignmentType.CENTER }),
          cell({ text: g.notes || '' }),
        ],
      }),
  );

  const overallRow = new TableRow({
    children: [
      cell({ text: 'Overall', bold: true }),
      cell({ text: fmtMoney(totals.spend, sym), bold: true, align: AlignmentType.CENTER }),
      cell({ text: overallRoi.toFixed(2), bold: true, align: AlignmentType.CENTER }),
      cell({ text: fmtN(totals.orders), bold: true, align: AlignmentType.CENTER }),
      cell({ text: fmtMoney(overallCpo, sym), bold: true, align: AlignmentType.CENTER }),
      cell({ text: fmtMoney(totals.gmv, sym), bold: true, align: AlignmentType.CENTER }),
      cell({ text: '' }),
    ],
  });

  return table([header, ...rows, overallRow], [24, 12, 8, 10, 12, 12, 22]);
}

function buildProductHighlightsTable(report, sym) {
  const products = (report.productHighlights || []).filter((p) => p && (p.productName || p.productId || p.gmv));
  if (products.length === 0) return null;

  const header = new TableRow({
    children: [
      cell({ text: 'Product ID + Name (Focus products)', bold: true, header: true }),
      cell({ text: productUnitsLabel(report.createdAt), bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'GMV', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'New Videos', bold: true, header: true, align: AlignmentType.CENTER }),
      cell({ text: 'Notes', bold: true, header: true }),
    ],
  });

  return table(
    [
      header,
      ...products.map((p) => {
        // Reference PDF puts the product NAME then the ID on a new line
        // inside the same cell. Build that with two paragraphs.
        const nameCell = new TableCell({
          children: [
            new Paragraph({ children: [txt(p.productName || '')] }),
            ...(p.productId ? [new Paragraph({ children: [txt(p.productId)] })] : []),
          ],
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
        });
        return new TableRow({
          children: [
            nameCell,
            cell({ text: fmtN(p.unitsSold), align: AlignmentType.CENTER }),
            cell({ text: fmtMoney(p.gmv, sym), align: AlignmentType.CENTER }),
            cell({ text: fmtN(p.newVideos), align: AlignmentType.CENTER }),
            cell({ text: p.notes || '' }),
          ],
        });
      }),
    ],
    [42, 12, 14, 14, 18],
  );
}

// --- public entry ----------------------------------------------------

export async function buildWeeklyReportDocx({ report, previousReport, currency = '$' }) {
  const sectEnabled = report.sectionsEnabled || {};
  const en = (k) => sectEnabled[k] === undefined ? true : !!sectEnabled[k];

  const children = [];

  // ── Title ─────────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      children: [
        txt(
          `WEEKLY REPORT - ${report.brandName || 'Brand'} - ${report.weekLabel || ''}`,
          { bold: true, size: 32 },
        ),
      ],
      spacing: { after: 360 },
    }),
  );

  // ── Overall Performance ───────────────────────────────────────────
  if (en('overallPerformance')) {
    children.push(sectionHeading('Overall Performance:'));
    children.push(buildOverallTable(report, previousReport, currency));
  }

  // ── Top Creators ──────────────────────────────────────────────────
  if (en('topCreators')) {
    const t = buildTopCreatorsTable(report, currency);
    if (t) {
      children.push(sectionHeading('Top Creators:'));
      children.push(t);
    }
  }

  // ── Top Videos ────────────────────────────────────────────────────
  if (en('topVideos')) {
    const t = buildTopVideosTable(report, currency);
    if (t) {
      children.push(sectionHeading('Top Videos:'));
      children.push(t);
    }
  }

  // ── GMV Max Performance ───────────────────────────────────────────
  if (en('gmvMax')) {
    const t = buildGmvMaxTable(report, currency);
    if (t) {
      children.push(sectionHeading('GMV Max Performance:'));
      children.push(t);
    }
  }

  // ── Product Highlights ────────────────────────────────────────────
  if (en('productHighlights')) {
    const t = buildProductHighlightsTable(report, currency);
    if (t) {
      children.push(sectionHeading('Product Highlights:'));
      children.push(t);
    }
  }

  // ── Insights ──────────────────────────────────────────────────────
  // Combine the per-section insight fields into a single bulleted
  // "Insights" block at the bottom, mirroring the reference PDF.
  const insightFields = [
    report.overallInsights,
    report.topCreatorsInsights,
    report.topVideosInsights,
    report.gmvMaxInsights,
    report.productHighlightsInsights,
    report.offsiteInsights,
  ];
  const combined = insightFields
    .map((v) => htmlToPlainText(v || '').trim())
    .filter(Boolean)
    .join('\n');
  const bullets = bulletList(combined);
  if (bullets.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [txt('Insights', { bold: true, size: 28 })],
        spacing: { before: 360, after: 120 },
      }),
    );
    children.push(...bullets);
  }

  const doc = new Document({
    creator: 'WurxOS',
    title: `Weekly Report - ${report.brandName || ''} - ${report.weekLabel || ''}`,
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } },
        },
        children,
      },
    ],
  });

  return await Packer.toBlob(doc);
}
