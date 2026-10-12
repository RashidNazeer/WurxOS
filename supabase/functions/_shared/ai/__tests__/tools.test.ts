import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtMoney, normTier, parseMetric, reportCurrency } from '../tools/metrics.ts';
import { inPeriod, pktToday, resolvePeriod } from '../tools/period.ts';
import {
  findPreviousByPeriod, gmvMaxTotals, metricsLineCur, metricValue, monthCreatorView, NO_ITEMS_NOTE, normHandle, rankCore,
  rankCreators, selectPending, splitWeeks,
} from '../tools/reports.ts';
import { bound, NOT_YOURS, ROLE_ANGLES, runDataTool, STAFF_ROLES, TOOL_DEFS, TOOL_NAMES, TOOL_RESULT_CHAR_CAP } from '../tools/index.ts';
import { _resetAclProbe } from '../tools/acl.ts';
import { assignmentText, loadAssignments } from '../tools/assignments.ts';
import { fakeDb } from './fixtures/fakeDb.ts';

// ------------------------------------------------------------------ parseMetric
test('parseMetric: every value shape seen on dev (inventory §2 + probe)', () => {
  const v = (s: unknown) => parseMetric(s).value;
  // plain, as stored
  assert.equal(v('12345.67'), 12345.67);
  assert.equal(v('580'), 580);
  assert.equal(v(357869.19), 357869.19);
  assert.equal(v(0), 0);
  assert.equal(v('-9'), -9);                      // itemsSold "-9" exists; parsed, not judged
  // currency: symbols and codes (GMV Max cells carry "USD")
  assert.deepEqual(parseMetric('22544.45USD'), { value: 22544.45, unit: 'currency', currency: 'USD', raw: '22544.45USD' });
  assert.deepEqual(parseMetric('$1,234.50'), { value: 1234.5, unit: 'currency', currency: 'USD', raw: '$1,234.50' });
  assert.equal(parseMetric('£5,655.36').currency, 'GBP');
  assert.equal(parseMetric('£5,655.36').value, 5655.36);
  assert.equal(parseMetric('GBP 100').currency, 'GBP');
  assert.equal(parseMetric('100 usd').currency, 'USD');
  assert.equal(v('-$12.50'), -12.5);
  // magnitude
  assert.equal(v('23.84k'), 23840);
  assert.equal(v('3.20K'), 3200);
  assert.equal(v('4.33M'), 4330000);
  assert.equal(v('249.71K'), 249710);
  assert.equal(v('1.1k'), 1100);                  // no float noise
  // percent / multiplier
  assert.deepEqual(parseMetric('5.1%'), { value: 5.1, unit: 'percent', raw: '5.1%' });
  assert.equal(parseMetric('2.3×').unit, 'multiplier');
  assert.equal(v('2.3×'), 2.3);
  assert.equal(v('4.2x'), 4.2);
  assert.equal(v('4.2X'), 4.2);
  // placeholders → null, reason placeholder
  for (const p of ['N/A', 'Null', 'Not_Available_yet', 'Not_available', 'Not_Available', 'Notavailableyet', 'None', 'Not_Rated', '--', '-', 'n/a', ' NA ']) {
    assert.deepEqual([p, parseMetric(p).value, parseMetric(p).reason], [p, null, 'placeholder']);
  }
  assert.equal(parseMetric('').reason, 'empty');
  assert.equal(parseMetric(null).reason, 'empty');
  // never guessed
  for (const bad of ['9.9v', '1.2.3', '4.5-4.8', '1,2', '12,34.5', '$5%', 'USD$5', 'abc', '5 apples', 'M', '--5', '1e5']) {
    assert.deepEqual([bad, parseMetric(bad).value, parseMetric(bad).reason], [bad, null, 'unparseable']);
  }
  assert.equal(parseMetric({}).reason, 'unparseable');
  assert.equal(parseMetric('9.9v').raw, '9.9v');
});

test('currency per report: brand → report snapshot → USD (the extractor\'s rule)', () => {
  assert.equal(reportCurrency({ data: { currency: 'USD' }, brand: { currency: 'gbp' } }), 'GBP');
  assert.equal(reportCurrency({ data: { currency: 'gbp' }, brand: { currency: null } }), 'GBP');
  assert.equal(reportCurrency({ data: { currency: 'GBP' }, brand: null }), 'GBP');
  assert.equal(reportCurrency({ data: {}, brand: { currency: '' } }), 'USD');
  assert.equal(reportCurrency({ data: null }), 'USD');
  assert.equal(fmtMoney(859.95, 'USD'), '$859.95');
  assert.equal(fmtMoney(5655.36, 'GBP'), '£5,655.36');
  assert.equal(fmtMoney(-1200, 'PKR'), '-PKR 1,200.00');
});

test('normTier: dev spellings', () => {
  assert.equal(normTier('2000'), '2K');
  assert.equal(normTier('2K'), '2K');
  assert.equal(normTier('7k'), '7K');
  assert.equal(normTier('7,000'), '7K');
  assert.equal(normTier('unlimited'), 'Unlimited');
  assert.equal(normTier('Unlimited'), 'Unlimited');
  assert.equal(normTier('starter  pack'), 'Starter pack');
  assert.equal(normTier(''), null);
  assert.equal(normTier(null), null);
  assert.equal(normTier('1500'), '1500');
});

// ------------------------------------------------------------------ periods (PKT)
test('PKT edges: UTC evening is already tomorrow in Karachi', () => {
  // 2026-09-30 19:30 UTC = 2026-10-01 00:30 PKT
  const now = new Date('2026-09-30T19:30:00Z');
  assert.equal(pktToday(now), '2026-10-01');
  assert.equal(resolvePeriod('this month', now)!.label, 'October 2026');
  assert.equal(resolvePeriod('last month', now)!.label, 'September 2026');
  assert.equal(pktToday(new Date('2026-09-30T18:59:00Z')), '2026-09-30');
});

test('weeks run Sunday to Saturday, in PKT', () => {
  const tue = new Date('2026-09-29T06:00:00Z');   // Tue Sep 29
  assert.deepEqual(resolvePeriod('last week', tue), { kind: 'week', label: 'Sep 20 – 26, 2026', from: '2026-09-20', to: '2026-09-26', type: 'weekly' });
  assert.equal(resolvePeriod('this week', tue)!.label, 'Sep 27 – Oct 3, 2026');
  assert.equal(resolvePeriod('week before last', tue)!.from, '2026-09-13');
  // Saturday 23:30 PKT is still that week; Sunday 00:00 PKT starts the next.
  const satNight = new Date('2026-09-26T18:30:00Z');
  const sunStart = new Date('2026-09-26T19:00:00Z');
  assert.equal(resolvePeriod('this week', satNight)!.from, '2026-09-20');
  assert.equal(resolvePeriod('this week', sunStart)!.from, '2026-09-27');
  assert.equal(resolvePeriod('last week', sunStart)!.from, '2026-09-20');
});

