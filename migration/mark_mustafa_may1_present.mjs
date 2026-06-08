import { sb } from './lib/supabase.js';

// Reusable: mark one or more dates as present (zero-hour clock-in row).
// Usage: node migration/mark_mustafa_may1_present.mjs <user_id> <YYYY-MM-DD> [YYYY-MM-DD ...]
const [, , uid, ...dates] = process.argv;
if (!uid || !dates.length) {
  console.error('usage: node migration/mark_mustafa_may1_present.mjs <user_id> <YYYY-MM-DD> [more dates...]');
  process.exit(1);
}

for (const date of dates) {
  const t = `${date}T11:00:00+00:00`;
  const row = {
    user_id: uid,
    date,
    clock_in:  t,
    clock_out: t,
    status: 'clocked-out',
    breaks: [],
    total_work_ms:  0,
    total_break_ms: 0,
    auto_closed: false,
    legacy_id: `att:manualpresent_${uid}_${date}`,
    location: 'bahria',
    created_at: new Date().toISOString(),
  };
  const { data, error } = await sb
    .from('attendance')
    .insert(row)
    .select('id, date, status, total_work_ms')
    .single();
  if (error) {
    console.error(`insert failed for ${date}:`, error.message);
    continue;
  }
  console.log(`Inserted: user=${uid} date=${data.date} status=${data.status} hours=${data.total_work_ms}ms`);
}
