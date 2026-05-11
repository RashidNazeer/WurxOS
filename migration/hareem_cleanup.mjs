import { sb } from './lib/supabase.js';
const APPLY = process.argv.includes('--apply');

const { data: profs } = await sb
  .from('profiles')
  .select('id, display_name, role, email')
  .eq('email', 'hareem.asim@wurx.com')
  .limit(2);
if (!profs?.length) {
  const { data: byName } = await sb
    .from('profiles')
    .select('id, display_name, role, email')
    .ilike('display_name', 'Hareem%')
    .limit(5);
  console.log('No exact email match. Candidates by name:', byName);
  process.exit(1);
}
const u = profs[0];
console.log(`User: ${u.display_name} (${u.email}) role=${u.role} id=${u.id}\n`);

const { data: tasks } = await sb
  .from('tasks')
  .select('id, title, description, category, status, brand_id, due_date, created_at')
  .eq('assignee_id', u.id)
  .order('created_at', { ascending: true });

console.log(`Total tasks assigned to her: ${tasks?.length || 0}\n`);

const groups = new Map();
for (const t of (tasks || [])) {
  const key = `${(t.title || '').trim().toLowerCase()}|${t.category}|${t.brand_id || 'null'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(t);
}

const dupesToDelete = [];
for (const [key, arr] of groups) {
  if (arr.length > 1) {
    const keep = arr[0];
    const drop = arr.slice(1);
    console.log(`DUP (${arr.length}): "${keep.title}" [${keep.category}] brand=${keep.brand_id || 'personal'}`);
    console.log(`   keeping: ${keep.id} (${keep.created_at.slice(0,10)} status=${keep.status})`);
    for (const d of drop) {
      console.log(`   deleting: ${d.id} (${d.created_at.slice(0,10)} status=${d.status})`);
      dupesToDelete.push(d.id);
    }
  }
}
console.log(`\nDuplicate task IDs to delete: ${dupesToDelete.length}`);

const daily = (tasks || []).filter(t => t.category === 'daily' && t.status !== 'done' && !dupesToDelete.includes(t.id));
console.log(`\nDaily tasks to mark done: ${daily.length}`);
for (const t of daily) {
  console.log(`   ${t.id}  "${t.title}" current_status=${t.status}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN. Re-run with --apply to execute.');
  process.exit(0);
}

console.log('\n=== APPLYING ===');
if (dupesToDelete.length) {
  const { error: delErr } = await sb.from('tasks').delete().in('id', dupesToDelete);
  if (delErr) { console.error('Delete failed:', delErr); process.exit(1); }
  console.log(`Deleted ${dupesToDelete.length} duplicate tasks.`);
}
if (daily.length) {
  const ids = daily.map(t => t.id);
  const { error: updErr } = await sb
    .from('tasks')
    .update({ status: 'done', notify: false })
    .in('id', ids);
  if (updErr) { console.error('Mark-done failed:', updErr); process.exit(1); }
  console.log(`Marked ${daily.length} daily tasks as done.`);
}
console.log('Done.');
