// One-time import: hire dates from the published Google Sheet
// into profiles.start_date via the set_user_hire_date RPC.
//
// Sheet URL (no header row, columns are Name, Hiring Date in M/D/YYYY):
//   https://docs.google.com/spreadsheets/d/e/2PACX-1vRQ0VNEt6Nx9lseGhbDBpHKVYBMGoslpnEovCQoj-cfCm_NQjn0OpnavBMYUbCAoEW6WwIuqXn2kdkl/pub?gid=0&single=true&output=csv
//
// Run AFTER migration 185_salary_management.sql.
//
// Usage:
//   node migration/seed_hire_dates_from_sheet.mjs --dry-run
//     → prints all matches grouped by confidence, writes
//       migration/_hire_date_review.json with uncertain rows
//   node migration/seed_hire_dates_from_sheet.mjs --commit
//     → applies confidence ≥ 0.85 automatically; still writes the
//       review file for the rest
//   node migration/seed_hire_dates_from_sheet.mjs --apply-review
//     → reads migration/_hire_date_review.json (you've edited
//       it to mark { uid: "..." } on the rows you confirmed) and
//       applies just those
//
// Confidence: token-set ratio (intersection / union of normalized
// name tokens), so "Shumyle Bin Asim" vs "Shumyle Asim" = 0.67.
// Auto-import threshold is 0.85 by default; pass --threshold=0.x
// to override.

import { sb } from './lib/supabase.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRQ0VNEt6Nx9lseGhbDBpHKVYBMGoslpnEovCQoj-cfCm_NQjn0OpnavBMYUbCAoEW6WwIuqXn2kdkl/pub?gid=0&single=true&output=csv';
const REVIEW_FILE = 'migration/_hire_date_review.json';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const COMMIT = args.includes('--commit');
const APPLY_REVIEW = args.includes('--apply-review');
const thresholdArg = args.find(a => a.startsWith('--threshold='));
const THRESHOLD = thresholdArg ? Number(thresholdArg.split('=')[1]) : 0.85;

if (!DRY && !COMMIT && !APPLY_REVIEW) {
  console.log('Pass --dry-run | --commit | --apply-review');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────
function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    // Drop common honorifics / connectors that hurt matching.
    .filter(t => !['bin', 'ibn', 'mr', 'mrs', 'ms', 'dr'].includes(t));
}

function tokenSetRatio(a, b) {
  const sa = new Set(normalize(a));
  const sb_ = new Set(normalize(b));
  if (!sa.size || !sb_.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb_.has(t)) inter++;
  const union = sa.size + sb_.size - inter;
  return inter / union;
}

function parseMDYDate(str) {
  // Sheet format: M/D/YYYY (single-digit month/day, no padding)
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    return null;  // invalid (Feb 30 etc)
  }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseCSV(text) {
  // Sheet has NO header row and exactly 2 columns (per discovery agent).
  // Use a defensive parser that handles quoted fields.
  const rows = [];
  let cur = '';
  let inQuote = false;
  let row = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (cur || row.length) { row.push(cur); rows.push(row); }
        cur = ''; row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows
    .map(r => ({ name: (r[0] || '').trim(), date: (r[1] || '').trim() }))
    .filter(r => r.name);
}

// ── Main ──────────────────────────────────────────────────────
if (APPLY_REVIEW) {
  if (!existsSync(REVIEW_FILE)) {
    console.error(`No review file at ${REVIEW_FILE}. Run --dry-run or --commit first.`);
    process.exit(1);
  }
  const review = JSON.parse(readFileSync(REVIEW_FILE, 'utf8'));
  let applied = 0, skipped = 0, errors = 0;
  for (const r of review) {
    if (!r.uid) { skipped++; continue; }
    const { error } = await sb.rpc('set_user_hire_date', {
      p_uid: r.uid,
      p_hire_date: r.parsedDate,
    });
    if (error) { console.error(`  ✗ ${r.sheetName}:`, error.message); errors++; }
    else { console.log(`  ✓ ${r.sheetName} → ${r.parsedDate}`); applied++; }
  }
  console.log(`\nApplied: ${applied}  Skipped (no uid): ${skipped}  Errors: ${errors}`);
  process.exit(0);
}

