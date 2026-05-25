// Inspect leave_quota for all IPCs — diagnose Shumyle Asim's WFH 0/0.
import { sb } from './lib/supabase.js';

const { data: rows, error } = await sb
  .from('profiles')
  .select('id, display_name, email, role, leave_quota')
  .eq('role', 'ipc')
  .is('deleted_at', null);
if (error) { console.log('ERR', error.message); process.exit(1); }

console.log('IPC leave_quota values:');
for (const r of rows || []) {
  console.log(`  ${r.display_name} | ${r.email}`);
  console.log(`     leave_quota = ${JSON.stringify(r.leave_quota)}`);
}
