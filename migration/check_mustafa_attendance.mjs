import { sb } from './lib/supabase.js';

// Find Mustafa Jan
const { data: profiles } = await sb
  .from('profiles')
  .select('id, display_name, email, role')
  .ilike('display_name', '%mustafa%')
  .is('deleted_at', null);

console.log('Matches for "mustafa":');
for (const p of profiles || []) console.log(`  ${p.id}  ${p.display_name}  ${p.email}  role=${p.role}`);

const target = (profiles || []).find(p => /mustafa\s*jan/i.test(p.display_name || '')) || (profiles || [])[0];
if (!target) { console.log('No Mustafa found'); process.exit(0); }
console.log(`\nUsing user: ${target.display_name}  (${target.id})  role=${target.role}\n`);

// Fetch all attendance rows for this user
const { data: rows, error } = await sb
  .from('attendance')
  .select('date, clock_in, clock_out, status')
  .eq('user_id', target.id)
  .order('date', { ascending: true });
if (error) { console.error(error); process.exit(1); }

console.log(`Total attendance rows: ${rows.length}`);

// Bucket by month
const byMonth = {};
for (const r of rows) {
  const ym = (r.date || '').slice(0, 7);
  if (!byMonth[ym]) byMonth[ym] = { present: 0, absent: 0, half: 0, dates: [] };
  if (r.status === 'present') byMonth[ym].present++;
  else if (r.status === 'half_day') byMonth[ym].half++;
  else byMonth[ym].absent++;
  byMonth[ym].dates.push(`${r.date}=${r.status}`);
}
for (const ym of Object.keys(byMonth).sort()) {
  const b = byMonth[ym];
  console.log(`\n${ym}: present=${b.present}  half=${b.half}  other=${b.absent}`);
  console.log('  ' + b.dates.join(', '));
}

// Approved leaves
const { data: leaves } = await sb
  .from('leave_requests')
  .select('start_date, end_date, type, status')
  .eq('user_id', target.id)
  .eq('status', 'approved')
  .order('start_date', { ascending: true });
console.log(`\nApproved leaves (${(leaves || []).length}):`);
for (const l of leaves || []) {
  console.log(`  ${l.start_date} → ${l.end_date}  type=${l.type}`);
}