test('months, quarters and year boundaries', () => {
  const jan = new Date('2026-01-05T06:00:00Z');
  assert.equal(resolvePeriod('last month', jan)!.label, 'December 2025');
  assert.deepEqual(resolvePeriod('December', jan), { kind: 'month', label: 'December 2025', from: '2025-12-01', to: '2025-12-31', type: 'monthly' });
  assert.equal(resolvePeriod('January', jan)!.label, 'January 2026');   // current month counts
  assert.equal(resolvePeriod('Q4', jan)!.label, 'Q4 2025');
  assert.equal(resolvePeriod('2026 Q1', jan)!.to, '2026-03-31');
  assert.equal(resolvePeriod('feb 2024', jan)!.to, '2024-02-29');          // leap year
  assert.equal(resolvePeriod('2026-02', jan)!.to, '2026-02-28');
  assert.equal(resolvePeriod('2026 june', jan)!.label, 'June 2026');
  assert.equal(resolvePeriod('Sept', new Date('2026-09-29T06:00:00Z'))!.label, 'September 2026');
  assert.deepEqual(resolvePeriod('Week 24'), { kind: 'label', label: 'Week 24', pattern: 'Week 24 (', type: 'weekly' });
  assert.equal(resolvePeriod('2026-09-14')!.kind, 'day');
  assert.equal(resolvePeriod('2026-09-01..2026-09-30')!.kind, 'range');
  assert.deepEqual(resolvePeriod('Holiday special'), { kind: 'label', label: 'Holiday special', pattern: 'Holiday special' });
  assert.equal(resolvePeriod('  '), null);
  // label matching never confuses Week 2 with Week 24
  const w24 = { period_label: 'Week 24 (Sep 13 - 19)', period_start: '2026-09-13', period_end: '2026-09-19' };
  assert.ok(!inPeriod(w24, resolvePeriod('Week 2')));
  assert.ok(inPeriod(w24, resolvePeriod('Week 24')));
  assert.ok(inPeriod(w24, resolvePeriod('2026-09-15')));
  assert.ok(!inPeriod(w24, resolvePeriod('last week', new Date('2026-09-29T06:00:00Z'))));
});

