// Read-only probe for "Samran" and "Test APC" (the bare one, distinct
// from Test APC 2 which we already deleted).

import { sb } from './lib/supabase.js';

const QUERIES = [
  { label: 'Samran',   pattern: '%samran%' },
  { label: 'Test APC', pattern: '%test%apc%' },
];

for (const { label, pattern } of QUERIES) {
  console.log(`\n=== ${label} (LIKE ${pattern}) ===`);
  const { data: rows, error } = await sb
    .from('profiles')
    .select('id, display_name, email, role, reports_to, is_active, deleted_at')
    .ilike('display_name', pattern);
  if (error) { console.log('  ERR', error.message); continue; }
  if (!rows?.length) { console.log('  (no match)'); continue; }
  for (const r of rows) {
    let ownerName = '';
    if (r.reports_to) {
      const { data: own } = await sb
        .from('profiles').select('display_name').eq('id', r.reports_to).maybeSingle();
      ownerName = own?.display_name || '?';
    }
    console.log(
      `  ${r.display_name} | ${r.email} | role=${r.role} | active=${r.is_active} | deleted=${r.deleted_at || '—'} | reports_to=${ownerName || 'none'} | id=${r.id}`
    );
    const [brandsOwned, brandLinks, openTasks, leaves, ratings] = await Promise.all([
      sb.from('brands').select('id', { count: 'exact', head: true }).eq('owner_id', r.id),
      sb.from('brand_assignments').select('brand_id', { count: 'exact', head: true }).eq('user_id', r.id),
      sb.from('tasks').select('id', { count: 'exact', head: true }).eq('assignee_id', r.id),
      sb.from('leave_requests').select('id', { count: 'exact', head: true }).eq('requester_id', r.id),
      sb.from('performance_ratings').select('id', { count: 'exact', head: true }).eq('user_id', r.id),
    ]);
    console.log(
      `    └─ owns_brands=${brandsOwned.count ?? 0}, assigned_brands=${brandLinks.count ?? 0}, tasks=${openTasks.count ?? 0}, leaves=${leaves.count ?? 0}, ratings=${ratings.count ?? 0}`,
    );
  }
}
