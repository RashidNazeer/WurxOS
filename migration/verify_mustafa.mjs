// Quick state probe for the Salary Management feature.
import { sb } from './lib/supabase.js';

const { count: compCount } = await sb
  .from('employee_compensation')
  .select('*', { count: 'exact', head: true });
console.log(`employee_compensation rows: ${compCount}`);

const { count: histCount } = await sb
  .from('salary_history')
  .select('*', { count: 'exact', head: true });
console.log(`salary_history rows:        ${histCount}`);

const { data: hire } = await sb
  .from('profiles')
  .select('display_name, role, start_date')
  .not('start_date', 'is', null)
  .is('deleted_at', null)
  .order('display_name');
console.log(`\nprofiles with start_date set: ${hire.length}`);
for (const p of hire) {
  console.log(`  ${p.display_name.padEnd(28)} ${p.role.padEnd(5)}  ${p.start_date}`);
}
