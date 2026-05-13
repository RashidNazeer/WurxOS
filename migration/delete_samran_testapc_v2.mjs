// Round-2 cleanup + delete for Samran and Test APC.
// First pass (delete_samran_testapc.mjs) cleared their tasks/leaves/
// brand_assignments and then the auth delete failed because other
// tables still pointed at them. This pass:
//   * NULLs the cross-cutting creator/actor references that should
//     stay in the system as historical records (resources,
//     product_campaigns, audit_log, notifications).
//   * Hard-deletes personal records (attendance, adjustments,
//     performance_flags, incentives) — they have no meaning without
//     the user.
//   * Retries auth.admin.deleteUser; profile row should cascade.

import { sb } from './lib/supabase.js';

const TARGETS = [
  { name: 'Samran',   id: '38c1b000-292b-55a0-b5d0-7ada6a8e6317' },
  { name: 'Test APC', id: '80f41dbf-9478-5036-8976-9ed7b6cbff02' },
];

// NULL out the creator/actor column. Returns count of rows touched.
async function nullify(table, col, userId) {
  const { data, error } = await sb
    .from(table)
    .update({ [col]: null })
    .eq(col, userId)
    .select('*');
  if (error) return { count: 0, err: error.message };
  return { count: data?.length || 0 };
}

async function del(table, col, userId) {
  const { data, error } = await sb
    .from(table)
    .delete()
    .eq(col, userId)
    .select('*');
  if (error) return { count: 0, err: error.message };
  return { count: data?.length || 0 };
}

for (const t of TARGETS) {
  console.log(`\n--- ${t.name} (${t.id}) ---`);

  // Preserve content — NULL the creator/actor link.
  // audit_log intentionally NOT touched (immutable history record).
  for (const [table, col] of [
    ['resources',         'created_by'],
    ['product_campaigns', 'created_by'],
    ['notifications',     'actor_id'],
  ]) {
    const r = await nullify(table, col, t.id);
    if (r.err) console.log(`  NULL ${table}.${col}: ERR ${r.err}`);
    else if (r.count > 0) console.log(`  NULL ${table}.${col}: ${r.count}`);
  }

  // Delete user-specific records.
  for (const [table, col] of [
    ['attendance',             'user_id'],
    ['attendance_adjustments', 'user_id'],
    ['performance_flags',      'user_id'],
    ['incentives',             'user_id'],
    // Catch-all sweeps for anything the first pass missed:
    ['tasks',                  'assignee_id'],
    ['leave_requests',         'requester_id'],
    ['brand_assignments',      'user_id'],
    ['notifications',          'user_id'],
  ]) {
    const r = await del(table, col, t.id);
    if (r.err) console.log(`  DEL ${table}.${col}: ERR ${r.err}`);
    else if (r.count > 0) console.log(`  DEL ${table}.${col}: ${r.count}`);
  }

  // Retry auth deletion.
  const { error: dErr } = await sb.auth.admin.deleteUser(t.id);
  if (dErr) {
    console.log(`  auth.admin.deleteUser ERR: ${dErr.message}`);
    continue;
  }
  console.log('  auth user deleted ✓');

  const { data: profCheck } = await sb
    .from('profiles').select('id, display_name').eq('id', t.id).maybeSingle();
  console.log(profCheck
    ? `  ⚠ profile still present: ${profCheck.display_name}`
    : '  profile row gone ✓');
}

console.log('\nDone.');
