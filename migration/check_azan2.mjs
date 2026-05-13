import { sb } from './lib/supabase.js';

const AZAN = '0beaff2d-dc51-5cdb-a97e-a1f4a67b3f46';

// All tasks (any status) assigned to Azan
const { data: all } = await sb.from('tasks')
  .select('id, title, status, brand_id, recurrence, created_by, due_at, completed_at')
  .eq('assignee_id', AZAN);

console.log(`ALL tasks (any status) assigned to Azan: ${all?.length || 0}`);
const byStatus = {};
for (const t of (all || [])) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
console.log('  by status:', byStatus);

// Open tasks Azan created
const { data: cre } = await sb.from('tasks')
  .select('id, title, status, brand_id, recurrence, assignee_id, created_by, created_at')
  .eq('created_by', AZAN)
  .neq('status', 'done')
  .order('created_at', { ascending: false });
console.log(`\nOpen tasks Azan created: ${cre?.length || 0}`);
for (const t of (cre || []).slice(0, 12)) {
  console.log(`  "${t.title?.slice(0,40)}"  status=${t.status} recurrence=${t.recurrence} brand=${t.brand_id?.slice(0,8) || '—'} assignee=${t.assignee_id?.slice(0,8) || '—'}`);
}

// Audit history for Azan in brand switches
const { data: hist } = await sb.from('audit_log')
  .select('action, entity_id, before, after, created_at')
  .eq('entity_type', 'brands')
  .order('created_at', { ascending: false })
  .limit(80);

const azanEvents = (hist || []).filter((h) =>
  h.before?.assigned_apc === AZAN || h.after?.assigned_apc === AZAN
);
console.log(`\nAudit log brand-switch events touching Azan: ${azanEvents.length}`);
for (const h of azanEvents.slice(0, 10)) {
  console.log(`  ${h.created_at}  brand=${h.entity_id?.slice(0,8)}  before.apc=${h.before?.assigned_apc?.slice(0,8) || '—'} → after.apc=${h.after?.assigned_apc?.slice(0,8) || '—'}  (${h.after?.swap_side})`);
}
