import { sb } from './lib/supabase.js';

const ALI = '7ab9eeb2-0398-577d-b25e-d57075ac817c';

// Same query getActiveRecord uses
const { data, error } = await sb.from('attendance')
  .select('id, user_id, date, clock_in, clock_out, status, auto_closed, auto_clock_out')
  .eq('user_id', ALI)
  .is('clock_out', null)
  .in('status', ['clocked-in', 'on-break', 'pending-approval'])
  .order('clock_in', { ascending: false })
  .limit(1)
  .maybeSingle();
console.log('Active record for Ali Hamza (service role):');
console.log({ error, data });

// Also check the RLS policy for attendance — what columns it filters on
const { data: pol } = await sb.rpc('exec_sql', { sql: `select policyname, cmd, qual from pg_policies where tablename='attendance' and cmd='r';` }).catch(() => ({ data: null }));
if (pol) console.log('\nRLS read policies on attendance:', pol);
