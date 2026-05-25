// Delete Test Brand 2 + PDC (both owned by Test team lead) + the
// Test team lead user itself. All confirmed empty / explicitly
// user-authorized.
//
// Brand FKs cascade (brand_assignments, tasks, reports, resources
// all have ON DELETE CASCADE for brand_id), so deleting brands is
// safe. For the user, sweep personal records then hard-delete auth.

import { sb } from './lib/supabase.js';

const TEST_BRAND_2_ID = '5463b579-8e39-5139-b9e4-13fd6979828b';
const PDC_ID          = 'b8dbb1de-b759-5415-a885-ccfb048623c5';
const TEST_TL_ID      = 'bc8af8ab-beaf-52b1-a667-b00c341de657';

// --- Brand deletes -----------------------------------------------
for (const [name, id] of [['Test Brand 2', TEST_BRAND_2_ID], ['PDC', PDC_ID]]) {
  const { data, error } = await sb.from('brands').delete().eq('id', id).select('id, brand_name');
  if (error) console.log(`  Brand ${name} ERR: ${error.message}`);
  else console.log(`  Brand "${name}" deleted: ${data?.length ? '✓' : '(no row)'}`);
}

// --- Test team lead: sweep personal data then auth delete --------
console.log(`\n--- Test team lead (${TEST_TL_ID}) ---`);
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
  ['tasks', 'created_by'],
]) {
  const { data, error } = await sb.from(table).delete().eq(col, TEST_TL_ID).select('id');
  if (error) {
    if (!/column .* does not exist|relation .* does not exist/i.test(error.message)) {
      console.log(`  DEL ${table}.${col} ERR: ${error.message}`);
    }
  } else if ((data?.length || 0) > 0) {
    console.log(`  DEL ${table}.${col}: ${data.length}`);
  }
}

const { error: dErr } = await sb.auth.admin.deleteUser(TEST_TL_ID);
if (dErr) console.log(`  auth.admin.deleteUser ERR: ${dErr.message}`);
else {
  console.log('  auth user deleted ✓');
  const { data: prof } = await sb.from('profiles').select('id, display_name').eq('id', TEST_TL_ID).maybeSingle();
  console.log(prof ? `  ⚠ profile still present: ${prof.display_name}` : '  profile row gone ✓');
}

console.log('\nDone.');