// ------------------------------------------------------------------ report fixtures
const BRANDS = [
  { id: 'b1', brand_name: 'Cutler Nutritions', status: 'active', currency: 'USD', owner_id: 'o1', tier: '7000' },
  { id: 'b2', brand_name: 'Aqua Sonic', status: 'active', currency: null, owner_id: 'o1', tier: 'unlimited' },
  { id: 'b3', brand_name: 'Longevity Box', status: 'active', currency: 'GBP', owner_id: 'o2', tier: '' },
  { id: 'b4', brand_name: 'Old Brand', status: 'inactive', currency: 'USD', owner_id: 'o2', tier: '2K' },
];
let seq = 0;
const weekly = (brand: string, n: number, start: string, status: string, perf: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const end = new Date(`${start}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
  const e = end.toISOString().slice(0, 10);
  const mon = (d: string) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1];
  const lbl = `Week ${n} (${mon(start)} ${Number(start.slice(8))} - ${mon(e) === mon(start) ? '' : `${mon(e)} `}${Number(e.slice(8))})`;
  return { id: `r${++seq}`, brand_id: brand, type: 'weekly', status, period_label: lbl, period_start: start, period_end: e,
    period_year: 2026, period_month: Number(start.slice(5, 7)) - 1, created_at: '2026-01-01', data: { overallPerformance: perf, ...extra }, sections_enabled: null };
};
const monthly = (brand: string, m: number, status: string, data: Record<string, unknown>, created = '2026-01-01') => {
  const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return { id: `r${++seq}`, brand_id: brand, type: 'monthly', status, period_label: `${names[m - 1]} 2026`, period_start: `2026-${String(m).padStart(2, '0')}-01`,
    period_end: `2026-${String(m).padStart(2, '0')}-${last}`, period_year: 2026, period_month: m - 1, created_at: created, data, sections_enabled: null };
};
const BOSS = { userId: 'boss-1', role: 'boss' };

test('findPreviousByPeriod: picks by period, never by created_at (OL backfills)', () => {
  const w23 = { ...weekly('b1', 23, '2026-09-06', 'approved', { gmv: '100' }), created_at: '2026-09-28' };   // backfilled last
  const w24 = { ...weekly('b1', 24, '2026-09-13', 'approved', { gmv: '120' }), created_at: '2026-09-20' };
  const w21 = { ...weekly('b1', 21, '2026-08-23', 'approved', { gmv: '90' }), created_at: '2026-09-29' };
  const other = { ...weekly('b2', 23, '2026-09-06', 'approved', { gmv: '1' }) };
  assert.equal(findPreviousByPeriod([w21, w23, w24, other], w24)!.id, w23.id);
  assert.equal(findPreviousByPeriod([w21, w23, w24], w23)!.id, w21.id);
  assert.equal(findPreviousByPeriod([w21, w23, w24], w21), null);
  // monthly compares the month key (period_year + 0-based period_month)
  const jul = monthly('b1', 7, 'approved', {}, '2026-09-10'), jun = monthly('b1', 6, 'approved', {}, '2026-09-11'), may = monthly('b1', 5, 'approved', {}, '2026-09-12');
  assert.equal(findPreviousByPeriod([may, jul, jun], jul)!.id, jun.id);
});

test('compare_periods: baseline by period with out-of-order creation; cross-currency refused', async () => {
  const w22 = { ...weekly('b1', 22, '2026-08-30', 'approved', { gmv: '1,000.00' }), created_at: '2026-09-29' };
  const w23 = { ...weekly('b1', 23, '2026-09-06', 'approved', { gmv: '$1,100.00' }), created_at: '2026-09-07' };
  const w24 = { ...weekly('b1', 24, '2026-09-13', 'approved', { gmv: '1320' }), created_at: '2026-09-01' };
  const db = fakeDb({ brands: BRANDS, reports: [w22, w24, w23] });
  const r = await runDataTool(db, BOSS, 'compare_periods', { brand: 'Cutler Nutrition', metric: 'gmv', period_a: 'Week 24' });
  assert.match(r.text, /- Week 24 \(Sep 13 - 19\): \$1,320\.00/);
  assert.match(r.text, /- Week 23 \(Sep 6 - 12\) \(baseline\): \$1,100\.00/);
  assert.match(r.text, /Change: \+\$220\.00 \(\+20\.00%\)\./);
  assert.deepEqual(r.source.ids, [w24.id, w23.id]);
  assert.equal(r.source.currency, 'USD');
  // explicit baseline
  const r2 = await runDataTool(db, BOSS, 'compare_periods', { brand: 'Cutler', metric: 'gmv', period_a: 'Week 24', period_b: 'Week 22' });
  assert.match(r2.text, /Change: \+\$320\.00 \(\+32\.00%\)/);
  // a cell in another currency than the report → not compared
  const odd = { ...weekly('b1', 25, '2026-09-20', 'approved', { gmv: '£900' }) };
  const r3 = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24, odd] }), BOSS, 'compare_periods', { brand: 'Cutler', metric: 'gmv', period_a: 'Week 25' });
  assert.match(r3.text, /not available \(written in GBP, report currency is USD\)/);
  assert.match(r3.text, /No change computed/);
  // different report currencies (brand currency changed between reports is impossible
  // by the brand-first rule, so exercise the guard through the pure path)
  const a = metricValue({ ...w24, brand: { currency: 'USD' } }, 'gmv'), b = metricValue({ ...w23, brand: { currency: 'GBP' } }, 'gmv');
  assert.notEqual(a.currency, b.currency);
});

test('compare_periods: a period with no approved report is not substituted', async () => {
  const w24 = weekly('b1', 24, '2026-09-13', 'approved', { gmv: '1320' });
  const w25 = weekly('b1', 25, '2026-09-20', 'submitted', { gmv: '99999' });
  const db = fakeDb({ brands: BRANDS, reports: [w24, w25] });
  const r = await runDataTool(db, BOSS, 'compare_periods', { brand: 'Cutler', metric: 'gmv', period_a: '2026-09-20..2026-09-26' });
  // A date range implies no report type.
  assert.match(r.text, /The report for 2026-09-20 – 2026-09-26 \(PKT\) \(Week 25 \(Sep 20 - 26\)\) exists but is submitted, awaiting approval \(figures withheld\)\. Latest approved report instead: Week 24/);
  assert.equal((r.data as any).period_status, 'pending');
  assert.match(r.text, /Nothing compared/);
  assert.match(r.text, /Week 25 \(Sep 20 - 26\) \(weekly\): submitted/);
  assert.ok(!r.text.includes('99999') && !r.text.includes('99,999'));
});

// ------------------------------------------------------------------ pending note
test('get_reports: approved only; a newer unapproved report is a pending note, never figures', async () => {
  const w23 = weekly('b1', 23, '2026-09-06', 'approved', { gmv: '52273.47', orders: '900' });
  const w24 = weekly('b1', 24, '2026-09-13', 'verified', { gmv: '77777.77', orders: '1234' });
  const old = weekly('b1', 12, '2026-06-21', 'draft', { gmv: '5' });
  const db = fakeDb({ brands: BRANDS, reports: [w23, w24, old] });
  const r = await runDataTool(db, BOSS, 'get_reports', { brand_name: 'Cutler' });
  assert.match(r.text, /^Reports \(1 matched\):\n- Cutler Nutritions · Week 23 \(Sep 6 - 12\) \(weekly, approved\): GMV 52273\.47, orders 900/);
  assert.match(r.text, /Not yet approved \(figures withheld; never quote them\):\n- Cutler Nutritions · Week 24 \(Sep 13 - 19\) \(weekly\): verified by the TL, awaiting approval$/);
  assert.ok(!r.text.includes('77777') && !r.text.includes('1234'));
  assert.ok(!r.text.includes('Week 12'), 'an old draft is not news');
  assert.deepEqual(r.source.ids, [w23.id]);
  assert.deepEqual(r.source.pending, [{ id: w24.id, period: 'Week 24 (Sep 13 - 19)', status: 'verified', brand: 'Cutler Nutritions' }]);
  assert.equal(r.source.status, 'approved');
});

test('selectPending: newer ones, and non-drafts up to 4 weeks behind the latest approved', () => {
  const a24 = weekly('b1', 24, '2026-09-13', 'approved', {});
  const p22 = weekly('b1', 22, '2026-08-30', 'verified', {});
  const p25 = weekly('b1', 25, '2026-09-20', 'draft', {});
  const d23 = weekly('b1', 23, '2026-09-06', 'draft', {});
  const p10 = weekly('b1', 10, '2026-06-07', 'submitted', {});
  const other = weekly('b2', 24, '2026-09-13', 'submitted', {});
  assert.deepEqual(selectPending([a24], [p25, d23, p22, p10, other]).map((p) => p.id), [p25.id, p22.id]);
  assert.deepEqual(selectPending([a24], [other], true).map((p) => p.id), [other.id]);
  assert.deepEqual(selectPending([], [p22]).map((p) => p.id), [p22.id]);
});

test('get_reports: "last week" with no report → dates, then the latest approved week, plus pending (Owner test 1)', async () => {
  const reps = [
    weekly('b1', 21, '2026-08-23', 'approved', { gmv: '1' }),
    weekly('b1', 22, '2026-08-30', 'verified', { gmv: '2' }),
    weekly('b1', 23, '2026-09-06', 'approved', { gmv: '3' }),
    weekly('b1', 24, '2026-09-13', 'approved', { gmv: '4' }, { topCreators: [{ name: 'b', gmv: '10', itemsSold: '5' }, { name: 'a', gmv: '30', itemsSold: '9' }] }),
  ];
  const db = fakeDb({ brands: BRANDS, reports: reps });
  const now = new Date();
  const lastWeek = resolvePeriod('last week', now)!;
  // Only meaningful when "last week" is after Week 24 (true from 2026-09-27 on).
  if (lastWeek.from! <= '2026-09-19') return;
  const r = await runDataTool(db, BOSS, 'get_top_creators', { brand: 'Cutler Nutrition', period: 'last week' });
  assert.ok(r.text.includes(`No weekly report has been submitted for ${lastWeek.label} (PKT) yet (not in yet).`), r.text);
  assert.equal((r.data as any).period_status, 'missing');
  assert.match(r.text, /Latest approved weekly report instead: Week 24 \(Sep 13 - 19\)\./);
  assert.match(r.text, /1\. a — GMV \$30\.00, items sold 9/);
  assert.match(r.text, /2\. b — GMV \$10\.00, items sold 5/);
  assert.match(r.text, /Report's own order: b, a\./);
  assert.match(r.text, /Week 22 \(Aug 30 - Sep 5\) \(weekly\): verified/);
});

// ------------------------------------------------------------------ creators, month path (Owner rule 6a)
const cr = (name: string, gmv: string, items?: string) => (items === undefined ? { username: name, gmv } : { name, gmv, itemsSold: items, videosPosted: '1', notes: '' });

test('normHandle: monthly @username and weekly name are the same creator', () => {
  assert.equal(normHandle('@tavo2real'), 'tavo2real');
  assert.equal(normHandle(' Tavo2Real '), 'tavo2real');
  assert.equal(normHandle('https://www.tiktok.com/@tavo2real?lang=en'), 'tavo2real');
  assert.equal(normHandle('tiktok.com/@tavo2real/'), 'tavo2real');
  assert.equal(normHandle('@@x'), 'x');
});

// Mirrors Cutler June on dev: monthly top @tavo2real $9,302.45; approved
// Weeks 10-12 lie inside June, Weeks 9 and 13 straddle it.
const juneWeeks = () => [
  weekly('b1', 9, '2026-05-31', 'approved', {}, { topCreators: [cr('tavo2real', '1000', '40')] }),
  weekly('b1', 10, '2026-06-07', 'approved', {}, { topCreators: [cr('tavo2real', '2500.00', '60'), cr('other', '100', '3')] }),
  weekly('b1', 11, '2026-06-14', 'approved', {}, { topCreators: [cr('Tavo2real', '2481.42', '50')] }),
  weekly('b1', 12, '2026-06-21', 'approved', {}, { topCreators: [cr('tavo2real', '2000', '45'), cr('other', '50', '2')] }),
  weekly('b1', 13, '2026-06-28', 'approved', {}, { topCreators: [cr('tavo2real', '999', '99')] }),
];

test('month path: approved monthly ranks by its GMV; items derived from weeklies fully inside', () => {
  const june = monthly('b1', 6, 'approved', { topCreators: [cr('@tavo2real', '9302.45'), cr('@other', '500'), cr('@nobody', '10')] });
  const v = monthCreatorView(june, juneWeeks(), '2026-06-01', '2026-06-30');
  assert.equal(v.derived_from, 'weekly');
  assert.equal(v.note, NO_ITEMS_NOTE);
  assert.equal(v.note, 'monthly reports do not record items sold per creator');
  assert.equal(v.partial_per_creator, true);
  assert.deepEqual(v.weeks_used, ['Week 10 (Jun 7 - 13)', 'Week 11 (Jun 14 - 20)', 'Week 12 (Jun 21 - 27)']);
  assert.deepEqual(v.weeks_excluded, [
    { period: 'Week 9 (May 31 - Jun 6)', reason: 'straddles the month' },
    { period: 'Week 13 (Jun 28 - Jul 4)', reason: 'straddles the month' },
  ]);
  assert.deepEqual(v.creators[0], { rank: 1, name: '@tavo2real', handle: 'tavo2real', gmv: 9302.45, gmv_source: 'monthly', items_sold: 155, items_source: 'weekly', weeks_listed: 3, report_order: 1 });
  assert.equal(v.creators[1].items_sold, 5);
  assert.equal(v.creators[2].items_sold, null);          // in no weekly list: unknown, not 0
  assert.equal(v.creators[2].weeks_listed, 0);
  // everything derived when there is no approved monthly: $6,981.42 over 3 weeks
  const w = monthCreatorView(null, juneWeeks(), '2026-06-01', '2026-06-30');
  assert.equal(w.monthly_report, null);
  assert.deepEqual(w.creators[0], { rank: 1, name: 'tavo2real', handle: 'tavo2real', gmv: 6981.42, gmv_source: 'weekly', items_sold: 155, items_source: 'weekly', weeks_listed: 3, report_order: null });
});

test('month path via the tool: monthly not approved → derived from weeklies + monthly pending note (Owner test 2)', async () => {
  const aug = monthly('b1', 8, 'verified', { topCreators: [cr('@secret', '99999')] });
  const weeks = [
    weekly('b1', 17, '2026-07-26', 'approved', {}, { topCreators: [cr('x', '1', '1')] }),
    weekly('b1', 18, '2026-08-02', 'approved', {}, { topCreators: [cr('builtformore17', '1000', '40'), cr('y', '900', '50')] }),
    weekly('b1', 19, '2026-08-09', 'approved', {}, { topCreators: [cr('builtformore17', '1500', '60')] }),
    weekly('b1', 20, '2026-08-16', 'submitted', {}, { topCreators: [cr('builtformore17', '5000', '500')] }),
    weekly('b1', 21, '2026-08-23', 'approved', {}, { topCreators: [cr('@BuiltForMore17', '475.40', '8')] }),
    weekly('b1', 22, '2026-08-30', 'verified', {}, { topCreators: [cr('z', '1', '1')] }),
  ];
  const db = fakeDb({ brands: BRANDS, reports: [aug, ...weeks] });
  const r = await runDataTool(db, BOSS, 'get_top_creators', { brand: 'cutler nutrition', period: 'August 2026' });
  const d = r.data as any;
  assert.equal(d.monthly_report, null);
  assert.equal(d.derived_from, 'weekly');
  assert.deepEqual(d.weeks_used.map((x: string) => x.split(' (')[0]), ['Week 18', 'Week 19', 'Week 21']);
  assert.deepEqual(d.weeks_excluded.map((x: any) => [x.period.split(' (')[0], x.reason]), [
    ['Week 17', 'straddles the month'], ['Week 20', 'not approved (submitted)'], ['Week 22', 'straddles the month; not approved (verified)'],
  ]);
  assert.deepEqual([d.creators[0].name, d.creators[0].gmv, d.creators[0].items_sold, d.creators[0].weeks_listed], ['builtformore17', 2975.4, 108, 3]);
  assert.match(r.text, /the August 2026 monthly report exists but is verified, awaiting approval \(figures withheld\), so this is DERIVED/);
  assert.equal(d.period_status, 'pending');
  assert.match(r.text, /August 2026 \(monthly\): verified by the TL, awaiting approval/);
  assert.ok(!r.text.includes('99999') && !r.text.includes('secret') && !r.text.includes('5,000') && !r.text.includes('500'));
  assert.deepEqual(r.source.pending!.map((p) => p.status), ['verified']);
});

test('rankCreators: weekly order kept, monthly rows have no items column', () => {
  const w = weekly('b1', 1, '2026-04-05', 'approved', {}, { topCreators: [cr('b', '10', '5'), cr('a', '$30.00', '9'), cr('c', 'N/A', '1')] });
  const { rows, tracksItems } = rankCreators(w);
  assert.equal(tracksItems, true);
  assert.deepEqual(rows.map((c) => [c.name, c.order, c.gmv]), [['a', 2, 30], ['b', 1, 10], ['c', 3, null]]);
  assert.deepEqual(rankCreators(w, 'items_sold').rows.map((c) => c.name), ['a', 'b', 'c']);
  assert.equal(rankCreators(monthly('b1', 6, 'approved', { topCreators: [cr('@t', '1')] })).tracksItems, false);
});

test('splitWeeks: inside vs straddling', () => {
  const { inside, straddle } = splitWeeks(juneWeeks(), '2026-06-01', '2026-06-30');
  assert.deepEqual(inside.map((r) => r.period_label.split(' (')[0]), ['Week 10', 'Week 11', 'Week 12']);
  assert.deepEqual(straddle.map((r) => r.period_label.split(' (')[0]), ['Week 9', 'Week 13']);
});

// ------------------------------------------------------------------ GMV Max + rank_brands
test('gmvMaxTotals: Overall row wins; else sums; ROI = ΣGMV/Σspend, not a mean of ROIs', () => {
  const withOverall = { data: { gmvMax: [
    { campaign: 'A', spend: '100', gmv: '300', roi: '3' },
    { campaign: 'Overall', spend: '147373.65', gmv: '388389.06', roi: '2.64' },
  ] } };
  const t = gmvMaxTotals(withOverall);
  assert.deepEqual([t.spend, t.gmv, t.summaryRow, t.used], [147373.65, 388389.06, true, 1]);
  assert.ok(Math.abs(t.roi! - 388389.06 / 147373.65) < 1e-12);
  const rows = { data: { gmvMax: [
    { campaign: 'A', spend: '100USD', gmv: '1000USD', roi: '10' },
    { campaign: 'B', spend: '900', gmv: '900', roi: '1' },
    { campaign: 'C', spend: 'N/A', gmv: 'N/A' },
    { campaign: 'D', spend: '9.9.9', gmv: '5' },
  ] } };
  const s = gmvMaxTotals(rows);
  assert.deepEqual([s.spend, s.gmv, s.used, s.rows], [1000, 1900, 2, 4]);
  assert.equal(s.roi, 1.9);                    // not (10 + 1) / 2 = 5.5
  assert.match(s.note!, /1 of 4 campaign rows had unreadable figures/);
  // a GBP report's "USD" cell is left out, not converted
  const g = gmvMaxTotals({ brand: { currency: 'GBP' }, data: { gmvMax: [{ campaign: 'A', spend: '10USD', gmv: '20USD' }, { campaign: 'B', spend: '10', gmv: '40' }] } });
  assert.deepEqual([g.spend, g.gmv], [10, 40]);
  // float noise from sums is dropped
  const f = gmvMaxTotals({ data: { gmvMax: [{ campaign: 'A', spend: '140000.1', gmv: '1' }, { campaign: 'B', spend: '492.73', gmv: '1' }] } });
  assert.equal(f.spend, 140492.83);
});

test('metricValue: layouts, disabled sections, unreadable values', () => {
  const w = weekly('b1', 1, '2026-04-05', 'approved', { gmv: '1,234.5', roi: '2.5x', orders: 'N/A', samplesApproved: '9.9v' });
  assert.deepEqual(metricValue(w, 'gmv'), { value: 1234.5, currency: 'USD', raw: '1,234.5' });
  assert.equal(metricValue(w, 'roi').value, 2.5);
  assert.equal(metricValue(w, 'orders').note, 'not filled');
  assert.match(metricValue(w, 'samples').note!, /unreadable value "9\.9v"/);
  const m = monthly('b1', 7, 'approved', { keyMetrics: { gmv: '' }, totalSales: { monthGmv: '5000' }, kpis: { freeSamplesApproved: '12' } });
  assert.equal(metricValue(m, 'gmv').value, 5000);          // keyMetrics empty → totalSales
  assert.equal(metricValue(m, 'samples').value, 12);
  assert.match(metricValue(m, 'roi').note!, /not part of monthly reports/);
  const off = { ...w, sections_enabled: { overallPerformance: false } };
  assert.equal(metricValue(off, 'gmv').value, null);
});

test('rank_brands: coverage over active brands, currencies apart, pending named', async () => {
  const gm = (spend: string, gmv: string) => ({ gmvMax: [{ campaign: 'X', spend, gmv }] });
  const reps = [
    monthly('b1', 8, 'verified', gm('100', '1000')),              // Cutler: verified only → excluded
    monthly('b2', 8, 'approved', gm('200', '500')),               // Aqua Sonic (USD by default)
    monthly('b3', 8, 'approved', gm('50', '150')),                // Longevity Box, GBP
    monthly('b4', 8, 'approved', gm('10', '40')),                 // inactive brand
    monthly('b2', 7, 'approved', gm('1', '999')),                 // July: out of range
  ];
  const db = fakeDb({ brands: BRANDS, reports: reps });
  const r = await runDataTool(db, BOSS, 'rank_brands', { metric: 'gmv_max_spend', period: 'August 2026' });
  assert.match(r.text, /Coverage: 2 of 3 active brands have an approved monthly report for August 2026 \(\+1 inactive brand\); 3 of 4 monthly reports in the period are approved \(not yet: 1 verified\)\./);
  assert.match(r.text, /1\. Aqua Sonic — \$200\.00 \(August 2026\)\n2\. Old Brand — \$10\.00/);
  assert.match(r.text, /Not ranked \(different currency\): Longevity Box £50\.00\./);
  assert.match(r.text, /Total: \$210\.00 across 2 reports; £50\.00 across 1 report \(currencies kept separate\)\./);
  assert.match(r.text, /Cutler Nutritions · August 2026 \(monthly\): verified/);
  assert.ok(!r.text.includes('$100.00'));
  const roi = await runDataTool(db, BOSS, 'rank_brands', { metric: 'gmv_max_roi', period: 'August 2026' });
  assert.match(roi.text, /1\. Old Brand — 4\.00[\s\S]*2\. Longevity Box — 3\.00[\s\S]*3\. Aqua Sonic — 2\.50/);   // ratios rank across currencies
});

test('rankCore: most common currency ranked, ties go to USD', () => {
  const r = (b: string, cur: string, gmv: string) => ({ ...weekly(b, 1, '2026-04-05', 'approved', { gmv }), brand: { brand_name: b, currency: cur } });
  const { ranked, apart, totals } = rankCore([r('A', 'GBP', '5'), r('B', 'USD', '7'), r('C', 'USD', '3'), r('D', 'GBP', '9')], 'gmv');
  assert.deepEqual(ranked.map((x) => x.r.brand.brand_name), ['B', 'C']);
  assert.deepEqual(apart.map((x) => x.r.brand.brand_name), ['A', 'D']);
  assert.deepEqual(totals, [{ currency: 'USD', sum: 10, reports: 2 }, { currency: 'GBP', sum: 14, reports: 2 }]);
});

// ------------------------------------------------------------------ dispatcher
test('dispatcher: role gate, identity required, bounded output with a truncation note', async () => {
  const db = fakeDb({ brands: BRANDS, reports: [] });
  const apc = { userId: 'apc-1', role: 'apc' };
  // No caller JWT client → people & pay fail closed, never the service client.
  for (const t of ['find_person', 'get_employees', 'get_incentives', 'get_salary', 'get_performance', 'get_attendance', 'get_leave']) {
    assert.equal((await runDataTool(db, apc, t, {})).text, "That's not something I can show you.");
  }
  assert.match((await runDataTool(db, { userId: '', role: '' } as any, 'list_brands', {})).text, /No caller identity/);
  assert.equal((await runDataTool(db, BOSS, 'nope', {})).text, 'Unknown tool: nope');
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const b = bound(long);
  assert.ok(b.truncated && b.text.length <= TOOL_RESULT_CHAR_CAP);
  assert.match(b.text, /\(Truncated: showing \d+ of \d+ characters\. Narrow the request/);
  assert.ok(b.text.split('\n\n(Truncated')[0].split('\n').every((l) => l.startsWith('line ')), 'cut at a line boundary');
  assert.deepEqual(bound('short'), { text: 'short', truncated: false });
});

test('non-Boss: brand tools only see brands can_view_brand allows', async () => {
  const reps = [weekly('b1', 24, '2026-09-13', 'approved', { gmv: '1' }), weekly('b2', 24, '2026-09-13', 'approved', { gmv: '2' })];
  const db = fakeDb({ brands: BRANDS, reports: reps }, { can_view_brand: (a: any) => a.b_id === 'b2' && a.uid === 'apc-1' });
  const apc = { userId: 'apc-1', role: 'apc' };
  assert.match((await runDataTool(db, apc, 'list_brands', {})).text, /^Brands you can see \(1\):\n- Aqua Sonic/);
  assert.equal((await runDataTool(db, apc, 'get_top_creators', { brand: 'Cutler' })).text, 'No brand matches "Cutler".');
  const all = await runDataTool(db, apc, 'get_reports', {});
  assert.match(all.text, /Reports \(1 matched\):\n- Aqua Sonic/);
  assert.equal((await runDataTool(db, apc, 'get_reports', { brand_name: 'Cutler' })).text, 'No matching reports found for that brand/period.');
});

test('acl: uses ai_viewable_brand_ids when it exists, detected once; else the per-brand loop', async () => {
  const reps = [weekly('b2', 24, '2026-09-13', 'approved', { gmv: '2' })];
  let setCalls = 0, loopCalls = 0;
  const loopRpc = { can_view_brand: (a: any) => { loopCalls++; return a.b_id === 'b2'; } };
  _resetAclProbe();
  const without = fakeDb({ brands: BRANDS, reports: reps }, loopRpc);
  assert.match((await runDataTool(without, { userId: 'u1', role: 'apc' }, 'list_brands', {})).text, /^Brands you can see \(1\):\n- Aqua Sonic/);
  assert.equal(loopCalls, BRANDS.length);
  // absent is remembered: no second probe, straight to the loop
  const probe = fakeDb({ brands: BRANDS, reports: reps }, { ...loopRpc, ai_viewable_brand_ids: () => { setCalls++; return ['b2']; } });
  await runDataTool(probe, { userId: 'u1', role: 'apc' }, 'list_brands', {});
  assert.equal(setCalls, 0);
  // fresh process with the function present: one call, no loop
  _resetAclProbe();
  loopCalls = 0;
  assert.match((await runDataTool(probe, { userId: 'u1', role: 'apc' }, 'list_brands', {})).text, /^Brands you can see \(1\):\n- Aqua Sonic/);
  assert.deepEqual([setCalls, loopCalls], [1, 0]);
  // a transient error falls back to the loop and does not disable the RPC
  _resetAclProbe();
  const flaky = fakeDb({ brands: BRANDS, reports: reps }, { ...loopRpc, ai_viewable_brand_ids: () => { throw new Error('fetch failed'); } });
  assert.match((await runDataTool(flaky, { userId: 'u1', role: 'apc' }, 'list_brands', {})).text, /^Brands you can see \(1\)/);
  await runDataTool(probe, { userId: 'u1', role: 'apc' }, 'list_brands', {});
  assert.equal(setCalls, 2);
  _resetAclProbe();
});

test('get_reports: non-USD lines carry their currency; USD lines stay v1-identical', async () => {
  const gbp = { ...monthly('b3', 8, 'approved', { keyMetrics: { gmv: '5,056.59', orders: '12' }, gmvMax: [{ campaign: 'A', spend: '10', gmv: '20' }] }) };
  const usd = { ...monthly('b2', 8, 'approved', { keyMetrics: { gmv: '100.00', orders: '3' } }) };
  const r = await runDataTool(fakeDb({ brands: BRANDS, reports: [gbp, usd] }), BOSS, 'get_reports', { period: 'August 2026', sections: ['metrics', 'gmvmax'] });
  assert.match(r.text, /- Longevity Box · August 2026 \(monthly, approved\): GMV 5,056\.59 \(GBP\), orders 12\n  GMV Max campaigns \(money in GBP\):/);
  assert.match(r.text, /- Aqua Sonic · August 2026 \(monthly, approved\): GMV 100\.00, orders 3(\n|$)/);
  assert.equal(metricsLineCur({ overallPerformance: { gmv: '1', affiliateGmv: '2', orders: '3' }, offsitePerformance: { offsiteGmv: '4' } }, 'GBP'),
    'GMV 1 (GBP), affiliate GMV 2 (GBP), orders 3, offsite GMV 4 (GBP)');
});

test('get_performance: composites 4 at a time, one retry, failures said and ranked last', async () => {
  const ratings = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => ({ user_id: id, month: '2026-08', metrics: {}, overall_score: 90 - i }));
  const profiles = ratings.map((r, i) => ({ id: r.user_id, display_name: `Person ${i + 1}`, role: 'apc', deleted_at: null }));
  let inFlight = 0, peak = 0;
  const tries = new Map<string, number>();
  const db = fakeDb({ performance_ratings: ratings, profiles, performance_flags: [], performance_warnings: [] }, {
    get_performance_composite: async (a: any) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      tries.set(a.p_user, (tries.get(a.p_user) || 0) + 1);
      if (a.p_user === 'p1') throw new Error('fetch failed');                      // always fails
      if (a.p_user === 'p2' && tries.get('p2') === 1) throw new Error('timeout');  // recovers on retry
      return [{ composite_score: 50 + Number(a.p_user.slice(1)), level: 'good' }];
    },
  });
  const r = await runDataTool(db, BOSS, 'get_performance', { month: '2026-08' });
  assert.ok(peak <= 4, `peak ${peak}`);
  assert.equal(tries.get('p1'), 2);
  assert.match(r.text, /- Person 2 — composite 52\.0\/100 — Good/);
  const lines = r.text.split('\n').filter((l) => l.startsWith('- Person'));
  assert.match(lines[lines.length - 1], /^- Person 1 — composite could not be loaded \(lookup failed\), so this is NOT the Performance page figure/);
  assert.match(r.text, /\(The composite could not be loaded for 1 of 6; they are listed last/);
});

test('no report vs unapproved report: never blurred (Buddy smoke), in text and data', async () => {
  const w24 = weekly('b1', 24, '2026-09-13', 'approved', { gmv: '1320' }, { topCreators: [cr('a', '30', '9')] });
  const args = { brand: 'Cutler', period: '2026-09-20..2026-09-26', type: 'weekly' };
  // missing: nothing submitted for the week
  const miss = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24] }), BOSS, 'get_top_creators', args);
  assert.match(miss.text, /^No weekly report has been submitted for 2026-09-20 – 2026-09-26 \(PKT\) yet \(not in yet\)\. Latest approved weekly report instead: Week 24 \(Sep 13 - 19\)\./);
  assert.ok(!/awaiting approval|not approved/.test(miss.text));
  assert.deepEqual([(miss.data as any).period_status, (miss.data as any).shown_period], ['missing', 'Week 24 (Sep 13 - 19)']);
  // pending: the week's report exists, verified
  const w25 = weekly('b1', 25, '2026-09-20', 'verified', { gmv: '99999' }, { topCreators: [cr('secret', '88888', '77')] });
  const pend = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24, w25] }), BOSS, 'get_top_creators', args);
  assert.match(pend.text, /^The weekly report for 2026-09-20 – 2026-09-26 \(PKT\) \(Week 25 \(Sep 20 - 26\)\) exists but is verified, awaiting approval \(figures withheld\)\. Latest approved weekly report instead: Week 24/);
  assert.ok(!/has been submitted|not in yet/.test(pend.text));
  assert.ok(!pend.text.includes('88888') && !pend.text.includes('secret'));
  assert.equal((pend.data as any).period_status, 'pending');
  // a draft is "not yet submitted", not "awaiting approval"
  const draft = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24, { ...w25, status: 'draft' }] }), BOSS, 'get_top_creators', args);
  assert.match(draft.text, /exists but is draft, not yet submitted \(figures withheld\)/);
  // approved in the period
  const ok = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24] }), BOSS, 'get_top_creators', { ...args, period: '2026-09-13..2026-09-19' });
  assert.equal((ok.data as any).period_status, 'approved');
  // the month path says the same two things
  const aug = monthly('b1', 8, 'submitted', {});
  const wk = weekly('b1', 18, '2026-08-02', 'approved', {}, { topCreators: [cr('x', '1', '1')] });
  const mp = await runDataTool(fakeDb({ brands: BRANDS, reports: [aug, wk] }), BOSS, 'get_top_creators', { brand: 'Cutler', period: 'August 2026' });
  assert.match(mp.text, /the August 2026 monthly report exists but is submitted, awaiting approval \(figures withheld\)/);
  assert.equal((mp.data as any).period_status, 'pending');
  const mm = await runDataTool(fakeDb({ brands: BRANDS, reports: [wk] }), BOSS, 'get_top_creators', { brand: 'Cutler', period: 'August 2026' });
  assert.match(mm.text, /no monthly report has been submitted for August 2026 yet \(not in yet\)/);
  assert.equal((mm.data as any).period_status, 'missing');
  // compare_periods and get_reports carry it too
  const cp = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24] }), BOSS, 'compare_periods', { brand: 'Cutler', metric: 'gmv', ...args, period_a: args.period });
  assert.match(cp.text, /No weekly report has been submitted for 2026-09-20 – 2026-09-26 \(PKT\) yet \(not in yet\)\..*Nothing compared/);
  assert.equal((cp.data as any).period_status, 'missing');
  const gr = await runDataTool(fakeDb({ brands: BRANDS, reports: [w24, w25] }), BOSS, 'get_reports', { brand_name: 'Cutler', period: '2026-09-20..2026-09-26', type: 'weekly' });
  assert.match(gr.text, /^The weekly report for .* exists but is verified, awaiting approval \(figures withheld\)\./);
  assert.equal((gr.data as any).period_status, 'pending');
});

// ------------------------------------------------------------------ role safeguards
// userClient = a fake holding only what that user's RLS would return.
const PEOPLE_ROWS = [
  { id: 'u-apc', display_name: 'Apc One', role: 'apc', reports_to: 'u-tl', deleted_at: null, is_active: true },
  { id: 'u-apc2', display_name: 'Apc Two', role: 'apc', reports_to: 'u-tl2', deleted_at: null, is_active: true },
  { id: 'u-tl', display_name: 'Tl One', role: 'tl', reports_to: null, deleted_at: null, is_active: true },
  { id: 'u-ol', display_name: 'Ol One', role: 'ol', reports_to: null, deleted_at: null, is_active: true },
];
const comp = (id: string, pay: number) => ({ user_id: id, basic_salary: pay, effective_from: '2026-01-01', last_change_reason: null });

test('salary: every non-Boss sees only their own, even where RLS would allow more (OL)', async () => {
  // An OL's RLS (ec_select) returns everyone; the app shows others' pay only to the Boss.
  const olClient = fakeDb({ profiles: PEOPLE_ROWS, employee_compensation: [comp('u-apc', 111), comp('u-apc2', 222), comp('u-ol', 333)], salary_history: [] });
  const ol = { userId: 'u-ol', role: 'ol', userClient: olClient };
  const own = await runDataTool(fakeDb({}), ol, 'get_salary', {});
  assert.equal(own.text, 'Salaries (1):\n- Ol One (ol): PKR 333 (since 2026-01-01)');
  assert.equal((await runDataTool(fakeDb({}), ol, 'get_salary', { person_name: 'Apc One' })).text, NOT_YOURS);
  assert.match((await runDataTool(fakeDb({}), ol, 'get_salary', { person_name: 'Ol One' })).text, /PKR 333/);
  // an APC with no row: a plain answer about themselves, nothing about others
  const apc = { userId: 'u-apc2', role: 'apc', userClient: fakeDb({ profiles: PEOPLE_ROWS, employee_compensation: [], salary_history: [] }) };
  assert.equal((await runDataTool(fakeDb({}), apc, 'get_salary', {})).text, 'No salary on record for you (My Compensation shows the same).');
});

test('people tools: RLS decides; a colleague you cannot see is a polite refusal, not "no data"', async () => {
  const inc = (id: string) => ({ user_id: id, month: '2026-08', basic_salary: 1, incentives: [{ text: 'Goal', amount: 100, completed: true }], bonuses: [], verified: true, payout_cleared: true });
  // TL: inc_select lets a manager read their reports' rows (u-apc reports to u-tl)
  const tlClient = fakeDb({ profiles: PEOPLE_ROWS, incentives: [inc('u-tl'), inc('u-apc')] });
  const tl = { userId: 'u-tl', role: 'tl', userClient: tlClient };
  assert.match((await runDataTool(fakeDb({}), tl, 'get_incentives', { person_name: 'Apc One', month: '2026-08' })).text, /^Incentives for 2026-08 \(1 record\(s\)\):\n\nApc One — 2026-08/);
  assert.equal((await runDataTool(fakeDb({}), tl, 'get_incentives', { person_name: 'Apc Two', month: '2026-08' })).text, NOT_YOURS);
  const all = await runDataTool(fakeDb({}), tl, 'get_incentives', { month: '2026-08' });
  assert.match(all.text, /\(2 record\(s\)\)/);
  assert.ok(!all.text.includes('Apc Two'));
  // leave / attendance about someone invisible
  const apc = { userId: 'u-apc', role: 'apc', userClient: fakeDb({ profiles: PEOPLE_ROWS, leave_requests: [], attendance: [] }, { attendance_month_breakdown_bulk: () => [] }) };
  assert.equal((await runDataTool(fakeDb({}), apc, 'get_leave', { person_name: 'Apc Two' })).text, NOT_YOURS);
  assert.equal((await runDataTool(fakeDb({}), apc, 'get_attendance', { person_name: 'Apc Two', month: '2026-08' })).text, NOT_YOURS);
  assert.match((await runDataTool(fakeDb({}), apc, 'get_leave', {})).text, /^No leave requests found\.$/);   // own, genuinely empty
  // performance: the composite RPC returns no row for someone you can't see
  const perfClient = fakeDb({ profiles: PEOPLE_ROWS, performance_ratings: [], performance_flags: [], performance_warnings: [] },
    { get_performance_composite: (a: any) => (a.p_user === 'u-apc' ? [{ composite_score: 80, level: 'good' }] : []) });
  const me = { userId: 'u-apc', role: 'apc', userClient: perfClient };
  assert.equal((await runDataTool(fakeDb({}), me, 'get_performance', { person_name: 'Apc Two', month: '2026-08' })).text, NOT_YOURS);
  assert.match((await runDataTool(fakeDb({}), me, 'get_performance', { person_name: 'Apc One', month: '2026-08' })).text, /^Apc One — composite 80\.0\/100 — Good/);
});

test('page guards stricter than RLS: no Performance for developer/ads_manager, no Incentives for developer', async () => {
  const c = (role: string) => ({ userId: 'u-x', role, userClient: fakeDb({ profiles: PEOPLE_ROWS }) });
  assert.equal((await runDataTool(fakeDb({}), c('developer'), 'get_performance', {})).text, NOT_YOURS);
  assert.equal((await runDataTool(fakeDb({}), c('ads_manager'), 'get_performance', {})).text, NOT_YOURS);
  assert.equal((await runDataTool(fakeDb({}), c('developer'), 'get_incentives', {})).text, NOT_YOURS);
  assert.notEqual((await runDataTool(fakeDb({}), c('ads_manager'), 'get_incentives', {})).text, NOT_YOURS);
  assert.deepEqual(Object.keys(ROLE_ANGLES).sort(), [...STAFF_ROLES].sort());
});

test('directory: email, responsibilities and employment type for Boss/OL only', async () => {
  const rows = PEOPLE_ROWS.map((p) => ({ ...p, email: `${p.id}@x.test`, responsibilities: ['Secret duty'], employment_type: 'full-time', start_date: '2026-01-01' }));
  const ask = (role: string) => runDataTool(fakeDb(role === 'boss' ? { profiles: rows } : {}), { userId: 'u-x', role, userClient: fakeDb({ profiles: rows }) }, 'find_person', { name: 'Apc One' });
  for (const role of ['apc', 'tl', 'pctl', 'ipc', 'developer', 'ads_manager']) {
    const t = (await ask(role)).text;
    assert.ok(!/Email|Secret duty|Employment|full-time/.test(t), role);
    assert.match(t, /^Apc One\n- Role: Affiliate Program Coordinator \(APC\)\n- Reports to: Tl One \(Team Lead — Affiliate \(TL\)\)\n- Start date: 2026-01-01/);
  }
  for (const role of ['ol', 'boss']) assert.match((await ask(role)).text, /- Email: u-apc@x\.test[\s\S]*- Employment: full-time[\s\S]*- Responsibilities: Secret duty/);
  const emp = await runDataTool(fakeDb({}), { userId: 'u-x', role: 'apc', userClient: fakeDb({ profiles: rows }) }, 'get_employees', {});
  assert.ok(!emp.text.includes('full-time'));
});

test('commission overlay: arithmetic via the service client on rows the caller can see', async () => {
  const row = { user_id: 'u-apc', month: '2026-08', basic_salary: 1, verified: false, payout_cleared: false, bonuses: [],
    incentives: [{ text: 'Commission', source: 'commission_tier', brandId: 'b1', targetValue: 100, achievedValue: 300, commissionPct: 10, amount: 0, completed: false }] };
  const user = fakeDb({ profiles: PEOPLE_ROWS, incentives: [row], brand_monthly_metrics: [] });   // no commission_line_state for users
  const svc = fakeDb({}, { commission_line_state: () => ({ completed: true, amount: 5600 }) });
  const r = await runDataTool(svc, { userId: 'u-apc', role: 'apc', userClient: user }, 'get_incentives', { month: '2026-08' });
  assert.match(r.text, /Earned so far \(completed goals\): PKR 5,600 of PKR 5,600 potential\./);
});

test('reports with the caller JWT: can_view_report decides, including the author\'s own report', async () => {
  const own = { ...weekly('b4', 3, '2026-04-19', 'approved', { gmv: '5' }), author_id: 'u-apc' };   // brand not visible to them
  const user = fakeDb({ brands: BRANDS.filter((b) => b.id === 'b2'), reports: [own, weekly('b2', 3, '2026-04-19', 'approved', { gmv: '7' })] });
  const r = await runDataTool(fakeDb({ brands: BRANDS }), { userId: 'u-apc', role: 'apc', userClient: user }, 'get_reports', {});
  assert.match(r.text, /^Reports \(2 matched\):/);
  // the hidden brand's NAME is resolved via the service client, never its other rows
  assert.match(r.text, /- Old Brand · Week 3 \(Apr 19 - 25\) \(weekly, approved\): GMV 5/);
  assert.ok(!r.text.includes('Unknown brand'));
  assert.match((await runDataTool(fakeDb({}), { userId: 'u-apc', role: 'apc', userClient: user }, 'list_brands', {})).text, /^Brands you can see \(1\):/);
  const ov = await runDataTool(fakeDb({}), { userId: 'u-apc', role: 'apc', userClient: fakeDb({ brands: BRANDS.filter((b) => b.id === 'b2'), brand_monthly_metrics: [], reports: [], profiles: [] }) }, 'brand_overview', { brand: 'Aqua' });
  assert.match(ov.text, /Monthly targets: none I can show you\./);
});

// ------------------------------------------------------------------ brand assignments (APCs/IPCs)
const TEAM = [
  { id: 't1', display_name: 'Tina TL', role: 'tl', is_active: true, deleted_at: null },
  { id: 'a1', display_name: 'Ali APC', role: 'apc', is_active: true, deleted_at: null },
  { id: 'a2', display_name: 'Bea APC', role: 'apc', is_active: true, deleted_at: null },
  { id: 'a3', display_name: 'Gone APC', role: 'apc', is_active: false, deleted_at: null },
  { id: 'i1', display_name: 'Ivy IPC', role: 'ipc', is_active: true, deleted_at: null },
];
const TEAM_BRANDS = [
  { id: 'bA', brand_name: 'Alpha', status: 'active', owner_id: 't1', currency: 'USD' },
  { id: 'bB', brand_name: 'Beta', status: 'active', owner_id: 't1', currency: 'USD' },
];
const ASG = [
  { brand_id: 'bA', user_id: 'a1', expires_at: null },
  { brand_id: 'bA', user_id: 'a2', expires_at: '2099-10-12T10:00:00Z' },   // temporary cover
  { brand_id: 'bA', user_id: 'a3', expires_at: null },                     // inactive: left out
  { brand_id: 'bA', user_id: 'i1', expires_at: null },
  { brand_id: 'bB', user_id: 'a2', expires_at: '2000-01-01T00:00:00Z' },   // expired cover: left out
];

test('assignments: grouped by role, temporary cover marked, inactive and expired left out', async () => {
  const m = await loadAssignments(fakeDb({ brand_assignments: ASG, profiles: TEAM }), ['bA', 'bB']);
  assert.equal(assignmentText(m.get('bA')), 'APCs: Ali APC, Bea APC (temporary cover until 12 Oct); IPCs: Ivy IPC');
  assert.equal(m.get('bB'), undefined);
  assert.equal(assignmentText([]), '');
});

test('list_brands / brand_overview / get_brand_assignments show the assigned APCs, via the caller JWT for non-Boss', async () => {
  const boss = fakeDb({ brands: TEAM_BRANDS, brand_assignments: ASG, profiles: TEAM, brand_monthly_metrics: [], reports: [] });
  const lb = await runDataTool(boss, BOSS, 'list_brands', {});
  assert.match(lb.text, /- Alpha \(active\) — owner: Tina TL; APCs: Ali APC, Bea APC \(temporary cover until 12 Oct\); IPCs: Ivy IPC/);
  assert.match(lb.text, /- Beta \(active\) — owner: Tina TL$/m);
  const ov = await runDataTool(boss, BOSS, 'brand_overview', { brand: 'Alpha' });
  assert.match(ov.text, /- Owner \(Team Lead\): Tina TL\n- Assigned: APCs: Ali APC, Bea APC \(temporary cover until 12 Oct\); IPCs: Ivy IPC/);
  const who = await runDataTool(boss, BOSS, 'get_brand_assignments', { brand: 'Alpha', role: 'apc' });
  assert.match(who.text, /- Alpha \(active\) — APCs: Ali APC, Bea APC \(temporary cover until 12 Oct\)/);
  const mine = await runDataTool(boss, BOSS, 'get_brand_assignments', { person: 'Bea' });
  assert.match(mine.text, /^Brands Bea APC handles \(1\):\n- Alpha \(active\): assigned APC \(temporary cover until 12 Oct\)$/);
  const tl = await runDataTool(boss, BOSS, 'get_brand_assignments', { person: 'Tina' });
  assert.match(tl.text, /- Alpha \(active\): owner \(Team Lead\)\n- Beta \(active\): owner \(Team Lead\)/);
  // Non-Boss: read with the caller's client (RLS): the service client's rows are never used.
  const user = fakeDb({ brands: TEAM_BRANDS.slice(0, 1), brand_assignments: ASG.slice(0, 1), profiles: TEAM });
  const svc = fakeDb({ brands: TEAM_BRANDS, brand_assignments: ASG, profiles: TEAM });
  const apcView = await runDataTool(svc, { userId: 'a1', role: 'apc', userClient: user }, 'list_brands', {});
  assert.match(apcView.text, /^Brands you can see \(1\):\n- Alpha \(active\) — owner: Tina TL; APCs: Ali APC$/);
});

test('tool catalog: every definition has an implementation and a JSON schema', () => {
  assert.deepEqual(TOOL_DEFS.map((d) => d.name).sort(), [...TOOL_NAMES].sort());
  for (const d of TOOL_DEFS) {
    assert.equal((d.parameters as any).type, 'object', d.name);
    assert.ok(d.description.length > 20, d.name);
  }
});
