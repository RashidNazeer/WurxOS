// Fix Hareem Asim's break for 2026-05-13.
// Current: 19:51 → 01:26 PKT (5.5h)
// Target:  20:47 → 21:42 PKT (55 min)
//
// All timestamps are PKT (UTC+5). Stored as UTC in DB.

import { sb } from './lib/supabase.js';

const ROW_ID = '425a3728-1a40-4999-96c0-819fe8645df1';
const HAREEM_ID = '27f2a01e-6816-5309-bed5-b05065a00007';

// 20:47 PKT 2026-05-13 = 15:47 UTC
// 21:42 PKT 2026-05-13 = 16:42 UTC
const NEW_BREAK_START_UTC = '2026-05-13T15:47:00.000+00:00';
const NEW_BREAK_END_UTC   = '2026-05-13T16:42:00.000+00:00';

const newBreakMs = new Date(NEW_BREAK_END_UTC).getTime() - new Date(NEW_BREAK_START_UTC).getTime();
console.log(`New break duration: ${newBreakMs} ms = ${newBreakMs / 60000} min`);

// Fetch row first for sanity check + clock_in/clock_out values.
const { data: row, error: gErr } = await sb
  .from('attendance')
  .select('id, date, clock_in, clock_out, breaks, total_break_ms, total_work_ms')
  .eq('id', ROW_ID)
  .single();
if (gErr) { console.log('fetch ERR', gErr.message); process.exit(1); }
console.log('\nBEFORE:');
console.log(JSON.stringify(row, null, 2));

const clockInMs  = new Date(row.clock_in).getTime();
const clockOutMs = new Date(row.clock_out).getTime();
const shiftMs    = clockOutMs - clockInMs;
const newWorkMs  = Math.max(0, shiftMs - newBreakMs);
console.log(`\nShift span: ${shiftMs} ms = ${(shiftMs / 3600000).toFixed(2)} h`);
console.log(`New total_work_ms: ${newWorkMs} ms = ${(newWorkMs / 3600000).toFixed(2)} h`);

const newBreaks = [{ start: NEW_BREAK_START_UTC, end: NEW_BREAK_END_UTC }];

const { data: updated, error: uErr } = await sb
  .from('attendance')
  .update({
    breaks:         newBreaks,
    total_break_ms: newBreakMs,
    total_work_ms:  newWorkMs,
  })
  .eq('id', ROW_ID)
  .select('id, date, clock_in, clock_out, breaks, total_break_ms, total_work_ms')
  .single();
if (uErr) { console.log('update ERR', uErr.message); process.exit(1); }

console.log('\nAFTER:');
console.log(JSON.stringify(updated, null, 2));

// Audit-log the manual fix so it's traceable later. We don't know
// who's running this, so log with a null actor and a clear note.
const { error: lErr } = await sb
  .from('audit_log')
  .insert({
    actor_id:    null,
    action:      'attendance.manual_break_fix',
    entity_type: 'attendance',
    entity_id:   ROW_ID,
    before: { breaks: row.breaks, total_break_ms: row.total_break_ms, total_work_ms: row.total_work_ms },
    after:  { breaks: newBreaks,  total_break_ms: newBreakMs,         total_work_ms: newWorkMs },
  });
if (lErr) console.log('audit ERR (non-fatal):', lErr.message);
else console.log('\nAudit log entry written.');
