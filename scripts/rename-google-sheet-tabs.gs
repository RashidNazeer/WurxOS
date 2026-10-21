/**
 * Rename the brand tabs in the incentive Google Sheet to the names WurxOS
 * stores, so nothing downstream has to fuzzy-match a brand name.
 *
 * HOW TO RUN
 *   1. Open the spreadsheet -> Extensions -> Apps Script
 *   2. Paste this file over Code.gs and Save
 *   3. Run `planRenames` first. It changes NOTHING and prints the plan to the
 *      Execution log (View -> Logs). Google will ask you to authorise it; it
 *      then runs as you, with your access.
 *   4. Read the plan. If it is right, set DRY_RUN to false and run `planRenames`
 *      again to apply.
 *
 * DUPLICATES. Where two tabs claim one brand, the one with the LATEST DATA
 * wins and the loser is renamed "<brand> (old)" -- renamed, never deleted.
 * "Latest" is decided by how many of the five incentive rows a tab carries and
 * then by the most recent month named in its header row. In the .xlsx version
 * of this workbook that is what separated the live "Apothecary brands" tab
 * (through Oct 2026, all five rows) from a leftover "Apothecary" tab that
 * stopped at March and still used the old Authorized Videos / Total GMV
 * labels. Column count is NOT used: the stale tab had more columns.
 *
 * Anything that matches no WurxOS brand is left alone. ~53 such tabs are
 * expected -- the workbook covers far more brands than the agency runs.
 */

var SPREADSHEET_ID = '1fXwCJ15GmX0KWRRUwVXegynAVgkO3c_NLU_upTUpZ5E';
var DRY_RUN = true;   // set to false to actually rename

/** Active WurxOS brands, read from production on 2026-10-21. */
var BRANDS = [
  'Apothecary', 'Aqua Sonic', 'Aurelia', 'Bentgo', 'Biostime Shop US',
  'Cutler Nutritions', 'Dr Tobias', "Dr. Harvey's", 'Honeysticks', 'Inno Supps',
  'Irwin Naturals', 'JoyMode', 'Kenashii', 'Klassy Network', 'Longevity Box',
  'Mineral Ice Extreme', 'Penetrex', 'Pure Daily Care', 'Swisse', 'YesDay'
];

/** Tab name -> brand, only for pairs canonical matching cannot see. */
var ALIASES = {
  'cutler': 'Cutler Nutritions',
  'pdc': 'Pure Daily Care',
  'biostime': 'Biostime Shop US',
  'apothecarybrands': 'Apothecary'
};

/** The five incentive rows. Presence of these is the freshness signal. */
var OPTION_ROWS = [
  'video authorized', 'authorized videos',
  'creators with more than three video', 'creators with more than three videos',
  'videos with $100+ gmv',
  'onboarding l3+ creators',
  'total gmv from gmv max'
];

var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
              'july', 'august', 'september', 'october', 'november', 'december'];

function canon_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
function norm_(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Month index from a header label like "Oct 26", "Sep 1-30", "jan1-31". */
function monthIndex_(label) {
  var s = norm_(label);
  for (var i = 0; i < MONTHS.length; i++) {
    var full = MONTHS[i], abbr = full.slice(0, 3);
    if (s.indexOf(full) === 0 || s.indexOf(abbr) === 0) return i;
  }
  return -1;
}

/**
 * Score a tab for freshness: [number of the five option rows, latest month seen].
 * Reads a small window only, so this stays fast across ~90 tabs.
 */
function freshness_(sheet) {
  var lastRow = Math.min(sheet.getLastRow(), 20);
  var lastCol = Math.min(sheet.getLastColumn(), 60);
  if (lastRow < 2 || lastCol < 2) return { opts: 0, month: -1, year: -1 };
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  var opts = 0, seen = {};
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < Math.min(values[r].length, 3); c++) {
      var label = norm_(values[r][c]);
      if (label && OPTION_ROWS.indexOf(label) >= 0 && !seen[label]) { seen[label] = true; opts++; }
    }
  }
  // Latest month named anywhere in the first rows, with a "26"/"2026" hint.
  var month = -1, year = -1;
  for (var r2 = 0; r2 < Math.min(values.length, 6); r2++) {
    for (var c2 = 0; c2 < values[r2].length; c2++) {
      var cell = norm_(values[r2][c2]);
      if (!cell) continue;
      var mi = monthIndex_(cell);
      if (mi < 0) continue;
      var y = /20\d\d/.test(cell) ? Number(cell.match(/20\d\d/)[0])
            : /\b26\b/.test(cell) ? 2026
            : /\b25\b/.test(cell) ? 2025 : -1;
      if (y > year || (y === year && mi > month)) { year = y; month = mi; }
    }
  }
  return { opts: opts, month: month, year: year };
}

