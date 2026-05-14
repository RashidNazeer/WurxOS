// 1. Check if any orphaned tasks/resources exist (brand_id pointing
//    at a brand that no longer exists). These would indicate the
//    cascade got blocked somewhere.
// 2. Look at Rashid Nazeer's recent brand_assignments history for
//    any clues about why he lost his brands.

import { sb } from './lib/supabase.js';

const APC_RASHID = '3582f4f1-e018-507d-af98-8ae206320c5e';

// ===== 1. Orphan check =====
// Tasks where brand_id is not null but no matching brand row exists.
const { data: tasks } = await sb
  .from('tasks')
  .select('id, brand_id, title, assignee:assignee_id(display_name)')
  .not('brand_id', 'is', null)
  .limit(5000);
const brandIdsNeeded = new Set((tasks || []).map((t) => t.brand_id).filter(Boolean));
const { data: liveBrands } = await sb
  .from('brands')
  .select('id, brand_name, status')
  .in('id', [...brandIdsNeeded]);
const liveBrandIds = new Set((liveBrands || []).map((b) => b.id));
const orphanedTasks = (tasks || []).filter((t) => t.brand_id && !liveBrandIds.has(t.brand_id));
console.log(`Orphaned tasks (brand_id → nonexistent brand): ${orphanedTasks.length}`);
for (const t of orphanedTasks.slice(0, 20)) {
  console.log(`  - "${t.title}" | brand_id=${t.brand_id} | assignee=${t.assignee?.display_name}`);
}

// Same for resources
const { data: resources } = await sb
  .from('resources')
  .select('id, name, brand_id')
  .not('brand_id', 'is', null)
  .limit(5000);
const resBrandIds = new Set((resources || []).map((r) => r.brand_id).filter(Boolean));
const { data: liveBrands2 } = await sb
  .from('brands').select('id').in('id', [...resBrandIds]);
const liveBrand2Ids = new Set((liveBrands2 || []).map((b) => b.id));
const orphanedRes = (resources || []).filter((r) => r.brand_id && !liveBrand2Ids.has(r.brand_id));
console.log(`\nOrphaned resources: ${orphanedRes.length}`);
for (const r of orphanedRes.slice(0, 10)) {
  console.log(`  - "${r.name}" | brand_id=${r.brand_id}`);
}

// ===== 2. Rashid brand_assignments audit =====
console.log(`\n=== Rashid (APC) brand_assignments — anything recorded in audit? ===`);
const { data: rashidAudit } = await sb
  .from('audit_log')
  .select('action, entity_type, entity_id, before, after, created_at, actor:actor_id(display_name, role)')
  .or(`before->>assigned_apc.eq.${APC_RASHID},after->>assigned_apc.eq.${APC_RASHID}`)
  .order('created_at', { ascending: false })
  .limit(20);
console.log(`Audit entries touching Rashid: ${rashidAudit?.length || 0}`);
for (const a of rashidAudit || []) {
  console.log(`  [${a.created_at.slice(0,16)}] ${a.action} by ${a.actor?.display_name || 'unknown'} (${a.actor?.role || '—'})`);
  if (a.before?.assigned_apc) console.log(`     before.assigned_apc: ${a.before.assigned_apc}`);
  if (a.after?.assigned_apc)  console.log(`     after.assigned_apc:  ${a.after.assigned_apc}`);
}

// ===== 3. Check Smackin (the inactive brand that has Rashid's task) =====
console.log(`\n=== Smackin brand info ===`);
const { data: smackin } = await sb
  .from('brands').select('id, brand_name, status, owner_id, owner:owner_id(display_name)').ilike('brand_name', '%smackin%').maybeSingle();
console.log(smackin);
if (smackin) {
  const { data: smacAssigns } = await sb
    .from('brand_assignments')
    .select('user_id, profile:user_id(display_name, role)')
    .eq('brand_id', smackin.id);
  console.log(`Smackin current APC assignees:`);
  for (const a of smacAssigns || []) console.log(`  - ${a.profile?.display_name} (${a.profile?.role})`);
}
