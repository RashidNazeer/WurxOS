import { sb } from './lib/supabase.js';
import { writeFileSync } from 'node:fs';

// Set profiles.shift_start_time from each user's most-frequent clock-in OFFICE.
// bahria -> 16:00 (4pm-12am) ; lakecity -> 18:00 (6pm-2am).
// wfh / legacy 'office' don't define a shift -> excluded from the vote.
//
// SAFETY:
//  - only writes users whose shift_start_time is currently NULL,
//  - skips users already set to the computed value (no-op),
//  - NEVER overwrites a different existing value — reports it as a conflict.
// Pass DRY=1 to preview without writing.

const DRY = process.env.DRY === '1';
const OFFICE_START = { bahria: '16:00:00', lakecity: '18:00:00' };

const { data: profiles, error: pErr } = await sb
  .from('profiles')
  .select('id, display_name, role, is_active, shift_start_time');
if (pErr) throw pErr;
const byId = new Map(profiles.map(p => [p.id, p]));

const counts = new Map();
let from = 0; const PAGE = 1000;
for (;;) {
  const { data, error } = await sb.from('attendance')
    .select('user_id, location').range(from, from + PAGE - 1);
  if (error) throw error;
  if (!data.length) break;
  for (const r of data) {
    const c = counts.get(r.user_id) || { bahria: 0, lakecity: 0 };
    if (r.location === 'bahria') c.bahria++;
    else if (r.location === 'lakecity') c.lakecity++;
    counts.set(r.user_id, c);
  }
  if (data.length < PAGE) break;
  from += PAGE;
}

const norm = (t) => (t ? String(t).slice(0, 5) : null);   // '16:00:00' -> '16:00'
const willSet = [], skippedMatch = [], conflicts = [], noOffice = [];
const rollback = [];

for (const [uid, c] of counts) {
  const p = byId.get(uid);
  if (!p) continue;
  const office = c.lakecity > c.bahria ? 'lakecity'
              : c.bahria > c.lakecity ? 'bahria' : null;
  if (!office) continue;                       // tie or zero office visits
  const target = OFFICE_START[office];         // '16:00:00' / '18:00:00'
  const cur = p.shift_start_time;
  if (cur == null) {
    willSet.push({ uid, name: p.display_name, office, target, active: p.is_active });
    rollback.push({ uid, name: p.display_name, old: null });
  } else if (norm(cur) === norm(target)) {
    skippedMatch.push({ name: p.display_name, cur: norm(cur) });
  } else {
    conflicts.push({ name: p.display_name, role: p.role, cur: norm(cur),
                     computed: norm(target), bahria: c.bahria, lakecity: c.lakecity });
  }
}
for (const p of profiles) {
  const c = counts.get(p.id);
  if (!c || (c.bahria === 0 && c.lakecity === 0)) {
    if (counts.has(p.id) || true) noOffice.push(p.display_name);
  }
}

console.log(`${DRY ? '[DRY RUN] ' : ''}Will set ${willSet.length} users:`);
for (const r of willSet) console.log(`  ${r.office === 'bahria' ? '16:00' : '18:00'}  ${r.name}${r.active ? '' : '  (inactive)'}`);
console.log(`\nAlready correct (skip): ${skippedMatch.map(s => `${s.name}=${s.cur}`).join(', ') || 'none'}`);
console.log(`\nCONFLICTS (existing value differs — NOT touched):`);
for (const c of conflicts) console.log(`  ${c.name} (${c.role}): has ${c.cur}, rule says ${c.computed}  [bahria ${c.bahria} / lakecity ${c.lakecity}]`);
if (!conflicts.length) console.log('  none');

if (DRY) { console.log('\nDRY RUN — no writes.'); process.exit(0); }

// rollback snapshot
const stamp = '20260716';
const rbPath = `migration/rollback_shift_start_${stamp}.json`;
writeFileSync(rbPath, JSON.stringify(rollback, null, 2));
console.log(`\nRollback snapshot -> ${rbPath}`);

let ok = 0, fail = 0;
for (const r of willSet) {
  const { error } = await sb.from('profiles')
    .update({ shift_start_time: r.target }).eq('id', r.uid);
  if (error) { console.error(`  FAIL ${r.name}: ${error.message}`); fail++; }
  else ok++;
}
console.log(`\nDone. Set ${ok}, failed ${fail}.`);
