// Mark Rashid (developer) present for Fri Jun 5 — 8h clocked-out row,
// no adjustment trail. Same pattern as the Fahad/Mustafa/Shumyle
// backfills earlier in the session.
import { sb } from './lib/supabase.js';

const UID  = '87f3419d-5c90-537e-b41e-e4097330d670';   // Rashid (developer)
const DATE = '2026-06-05';
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

const { data: existing } = await sb
  .from('attendance').select('id').eq('user_id', UID).eq('date', DATE).maybeSingle();
if (existing) { console.log('  already exists, skip'); process.exit(0); }

const clockIn  = `${DATE}T04:00:00+00:00`;   // 09:00 PKT
const clockOut = `${DATE}T12:00:00+00:00`;   // 17:00 PKT

const { error } = await sb.from('attendance').insert({
  user_id: UID,
  date: DATE,
  clock_in: clockIn,
  clock_out: clockOut,
  status: 'clocked-out',
  breaks: [],
  total_work_ms: EIGHT_HOURS_MS,
  total_break_ms: 0,
  auto_closed: false,
  legacy_id: `att:manualpresent_${UID}_${DATE}`,
  location: 'bahria',
  created_at: new Date().toISOString(),
});
console.log(error ? '✗ ' + error.message : `✓ Inserted Jun 5 present (8h) for Rashid (developer)`);
