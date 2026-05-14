// Investigate why Rashid Nazeer can't see brands.
// (Note: per handoff, 3 Rashid Nazeer accounts exist — dev/apc/tl.)

import { sb } from './lib/supabase.js';

const { data: rashids } = await sb
  .from('profiles')
  .select('id, display_name, email, role, reports_to, is_active, deleted_at')
  .ilike('display_name', '%rashid%nazeer%');
console.log('All Rashid Nazeer accounts:');
for (const r of rashids || []) {
  console.log(`  ${r.email} | role=${r.role} | active=${r.is_active} | id=${r.id}`);
}

// Focus on the APC one (most likely "can't see brands")
const apcRashid = (rashids || []).find((r) => r.role === 'apc');
if (!apcRashid) {
  console.log('\nNo APC Rashid Nazeer found.');
  process.exit(0);
}
console.log(`\n=== Focusing on APC Rashid: ${apcRashid.email} (${apcRashid.id}) ===`);

// What brands he's CURRENTLY assigned to
const { data: links } = await sb
  .from('brand_assignments')
  .select('brand:brand_id(id, brand_name, status, owner_id)')
  .eq('user_id', apcRashid.id);
console.log(`\nCurrent brand_assignments: ${links?.length || 0}`);
for (const l of links || []) {
  console.log(`  - ${l.brand?.brand_name} (status=${l.brand?.status})`);
}

// Tasks he has (brand or personal)
const { data: tasks, count: taskCount } = await sb
  .from('tasks')
  .select('id, title, brand_id, brand:brand_id(brand_name, status), status, category', { count: 'exact' })
  .eq('assignee_id', apcRashid.id);
console.log(`\nTasks (total ${taskCount}):`);
for (const t of (tasks || []).slice(0, 20)) {
  console.log(`  - "${t.title}" | brand=${t.brand?.brand_name || '(personal)'} (${t.brand?.status || '—'}) | status=${t.status} | cat=${t.category}`);
}

// Resources he created
const { data: resources, count: resCount } = await sb
  .from('resources')
  .select('id, name, brand_id, brand:brand_id(brand_name, status)', { count: 'exact' })
  .eq('created_by', apcRashid.id);
console.log(`\nResources he created (total ${resCount}):`);
for (const r of (resources || []).slice(0, 10)) {
  console.log(`  - "${r.name}" | brand=${r.brand?.brand_name || '(general)'} (${r.brand?.status || '—'})`);
}

// Audit log: any recent brand.delete actions that touched his brands
console.log(`\n=== Recent brand-delete audit events (last 7 days) ===`);
const since = new Date(Date.now() - 7 * 86400_000).toISOString();
const { data: deletes } = await sb
  .from('audit_log')
  .select('id, action, entity_id, before, after, created_at, actor:actor_id(display_name, role)')
  .gte('created_at', since)
  .or('action.eq.brand.delete,action.eq.brand.deleted,action.eq.brand_deleted,action.ilike.%delete%')
  .order('created_at', { ascending: false })
  .limit(20);
for (const d of deletes || []) {
  console.log(`  [${d.created_at.slice(0, 16)}] ${d.action} by ${d.actor?.display_name} (${d.actor?.role}) — entity ${d.entity_id}`);
  if (d.before) console.log(`     before:`, JSON.stringify(d.before).slice(0, 120));
}
