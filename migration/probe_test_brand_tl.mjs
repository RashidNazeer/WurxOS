// Probe Test Brand 2 + Test Team Lead before deletion.

import { sb } from './lib/supabase.js';

console.log('=== Brand: Test Brand 2 ===');
const { data: brands } = await sb
  .from('brands')
  .select('id, brand_name, client_name, status, owner_id, tier, owner:owner_id(display_name, role)')
  .ilike('brand_name', '%test%brand%2%');
for (const b of brands || []) {
  console.log(`  "${b.brand_name}" (${b.id}) — status=${b.status}, owner=${b.owner?.display_name} (${b.owner?.role})`);
  const [tasks, reports, resources, assignments] = await Promise.all([
    sb.from('tasks').select('id', { count: 'exact', head: true }).eq('brand_id', b.id),
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('brand_id', b.id),
    sb.from('resources').select('id', { count: 'exact', head: true }).eq('brand_id', b.id),
    sb.from('brand_assignments').select('user_id', { count: 'exact', head: true }).eq('brand_id', b.id),
  ]);
  console.log(`    └─ tasks=${tasks.count}, reports=${reports.count}, resources=${resources.count}, assignments=${assignments.count}`);
}

console.log('\n=== User: Test Team Lead ===');
const { data: users } = await sb
  .from('profiles')
  .select('id, display_name, email, role, reports_to, is_active, deleted_at')
  .ilike('display_name', '%test%team%lead%');
for (const u of users || []) {
  let ownerName = '';
  if (u.reports_to) {
    const { data: own } = await sb.from('profiles').select('display_name').eq('id', u.reports_to).maybeSingle();
    ownerName = own?.display_name || '?';
  }
  console.log(`  ${u.display_name} | ${u.email} | role=${u.role} | active=${u.is_active} | deleted=${u.deleted_at || '—'} | reports_to=${ownerName} | id=${u.id}`);
  const [ownsBrands, brandLinks, tasks, leaves, ratings, reports, resources, attendance, audit, reportees] = await Promise.all([
    sb.from('brands').select('id', { count: 'exact', head: true }).eq('owner_id', u.id),
    sb.from('brand_assignments').select('brand_id', { count: 'exact', head: true }).eq('user_id', u.id),
    sb.from('tasks').select('id', { count: 'exact', head: true }).eq('assignee_id', u.id),
    sb.from('leave_requests').select('id', { count: 'exact', head: true }).eq('requester_id', u.id),
    sb.from('performance_ratings').select('id', { count: 'exact', head: true }).eq('user_id', u.id),
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('author_id', u.id),
    sb.from('resources').select('id', { count: 'exact', head: true }).eq('created_by', u.id),
    sb.from('attendance').select('id', { count: 'exact', head: true }).eq('user_id', u.id),
    sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('actor_id', u.id),
    sb.from('profiles').select('id, display_name', { count: 'exact', head: false }).eq('reports_to', u.id),
  ]);
  console.log(
    `    └─ owns_brands=${ownsBrands.count}, assigned_brands=${brandLinks.count}, tasks=${tasks.count}, leaves=${leaves.count}, ratings=${ratings.count}, reports=${reports.count}, resources=${resources.count}, attendance=${attendance.count}, audit_actor=${audit.count}`,
  );
  if (reportees.data?.length) {
    console.log('    └─ DIRECT REPORTS:');
    for (const r of reportees.data) console.log(`         - ${r.display_name} (${r.id})`);
  }
}