function fresher_(a, b) {
  if (a.opts !== b.opts) return a.opts > b.opts;
  if (a.year !== b.year) return a.year > b.year;
  return a.month > b.month;
}

function planRenames() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheets = ss.getSheets();
  var byCanon = {};
  for (var i = 0; i < BRANDS.length; i++) byCanon[canon_(BRANDS[i])] = BRANDS[i];

  // 1. which tabs claim which brand
  var claims = {};   // brand -> [{ sheet, name, how }]
  var untouched = [];
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s], name = sh.getName(), k = canon_(name);
    var brand = byCanon[k] || (ALIASES[k] ? ALIASES[k] : null);
    if (!brand) { untouched.push(name); continue; }
    if (!claims[brand]) claims[brand] = [];
    claims[brand].push({ sheet: sh, name: name, how: byCanon[k] ? 'canonical' : 'alias' });
  }

  // 2. resolve duplicates on freshness
  var plan = [];
  Object.keys(claims).forEach(function (brand) {
    var list = claims[brand];
    if (list.length === 1) {
      if (list[0].name !== brand) plan.push({ from: list[0].name, to: brand, why: list[0].how });
      return;
    }
    var best = null;
    list.forEach(function (c) {
      c.fresh = freshness_(c.sheet);
      if (!best || fresher_(c.fresh, best.fresh)) best = c;
    });
    list.forEach(function (c) {
      var tag = '[opts ' + c.fresh.opts + ', latest ' +
        (c.fresh.month >= 0 ? MONTHS[c.fresh.month] + ' ' + (c.fresh.year > 0 ? c.fresh.year : '?') : 'none') + ']';
      if (c === best) {
        if (c.name !== brand) plan.push({ from: c.name, to: brand, why: 'freshest ' + tag });
      } else {
        plan.push({ from: c.name, to: brand + ' (old)', why: 'superseded ' + tag });
      }
    });
  });

  // 3. superseded tabs move first, so a live tab can take the name they hold
  plan.sort(function (a, b) {
    return (a.why.indexOf('superseded') === 0 ? -1 : 0) - (b.why.indexOf('superseded') === 0 ? -1 : 0);
  });

  Logger.log('Tabs: ' + sheets.length + '   renames planned: ' + plan.length +
             '   left alone: ' + untouched.length);
  Logger.log('--- PLAN ---');
  plan.forEach(function (p) { Logger.log('  "' + p.from + '"  ->  "' + p.to + '"   (' + p.why + ')'); });

  var missing = BRANDS.filter(function (b) { return !claims[b]; });
  if (missing.length) Logger.log('--- ACTIVE BRANDS WITH NO TAB (' + missing.length + ') ---\n  ' + missing.join('\n  '));

  if (DRY_RUN) { Logger.log('\nDRY RUN - nothing changed. Set DRY_RUN = false and run again to apply.'); return; }

  var taken = {};
  sheets.forEach(function (sh) { taken[sh.getName()] = true; });
  var done = 0;
  for (var p = 0; p < plan.length; p++) {
    var item = plan[p];
    if (taken[item.to] && item.to !== item.from) {
      Logger.log('SKIPPED "' + item.from + '" -> "' + item.to + '": that name is still taken.');
      continue;
    }
    var sheet = ss.getSheetByName(item.from);
    if (!sheet) { Logger.log('SKIPPED "' + item.from + '": no such tab now.'); continue; }
    delete taken[item.from];
    sheet.setName(item.to);
    taken[item.to] = true;
    done++;
  }
  Logger.log('\nRenamed ' + done + ' tab(s).');
}
