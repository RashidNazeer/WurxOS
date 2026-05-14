// Hard-delete Test PCTL + TL Rashid Nazeer. Both are clean (no
// owned brands, no reports/resources, minimal personal data).
// APC Rashid Nazeer is explicitly preserved.

import { sb } from './lib/supabase.js';

const TEST_PCTL_ID  = 'f09c7680-125b-5361-b4d8-32a8ccc0ef88';
const TL_RASHID_ID  = '6ab21939-03da-512b-946c-ae67ddb6e60b';
const APC_RASHID_ID = '3582f4f1-e018-507d-af98-8ae206320c5e'; // PRESERVE

for (const [name, id] of [['Test PCTL', TEST_PCTL_ID], ['TL Rashid Nazeer', TL_RASHID_ID]]) {
  if (id === APC_RASHID_ID) {
    console.log(`SAFETY ABORT: ${name} id collides with APC Rashid Nazeer!`);
    process.exit(1);
  }
  console.log(`\n--- ${name} (${id}) ---`);
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
    const { data, error } = await sb.from(table).delete().eq(col, id).select('id');
    if (error) {
      if (!/column .* does not exist|relation .* does not exist/i.test(error.message)) {
        console.log(`  DEL ${table}.${col} ERR: ${error.message}`);
      }
    } else if ((data?.length || 0) > 0) {
      console.log(`  DEL ${table}.${col}: ${data.length}`);
    }
  }
  const { error: dErr } = await sb.auth.admin.deleteUser(id);
  if (dErr) console.log(`  auth.admin.deleteUser ERR: ${dErr.message}`);
  else {
    console.log('  auth user deleted ✓');
    const { data: prof } = await sb.from('profiles').select('id, display_name').eq('id', id).maybeSingle();
    console.log(prof ? `  ⚠ profile still present: ${prof.display_name}` : '  profile row gone ✓');
  }
}

// Re-verify APC Rashid is still there
console.log('\n=== APC Rashid verification ===');
const { data: apcR } = await sb.from('profiles').select('id, display_name, email, role').eq('id', APC_RASHID_ID).maybeSingle();
console.log(apcR ? `✓ Preserved: ${apcR.display_name} (${apcR.email})` : '⚠ APC Rashid is MISSING — something went wrong');
