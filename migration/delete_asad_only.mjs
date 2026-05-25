// Hard-delete Muhammad Asad only.
// Asad's content (1 report + 10 resources, all for Aqua Sonic)
// reassigned to Umair Tariq, the current APC of Aqua Sonic.
// Operational data (tasks, attendance, rating) deleted.

import { sb } from './lib/supabase.js';

const ASAD_ID = 'c866b2ea-2153-54b1-9917-aa881aa297eb';

const { data: umairRows } = await sb
  .from('profiles').select('id, display_name, role')
  .ilike('display_name', '%umair%tariq%');
const umair = umairRows?.[0];
if (!umair) { console.log('ABORT: Umair Tariq not found'); process.exit(1); }
console.log(`Umair Tariq: ${umair.id} (${umair.role})`);

console.log(`\n--- Muhammad Asad (${ASAD_ID}) ---`);

const { data: aRep } = await sb
  .from('reports').update({ author_id: umair.id })
  .eq('author_id', ASAD_ID).select('id');
console.log(`  reports reassigned to Umair Tariq: ${aRep?.length || 0}`);

const { data: aRes } = await sb
  .from('resources').update({ created_by: umair.id })
  .eq('created_by', ASAD_ID).select('id');
console.log(`  resources reassigned to Umair Tariq: ${aRes?.length || 0}`);

for (const [table, col] of [
  ['attendance', 'user_id'],
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
