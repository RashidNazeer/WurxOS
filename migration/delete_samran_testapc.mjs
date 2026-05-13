// Permanently delete Samran and Test APC.
// Same pattern as delete_four_apcs.mjs: drop their tasks / leaves /
// brand_assignments, then hard-delete the auth user (profile cascades).

import { sb } from './lib/supabase.js';

const TARGETS = [
  { name: 'Samran',   id: '38c1b000-292b-55a0-b5d0-7ada6a8e6317' },
  { name: 'Test APC', id: '80f41dbf-9478-5036-8976-9ed7b6cbff02' },
];

for (const t of TARGETS) {
  console.log(`\n--- ${t.name} (${t.id}) ---`);

  const { data: tRows, error: tErr } = await sb
    .from('tasks').delete().eq('assignee_id', t.id).select('id');
  if (tErr) { console.log('  tasks ERR', tErr.message); continue; }
  console.log(`  tasks deleted: ${tRows?.length || 0}`);

  const { data: lRows, error: lErr } = await sb
    .from('leave_requests').delete().eq('requester_id', t.id).select('id');
  if (lErr) { console.log('  leaves ERR', lErr.message); continue; }
  console.log(`  leave_requests deleted: ${lRows?.length || 0}`);

  const { data: bRows, error: bErr } = await sb
    .from('brand_assignments').delete().eq('user_id', t.id).select('brand_id');
  if (bErr) { console.log('  brand_assignments ERR', bErr.message); continue; }
  console.log(`  brand_assignments deleted: ${bRows?.length || 0}`);

  const { error: dErr } = await sb.auth.admin.deleteUser(t.id);
  if (dErr) { console.log('  auth.admin.deleteUser ERR', dErr.message); continue; }
  console.log('  auth user deleted ✓');

  const { data: profCheck } = await sb
    .from('profiles').select('id, display_name').eq('id', t.id).maybeSingle();
  console.log(profCheck
    ? `  ⚠ profile row still present: ${profCheck.display_name}`
    : '  profile row gone ✓');
}

console.log('\nDone.');
