// Final state probe — Salary Management feature
import { sb } from './lib/supabase.js';

const { count: comp } = await sb.from('employee_compensation').select('*', { count: 'exact', head: true });
const { count: hist } = await sb.from('salary_history').select('*', { count: 'exact', head: true });
const { count: anni } = await sb.from('anniversary_celebrations').select('*', { count: 'exact', head: true });
console.log(`employee_compensation: ${comp}`);
console.log(`salary_history:        ${hist}`);
console.log(`anniversary_celebrations: ${anni}`);

const { data: hireSet } = await sb
  .from('profiles')
  .select('id', { count: 'exact' })
  .not('start_date', 'is', null)
  .is('deleted_at', null);
console.log(`profiles with start_date: ${hireSet?.length || 0}`);

// Try the cron job listing — may or may not be readable depending on RLS.
try {
  const { data: cronRes } = await sb.rpc('daily_anniversary_sweep');
  console.log(`daily_anniversary_sweep test run: returned ${cronRes} (would-notify count for today)`);
} catch (e) {
  console.log(`daily_anniversary_sweep call: ${e.message}`);
}
