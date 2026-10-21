// ============================================================
// Rename the brand sheets in the incentive workbook to the brand names WurxOS
// actually stores, so nothing downstream has to fuzzy-match a name.
//
//   node scripts/rename-workbook-sheets.mjs "C:\path\All Brands Data.xlsx"
//   node scripts/rename-workbook-sheets.mjs "C:\path\All Brands Data.xlsx" --apply
//
// Dry run by default: prints every sheet and what it would become, and changes
// nothing. --apply writes a NEW workbook beside the original ("… (app names).xlsx")
// and never touches the file you pass in.
//
// Matching is deliberately conservative, because a sheet renamed onto the wrong
// brand would feed the wrong brand's figures into someone's pay:
//   * canonical match (case / spaces / punctuation ignored) -> rename
//   * an explicit alias from the table below                -> rename
//   * anything else                                         -> LEFT ALONE
//   * two sheets claiming one brand, or one sheet matching two brands -> refused
// The workbook holds ~87 sheets and the agency runs ~20 brands, so most sheets
// are expected to be left alone. That is not a failure.
//
// Brand names come from production, never from a list typed in here.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const XLSX = require('xlsx');

const REF = 'xoaaidgvblondjpvxjqp';
const file = process.argv.find((a) => /\.xlsx?$/i.test(a));
const apply = process.argv.includes('--apply');
if (!file) { console.error('usage: node scripts/rename-workbook-sheets.mjs <workbook.xlsx> [--apply]'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('No such file: ' + file); process.exit(1); }

// ── Aliases: sheet name -> the WurxOS brand it means. ONLY for pairs that
// canonical matching cannot see. Each one is a human judgement; add here rather
// than loosening the matcher, so every assumption stays visible and reviewable.
const ALIASES = {
  'cutler': 'Cutler Nutritions',
  'pdc': 'Pure Daily Care',
  'biostime': 'Biostime Shop US',
  // "Apothecary brands" is the LIVE sheet (ends Oct 2026, carries all five
  // incentive rows). The sheet literally named "Apothecary" is a leftover that
  // stops at March and still uses the old Authorized Videos / Total GMV labels.
  // Canonical matching would have handed the brand to the stale one purely
  // because its name matched exactly — see SUPERSEDED.
  'apothecarybrands': 'Apothecary',
};

// Sheets that must be moved out of the way BEFORE the renames above, because
// they hold the name a live sheet needs. Renamed, never deleted: the history is
// still someone's record even though nothing should read it.
const SUPERSEDED = {
  'Apothecary': 'Apothecary (old, to Mar)',
};

const canon = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function liveBrands() {
  const envFile = path.join(ROOT, '.env.production');
  if (!fs.existsSync(envFile)) throw new Error('Missing .env.production with SUPABASE_ACCESS_TOKEN');
  const token = (fs.readFileSync(envFile, 'utf8').match(/SUPABASE_ACCESS_TOKEN=(.+)/) || [])[1];
  if (!token) throw new Error('No SUPABASE_ACCESS_TOKEN in .env.production');
  const res = await fetch('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: "select brand_name, status from public.brands order by brand_name" }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + text.slice(0, 300));
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : (j.result ?? j.rows ?? []);
}

let brands;
try {
  brands = await liveBrands();
} catch (e) {
  console.error('Could not read the brand list from production: ' + e.message);
  console.error('\nIf the Supabase token has been revoked, re-add a fresh one to .env.production,');
  console.error('or run this query and save the result as brands.json next to the workbook:');
  console.error('  select brand_name, status from public.brands order by brand_name;');
  process.exit(1);
}
const active = brands.filter((b) => b.status === 'active');
console.log(`Live brands: ${brands.length} total, ${active.length} active.\n`);

// Index every brand (active first, so an active brand wins a canonical tie).
const byCanon = new Map();
for (const b of [...active, ...brands.filter((b) => b.status !== 'active')]) {
  const k = canon(b.brand_name);
  if (!byCanon.has(k)) byCanon.set(k, b);
}

const wb = XLSX.readFile(file, { cellStyles: true, bookVBA: true });
const plan = [];
for (const sheet of wb.SheetNames) {
  if (SUPERSEDED[sheet]) { plan.push({ sheet, to: SUPERSEDED[sheet], how: 'superseded', status: 'archive' }); continue; }
  const k = canon(sheet);
  let brand = byCanon.get(k) || null;
  let how = brand ? 'canonical' : null;
  if (!brand && ALIASES[k]) {
    brand = brands.find((b) => canon(b.brand_name) === canon(ALIASES[k])) || null;
    how = brand ? 'alias' : null;
    if (!brand) plan.push({ sheet, to: null, note: `alias points at "${ALIASES[k]}" which is not a brand` });
  }
  if (!brand) { plan.push({ sheet, to: null, note: how === null && ALIASES[k] ? 'alias unresolved' : 'no WurxOS brand — left alone' }); continue; }
  plan.push({ sheet, to: brand.brand_name, status: brand.status, how });
}

// Refuse collisions rather than silently dropping one sheet onto another.
const targets = new Map();
for (const p of plan) {
  if (!p.to) continue;
  if (!targets.has(p.to)) targets.set(p.to, []);
  targets.get(p.to).push(p.sheet);
}
const collisions = [...targets.entries()].filter(([, s]) => s.length > 1);

const renames = plan.filter((p) => p.to && p.to !== p.sheet && !collisions.some(([t]) => t === p.to));
const already = plan.filter((p) => p.to && p.to === p.sheet);
const untouched = plan.filter((p) => !p.to);

console.log('=== WOULD RENAME (' + renames.length + ') ===');
for (const p of renames) console.log(`  ${JSON.stringify(p.sheet).padEnd(26)} -> ${JSON.stringify(p.to)}  [${p.how}${p.status !== 'active' ? ', ' + p.status : ''}]`);
console.log('\n=== ALREADY CORRECT (' + already.length + ') ===');
console.log('  ' + already.map((p) => p.sheet).join(' | '));
if (collisions.length) {
  console.log('\n=== REFUSED — two sheets claim one brand (' + collisions.length + ') ===');
  for (const [t, s] of collisions) console.log(`  "${t}" <- ${s.map((x) => JSON.stringify(x)).join(' AND ')}   (decide which is authoritative)`);
}
console.log('\n=== LEFT ALONE (' + untouched.length + ' sheets with no WurxOS brand) ===');
const missing = active.filter((b) => !plan.some((p) => p.to === b.brand_name));
if (missing.length) {
  console.log('\n=== ACTIVE BRANDS WITH NO SHEET (' + missing.length + ') ===');
  for (const b of missing) console.log('  ' + b.brand_name);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to produce the renamed copy.');
  process.exit(0);
}
if (collisions.length) {
  console.error('\nRefusing to write while ' + collisions.length + ' collision(s) are unresolved.');
  process.exit(1);
}

// Emit the plan; the rename itself is done by the .ps1, which patches only
// xl/workbook.xml inside the zip.
//
// This script deliberately does NOT write the workbook. Rewriting it through
// SheetJS re-emits every worksheet: on this file that shifted each sheet's
// range (B4:AR37 -> A4:BG37, gaining a leading empty column) and would drop the
// comments, drawings, tables and threaded comments the workbook carries. Sheet
// names live only in xl/workbook.xml, and this workbook has no defined names
// and no cross-sheet formula references, so that one part is all that changes.
const planFile = path.join(path.dirname(file), 'sheet-rename-plan.json');
fs.writeFileSync(planFile, JSON.stringify(renames.map((p) => ({ from: p.sheet, to: p.to })), null, 2), 'utf8');
console.log(`\nWrote the plan (${renames.length} rename(s)) to:\n  ${planFile}`);
console.log('\nApply it with:');
console.log(`  powershell -ExecutionPolicy Bypass -File scripts\\rename-workbook-sheets.ps1 \\`);
console.log(`    -Workbook "${file}" -Plan "${planFile}"`);
