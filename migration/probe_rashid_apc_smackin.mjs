import { sb } from './lib/supabase.js';

const DEV = '87f3419d-5c90-537e-b41e-e4097330d670';

const { data: rashid } = await sb
  .from('profiles').select('id, display_name, role, reports_to, manager:reports_to(display_name, role)')
  .eq('id', DEV).single();
console.log(`Rashid (developer):`);
console.log(`  reports_to: ${rashid.reports_to || '(null)'}`);
console.log(`  manager:    ${rashid.manager?.display_name || '(none)'} (${rashid.manager?.role || 'n/a'})`);

if (!rashid.reports_to || rashid.manager?.role !== 'boss') {
  console.log('\n  ⚠ Needs fixing — should report to Boss directly.');
  const { data: boss } = await sb
    .from('profiles').select('id, display_name').eq('role', 'boss').eq('is_active', true)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!boss) { console.log('  no active Boss found'); process.exit(1); }
  console.log(`  setting reports_to = ${boss.display_name} (${boss.id})`);
  const { error } = await sb.from('profiles')
    .update({ reports_to: boss.id, updated_at: new Date().toISOString() })
    .eq('id', DEV);
  if (error) { console.error(error); process.exit(1); }
  console.log('  ✓ updated');
} else {
  console.log('  ✓ Already correctly reports to Boss.');
}
