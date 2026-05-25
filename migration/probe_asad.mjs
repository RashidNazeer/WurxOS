// Locate Muhammad Asad (APC under Raees) + blast radius.
import { sb } from './lib/supabase.js';

const { data: rows, error } = await sb
  .from('profiles')
  .select('id, display_name, email, role, reports_to, is_active, deleted_at')
  .ilike('display_name', '%asad%');
if (error) { console.log('ERR', error.message); process.exit(1); }
console.log('Asad matches:');
for (const r of rows || []) {
  let ownerName = '';
  if (r.reports_to) {
    const { data: own } = await sb.from('profiles').select('display_name').eq('id', r.reports_to).maybeSingle();
    ownerName = own?.display_name || '?';
  }
  console.log(`  ${r.display_name} | ${r.email} | role=${r.role} | active=${r.is_active} | deleted=${r.deleted_at || '—'} | reports_to=${ownerName} | id=${r.id}`);
  const [brandsOwned, brandLinks, tasks, leaves, ratings, reports, resources, attendance, audit] = await Promise.all([
    sb.from('brands').select('id', { count: 'exact', head: true }).eq('owner_id', r.id),
    sb.from('brand_assignments').select('brand_id', { count: 'exact', head: true }).eq('user_id', r.id),
    sb.from('tasks').select('id', { count: 'exact', head: true }).eq('assignee_id', r.id),
    sb.from('leave_requests').select('id', { count: 'exact', head: true }).eq('requester_id', r.id),
    sb.from('performance_ratings').select('id', { count: 'exact', head: true }).eq('user_id', r.id),
    sb.from('reports').select('id', { count: 'exact', head: true }).eq('author_id', r.id),
    sb.from('resources').select('id', { count: 'exact', head: true }).eq('created_by', r.id),
    sb.from('attendance').select('id', { count: 'exact', head: true }).eq('user_id', r.id),
    sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('actor_id', r.id),
  ]);
  console.log(
    `    └─ owns_brands=${brandsOwned.count ?? 0}, assigned_brands=${brandLinks.count ?? 0}, tasks=${tasks.count ?? 0}, leaves=${leaves.count ?? 0}, ratings=${ratings.count ?? 0}, reports=${reports.count ?? 0}, resources=${resources.count ?? 0}, attendance=${attendance.count ?? 0}, audit_actor=${audit.count ?? 0}`,
  );
}
