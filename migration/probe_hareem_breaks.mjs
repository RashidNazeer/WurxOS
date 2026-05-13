// Read-only probe for Hareem.asim@wurx.com — find today's attendance
// row and her current breaks array so we know what to edit.

import { sb } from './lib/supabase.js';

// 1. Find Hareem
const { data: hareems, error: hErr } = await sb
  .from('profiles')
  .select('id, display_name, email, role')
  .ilike('email', '%hareem%');
if (hErr) { console.log('lookup ERR', hErr.message); process.exit(1); }
console.log('Hareem matches:');
console.log(hareems);
if (!hareems?.length) { console.log('No match'); process.exit(0); }

const hareem = hareems[0];
console.log(`\nUsing: ${hareem.display_name} (${hareem.email}) — id=${hareem.id}`);

// 2. Today's attendance row in Karachi local date (and yesterday's,
//    in case the shift spans midnight). Karachi is UTC+5.
const nowKa = new Date(Date.now() + 5 * 3600_000);
const pad = (n) => String(n).padStart(2, '0');
const todayKa = `${nowKa.getUTCFullYear()}-${pad(nowKa.getUTCMonth() + 1)}-${pad(nowKa.getUTCDate())}`;
const yKa = new Date(nowKa.getTime() - 86400_000);
const yestKa = `${yKa.getUTCFullYear()}-${pad(yKa.getUTCMonth() + 1)}-${pad(yKa.getUTCDate())}`;

console.log(`\nLooking up attendance for ${todayKa} and ${yestKa}`);
const { data: rows, error: aErr } = await sb
  .from('attendance')
  .select('id, date, clock_in, clock_out, status, breaks, total_break_ms, total_work_ms')
  .eq('user_id', hareem.id)
  .in('date', [todayKa, yestKa])
  .order('date', { ascending: false });
if (aErr) { console.log('attendance ERR', aErr.message); process.exit(1); }
console.log(JSON.stringify(rows, null, 2));
