import { sb } from './lib/supabase.js';

// All TLs and whether they have an open shift today (PKT)
const { data: tls } = await sb
  .from('profiles')
  .select('id, display_name')
  .in('role', ['tl', 'pctl'])
  .eq('is_active', true);

console.log('TL clock-in status (most recent attendance):');
for (const tl of tls || []) {
  const { data: a } = await sb
    .from('attendance')
    .select('date, clock_in, clock_out, status, auto_closed')
    .eq('user_id', tl.id)
    .order('clock_in', { ascending: false })
    .limit(1);
  if (!a || !a.length) {
    console.log(`  ${tl.display_name.padEnd(28)} (no attendance)`);
    continue;
  }
  const r = a[0];
  const open = r.clock_out == null && (r.status === 'clocked-in' || r.status === 'on-break');
  console.log(`  ${tl.display_name.padEnd(28)} date=${r.date} status=${r.status.padEnd(12)} OPEN=${open}`);
}
