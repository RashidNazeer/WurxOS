// ============================================================
// Tests for src/lib/incentiveWorkbook.js — the brand incentive workbook reader.
//
//   node scripts/incentive-workbook-tests.mjs
//
// No network, no spreadsheet file: the fixtures are the real header rows copied
// out of the workbook, because the header row is where every risk lives. If a
// month ever resolves to the wrong column these fail, and a wrong column here
// is a wrong number in somebody's pay.
// ============================================================
import assert from 'node:assert/strict';

// Resolved relative to this file, so the suite runs on any machine.
const M = await import(new URL('../src/lib/incentiveWorkbook.js', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};

// ── cell parsing ───────────────────────────────────────────────────
t('reads plain numbers and spreadsheet formatting', () => {
  assert.equal(M.parseCell(160).value, 160);
  assert.equal(M.parseCell('250000').value, 250000);
  assert.equal(M.parseCell('$3500').value, 3500);
  assert.equal(M.parseCell('1,250').value, 1250);
  assert.equal(M.parseCell(0.95).value, 0.95);
});
t('REFUSES abbreviated figures rather than inventing precision', () => {
  // These are real cells from the Cutler and Bentgo GMV rows.
  for (const bad of ['1.9M', '1.821M', '$1.296M', '1.7 Million', '1.65 mil', '1.5 Mill']) {
    const r = M.parseCell(bad);
    assert.ok(r.error, `${bad} should be refused, got ${JSON.stringify(r)}`);
  }
});
t('blank is empty, garbage is an error', () => {
  assert.equal(M.parseCell('').empty, true);
  assert.equal(M.parseCell(null).empty, true);
  assert.ok(M.parseCell('n/a').error);
});

// ── the three real header shapes ───────────────────────────────────
// Bentgo: targets are bare month names, achieved are date ranges.
const BENTGO = ['Bentgo', 'July 1 to 29', 'Aug 1-31', 'Column 4', 'Sep 1-29', 'October', 'Oct 1-30',
  'November', 'NoV 1-30', 'December', 'Dec 1-31', 'January ', 'Jan 1 - 31', 'Feb', 'Feb 1 - 25',
  'March ', 'March 1 - 31', 'April', 'April 1 - 29', 'May', 'May 1-31', 'June 26', 'June 1-30',
  'July', 'July 1-31', 'Aug 26', 'Aug 1-31 2', 'Sep 26', 'Sep 1-30', 'Oct 26'];

// Aurelia: ACHIEVED columns labelled with bare month names ("April", "August"),
// which look exactly like targets. This is why columns are read by position.
const AURELIA = ['Aurelia', 'Column 1', 'Oct 1-30', 'Column 3', 'March', 'April 26', 'April',
  'May 26', 'May 1-31', 'June 26', 'June 1-30', 'July 26 ', 'July 1-31', 'Aug 26', 'August',
  'Sep 26', 'Sep 1-30', 'Oct 26'];

// Cutler: spans two years with ad-hoc disambiguators ("November  2", "January  2",
// "December 2025") and an early stretch with no targets at all.
const CUTLER = ['Cutler', 'November ', 'December ', 'January ', 'February (1-25)', 'March (1-28)',
  'Column 1', 'April (1-30)', 'May', 'May 1-30', 'June', 'June  1-29', 'July', 'Jul 1-30', 'Aug',
  'Aug 1-30', 'Sep ', 'Sep 1-29', 'October', 'Oct 1-30', 'November  2', 'Nov 1-30', 'December 2025',
  'Dec 1-31', 'January  2', 'jan1-31', 'Feb', 'Feb 1-28', 'March', 'March 1-31', 'April 26',
  'April 1-30', 'May 26', 'May 1-31', 'June 26', 'june 1-30', 'July 26', 'July 1-31', 'Aug 26',
  'Aug 1-31', 'Sep 26', 'Sep 1-30', 'Oct 26'];

t('Bentgo: anchors on Oct 26 and steps left in twos', () => {
  const { targets } = M.resolveTargetColumns(BENTGO);
  assert.equal(targets['2026-10'], 29);
  assert.equal(targets['2026-09'], 27);
  assert.equal(targets['2026-08'], 25);
  assert.equal(targets['2026-07'], 23);   // "July", a bare name
  assert.equal(targets['2025-12'], 9);    // year carried back across January
  assert.equal(targets['2025-10'], 5);
});
t('Aurelia: a bare-month ACHIEVED column is never taken as a target', () => {
  const { targets } = M.resolveTargetColumns(AURELIA);
  assert.equal(targets['2026-10'], 17);
  assert.equal(targets['2026-09'], 15);
  assert.equal(targets['2026-08'], 13);   // "Aug 26" -- NOT col 14 "August"
  assert.ok(!Object.values(targets).includes(14), '"August" (achieved) must not be a target column');
  assert.ok(!Object.values(targets).includes(6), '"April" (achieved) must not be a target column');
});
t('Cutler: explicit years re-anchor the walk across two years', () => {
  const { targets } = M.resolveTargetColumns(CUTLER);
  assert.equal(targets['2026-10'], 42);
  assert.equal(targets['2026-04'], 30);   // "April 26"
  assert.equal(targets['2026-01'], 24);   // "January  2" -- the 2 is NOT a year
  assert.equal(targets['2025-12'], 22);   // "December 2025"
  assert.equal(targets['2025-11'], 20);   // "November  2"
  assert.equal(targets['2025-10'], 18);   // "October"
});
t('placeholders and month mismatches are refused, not guessed', () => {
  const b = M.resolveTargetColumns(BENTGO);
  assert.ok(b.issues.some((i) => /placeholder/.test(i.reason)), 'Column 4 refused');
  // "July 1 to 29" sits where August's target should be. It is refused as a day
  // range (the more precise reason) rather than as a month mismatch; either way
  // it must never be read as a target.
  assert.ok(b.issues.some((i) => /day range sits where/.test(i.reason) || /expected august/.test(i.reason)),
    'a column holding an achieved figure where a target belongs is refused');
  assert.ok(!Object.values(b.targets).includes(1), '"July 1 to 29" is never a target column');
  const a = M.resolveTargetColumns(AURELIA);
  assert.equal(a.issues.filter((i) => /placeholder/.test(i.reason)).length, 2);
});
// Longevity Box and Dr Tobias both END on the achieved half of September.
// Anchoring there would offset the whole walk by one and every "target" read
// would in fact be an achieved figure.
const LONGEVITY = ['Longevity Box', 'Feb 1-28', 'March', 'Mar 1-31', 'April 26', 'April 1-30',
  'May 26', 'May 1-31', 'June ', 'June 1-30', 'July 26 ', 'July 1-31', 'AUG', 'Aug 1-31',
  'Sep 26', 'Sep 1-30'];
const TOBIAS = ['Dr. Tobias', 'Aug 1-31', 'Sep 26', 'Sep 1-30'];

t('a sheet ending on an ACHIEVED column anchors on the target to its left', () => {
  const l = M.resolveTargetColumns(LONGEVITY);
  assert.equal(l.targets['2026-09'], 14, '"Sep 26" is the target, not "Sep 1-30"');
  assert.equal(l.targets['2026-08'], 12);   // "AUG"
  assert.ok(!Object.values(l.targets).includes(15), 'the achieved column is never a target');

  const d = M.resolveTargetColumns(TOBIAS);
  assert.equal(d.targets['2026-09'], 2);
  assert.ok(!Object.values(d.targets).includes(3));
});

t('a day number is never read as a year', () => {
  // "Sep 1-30" would give 2030, "Feb 1-28" 2028, "February (1-25)" 2025.
  for (const h of [LONGEVITY, TOBIAS]) {
    for (const key of Object.keys(M.resolveTargetColumns(h).targets)) {
      const year = Number(key.slice(0, 4));
      assert.ok(year >= 2024 && year <= 2027, `implausible year ${key} — a day was read as a year`);
    }
  }
  assert.ok(M.looksAchieved('Sep 1-30'));
  assert.ok(M.looksAchieved('July 1 to 29'));
  assert.ok(M.looksAchieved('Feb 1 - 25'));
  assert.ok(!M.looksAchieved('Sep 26'));
  assert.ok(!M.looksAchieved('December 2025'));
  assert.ok(!M.looksAchieved('January  2'));
});

t('no two months ever share a column', () => {
  for (const h of [BENTGO, AURELIA, CUTLER, LONGEVITY, TOBIAS]) {
    const cols = Object.values(M.resolveTargetColumns(h).targets);
    assert.equal(new Set(cols).size, cols.length, 'duplicate column across months');
  }
});

// ── end to end on a small grid ─────────────────────────────────────
const GRID = [
  [],
  AURELIA,
  ['Total Videos Made', '', '43', '', '115', '', '397', '', '396', '', '414', '', '357', '', '248', '', '207', ''],
  ['Video Authorized ', '', '0', '0.2', '0', '0.1', '0', '0.1', '332', '0.85', '380', '0.95', '325', '0.95', '235', '0.95', '202', '0.95'],
  ['Creators with more than three video', '', '6', '10', '6', '8', '14', '20', '21', '28', '21', '28', '36', '45', '12', '20', '3', '10'],
  ['Total GMV from GMV Max', '', '5189.5', '', '2461.63', '5000', '0', '5000', '777.51', '2000', '1175.25', '2000', '2299.43', '5000', '3492.9', '2500', '2077.32', '$3500'],
  ['Affiliate GMV ', '', '1787', '3500', '0', '', '0', '', '714.47', '', '1087.13', '', '2046', '', '2820.44', '', '1584.35', ''],
];

t('reads the right target for the right option and month', () => {
  const s = M.readBrandSheet(GRID);
  assert.ok(s.ok);
  assert.equal(M.getTarget(s, 'creators_3plus', '2026-10').value, 10);
  assert.equal(M.getTarget(s, 'creators_3plus', '2026-09').value, 20);
  assert.equal(M.getTarget(s, 'video_authorized', '2026-10').value, 0.95);
  assert.equal(M.getTarget(s, 'gmv_max', '2026-10').value, 3500);     // "$3500"
  assert.equal(M.getTarget(s, 'gmv_max', '2026-09').value, 2500);
});
t('Affiliate GMV is not an option at all', () => {
  assert.ok(!M.INCENTIVE_OPTIONS.some((o) => o.rowAliases.includes('affiliate gmv')));
  assert.ok(!M.INCENTIVE_OPTIONS.some((o) => o.rowAliases.includes('total gmv')),
    'bare "Total GMV" must not alias the GMV Max row');
});
t('a missing option row says so instead of returning a number', () => {
  const s = M.readBrandSheet(GRID);
  const r = M.getTarget(s, 'onboarding_l3', '2026-10');
  assert.ok(r.unavailable && /no "Onboarding L3\+ creators" row/.test(r.unavailable), r.unavailable);
});
t('a month the sheet cannot answer is unavailable, not a neighbour', () => {
  const s = M.readBrandSheet(GRID);
  const r = M.getTarget(s, 'creators_3plus', '2026-03');  // behind "Column 3"
  assert.ok(r.unavailable, 'should refuse');
  assert.equal(r.value, undefined);
});
t('the five options split 3 incentives / 2 bonuses', () => {
  assert.equal(M.INCENTIVE_OPTIONS.filter((o) => o.section === 'incentives').length, 3);
  assert.equal(M.INCENTIVE_OPTIONS.filter((o) => o.section === 'bonuses').length, 2);
  assert.equal(M.MAX_SELECTIONS_PER_APC, 5);
});

// ── turning ticked options into plan lines ─────────────────────────
const SHEET = M.readBrandSheet(GRID);
const BRANDS = [{ id: 'b1', name: 'Aurelia' }];
const sheetsByBrand = { b1: SHEET };
let seq = 0;
const newId = () => `id${++seq}`;
const build = (picked, existing = new Map(), month = '2026-10') => {
  seq = 0;
  return M.buildSelectionChanges({ picked: new Set(picked), brands: BRANDS, sheetsByBrand, month, existing, newId });
};

t('a ticked option becomes a line with the sheet target', () => {
  const r = build(['b1::creators_3plus']);
  assert.equal(r.add.incentives.length, 1);
  const line = r.add.incentives[0];
  assert.equal(line.text, 'Creators with more than three videos');
  assert.equal(line.targetValue, '10');
  assert.equal(line.brandId, 'b1');
  assert.equal(line.wbOption, 'creators_3plus');
  assert.equal(line.amount, '', 'the PKR amount stays for the OL to type');
});
t('a ratio target is stored as a percentage, not 0.95', () => {
  const line = build(['b1::video_authorized']).add.incentives[0];
  assert.equal(line.targetValue, '95', 'stored as 95 so autoComplete cannot pay at 86%');
  assert.equal(line.suffix, '%');
});
t('options land in the right section, and GMV Max keeps its auto source', () => {
  const r = build(['b1::creators_3plus', 'b1::gmv_max']);
  assert.equal(r.add.incentives.length, 1);
  assert.equal(r.add.bonuses.length, 1);
  assert.equal(r.add.bonuses[0].wbOption, 'gmv_max');
  assert.equal(r.add.bonuses[0].source, 'gmv_max', 'achieved keeps coming from mig 317');
  assert.ok(!('source' in r.add.incentives[0]), 'the other options stay manual');
});
t('an option with no target this month is NEVER added as a blank line', () => {
  const r = build(['b1::onboarding_l3']);     // this grid has no such row
  assert.equal(r.add.incentives.length + r.add.bonuses.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].kept, false);
});
t('an EXISTING line whose target is unavailable keeps its old value', () => {
  // The regression that matters: a line carried from last month arrives already
  // ticked, so it reaches the builder even when this month has no column.
  // Writing '' here would wipe a figure nobody asked to change.
  const existing = new Map([['b1::onboarding_l3', 'old-1']]);
  const r = build(['b1::onboarding_l3'], existing);
  const patch = r.updates.get('old-1');
  assert.ok(patch, 'the existing line is still updated');
  assert.ok(!('targetValue' in patch), 'targetValue must NOT be overwritten with a blank');
  assert.equal(patch.wbOption, 'onboarding_l3', 'the marker is stamped so mig 422 counts it');
  assert.equal(r.skipped[0].kept, true);
});
t('an existing line IS updated when the sheet answers', () => {
  const existing = new Map([['b1::creators_3plus', 'old-2']]);
  const r = build(['b1::creators_3plus'], existing);
  assert.deepEqual(r.updates.get('old-2'), { targetValue: '10', wbOption: 'creators_3plus' });
  assert.equal(r.add.incentives.length, 0, 'no duplicate line');
});
t('unticking an option removes the line it created', () => {
  const existing = new Map([['b1::creators_3plus', 'old-3'], ['b1::gmv_max', 'old-4']]);
  const r = build(['b1::gmv_max'], existing);
  assert.deepEqual([...r.removed], ['old-3']);
  assert.ok(r.updates.has('old-4'));
});
t('a brand or option that no longer exists is ignored, not crashed on', () => {
  const r = build(['nope::creators_3plus', 'b1::not_an_option']);
  assert.equal(r.add.incentives.length + r.add.bonuses.length, 0);
  assert.equal(r.removed.size, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