console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}  Threshold: ${THRESHOLD}\n`);

// Fetch CSV.
const res = await fetch(SHEET_URL);
if (!res.ok) {
  console.error(`Fetch failed: ${res.status}`);
  process.exit(1);
}
const csv = await res.text();
const sheetRows = parseCSV(csv);
console.log(`Sheet rows: ${sheetRows.length}`);

// Load active profiles.
const { data: profiles, error: pErr } = await sb
  .from('profiles')
  .select('id, display_name, email, role, start_date, is_active, deleted_at')
  .is('deleted_at', null)
  .eq('is_active', true);
if (pErr) { console.error('profiles query failed:', pErr); process.exit(1); }

const auto = [];
const review = [];
const noMatch = [];

for (const row of sheetRows) {
  const parsedDate = parseMDYDate(row.date);
  if (!parsedDate) {
    review.push({ sheetName: row.name, sheetDate: row.date, parsedDate: null, candidates: [], uid: null, note: 'unparseable date' });
    continue;
  }

  // Score against every active profile.
  const scored = profiles.map(p => ({ p, score: tokenSetRatio(row.name, p.display_name || p.email) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];

  if (!best || best.score === 0) {
    noMatch.push({ sheetName: row.name, parsedDate });
    continue;
  }

  // Auto-import if best is strong AND clearly better than the runner-up.
  if (best.score >= THRESHOLD && (!second || best.score - second.score >= 0.15)) {
    auto.push({
      sheetName: row.name,
      parsedDate,
      uid: best.p.id,
      profileName: best.p.display_name,
      role: best.p.role,
      currentStart: best.p.start_date,
      score: best.score.toFixed(2),
    });
  } else {
    review.push({
      sheetName: row.name,
      sheetDate: row.date,
      parsedDate,
      candidates: scored.slice(0, 3).map(s => ({
        uid: s.p.id,
        name: s.p.display_name,
        role: s.p.role,
        currentStart: s.p.start_date,
        score: s.score.toFixed(2),
      })),
      uid: null,  // edit this file and set uid: "<candidate uid>" to apply, then run --apply-review
      note: best.score < THRESHOLD ? 'low confidence' : 'top two close',
    });
  }
}

console.log(`\nAUTO-MATCH (≥ ${THRESHOLD}):`);
for (const a of auto) {
  const existing = a.currentStart ? ` (current: ${a.currentStart})` : '';
  console.log(`  ${a.sheetName.padEnd(28)} → ${a.profileName.padEnd(28)}  ${a.parsedDate}  ${a.score}${existing}`);
}

if (noMatch.length) {
  console.log(`\nNO MATCH (in sheet but no candidate profile):`);
  for (const n of noMatch) console.log(`  ${n.sheetName.padEnd(28)} ${n.parsedDate}`);
}

console.log(`\nNEEDS REVIEW: ${review.length}`);
if (review.length) {
  console.log(`Review file written to ${REVIEW_FILE}.`);
  console.log(`Edit it, set "uid" on each row you want to apply, then run --apply-review.`);
  writeFileSync(REVIEW_FILE, JSON.stringify(review, null, 2));
}

console.log(`\nSummary — auto: ${auto.length}  review: ${review.length}  no match: ${noMatch.length}`);

if (COMMIT && auto.length) {
  console.log('\nApplying auto-matches…');
  let ok = 0, errors = 0;
  for (const a of auto) {
    const { error } = await sb.rpc('set_user_hire_date', {
      p_uid: a.uid,
      p_hire_date: a.parsedDate,
    });
    if (error) { console.error(`  ✗ ${a.profileName}:`, error.message); errors++; }
    else { ok++; }
  }
  console.log(`Applied: ${ok}  Errors: ${errors}`);
} else if (!COMMIT) {
  console.log('\n(dry-run — pass --commit to apply auto-matches)');
}
