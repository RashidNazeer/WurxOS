// Hard-delete Muhammad Asad (APC) and Raees Ali Azeem (TL, already
// soft-deleted). Per user 2026-05-14: preserve all content; only
// the user records go.
//
// Reassignments:
//   * Asad's 1 report + 10 resources (all for Aqua Sonic) →
//     Umair Tariq, the current APC of Aqua Sonic
//   * Raees's 3 reports + 1 owned brand "Lumi Wear Co" → Mustafa Jan,
//     the replacement TL
//
// Hard-deletes (operational, can't preserve meaningfully):
//   * Asad's 2 personal done-tasks
//   * Asad's 1 performance rating (he's no longer rateable)
//   * Asad + Raees attendance history (anchored to person)

import { sb } from './lib/supabase.js';

const ASAD_ID    = 'c866b2ea-2153-54b1-9917-aa881aa297eb';
const RAEES_ID   = '1214d2f3-781d-58b1-bf52-3b3af21ccc3d';
const MUSTAFA_ID = 'e3983541-0195-590c-a466-e61e2e430f1a';

// Look up Umair Tariq's id by name.
const { data: umairRows } = await sb
  .from('profiles').select('id, display_name, role')
  .ilike('display_name', '%umair%tariq%');
const umair = umairRows?.[0];
if (!umair) { console.log('ABORT: Umair Tariq not found'); process.exit(1); }
console.log(`Umair Tariq: ${umair.id} (${umair.role})`);

// =============================================================
// RAEES — reassign content, then hard-delete auth user.
// =============================================================
console.log(`\n--- Raees Ali Azeem (${RAEES_ID}) ---`);

const { data: rRep } = await sb
  .from('reports').update({ author_id: MUSTAFA_ID })
  .eq('author_id', RAEES_ID).select('id');
console.log(`  reports reassigned to Mustafa Jan: ${rRep?.length || 0}`);

const { data: rBr } = await sb
  .from('brands').update({ owner_id: MUSTAFA_ID })
  .eq('owner_id', RAEES_ID).select('id, brand_name');
console.log(`  brands reassigned to Mustafa Jan: ${rBr?.length || 0} (${rBr?.map((b) => b.brand_name).join(', ')})`);

const { data: rAtt } = await sb
  .from('attendance').delete().eq('user_id', RAEES_ID).select('id');
console.log(`  attendance deleted: ${rAtt?.length || 0}`);

// Sweep anything else that would block. Adjustments, edit requests, etc.
for (const [table, col] of [
  ['attendance_adjustments', 'user_id'],
  ['attendance_edit_requests', 'user_id'],
  ['leave_requests', 'requester_id'],
  ['brand_assignments', 'user_id'],
  ['performance_ratings', 'user_id'],
  ['performance_flags', 'user_id'],
  ['incentives', 'user_id'],
  ['tasks', 'assignee_id'],
]) {
  const { data, error } = await sb.from(table).delete().eq(col, RAEES_ID).select('id');
  if (error) {
    if (!/column .* does not exist|relation .* does not exist/i.test(error.message)) {
      console.log(`  DEL ${table}.${col} ERR: ${error.message}`);
    }
  } else if ((data?.length || 0) > 0) {
    console.log(`  DEL ${table}.${col}: ${data.length}`);
  }
}

const { error: rDel } = await sb.auth.admin.deleteUser(RAEES_ID);
if (rDel) console.log(`  auth.admin.deleteUser ERR: ${rDel.message}`);
else {
  console.log('  auth user deleted ✓');
  const { data: prof } = await sb
    .from('profiles').select('id, display_name').eq('id', RAEES_ID).maybeSingle();
  console.log(prof ? `  ⚠ profile still present: ${prof.display_name}` : '  profile row gone ✓');
}

// =============================================================
// ASAD — reassign content, then hard-delete auth user.
// =============================================================
console.log(`\n--- Muhammad Asad (${ASAD_ID}) ---`);

const { data: aRep } = await sb
  .from('reports').update({ author_id: umair.id })
  .eq('author_id', ASAD_ID).select('id');
console.log(`  reports reassigned to Umair Tariq: ${aRep?.length || 0}`);

const { data: aRes } = await sb
  .from('resources').update({ created_by: umair.id })
  .eq('created_by', ASAD_ID).select('id');
console.log(`  resources reassigned to Umair Tariq: ${aRes?.length || 0}`);

const { data: aAtt } = await sb
  .from('attendance').delete().eq('user_id', ASAD_ID).select('id');
console.log(`  attendance deleted: ${aAtt?.length || 0}`);

for (const [table, col] of [
  ['attendance_adjustments', 'user_id'],
  ['attendance_edit_requests', 'user_id'],
  ['leave_requests', 'requester_id'],
  ['brand_assignments', 'user_id'],
  ['performance_ratings', 'user_id'],
  ['performance_flags', 'user_id'],
  ['incentives', 'user_id'],
  ['tasks', 'assignee_id'],
]) {
  const { data, error } = await sb.from(table).delete().eq(col, ASAD_ID).select('id');
  if (error) {
    if (!/column .* does not exist|relation .* does not exist/i.test(error.message)) {
      console.log(`  DEL ${table}.${col} ERR: ${error.message}`);
    }
  } else if ((data?.length || 0) > 0) {
    console.log(`  DEL ${table}.${col}: ${data.length}`);
  }
}

const { error: aDel } = await sb.auth.admin.deleteUser(ASAD_ID);
if (aDel) console.log(`  auth.admin.deleteUser ERR: ${aDel.message}`);
else {
  console.log('  auth user deleted ✓');
  const { data: prof } = await sb
    .from('profiles').select('id, display_name').eq('id', ASAD_ID).maybeSingle();
  console.log(prof ? `  ⚠ profile still present: ${prof.display_name}` : '  profile row gone ✓');
}

console.log('\nDone.');
