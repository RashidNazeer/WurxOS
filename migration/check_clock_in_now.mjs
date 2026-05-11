import { sb } from './lib/supabase.js';

// Most recent attendance row across everyone, last 24h
const { data } = await sb
  .from('attendance')
  .select('user_id, date, clock_in, clock_out, status, profiles:user_id(display_name, role)')
  .gte('clock_in', new Date(Date.now() - 24*3600*1000).toISOString())
  .order('clock_in', { ascending: false })
  .limit(15);
for (const r of (data || [])) {
  const ci = new Date(r.clock_in);
  const pkt = ci.toLocaleString('en-US', { timeZone: 'Asia/Karachi', hour12: true });
  console.log(`${r.profiles?.display_name?.padEnd(28)} ${r.profiles?.role?.padEnd(5)}  date=${r.date}  clock_in_UTC=${r.clock_in}  clock_in_PKT=${pkt}  status=${r.status}`);
}
