// ============================================================
// Tests for src/lib/incentiveAchieved.js — achieved figures from the brand workbook.
//
//   node scripts/test-incentive-achieved.mjs [path/to/All Brands Data.xlsx]
//
// No network, no DB. The synthetic-grid tests always run; the real-workbook
// checks run only when the xlsx fixture is found (arg, env WORKBOOK, or the
// OL's Downloads copy) and are reported as SKIP otherwise.
// ============================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const W = await import(new URL('../src/lib/incentiveWorkbook.js', import.meta.url).href);
const A = await import(new URL('../src/lib/incentiveAchieved.js', import.meta.url).href);

let pass = 0, fail = 0, skip = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};

// A two-column-per-month grid: header row 1, month targets at cols 1,3,5.
const HDR = ['Brand', 'Aug 26', 'Aug 1-31', 'Sep 26', 'Sep 1-30', 'Oct 26', 'Oct 1-31'];
const sheetOf = (rows, hdr = HDR) => W.readBrandSheet([['Brand title'], hdr, ...rows]);
const std = (total, auth, hdr) => sheetOf([
  ['Total Videos Made', null, 100, null, 200, null, total],
  ['Video authorized ', 0.95, 90, 0.95, 180, 0.95, auth],
  ['Creators with more than three video', 40, 30, 40, 31, 40, 32],
  ['Videos with $100+ GMV ', 10, 8, 10, 9, 10, 11],
  ['Onboarding L3+ creators', 5, 2, 5, 3, 5, 4],
  ['Total GMV from GMV Max', 1000, 800, 1000, 900, 1000, 1200.5],
], hdr);

// ── next month: the sheet grows a column pair every month ──────────
const grow = (hdr, add) => [...hdr, ...add];
t('Nov goal added first (no achieved yet): Oct still reads, Nov refuses (never zeroes)', () => {
  const hdr = grow(HDR, ['Nov 26']);
  const s = W.readBrandSheet([['Brand title'], hdr,
    ['Total Videos Made', null, 100, null, 200, null, 422, null],
    ['Video authorized ', 0.95, 90, 0.95, 180, 0.95, 377, 0.95]]);
  assert.equal(A.getAchieved(s, 'video_authorized', '2026-10').value, 89.34);
  assert.ok(A.getAchieved(s, 'video_authorized', '2026-11').unavailable);
});
t('Nov achieved column arrives: Nov reads, Oct unchanged', () => {
  const hdr = grow(HDR, ['Nov 26', 'Nov 1-30']);
  const s = W.readBrandSheet([['Brand title'], hdr,
    ['Total Videos Made', null, 100, null, 200, null, 422, null, 500],
    ['Video authorized ', 0.95, 90, 0.95, 180, 0.95, 377, 0.95, 450]]);
  assert.equal(A.getAchieved(s, 'video_authorized', '2026-11').value, 90);
  assert.equal(A.getAchieved(s, 'video_authorized', '2026-10').value, 89.34);
});
t('year rollover: Dec then Jan 27 resolve to 2026-12 / 2027-01', () => {
  const hdr = ['Brand', 'Nov 26', 'Nov 1-30', 'Dec 26', 'Dec 1-31', 'Jan 27', 'Jan 1-31'];
  const s = W.readBrandSheet([['Brand title'], hdr,
    ['Total Videos Made', null, 100, null, 200, null, 300],
    ['Video authorized ', 0.95, 90, 0.95, 150, 0.95, 270]]);
  assert.equal(A.getAchieved(s, 'video_authorized', '2026-11').value, 90);
  assert.equal(A.getAchieved(s, 'video_authorized', '2026-12').value, 75);
  assert.equal(A.getAchieved(s, 'video_authorized', '2027-01').value, 90);
});
t('earlier months keep resolving after a new month is appended', () => {
  assert.equal(A.getAchieved(std(422, 377), 'video_authorized', '2026-09').value, 90);
});

