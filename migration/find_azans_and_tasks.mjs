import { sb } from './lib/supabase.js';

// All Azans
const { data: azans } = await sb.from('profiles')
  .select('id, display_name, email, role, reports_to, is_active, deleted_at')
  .or('display_name.ilike.%azan%,email.ilike.%azan%');
console.log(`All Azan-ish profiles: ${azans?.length || 0}`);
for (const a of azans || []) {
  console.log(`  ${a.display_name?.padEnd(20)} ${a.email?.padEnd(30)} role=${a.role}  active=${a.is_active}  deleted=${!!a.deleted_at}`);
}

// Tasks with titles matching the screenshot
const titles = ['Outreach', 'Sample Approval', 'Sample approval', 'Video Reviews', 'Chat Sort', 'Chat sort', 'Weekly reporting'];
console.log('\nTasks with screenshot titles (any assignee):');
for (const t of titles) {
  const { data: rows } = await sb.from('tasks')
    .select('id, title, status, brand_id, recurrence, assignee_id, created_by')
    .ilike('title', t)
    .neq('status', 'done')
    .limit(15);
  console.log(`  "${t}": ${rows?.length || 0} open rows`);
  for (const r of rows || []) {
    console.log(`     status=${r.status}  brand=${r.brand_id?.slice(0,8) || '—'}  assignee=${r.assignee_id?.slice(0,8) || '—'}  creator=${r.created_by?.slice(0,8) || '—'}`);
  }
}

// And: Solid Gold Pets brand id
const { data: sg } = await sb.from('brands').select('id, brand_name, is_active, deleted_at, owner_id').ilike('brand_name', '%solid gold%');
console.log('\nSolid Gold brands:'); console.log(sg);
