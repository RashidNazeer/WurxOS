// Permanently delete four APCs the user no longer wants in the system.
// Runs with service-role credentials, so RLS does not apply.
//
// For each user:
//   1. Delete tasks where assignee_id = user.id
//   2. Delete leave_requests where requester_id = user.id
//   3. Delete brand_assignments where user_id = user.id (clean-up; none expected)
//   4. supabase.auth.admin.deleteUser(user.id) — hard-deletes the auth row.
//      The profile row cascades because profiles.id references auth.users.id.
//
// Prints per-user counts at every step so we can verify the math.

import { sb } from './lib/supabase.js';

const TARGETS = [
  { name: 'Malik Ehsan', id: '1be9494e-d3d8-52b0-ae56-81005715ef4c' },
  { name: 'Test APC 2',  id: 'cfbc2afa-ca8a-588c-be4e-a25f06620618' },
  { name: 'Test Mr Khan', id: 'a1178704-50b5-5ca6-b920-203e73e55564' },
  { name: 'Mr Khan',      id: '0fdf6627-36e5-5279-b5cb-65248b1b35d4' },
];

for (const t of TARGETS) {
  console.log(`\n--- ${t.name} (${t.id}) ---`);

  // 1. Tasks
  const { data: tRows, error: tErr } = await sb
    .from('tasks').delete().eq('assignee_id', t.id).select('id');
  if (tErr) { console.log('  tasks ERR', tErr.message); continue; }
  console.log(`  tasks deleted: ${tRows?.length || 0}`);

  // 2. Leave requests
  const { data: lRows, error: lErr } = await sb
    .from('leave_requests').delete().eq('requester_id', t.id).select('id');
  if (lErr) { console.log('  leaves ERR', lErr.message); continue; }
  console.log(`  leave_requests deleted: ${lRows?.length || 0}`);

  // 3. Brand assignments (none expected for these four, but clean-up
  //    is cheap and avoids leaving FK-orphans)
  const { data: bRows, error: bErr } = await sb
    .from('brand_assignments').delete().eq('user_id', t.id).select('brand_id');
  if (bErr) { console.log('  brand_assignments ERR', bErr.message); continue; }
  console.log(`  brand_assignments deleted: ${bRows?.length || 0}`);

  // 4. Auth user — profile cascades
  const { data: dRes, error: dErr } = await sb.auth.admin.deleteUser(t.id);
  if (dErr) { console.log('  auth.admin.deleteUser ERR', dErr.message); continue; }
  console.log(`  auth user deleted ✓`);

  // 5. Verify profile is gone
  const { data: profCheck } = await sb
    .from('profiles').select('id, display_name').eq('id', t.id).maybeSingle();
  console.log(profCheck
    ? `  ⚠ profile row still present: ${profCheck.display_name}`
    : `  profile row gone ✓`);
}

console.log('\nDone.');
