import { sb } from './lib/supabase.js';

// 2. Direct sample of tasks table to see what's there at all
const { data: anyTasks, count } = await sb.from('tasks')
  .select('id, title, assignee_id, brand_id, status', { count: 'exact' })
  .neq('status', 'done')
  .limit(5);
console.log(`\nTotal open tasks in v2: ${count}`);
console.log('Sample:', anyTasks);

// 3. Search tasks by title fuzzy
const { data: outreach } = await sb.from('tasks')
  .select('id, title, status, assignee_id, brand_id, created_by, created_at')
  .ilike('title', '%outreach%')
  .order('created_at', { ascending: false })
  .limit(20);
console.log(`\nTasks with "outreach" anywhere in title: ${outreach?.length || 0}`);
for (const t of outreach || []) {
  console.log(`  "${t.title}"  status=${t.status}  assignee=${t.assignee_id?.slice(0,8) || '—'}  brand=${t.brand_id?.slice(0,8) || '—'}  created=${t.created_at?.slice(0,10)}`);
}

// 4. Search brands fuzzy
const { data: brandsLike } = await sb.from('brands').select('id, brand_name, is_active, deleted_at').or('brand_name.ilike.%solid%,brand_name.ilike.%gold%,brand_name.ilike.%pet%').limit(20);
console.log(`\nBrands matching solid/gold/pet: ${brandsLike?.length || 0}`);
for (const b of brandsLike || []) {
  console.log(`  "${b.brand_name}"  active=${b.is_active}  deleted=${!!b.deleted_at}  id=${b.id.slice(0,8)}`);
}

// 5. Find Ali Hamza (the creator referenced in the prompt)
const { data: ali } = await sb.from('profiles').select('id, display_name, email, role, is_active').or('display_name.ilike.%ali%hamza%,display_name.ilike.%hamza%ali%').limit(10);
console.log(`\nAli Hamza profiles: ${ali?.length || 0}`);
for (const a of ali || []) console.log(`  ${a.display_name?.padEnd(20)} ${a.email?.padEnd(30)} role=${a.role}  active=${a.is_active}  id=${a.id.slice(0,8)}`);
