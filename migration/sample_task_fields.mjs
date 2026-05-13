// Inspect which optional task fields are actually populated so we
// only build filters for fields with real data.
import { sb } from './lib/supabase.js';

const { data: tasks, count } = await sb.from('tasks')
  .select('priority, category, due_date, brand_id, assignee_id, status', { count: 'exact' })
  .neq('status', 'done')
  .limit(2000);

console.log(`Sampled ${tasks?.length || 0} open tasks (total open: ${count})`);
const stats = {
  hasPriority: 0, prioritySet: new Set(),
  hasCategory: 0, categorySet: new Set(),
  hasDueDate: 0,
  hasBrand: 0,
  hasAssignee: 0,
};
for (const t of tasks || []) {
  if (t.priority && t.priority !== '') { stats.hasPriority++; stats.prioritySet.add(t.priority); }
  if (t.category && t.category !== '') { stats.hasCategory++; stats.categorySet.add(t.category); }
  if (t.due_date)   stats.hasDueDate++;
  if (t.brand_id)   stats.hasBrand++;
  if (t.assignee_id) stats.hasAssignee++;
}
console.log(JSON.stringify({
  hasPriority: `${stats.hasPriority}/${tasks.length}`,
  priorities: [...stats.prioritySet],
  hasCategory: `${stats.hasCategory}/${tasks.length}`,
  categories: [...stats.categorySet],
  hasDueDate: `${stats.hasDueDate}/${tasks.length}`,
  hasBrand:   `${stats.hasBrand}/${tasks.length}`,
  hasAssignee: `${stats.hasAssignee}/${tasks.length}`,
}, null, 2));
