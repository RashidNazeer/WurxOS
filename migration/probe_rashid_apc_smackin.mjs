import { sb } from './lib/supabase.js';

const { data: tls } = await sb
  .from('profiles')
  .select('id, display_name, reports_to, manager:reports_to(display_name, role)')
  .in('role', ['tl', 'pctl'])
  .eq('is_active', true).is('deleted_at', null)
  .order('role').order('display_name');
console.log('All active TLs / PCTLs and their managers:');
for (const t of tls || []) {
  const mgr = t.manager ? `${t.manager.display_name} (${t.manager.role})` : '(NULL)';
  console.log(`  ${t.display_name.padEnd(28)} → ${mgr}`);
}
