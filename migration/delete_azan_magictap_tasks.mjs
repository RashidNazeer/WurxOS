// Delete Azan's 4 leftover tasks from former brand "Magic Tap" (inactive)
// created by former TL Ali Hamza.

import { sb } from './lib/supabase.js';

const IDS = [
  'ecd4e636', // Outreach
  '192e3170', // Sample Approval
  '12510e10', // Video Reviews
  'dbc644c6', // Chat Sort
];

// Resolve full UUIDs by ID prefix — safer than hard-coding partials.
const AZAN = '0beaff2d-dc51-5cdb-a97e-a1f4a67b3f46';
const { data: candidates, error: qErr } = await sb.from('tasks')
  .select('id, title, status, brand_id, created_by, assignee_id, brands(brand_name, status), creator:created_by(display_name)')
  .eq('assignee_id', AZAN)
  .neq('status', 'done');
if (qErr) { console.error(qErr); process.exit(1); }

const toDelete = (candidates || []).filter((t) => IDS.some((p) => t.id.startsWith(p)));
console.log(`Matched ${toDelete.length} tasks (expected 4):\n`);
for (const t of toDelete) {
  console.log(`  ${t.id}  "${t.title}"  brand="${t.brands?.brand_name}"(${t.brands?.status})  creator="${t.creator?.display_name}"`);
}

// Safety guard: refuse if not exactly 4, or if any brand is currently active
if (toDelete.length !== 4) {
  console.error(`\nExpected 4 tasks, got ${toDelete.length}. Aborting.`);
  process.exit(1);
}
const anyActiveBrand = toDelete.some((t) => t.brands?.status === 'active');
if (anyActiveBrand) {
  console.error('\nOne of the matched tasks belongs to an ACTIVE brand. Aborting to be safe.');
  process.exit(1);
}

const { error } = await sb.from('tasks').delete().in('id', toDelete.map((t) => t.id));
if (error) { console.error('Delete failed:', error); process.exit(1); }
console.log(`\nDeleted ${toDelete.length} tasks.`);
