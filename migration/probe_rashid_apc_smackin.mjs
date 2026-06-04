// Mark Muhammd Fahad (OL) present for June 2 and June 3 with 8h work each.
// Uses 09:00–17:00 Asia/Karachi (04:00–12:00 UTC) so the timestamps look
// natural in his timezone.
import { sb } from './lib/supabase.js';

const UID = 'f9c7bfb1-cf20-505d-afec-d4a459354216';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

const DATES = ['2026-06-02', '2026-06-03'];

for (const date of DATES) {
  const { data: existing } = await sb
    .from('attendance').select('id').eq('user_id', UID).eq('date', date).maybeSingle();
  if (existing) { console.log(`  ${date}: already exists, skip`); continue; }

  // 09:00 PKT = 04:00 UTC; 17:00 PKT = 12:00 UTC. 8h flat.
  const clockIn  = `${date}T04:00:00+00:00`;
  const clockOut = `${date}T12:00:00+00:00`;

  const { error } = await sb.from('attendance').insert({
    user_id: UID,
    date,
    clock_in: clockIn,
    clock_out: clockOut,
    status: 'clocked-out',
    breaks: [],
    total_work_ms: EIGHT_HOURS_MS,
    total_break_ms: 0,
    auto_closed: false,
    legacy_id: `att:manualpresent_${UID}_${date}`,
    location: 'bahria',
    created_at: new Date().toISOString(),
  });
  console.log(`  ${date}: ${error ? '✗ ' + error.message : '✓ inserted present (8h)'}`);
}

// Verify
const { data: post } = await sb
  .from('attendance').select('date, status, total_work_ms')
  .eq('user_id', UID).gte('date', '2026-06-01').order('date');
console.log('\nFahad June attendance now:');
for (const r of post || []) console.log(`  ${r.date}  ${r.status}  ${((r.total_work_ms || 0) / 3600000).toFixed(2)}h`);
