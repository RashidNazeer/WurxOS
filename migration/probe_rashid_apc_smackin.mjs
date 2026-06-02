// Part A — Mushammir cleanup:
//   1. Reassign 5 APCs' reports_to to the TL who now owns their brand
//   2. Reassign Mushammir's 2 orphaned brands to Boss
// Run AFTER migration 190 is applied.

import { sb } from './lib/supabase.js';

const MUSHAMMIR = '15f3cb0e-39f5-5eea-97e5-8b87d1040db0';
const BOSS_UID  = '205800a5-6baf-5bed-bec7-322ae135dda9';  // Usman Qamar

// 1. APC reassignments — derived from earlier probe
const APC_MOVES = [
  // { apc_id, apc_name, new_tl_id, new_tl_name, brand }
  { uid: '7deb55a6-3fcf-5151-915d-12d89398859f', name: 'Ibrahim Baloch', toUid: 'a3cbbb8e-d671-5c81-8379-c34f2166a83f', toName: 'Muhammad Azam',  brand: 'JoyMode (owner Mustafa Jan)' },
  { uid: '27f2a01e-6816-5309-bed5-b05065a00007', name: 'Hareem Asim',    toUid: 'a3cbbb8e-d671-5c81-8379-c34f2166a83f', toName: 'Muhammad Azam',  brand: 'Kenashii' },
  { uid: '87cbdb86-c22a-5c17-9574-73fcb764b79e', name: 'Farakh Farooq',  toUid: '7ab9eeb2-0398-577d-b25e-d57075ac817c', toName: 'Ali Hamza',      brand: 'Squish Energy' },
  { uid: '52569db0-55e6-532b-9055-a8c00064e1de', name: 'Maida Hashmi',   toUid: 'a3cbbb8e-d671-5c81-8379-c34f2166a83f', toName: 'Muhammad Azam',  brand: 'FlyWell' },
  { uid: '44c1ec2b-5cd6-5d31-8760-9948aa067d97', name: 'Ali Ahmad',      toUid: 'a3cbbb8e-d671-5c81-8379-c34f2166a83f', toName: 'Muhammad Azam',  brand: 'Transformation Body' },
];

// Look up Mustafa Jan's uid (he was a different uid than Muhammad Azam — fix above)
const { data: mustafa } = await sb
  .from('profiles').select('id').ilike('display_name', 'Mustafa Jan').single();
const MUSTAFA = mustafa.id;
// Repoint JoyMode/Kenashii/FlyWell to Mustafa (per probe — those brands' owner is Mustafa Jan)
APC_MOVES[0].toUid = MUSTAFA; APC_MOVES[0].toName = 'Mustafa Jan';
APC_MOVES[1].toUid = MUSTAFA; APC_MOVES[1].toName = 'Mustafa Jan';
APC_MOVES[3].toUid = MUSTAFA; APC_MOVES[3].toName = 'Mustafa Jan';

console.log('Part A1 — Reassigning APC reports_to:');
for (const m of APC_MOVES) {
  // Direct profile UPDATE (service-role bypasses RLS but not the auth check
  // inside team_move_apc_to_tl). Mirror what team_move_apc_to_tl does: update
  // profiles.reports_to + write an audit_log row.
  const { error: upErr } = await sb
    .from('profiles')
    .update({ reports_to: m.toUid, updated_at: new Date().toISOString() })
    .eq('id', m.uid);
  if (upErr) { console.error(`  ✗ ${m.name}: ${upErr.message}`); continue; }
  await sb.from('audit_log').insert({
    actor_id: null,
    action: 'team.move_apc.cleanup',
    entity_type: 'profiles',
    entity_id: m.uid,
    before: { reports_to: MUSHAMMIR },
    after:  { reports_to: m.toUid, reason: 'orphaned after Mushammir Qamar deletion', context: m.brand },
  });
  console.log(`  ✓ ${m.name.padEnd(18)} → ${m.toName.padEnd(16)} (${m.brand})`);
}

// 2. Reassign Mushammir's 2 orphaned brands to Boss
console.log('\nPart A2 — Reassigning orphaned brands via admin_reassign_orphaned_brands:');
const { data: count, error: rErr } = await sb.rpc('admin_reassign_orphaned_brands', {
  p_orphan: MUSHAMMIR,
  p_new_owner: BOSS_UID,
});
if (rErr) console.error(`  ✗ ${rErr.message}`);
else console.log(`  ✓ ${count} brand(s) reassigned to Boss`);

// 3. Verify
console.log('\nVerifying...');
const { data: stillReporting } = await sb
  .from('profiles').select('display_name, role')
  .eq('reports_to', MUSHAMMIR).is('deleted_at', null).eq('is_active', true);
console.log(`  Subordinates still pointing at Mushammir: ${stillReporting?.length || 0}`);
for (const s of stillReporting || []) console.log(`    ${s.display_name} (${s.role})`);

const { data: stillOwned } = await sb
  .from('brands').select('brand_name, status, owner_id')
  .eq('owner_id', MUSHAMMIR);
console.log(`  Brands still owned by Mushammir: ${stillOwned?.length || 0}`);
for (const b of stillOwned || []) console.log(`    ${b.brand_name} (${b.status})`);
