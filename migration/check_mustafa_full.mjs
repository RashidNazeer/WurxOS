import { sb } from './lib/supabase.js';

const uid = 'e3983541-0195-590c-a466-e61e2e430f1a';
const month = '2026-05';
const today = '2026-05-31';

// Attendance
const { data: att } = await sb
  .from('attendance')
  .select('date, status')
  .eq('user_id', uid)
  .gte('date', `${month}-01`)
  .lte('date', `${month}-31`)
  .order('date', { ascending: true });

const clockedDates = new Set((att || []).map(r => r.date));
console.log(`Clocked dates (${clockedDates.size}): ${[...clockedDates].join(', ')}`);

// Holidays
const { data: hols } = await sb
  .from('company_holidays')
  .select('start_date, end_date, label')
  .lte('start_date', `${month}-31`)
  .gte('end_date',   `${month}-01`);
console.log(`\nHoliday rows overlapping May 2026 (${(hols || []).length}):`);
const holSet = new Set();
for (const h of hols || []) {
  console.log(`  ${h.start_date} → ${h.end_date}  ${h.label}`);
  let d = new Date(h.start_date + 'T00:00:00Z');
  const end = new Date(h.end_date + 'T00:00:00Z');
  while (d <= end) {
    const ymd = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && ymd.startsWith(month)) holSet.add(ymd);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
console.log(`Holiday weekdays in May: ${[...holSet].sort().join(', ')}`);

// Approved leaves overlapping May
const { data: leaves } = await sb
  .from('leave_requests')
  .select('start_date, end_date, type, status')
  .eq('user_id', uid)
  .eq('status', 'approved');
console.log(`\nApproved leaves (any): ${(leaves || []).length}`);
const leaveSet = new Set();
for (const l of leaves || []) {
  // expand weekdays only
  let d = new Date(l.start_date + 'T00:00:00Z');
  const end = new Date(l.end_date + 'T00:00:00Z');
  while (d <= end) {
    const ymd = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay(); // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6 && ymd.startsWith(month)) leaveSet.add(ymd);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
console.log(`Leave weekdays in May: ${leaveSet.size}`);

// Build day list for May 1..31, classify each
const days = [];
for (let n = 1; n <= 31; n++) {
  const ymd = `${month}-${String(n).padStart(2, '0')}`;
  if (ymd > today) break;
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();
  const isWeekend = (dow === 0 || dow === 6);
  const isHoliday = holSet.has(ymd);
  const isLeave = leaveSet.has(ymd);
  const isClocked = clockedDates.has(ymd);
  let bucket;
  if (isClocked) bucket = 'present';
  else if (isWeekend) bucket = 'weekend';
  else if (isHoliday) bucket = 'holiday';
  else if (isLeave) bucket = 'leave';
  else bucket = 'missed';
  days.push({ ymd, dow, bucket });
}

const counts = { present: 0, weekend: 0, holiday: 0, leave: 0, missed: 0 };
for (const d of days) counts[d.bucket]++;
console.log(`\nDays elapsed: ${days.length}`);
console.log(`  Present (clocked):   ${counts.present}`);
console.log(`  Weekend (auto):      ${counts.weekend}`);
console.log(`  Holiday (auto):      ${counts.holiday}`);
console.log(`  Approved leave:      ${counts.leave}`);
console.log(`  Missed:              ${counts.missed}`);
console.log(`\nMissed weekdays: ${days.filter(d => d.bucket === 'missed').map(d => d.ymd).join(', ')}`);

const covered = counts.present + counts.weekend + counts.holiday + counts.leave;
console.log(`\nAttendance score: ${covered}/${days.length} = ${((covered / days.length) * 100).toFixed(1)}%`);
