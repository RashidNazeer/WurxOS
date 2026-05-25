// Probe everything needed before deleting Asad + Raees:
//   * Raees Ali Azeem — confirm exists, his blast radius
//   * Mustafa Jan — confirm exists (target for Raees's content)
//   * Asad's prior brand assignment (via audit_log brand.switch_apc
//     entries) and the brand's CURRENT APC — target for Asad's content.

import { sb } from './lib/supabase.js';

const ASAD_ID = 'c866b2ea-2153-54b1-9917-aa881aa297eb';

console.log('=== Raees Ali Azeem ===');
const { data: raeesRows } = await sb
  .from('profiles')
  .select('id, display_name, email, role, reports_to, is_active, deleted_at')
  .ilike('display_name', '%raees%');
for (const r of raeesRows || []) {
  console.log(`  ${r.display_name} | ${r.email} | role=${r.role} | active=${r.is_active} | deleted=${r.deleted_at || '—'} | id=${r.id}`);
  const [reports, resources, attendance, audit, brands] = await Promise.all([
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('author_id', r.id),
    sb.from('resources').select('id', { count: 'exact', head: true }).eq('created_by', r.id),
    sb.from('attendance').select('id', { count: 'exact', head: true }).eq('user_id', r.id),
    sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('actor_id', r.id),
    sb.from('brands').select('id', { count: 'exact', head: true }).eq('owner_id', r.id),
  ]);
  console.log(`    └─ reports=${reports.count}, resources=${resources.count}, attendance=${attendance.count}, audit_actor=${audit.count}, owns_brands=${brands.count}`);
}

console.log('\n=== Mustafa Jan ===');
const { data: mustafaRows } = await sb
  .from('profiles')
  .select('id, display_name, email, role, is_active')
  .ilike('display_name', '%mustafa%');
console.log(mustafaRows);

console.log('\n=== Asad’s brand-switch history (audit_log entries where assigned_apc was Asad) ===');
// brand.switch_apc audit entries record { before: {assigned_apc: X}, after: {assigned_apc: Y} }.
// Find every entry where Asad appears on either side.
const { data: switches } = await sb
  .from('audit_log')
  .select('id, entity_id, before, after, created_at, actor_id')
  .eq('action', 'brand.switch_apc')
  .order('created_at', { ascending: false });

const relevant = (switches || []).filter(
  (s) => s.before?.assigned_apc === ASAD_ID || s.after?.assigned_apc === ASAD_ID,
);
console.log(`Found ${relevant.length} brand-switch entries involving Asad`);

const brandIds = new Set(relevant.map((s) => s.entity_id));
console.log(`Unique brand IDs touched: ${[...brandIds].join(', ')}`);

for (const bid of brandIds) {
  const { data: brand } = await sb
    .from('brands')
    .select('id, brand_name, owner_id, status')
    .eq('id', bid)
    .maybeSingle();
  const { data: links } = await sb
    .from('brand_assignments')
    .select('user_id, profile:user_id(display_name, email, role)')
    .eq('brand_id', bid);
  console.log(`\n  Brand "${brand?.brand_name}" (${brand?.id}, status=${brand?.status})`);
  console.log(`    current assignees:`, links?.map((l) => `${l.profile?.display_name} (${l.profile?.role})`).join(', ') || '(none)');
}
