import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType,
} from 'docx';
import { writeFileSync } from 'node:fs';

// Plain, editable Word doc for the Euka meeting. No colors, single black
// table borders, screenshot placeholders left blank for the user to fill.
// Output goes to the project folder (one level above the repo).

const FONT = 'Calibri';
const OUT = process.env.OUT || 'D:/Milestone/WurxOS V2/Euka - Metrics and API Requests.docx';

const B = '000000';
const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: B };
const tableBorders = {
  top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder,
  insideHorizontal: cellBorder, insideVertical: cellBorder,
};

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 22, bold: o.bold, italics: o.italics, color: o.color });
const para = (text, o = {}) => new Paragraph({
  spacing: { after: o.after ?? 140, before: o.before ?? 0, line: 276 },
  alignment: o.align,
  children: Array.isArray(text) ? text : [run(text, o)],
});
const h1 = (text) => new Paragraph({
  spacing: { after: 80, before: 40 },
  children: [run(text, { bold: true, size: 40 })],
});
const h2 = (text) => new Paragraph({
  spacing: { after: 100, before: 260 },
  children: [run(text, { bold: true, size: 30 })],
});
const h3 = (text) => new Paragraph({
  spacing: { after: 80, before: 180 },
  children: [run(text, { bold: true, size: 24 })],
});
const bullet = (text) => new Paragraph({
  bullet: { level: 0 }, spacing: { after: 60, line: 276 },
  children: [run(text)],
});
const ss = (text) => new Paragraph({
  spacing: { after: 160, before: 60 },
  children: [run(text, { italics: true, color: '808080' })],
});
const rule = () => new Paragraph({
  spacing: { after: 180, before: 120 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } },
  children: [run('')],
});

// --- GMV Max columns table ---
const GMV_ROWS = [
  ['Column', 'What it is'],
  ['Campaign Name', 'Name of the campaign'],
  ['Campaign ID', 'TikTok campaign ID'],
  ['Status', 'Active, Paused, Ended, or Draft'],
  ['Schedule Time', 'When the campaign is set to run'],
  ['Campaign Budget', 'Budget set for the campaign'],
  ['Target ROI', 'The ROI target set on the campaign'],
  ['Cost', 'Ad spend for the period'],
  ['SKU Orders', 'Number of SKU orders generated'],
  ['Cost per Order', 'Cost divided by SKU orders'],
  ['Gross Revenue (GMV)', 'Revenue attributed to the campaign'],
  ['ROI', 'Gross revenue divided by cost'],
];
function gmvTable() {
  const rows = GMV_ROWS.map((r, i) => new TableRow({
    tableHeader: i === 0,
    children: r.map((c, ci) => new TableCell({
      width: { size: ci === 0 ? 34 : 66, type: WidthType.PERCENTAGE },
      shading: i === 0 ? { fill: 'EDEDED' } : undefined,
      margins: { top: 40, bottom: 40, left: 90, right: 90 },
      children: [new Paragraph({ children: [run(c, { bold: i === 0 })], spacing: { after: 0, line: 264 } })],
    })),
  }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorders, rows });
}

const body = [
  h1('Metrics and API Requests for Euka'),
  para([run('From: Wurx Media', { bold: true })], { after: 20 }),
  para([run('Date: July 2026', { bold: true })], { after: 200 }),

  h2('Quick context'),
  para("We use Euka every day for our TikTok Shop reporting across all of our brands, and it saves us a lot of manual work. Ahead of our meeting, we wanted to write down the exact stats and endpoints we're hoping to get from you so nothing gets lost."),
  para("There are two groups below. The first is data we can see on TikTok Shop but that isn't in Euka yet, and we'd love it in the dashboard and in the API. The second is data you already give us, but we need it in a different form, or the numbers don't match TikTok Shop and need fixing."),
  para("We've attached screenshots for most of the points so you can see exactly what we mean."),
  rule(),

  h2("Part 1: Stats that aren't in Euka yet"),
  para("For everything in this section, we'd like it added to the dashboard and exposed as an API endpoint the same way you do with the open API."),

  h3('1. GMV Max Ads, overview stats'),
  para("On TikTok Shop the GMV Max Ads section shows us stats at two levels: an overview across the whole section, and then a breakdown per campaign. Neither is in Euka right now."),
  para('For the overview level, the stats we need are:'),
  bullet('Cost'),
  bullet('SKU Orders'),
  bullet('Cost per Order'),
  bullet('Gross Revenue (the GMV generated)'),
  bullet('ROI'),
  ss('[Screenshot 1: GMV Max overview stats on TikTok Shop]'),

  h3('2. Product GMV Max, per campaign'),
  para("Product GMV Max gives us a set of stats for each campaign. These are slightly different for our US brands and our UK brands, mainly the currency. Cutler Nutrition and Inno Supps are US brands and report in USD. Longevity is a UK brand and reports in GBP."),
  para("Here are the columns we'd like an endpoint for:"),
  gmvTable(),
  para([run('Currency note: US brands in USD, UK brand (Longevity) in GBP.', { italics: true })], { before: 120 }),
  ss('[Screenshot 2: Product GMV Max per campaign, US brand]'),
  ss('[Screenshot 3: Product GMV Max per campaign, UK brand]'),

  h3('3. Offsite Performance'),
  para("We'd like all of the metric data under Offsite Performance. Whatever TikTok Shop shows there, we want the full set."),
  ss('[Screenshot 4: Offsite Performance]'),

  h3('4. Campaigns and Promotions'),
  para("We'd like all the metrics TikTok Shop has for campaigns, both the ones that are running and any that are upcoming. Same for promotions, whether they are ongoing, upcoming, or already ended."),
  ss('[Screenshot 5: Campaigns]'),
  ss('[Screenshot 6: Promotions]'),

  h3('5. Shop Performance Score'),
  para("If you can add it, we'd love the shop performance score in Euka too. No screenshot for this one."),
  rule(),

  h2('Part 2: Data you already give us, but that we need differently or fixed'),

  h3('Top Videos'),
  para("Right now you're giving us video reviews data, but the version we usually work from is the one in the Affiliate Center. We've attached an example with Cutler Nutrition so you can see the data we mean."),
  para("Could you test this with Cutler first and check that the numbers line up? You do give us top videos, but we think they're coming from the Seller Center or being sorted by post date. What we need is the top videos by performance, not by the date they were posted."),
  ss('[Screenshot 7: Top Videos from Affiliate Center, Cutler Nutrition example]'),

  h3('Numbers that are a bit off'),
  para("The data we want is there, but some of the counts don't match what we see on TikTok Shop."),
  para([run('1. Number of Samples Approved', { bold: true })], { after: 80 }),
  para('Once a sample moves into "ready to ship," it should be counted as approved. The count in Euka is coming in lower than TikTok Shop. A couple of examples to help pin it down:'),
  bullet('Cutler Nutrition, 1 to 14 July: TikTok Shop shows 170 samples approved, Euka shows 153.'),
  bullet('Inno Supps, 1 to 14 July: TikTok Shop shows 358 samples approved, Euka shows 326.'),
  para("On top of that, the number of videos posted for a specific product, and the samples approved for a specific product inside a date range, both come out different from TikTok Shop. We'd like those fixed too."),
  rule(),

  h2("What we're asking for"),
  para("In short, we'd love it if you could fix the metrics above in the dashboard and expose API endpoints for all of them, the same way you already do with the open API. Happy to walk through any of these live in the meeting and share more examples if that helps."),
];

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 22 } } } },
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
    children: body,
  }],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(OUT, buf);
console.log('Wrote', OUT, `(${buf.length} bytes)`);
