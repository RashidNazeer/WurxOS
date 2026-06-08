// Audit v2 — focus on shared-token confusions in the sheet that
// COULD have collapsed onto one profile, plus a check of Ibrahim
// Baloch's currently-applied date.
import { sb } from './lib/supabase.js';

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRQ0VNEt6Nx9lseGhbDBpHKVYBMGoslpnEovCQoj-cfCm_NQjn0OpnavBMYUbCAoEW6WwIuqXn2kdkl/pub?gid=0&single=true&output=csv';

function normalize(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
    .filter(t => !['bin','ibn','mr','mrs','ms','dr'].includes(t));
}
function tokenSetRatio(a, b) {
  const sa = new Set(normalize(a)); const sb_ = new Set(normalize(b));
  if (!sa.size || !sb_.size) return 0;
  let inter = 0; for (const t of sa) if (sb_.has(t)) inter++;
  return inter / (sa.size + sb_.size - inter);
}
function parseMDY(s) {
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function parseCSV(text) {
  const rows = []; let cur = '', inQ = false, row = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c==='"'&&text[i+1]==='"'){cur+='"';i++;} else if(c==='"')inQ=false; else cur+=c; }
    else {
      if (c==='"') inQ=true;
      else if (c===',') { row.push(cur); cur=''; }
      else if (c==='\n'||c==='\r') {
        if (cur||row.length){row.push(cur);rows.push(row);}
        cur=''; row=[];
        if (c==='\r'&&text[i+1]==='\n')i++;
      } else cur+=c;
    }
  }
  if (cur||row.length){row.push(cur);rows.push(row);}
  return rows.map(r=>({name:(r[0]||'').trim(),date:parseMDY((r[1]||'').trim())})).filter(r=>r.name);
}

const sheet = parseCSV(await (await fetch(SHEET_URL)).text());

const { data: profiles } = await sb
  .from('profiles')
  .select('id, display_name, role, start_date, deleted_at, is_active')
  .is('deleted_at', null)
  .eq('is_active', true);

const profilesByStartDate = new Map();
const profilesById = new Map();
for (const p of profiles) {
  profilesById.set(p.id, p);
  if (p.start_date) {
    if (!profilesByStartDate.has(p.start_date)) profilesByStartDate.set(p.start_date, []);
    profilesByStartDate.get(p.start_date).push(p);
  }
}

console.log('═══════════ Confusion-risk audit ═══════════════════════════');

// Q1: Specifically check Ibrahim Baloch
const ibrahim = profiles.find(p => /ibrahim baloch/i.test(p.display_name || ''));
console.log('\n[Ibrahim Baloch check]');
if (!ibrahim) {
  console.log('  ✗ No Ibrahim Baloch profile found.');
} else {
  const sheetIbrahim = sheet.find(s => /muhammad ibrahim/i.test(s.name || ''));
  console.log(`  profile.start_date: ${ibrahim.start_date}`);
  console.log(`  sheet "MUHAMMAD IBRAHIM" date: ${sheetIbrahim?.date || '(not in sheet)'}`);
  if (sheetIbrahim && ibrahim.start_date === sheetIbrahim.date) {
    console.log(`  ✓ Date matches sheet entry for MUHAMMAD IBRAHIM.`);
  } else if (ibrahim.start_date) {
    console.log(`  ⚠ DB date differs from sheet date — confirm this was intentional.`);
  } else {
    console.log(`  ⚠ Ibrahim Baloch has NO start_date set.`);
  }
}

// Q2: Find every sheet name pair that shares >=1 token (could collide)
// and report which one(s) ended up on a profile, and whether anything
// was potentially absorbed.
console.log('\n[Sheet-side near-duplicates that COULD have been collapsed]');
const pairs = [];
for (let i = 0; i < sheet.length; i++) {
  for (let j = i + 1; j < sheet.length; j++) {
    const sim = tokenSetRatio(sheet[i].name, sheet[j].name);
    if (sim >= 0.33) pairs.push({ a: sheet[i], b: sheet[j], sim });
  }
}
pairs.sort((x, y) => y.sim - x.sim);
let flagged = 0;
for (const pair of pairs) {
  // Who, if anyone, currently has each sheet row's date applied?
  const applyA = profilesByStartDate.get(pair.a.date) || [];
  const applyB = profilesByStartDate.get(pair.b.date) || [];
  const aPlausibles = applyA.filter(p => tokenSetRatio(p.display_name, pair.a.name) >= 0.33);
  const bPlausibles = applyB.filter(p => tokenSetRatio(p.display_name, pair.b.name) >= 0.33);

  // Same profile absorbed BOTH dates (date-overwrite scenario — only the
  // latest stuck). Or one sheet row is unmatched. Either is worth a look.
  const sharedProfiles = aPlausibles.filter(p => bPlausibles.find(b2 => b2.id === p.id));
  if (sharedProfiles.length > 0) {
    console.log(`  ⚠ "${pair.a.name}" (${pair.a.date}) + "${pair.b.name}" (${pair.b.date})  sim=${pair.sim.toFixed(2)}`);
    console.log(`     both fuzzy-match the same profile(s): ${sharedProfiles.map(p => p.display_name).join(', ')}`);
    flagged++;
    continue;
  }
  // One side has a profile, the other doesn't — potentially the unused
  // side is a real distinct person not yet in our app.
  if ((aPlausibles.length === 0) !== (bPlausibles.length === 0)) {
    const used   = aPlausibles.length ? pair.a : pair.b;
    const unused = aPlausibles.length ? pair.b : pair.a;
    console.log(`  • "${used.name}" (${used.date}) is applied; "${unused.name}" (${unused.date}) is not`);
    console.log(`     sim=${pair.sim.toFixed(2)} — likely a DIFFERENT person, no action needed unless a duplicate profile exists`);
    flagged++;
  }
}
if (!flagged) console.log('  (none)');

// Q3: For every PROFILE that has start_date set, list which sheet rows
// fuzzy-match it >=0.5, so a human can eyeball mis-matches.
console.log('\n[Per-profile sheet candidates (>=0.5)]');
for (const p of profiles.filter(x => x.start_date)) {
  const cands = sheet
    .map(s => ({ s, score: tokenSetRatio(p.display_name, s.name) }))
    .filter(x => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (cands.length === 0) {
    console.log(`  ${p.display_name.padEnd(28)} DB=${p.start_date}  — no sheet match (manually set, OK)`);
    continue;
  }
  const using = cands.find(c => c.s.date === p.start_date);
  if (using) {
    const sym = cands.length > 1 ? '~' : '✓';
    const tail = cands.length > 1 ? ` (also similar: ${cands.filter(c => c !== using).map(c => `"${c.s.name}" ${c.s.date} ${c.score.toFixed(2)}`).join('; ')})` : '';
    console.log(`  ${sym} ${p.display_name.padEnd(28)} DB=${p.start_date}  ← "${using.s.name}" (${using.score.toFixed(2)})${tail}`);
  } else {
    console.log(`  ⚠ ${p.display_name.padEnd(28)} DB=${p.start_date}  but candidates are: ${cands.map(c => `"${c.s.name}" ${c.s.date} ${c.score.toFixed(2)}`).join('; ')}`);
  }
}
