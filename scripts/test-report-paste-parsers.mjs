// Run: node scripts/test-report-paste-parsers.mjs   (plain node, no network)
// Guards the Paste & Parse parsers used by the weekly, bi-weekly and monthly report
// forms. The GMV Max parser hangs on ONE line per campaign (its start time); these
// tests pin that it survives the other shapes TikTok could show it in.
import assert from 'node:assert/strict';

const P = await import(new URL('../src/utils/reportPasteParsers.js', import.meta.url).href);
const L = await import(new URL('../src/lib/gmvMaxLayout.js', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};

// One value per line, 2026 column order (the On/Off toggle emits no line).
const camp = (o) => [
  o.name, 'Analytics', 'Edit', 'Active', '100.00 USD', '1 recommendation', '-',
  o.cost, 'ROI protection eligible', '-', o.start, 'Continuously', '-', '3', '140.00 USD',
  o.orders, o.cpo, o.gmv, o.roi, '12.00 USD',
].join('\n');
const CAMPS = [
  { name: 'GMV Max_Alpha', cost: '160.00 USD', start: '2026-02-13 06:58:53', orders: '12', cpo: '13.33 USD', gmv: '600.00 USD', roi: '3.75' },
  { name: 'GMV Max_Beta LIVE', cost: '3,197.20 USD', start: '2026-03-01 10:00:00', orders: '1,204', cpo: '2.66 USD', gmv: '9,800.50 USD', roi: '3.07' },
];
const paste = (fmt = (s) => s) => CAMPS.map((c) => camp({ ...c, start: fmt(c.start) })).join('\n');
const WANT = [['GMV Max_Alpha', '160.00', '12', '13.33', '600.00', '3.75'], ['GMV Max_Beta LIVE', '3197.20', '1204', '2.66', '9800.50', '3.07']];
const flat = (rows) => rows.map((r) => [r.campaign, r.spend, r.orders, r.cpo, r.gmv, r.roi]);

const usParts = (s) => { const [d, tm] = s.split(' '); const [y, m, dd] = d.split('-'); return [y, m, dd, tm]; };
const FORMATS = {
  'documented YYYY-MM-DD HH:MM:SS': (s) => s,
  'ISO T separator': (s) => s.replace(' ', 'T'),
  'no seconds': (s) => s.slice(0, 16),
  'slashes': (s) => s.replace(/-/g, '/'),
  'US order MM/DD/YYYY': (s) => { const [y, m, d, tm] = usParts(s); return `${m}/${d}/${y} ${tm}`; },
  '12-hour clock with PM': (s) => { const [y, m, d] = usParts(s); return `${m}/${d}/${y} 6:58:53 PM`; },
  'month name': (s) => { const [y, , d] = usParts(s); return `Feb ${Number(d)}, ${y}, 6:58 AM`; },
  'day month year': (s) => { const [y, , d] = usParts(s); return `${Number(d)} Feb ${y} 06:58`; },
  'UTC suffix': (s) => `${s} (UTC-7)`,
};

for (const [label, fmt] of Object.entries(FORMATS)) {
  t(`GMV Max: start time as "${label}" still finds both campaigns (default layout)`, () => {
    assert.deepEqual(flat(P.parseGmvMaxText(paste(fmt), { columns: L.DEFAULT_COLUMNS })), WANT);
  });
}
t('GMV Max: heuristic path (no layout) gives the same rows', () => {
  assert.deepEqual(flat(P.parseGmvMaxText(paste())), WANT);
});
t('GMV Max: an APC re-taught layout (tab header + stray "Action" column) still maps', () => {
  const cols = L.parseColumnList(L.DEFAULT_COLUMNS.join('\t') + '\tAction');
  assert.deepEqual(flat(P.parseGmvMaxText(paste(), { columns: cols })), WANT);
});
t('GMV Max: an APC re-taught short layout with "(USD)" names still maps', () => {
  const cols = ['Campaign name', 'Status', 'Budget', 'Cost (USD)', 'Schedule', 'SKU orders', 'Cost per order (USD)', 'Gross revenue (USD)', 'ROI'];
  assert.deepEqual(flat(P.parseGmvMaxText(paste(), { columns: cols })), WANT);
});
t('GMV Max: money written with the currency code first ("USD 160.00") is read', () => {
  const rows = P.parseGmvMaxText(paste().replace(/(\d[\d,.]*) USD/g, 'USD $1'));
  assert.deepEqual(flat(rows), WANT);
});

// ── the explanation shown when nothing parses ──────────────────────
t('explain: no start-time line names the problem and quotes the nearest date-like lines', () => {
  const text = paste().replace(/2026-0\d-\d\d \d\d:\d\d:\d\d/g, 'Started: 13th of February');
  assert.equal(P.parseGmvMaxText(text).length, 0);
  assert.match(P.explainGmvMaxPaste(text), /no campaign start-time line/i);
});
t('explain: lists date-like lines it saw when the format is unrecognised', () => {
  const text = paste().replace(/2026-0\d-\d\d \d\d:\d\d:\d\d/g, '13-02-26 6.58pm');
  assert.equal(P.parseGmvMaxText(text).length, 0);
  assert.match(P.explainGmvMaxPaste(text), /13-02-26 6\.58pm/);
});
t('explain: empty paste explains nothing (the panel keeps its own message)', () => {
  assert.equal(P.explainGmvMaxPaste('   '), '');
});

// ── regressions on the documented formats of the other two parsers ──
t('Top Creators: documented layout still parses', () => {
  const text = ['@alpha', 'Followers', '12.4K', '$608.12', '43.08% of total GMV', '$60.81', '9', '8', '1.2', '2.38%', '33.07K', '0', '4']
    .join('\n');
  const rows = P.parseTopCreatorsText(text);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].gmv, rows[0].itemsSold, rows[0].videosPosted], ['alpha', '608.12', '9', '4']);
});
t('Top Videos: documented layout still parses', () => {
  const text = ['A caption', 'ID:', '7562729000000000001', '10/18/2025 16:53', '@creator1', 'Creator One', '120 Followers',
    'Some product', 'ID:', '1729999999999999999', 'Beauty', '$223.9', '6', '$0', '0', '6'].join('\n');
  const rows = P.parseTopVideosText(text);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].creatorName, rows[0].gmv, rows[0].itemsSold], ['creator1', '223.9', '6']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
