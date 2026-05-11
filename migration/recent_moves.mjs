import { sb } from './lib/supabase.js';

const { data } = await sb
  .from('audit_log')
  .select('created_at, actor_id, action, entity_id, before, after')
  .like('action', 'team.move%')
  .order('created_at', { ascending: false })
  .limit(10);
for (const r of (data || [])) {
  console.log(`${r.created_at}  ${r.action}  entity=${r.entity_id}`);
  console.log(`  before: ${JSON.stringify(r.before)}`);
  console.log(`  after:  ${JSON.stringify(r.after)}`);
  console.log('');
}