// ── getAchieved ────────────────────────────────────────────────────
t('video_authorized = authorized / total * 100, 2dp, with detail', () => {
  const r = A.getAchieved(std(422, 377), 'video_authorized', '2026-10');
  assert.deepEqual(r, { value: 89.34, unit: 'percent', detail: '377 of 422 videos authorized' });
});
t('other options read straight from the achieved cell', () => {
  const s = std(422, 377);
  assert.equal(A.getAchieved(s, 'creators_3plus', '2026-10').value, 32);
  assert.equal(A.getAchieved(s, 'videos_100_gmv', '2026-10').value, 11);
  assert.equal(A.getAchieved(s, 'onboarding_l3', '2026-10').value, 4);
  const g = A.getAchieved(s, 'gmv_max', '2026-10');
  assert.equal(g.value, 1200.5); assert.equal(g.unit, 'money');
});
t('reads the right month, never a neighbour', () => {
  const s = std(422, 377);
  assert.equal(A.getAchieved(s, 'creators_3plus', '2026-09').value, 31);
  assert.equal(A.getAchieved(s, 'creators_3plus', '2026-08').value, 30);
});
t('zero total refuses', () => {
  assert.match(A.getAchieved(std(0, 0), 'video_authorized', '2026-10').unavailable, /cannot divide/);
});
t('authorized > total refuses (never >100%)', () => {
  assert.match(A.getAchieved(std(100, 120), 'video_authorized', '2026-10').unavailable, /more than the 100 made/);
});
t('authorized == total gives exactly 100', () => {
  assert.equal(A.getAchieved(std(50, 50), 'video_authorized', '2026-10').value, 100);
});
t('blank authorized / blank total refuse', () => {
  assert.match(A.getAchieved(std(422, null), 'video_authorized', '2026-10').unavailable, /blank/);
  assert.match(A.getAchieved(std(null, 377), 'video_authorized', '2026-10').unavailable, /blank/);
});
t("'1.9M' style figures and text refuse", () => {
  assert.ok(A.getAchieved(std(422, '1.9M'), 'video_authorized', '2026-10').unavailable);
  assert.ok(A.getAchieved(std('1.7 Million', 377), 'video_authorized', '2026-10').unavailable);
  const s = sheetOf([['Total GMV from GMV Max', 1000, 800, 1000, 900, 1000, '$1.296M']]);
  assert.match(A.getAchieved(s, 'gmv_max', '2026-10').unavailable, /abbreviated/);
  const s2 = sheetOf([['Onboarding L3+ creators', 5, 2, 5, 3, 5, 'No Euka']]);
  assert.match(A.getAchieved(s2, 'onboarding_l3', '2026-10').unavailable, /not a number/);
});
t('negative achieved refuses', () => {
  const s = sheetOf([['Videos with $100+ GMV ', 10, 8, 10, 9, 10, -3]]);
  assert.match(A.getAchieved(s, 'videos_100_gmv', '2026-10').unavailable, /negative/);
});
t('sheet ending on the target (no achieved column yet) refuses, not the target', () => {
  const s = sheetOf([
    ['Total Videos Made', null, 100, null, 200, null],
    ['Video authorized ', 0.95, 90, 0.95, 180, 0.95],
    ['Creators with more than three video', 40, 30, 40, 31, 40],
  ], ['Brand', 'Aug 26', 'Aug 1-31', 'Sep 26', 'Sep 1-30', 'Oct 26']);
  assert.match(A.getAchieved(s, 'creators_3plus', '2026-10').unavailable, /no achieved column/);
  assert.match(A.getAchieved(s, 'video_authorized', '2026-10').unavailable, /no achieved column/);
  assert.equal(A.getAchieved(s, 'creators_3plus', '2026-09').value, 31);
});
t('sheet ending on the achieved half (Longevity Box / Dr Tobias) reads Sep, refuses Oct', () => {
  const hdr = ['Brand', 'Jul 26', 'Jul 1-31', 'Aug 26', 'Aug 1-31', 'Sep 26', 'Sep 1-30'];
  const s = sheetOf([
    ['Total Videos Made', null, 100, null, 200, null, 389],
    ['Authorized Videos', 0.95, 90, 0.95, 180, 0.95, 375],
    ['Creators with more than three video', 40, 30, 40, 31, 40, 26],
  ], hdr);
  assert.deepEqual(A.getAchieved(s, 'video_authorized', '2026-09'),
    { value: 96.4, unit: 'percent', detail: '375 of 389 videos authorized' });
  assert.equal(A.getAchieved(s, 'creators_3plus', '2026-09').value, 26);   // not the 40 target
  assert.ok(A.getAchieved(s, 'creators_3plus', '2026-10').unavailable);
});
t('Aurelia style: achieved column headed with a bare same-month name is accepted', () => {
  const s = sheetOf([['Videos with $100+ GMV ', 10, 6, 10, 7]], ['Aurelia', 'Aug 26', 'August', 'Sep 26', 'Sep 1-30']);
  assert.equal(A.getAchieved(s, 'videos_100_gmv', '2026-08').value, 6);
});
t('column after the target headed with a different month refuses', () => {
  const s = sheetOf([['Videos with $100+ GMV ', 10, 6, 10, 7]], ['Brand', 'Feb 26', 'March 26', 'Mar 26', 'Mar 1-31']);
  const r = A.getAchieved(s, 'videos_100_gmv', '2026-02');
  assert.ok(r.unavailable, JSON.stringify(r));
});
t('year-less headers (year could be off by one) refuse', () => {
  const s = sheetOf([['Videos with $100+ GMV ', 10, 6, 10, 7]], ['Brand', 'October', 'Oct 1-30', 'November', 'Nov 1-30']);
  assert.match(A.getAchieved(s, 'videos_100_gmv', '2026-10').unavailable, /never state the year/);
});
t('missing row, unknown option, unreadable sheet, missing sheet', () => {
  assert.match(A.getAchieved(sheetOf([['Total Videos Made', null, 1, null, 1, null, 1]]), 'gmv_max', '2026-10').unavailable, /no "Total GMV from GMV Max" row/);
  assert.match(A.getAchieved(std(1, 1), 'nope', '2026-10').unavailable, /unknown option/);
  assert.ok(A.getAchieved({ ok: false, reason: 'No header row' }, 'gmv_max', '2026-10').unavailable);
  assert.ok(A.getAchieved({ missing: true }, 'gmv_max', '2026-10').unavailable);
  assert.ok(A.getAchieved(undefined, 'gmv_max', '2026-10').unavailable);
});
t('video_authorized with no Total Videos Made row refuses', () => {
  const s = sheetOf([['Video authorized ', 0.95, 90, 0.95, 180, 0.95, 377]]);
  assert.match(A.getAchieved(s, 'video_authorized', '2026-10').unavailable, /Total Videos Made/);
});
t('label spellings: Total videos made / trailing spaces / Videos Authorized', () => {
  const s = sheetOf([
    ['  Total videos MADE ', null, 100, null, 200, null, 50],
    ['Videos Authorized', 0.95, 90, 0.95, 180, 0.95, 40],
  ]);
  assert.equal(A.getAchieved(s, 'video_authorized', '2026-10').value, 80);
});

