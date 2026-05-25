// Hard-delete Raees Ali Azeem (TL, already soft-deleted 2026-05-07).
// User instruction 2026-05-14: reassign his content to Mustafa Jan,
// then remove the auth user so the profile cascades.
//
// Content reassigned:
//   * 3 reports (author_id) → Mustafa Jan
//   * 1 owned brand "Lumi Wear Co" (brands.owner_id) → Mustafa Jan
// Personal data deleted (cannot meaningfully live without him):
//   * attendance, adjustments, edit requests, leave requests,
//     brand_assignments, performance ratings/flags, incentives, tasks

import { sb } from './lib/supabase.js';

const RAEES_ID   = '1214d2f3-781d-58b1-bf52-3b3af21ccc3d';
const MUSTAFA_ID = 'e3983541-0195-590c-a466-e61e2e430f1a';

console.log(`--- Raees Ali Azeem (${RAEES_ID}) → reassigning to Mustafa Jan (${MUSTAFA_ID}) ---`);

const { data: rRep } = await sb
  .from('reports').update({ author_id: MUSTAFA_ID })
  .eq('author_id', RAEES_ID).select('id');
console.log(`  reports reassigned to Mustafa Jan: ${rRep?.length || 0}`);

const { data: rBr } = await sb
  .from('brands').update({ owner_id: MUSTAFA_ID })
  .eq('owner_id', RAEES_ID).select('id, brand_name');
console.log(`  brands reassigned to Mustafa Jan: ${rBr?.length || 0} (${(rBr || []).map((b) => b.brand_name).join(', ')})`);

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

console.log('\nDone.');
