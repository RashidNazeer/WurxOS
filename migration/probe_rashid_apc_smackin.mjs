// Backfill the timing-gap cascade for Umar Ilyas. Mimics what the
// trigger WOULD have done if mig 190 had existed at the time of the
// YesDay brand switch on 2026-06-01.
import { sb } from './lib/supabase.js';

const UMAR     = '5d15f70d-cf9f-5a4f-a936-1153d1b352e8';
const MUSTAFA  = 'e3983541-0195-590c-a466-e61e2e430f1a';
const ALI      = '7ab9eeb2-0398-577d-b25e-d57075ac817c';
const YESDAY   = 'ad94a665-843f-5298-b0b9-a6e1afb8364a';

console.log('Pre-state:');
const { data: pre } = await sb.from('profiles').select('reports_to').eq('id', UMAR).single();
const { count: preTasks } = await sb.from('tasks').select('*', { count: 'exact', head: true })
  .eq('assignee_id', UMAR).eq('brand_id', YESDAY).eq('created_by', MUSTAFA);
console.log(`  Umar.reports_to: ${pre.reports_to === MUSTAFA ? 'Mustafa' : pre.reports_to}`);
console.log(`  Stale brand-tasks (created_by=Mustafa): ${preTasks}`);

// 1. profiles.reports_to
const { error: rErr } = await sb
  .from('profiles')
  .update({ reports_to: ALI, updated_at: new Date().toISOString() })
  .eq('id', UMAR);
if (rErr) { console.error('profile update failed:', rErr); process.exit(1); }
console.log('\n  ✓ profiles.reports_to updated → Ali Hamza');

// 2. tasks.created_by — exact same gate as the trigger
const { error: tErr, count: updatedCount } = await sb
  .from('tasks')
  .update({ created_by: ALI, updated_at: new Date().toISOString() }, { count: 'exact' })
  .eq('assignee_id', UMAR)
  .eq('brand_id', YESDAY)
  .eq('created_by', MUSTAFA);
if (tErr) { console.error('tasks update failed:', tErr); process.exit(1); }
console.log(`  ✓ tasks.created_by updated → Ali Hamza for ${updatedCount ?? '?'} rows`);

// 3. audit_log entry mirroring what the trigger would have written
await sb.from('audit_log').insert({
  actor_id: null,
  action: 'brand.cascade_apc_reports_to.backfill',
  entity_type: 'brands',
  entity_id: YESDAY,
  before: { previous_owner: MUSTAFA, new_owner: ALI, note: 'Brand owner change occurred 2026-06-01T14:44:17Z, BEFORE migration 190 (cascade trigger) was installed. This backfill replays what the trigger would have done.' },
  after:  { apcs_reassigned: 1, tasks_rewritten: updatedCount ?? 0, profile: UMAR },
});
console.log('  ✓ audit_log row recorded');

// Verify
console.log('\nPost-state:');
const { data: post } = await sb.from('profiles').select('reports_to, current_tl:reports_to(display_name)').eq('id', UMAR).single();
console.log(`  Umar.reports_to: ${post.current_tl?.display_name} (${post.reports_to})`);
const { count: postTasks } = await sb.from('tasks').select('*', { count: 'exact', head: true })
  .eq('assignee_id', UMAR).eq('brand_id', YESDAY).eq('created_by', MUSTAFA);
console.log(`  Stale brand-tasks (still created_by=Mustafa): ${postTasks}`);
const { count: newCreatorTasks } = await sb.from('tasks').select('*', { count: 'exact', head: true })
  .eq('assignee_id', UMAR).eq('brand_id', YESDAY).eq('created_by', ALI);
console.log(`  Brand-tasks now created_by=Ali: ${newCreatorTasks}`);