// ── buildAchievedUpdates ───────────────────────────────────────────
const line = (o) => ({
  id: 'l1', text: 'Creators with more than three videos', brandId: 'b1', brandName: 'Brand One',
  wbOption: 'creators_3plus', targetValue: '40', achievedValue: 0, completed: false, amount: 1000, ...o,
});
const plan = (o) => ({ userId: 'u1', userName: 'Ali', verified: false, payoutCleared: false, incentives: [], bonuses: [], ...o });
const sheets = { b1: std(422, 377) };

t('sheet updated for some brands, then again: second fetch fills the rest and only touches what changed', () => {
  // b1 has its Oct achieved column; b2 does not yet (sheet ends on the Oct goal).
  const b2Early = W.readBrandSheet([['Brand title'], ['Brand', 'Sep 26', 'Sep 1-30', 'Oct 26'],
    ['Creators with more than three video', 40, 30, 45]]);
  const b1v1 = std(422, 377);
  let p = plan({ incentives: [line({ id: 'a', brandId: 'b1' }), line({ id: 'c', brandId: 'b2', brandName: 'Brand Two' })] });
  const r1 = A.buildAchievedUpdates({ plans: [p], sheetsByBrand: { b1: b1v1, b2: b2Early }, month: '2026-10' });
  assert.equal(r1.changes.length, 1, 'only the updated brand fills');
  assert.equal(r1.changes[0].brandId, 'b1');
  assert.ok(r1.skipped.some((x) => x.brandName === 'Brand Two' && /no achieved column/.test(x.reason)), 'the other brand is named with a reason');
  p = { ...p, ...A.applyChangesToPlan(p, r1.changes) };
  // Sheet updated again: b2 gains its achieved column, b1 re-entered with a different value.
  const b2Late = W.readBrandSheet([['Brand title'], ['Brand', 'Sep 26', 'Sep 1-30', 'Oct 26', 'Oct 1-31'],
    ['Creators with more than three video', 40, 30, 45, 41]]);
  const b1v2 = W.readBrandSheet([['Brand title'], HDR,
    ['Creators with more than three video', 40, 30, 40, 31, 40, 36]]);
  const r2 = A.buildAchievedUpdates({ plans: [p], sheetsByBrand: { b1: b1v2, b2: b2Late }, month: '2026-10' });
  assert.deepEqual(r2.changes.map((c) => [c.brandId, c.before, c.after]).sort(), [['b1', 32, 36], ['b2', 0, 41]]);
  p = { ...p, ...A.applyChangesToPlan(p, r2.changes) };
  // A third fetch with an unchanged sheet changes nothing.
  const r3 = A.buildAchievedUpdates({ plans: [p], sheetsByBrand: { b1: b1v2, b2: b2Late }, month: '2026-10' });
  assert.equal(r3.changes.length, 0);
});
t('emits a change with before/after/completion/detail', () => {
  const { changes, skipped } = A.buildAchievedUpdates({
    plans: [plan({ incentives: [line({ achievedValue: 5 })] })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(skipped.length, 0);
  assert.deepEqual(changes, [{
    userId: 'u1', userName: 'Ali', section: 'incentives', lineId: 'l1', brandId: 'b1', brandName: 'Brand One',
    optionKey: 'creators_3plus', label: 'Creators with more than three videos', before: 5, after: 32,
    completedBefore: false, completedAfter: false, detail: '2026-10 achieved cell', wasVerified: false,
  }]);
});
t('completedAfter follows autoComplete (>= 90% of target)', () => {
  const { changes } = A.buildAchievedUpdates({
    plans: [plan({ incentives: [line({ targetValue: '35' })] })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(changes[0].completedAfter, true);   // 32/35 = 0.914
});
t('an injected autoComplete is used', () => {
  const { changes } = A.buildAchievedUpdates({
    plans: [plan({ incentives: [line()] })], sheetsByBrand: sheets, month: '2026-10', autoComplete: () => true,
  });
  assert.equal(changes[0].completedAfter, true);
});
t('paid (payoutCleared) plan is skipped entirely', () => {
  const { changes, skipped } = A.buildAchievedUpdates({
    plans: [plan({ payoutCleared: true, incentives: [line()] })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(changes.length, 0);
  assert.match(skipped[0].reason, /payout/);
});
t('verified plan is included and flagged', () => {
  const { changes } = A.buildAchievedUpdates({
    plans: [plan({ verified: true, incentives: [line()] })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(changes[0].wasVerified, true);
});
t('derived-source lines (gmv_max / attendance / ol_brands) are skipped with a reason', () => {
  const { changes, skipped } = A.buildAchievedUpdates({
    plans: [plan({
      bonuses: [line({ id: 'g', wbOption: 'gmv_max', source: 'gmv_max', targetValue: '1000' })],
      incentives: [line({ id: 'a', source: 'attendance' }), line({ id: 'o', source: 'ol_brands' })],
    })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(changes.length, 0);
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((s) => s.reason && s.userName === 'Ali'));
});
t('lines without wbOption or brandId are not candidates (not even skipped)', () => {
  const { changes, skipped } = A.buildAchievedUpdates({
    plans: [plan({ incentives: [line({ wbOption: undefined }), line({ brandId: undefined })] })],
    sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(changes.length + skipped.length, 0);
});
t('no change emitted when after === before', () => {
  const { changes, skipped } = A.buildAchievedUpdates({
    plans: [plan({ incentives: [line({ achievedValue: 32 })] })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(changes.length, 0); assert.equal(skipped.length, 0);
  // string-typed stored value is compared numerically
  const r = A.buildAchievedUpdates({
    plans: [plan({ incentives: [line({ achievedValue: '32' })] })], sheetsByBrand: sheets, month: '2026-10',
  });
  assert.equal(r.changes.length, 0);
});
t('unavailable / blank / missing sheet is a Skip and NEVER zeroes the line', () => {
  const blank = sheetOf([['Creators with more than three video', 40, 30, 40, 31, 40, null]]);
  const { changes, skipped } = A.buildAchievedUpdates({
    plans: [plan({ incentives: [
      line({ id: 'x', achievedValue: 12 }),
      line({ id: 'y', brandId: 'b2', brandName: 'Two', achievedValue: 7 }),
      line({ id: 'z', brandId: 'b3', brandName: 'Three', achievedValue: 7 }),
    ] })],
    sheetsByBrand: { b1: blank, b2: { missing: true } }, month: '2026-10',
  });
  assert.equal(changes.length, 0);
  assert.equal(skipped.length, 3);
  assert.match(skipped[0].reason, /blank/);
  assert.match(skipped[1].reason, /no sheet/);
  assert.match(skipped[2].reason, /no sheet/);
});
t('video_authorized line gets the percentage, bonuses section handled too', () => {
  const { changes } = A.buildAchievedUpdates({
    plans: [plan({
      incentives: [line({ id: 'v', wbOption: 'video_authorized', text: 'Video Authorized', targetValue: '95' })],
      bonuses: [line({ id: 'l3', wbOption: 'onboarding_l3', text: 'Onboarding L3+ creators', targetValue: '5' })],
    })], sheetsByBrand: sheets, month: '2026-10',
  });
  const v = changes.find((c) => c.lineId === 'v'), l3 = changes.find((c) => c.lineId === 'l3');
  assert.equal(v.after, 89.34); assert.equal(v.completedAfter, true); assert.equal(v.section, 'incentives');
  assert.equal(l3.after, 4); assert.equal(l3.section, 'bonuses');
});

// ── applyChangesToPlan ─────────────────────────────────────────────
t('applyChangesToPlan is immutable and touches only matching lines', () => {
  const p = plan({
    incentives: [line({ id: 'a', achievedValue: 5, completed: true, completedBy: 'Sara', extra: 1 }), line({ id: 'b', achievedValue: 1 })],
    bonuses: [line({ id: 'a', achievedValue: 9 })],   // same id, other section
  });
  const snapshot = JSON.stringify(p);
  const out = A.applyChangesToPlan(p, [{
    userId: 'u1', section: 'incentives', lineId: 'a', after: 32, completedAfter: false,
  }]);
  assert.equal(JSON.stringify(p), snapshot, 'input mutated');
  assert.notEqual(out.incentives, p.incentives);
  assert.equal(out.incentives[0].achievedValue, 32);
  assert.equal(out.incentives[0].completed, false);
  assert.equal(out.incentives[0].completedBy, null, 'cleared when no longer complete');
  assert.equal(out.incentives[0].extra, 1);
  assert.equal(out.incentives[0].text, p.incentives[0].text);
  assert.equal(out.incentives[1], p.incentives[1]);          // untouched line is the same object
  assert.equal(out.bonuses[0], p.bonuses[0]);                // other section untouched
});
t('applyChangesToPlan keeps completedBy while still complete; ignores other users', () => {
  const p = plan({ incentives: [line({ id: 'a', completed: true, completedBy: 'Sara' })] });
  const out = A.applyChangesToPlan(p, [
    { userId: 'u1', section: 'incentives', lineId: 'a', after: 40, completedAfter: true },
    { userId: 'other', section: 'incentives', lineId: 'a', after: 1, completedAfter: false },
  ]);
  assert.equal(out.incentives[0].achievedValue, 40);
  assert.equal(out.incentives[0].completed, true);
  assert.equal(out.incentives[0].completedBy, 'Sara');
  assert.deepEqual(A.applyChangesToPlan(p, []).incentives, p.incentives);
});

// ── parity with the real autoComplete ──────────────────────────────
// incentivesApi.js imports supabase and cannot load in plain node, so compare
// against its source text instead of a copy that could rot.
t('autoCompleteLike matches incentivesApi.autoComplete source', () => {
  const src = fs.readFileSync(new URL('../src/lib/incentivesApi.js', import.meta.url), 'utf8');
  const m = src.match(/export function autoComplete\(item\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'autoComplete not found in incentivesApi.js');
  const real = new Function(`${m[0].replace('export ', '')}; return autoComplete;`)();
  const cases = [
    { targetValue: '40', achievedValue: 36 }, { targetValue: '40', achievedValue: 35.9 },
    { targetValue: 0, achievedValue: 5, completed: true }, { targetValue: '', achievedValue: 5, completed: false },
    { targetValue: '95', achievedValue: 89.34 }, { targetValue: '-3', achievedValue: 1, completed: true },
    { targetValue: '10', achievedValue: null }, { targetValue: 'x', achievedValue: 1, completed: true },
  ];
  for (const c of cases) assert.equal(A.autoCompleteLike(c), real(c), JSON.stringify(c));
});

// ── the real workbook (optional) ───────────────────────────────────
const candidates = [process.argv[2], process.env.WORKBOOK, path.join(os.homedir(), 'Downloads', 'All Brands Data (1).xlsx')].filter(Boolean);
const file = candidates.find((f) => fs.existsSync(f));
if (!file) {
  console.log('  SKIP  real-workbook checks (fixture not found)'); skip++;
} else {
  const XLSX = createRequire(import.meta.url)('xlsx');
  const wb = XLSX.read(fs.readFileSync(file));
  const sheet = (n) => W.readBrandSheet(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null, blankrows: false }));
  t('JoyMode Oct 2026 video_authorized = 377/422 = 89.34', () => {
    assert.deepEqual(A.getAchieved(sheet('JoyMode'), 'video_authorized', '2026-10'),
      { value: 89.34, unit: 'percent', detail: '377 of 422 videos authorized' });
  });
  t('JoyMode Oct 2026 other options', () => {
    const s = sheet('JoyMode');
    assert.equal(A.getAchieved(s, 'creators_3plus', '2026-10').value, 36);
    assert.equal(A.getAchieved(s, 'videos_100_gmv', '2026-10').value, 40);
    assert.equal(A.getAchieved(s, 'onboarding_l3', '2026-10').value, 2);
    assert.equal(A.getAchieved(s, 'gmv_max', '2026-10').value, 22915.69);
  });
  t('Aurelia has no Oct achieved yet, Sep = 202/207', () => {
    const s = sheet('Aurelia');
    assert.match(A.getAchieved(s, 'creators_3plus', '2026-10').unavailable, /no achieved column/);
    assert.equal(A.getAchieved(s, 'video_authorized', '2026-09').detail, '202 of 207 videos authorized');
  });
  t('Longevity Box (ends on achieved): Sep = 375/389, Oct unavailable', () => {
    const s = sheet('Longevity Box');
    assert.equal(A.getAchieved(s, 'video_authorized', '2026-09').value, 96.4);
    assert.equal(A.getAchieved(s, 'creators_3plus', '2026-09').value, 26);
    assert.ok(A.getAchieved(s, 'creators_3plus', '2026-10').unavailable);
    assert.match(A.getAchieved(s, 'onboarding_l3', '2026-09').unavailable, /No Euka/);
  });
  t('Cutler Oct 2026 = 4488/4851; blank GMV Max refuses', () => {
    const s = sheet('Cutler Nutritions');
    assert.equal(A.getAchieved(s, 'video_authorized', '2026-10').value, 92.52);
    assert.match(A.getAchieved(s, 'gmv_max', '2026-10').unavailable, /blank/);
  });
  t('year-less Nov/Dec sheets (Nourished) refuse rather than read last year', () => {
    assert.match(A.getAchieved(sheet('Nourished Natural Health'), 'video_authorized', '2026-10').unavailable, /year/);
  });
  t('no tab ever returns video_authorized above 100 or below 0', () => {
    for (const n of wb.SheetNames) {
      const s = sheet(n);
      for (const k of Object.keys(s.targets || {})) {
        const r = A.getAchieved(s, 'video_authorized', k);
        if (r.value !== undefined) assert.ok(r.value >= 0 && r.value <= 100, `${n} ${k} ${r.value}`);
      }
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
