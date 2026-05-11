import { sb } from './lib/supabase.js';

const ROMAIL = '76cea800-34f9-5fcc-8489-0bfe405534ff';

const { data } = await sb
  .from('attendance_edit_requests')
  .select('*, decider:decided_by(display_name)')
  .eq('user_id', ROMAIL)
  .order('created_at', { ascending: false })
  .limit(10);
console.log(`${data?.length || 0} edit requests for Romail:`);
for (const r of (data || [])) {
  console.log(`  ${r.created_at}  field=${r.field}  status=${r.status}  decided_by=${r.decider?.display_name || 'pending'}  reason=${r.reason?.slice(0,40)}`);
}

// Also check his recent attendance
console.log('\nRomail attendance last 5 days:');
const { data: att } = await sb
  .from('attendance')
  .select('date, clock_in, clock_out, status, auto_closed')
  .eq('user_id', ROMAIL)
  .order('date', { ascending: false })
  .limit(5);
for (const a of (att || [])) {
  console.log(`  ${a.date}  in=${a.clock_in?.slice(11,16)} out=${a.clock_out?.slice(11,16) || '-'} status=${a.status} auto_closed=${a.auto_closed}`);
}
