// Close any v2 attendance rows that are still in 'clocked-in' status.
// Mirrors v2's pg_cron 8h auto-close (mig 126) but applies to all open
// shifts regardless of clock-in age. Sets:
//   status = 'clocked-out'
//   clock_out = now()
//   auto_closed = true
//   auto_closed_at = now()
//   total_work_ms / total_break_ms computed from existing clock_in / breaks
//
// Idempotent — re-running has no effect because all rows are already closed.

import { sb } from './lib/supabase.js';

const APPLY = process.argv.includes('--apply');

const { data: open, error } = await sb.from('attendance')
  .select('id, user_id, date, clock_in, breaks, profiles:user_id(display_name, role)')
  .eq('status', 'clocked-in')
  .order('clock_in', { ascending: true });

if (error) { console.error(error); process.exit(1); }

console.log(`Open shifts in v2: ${open?.length || 0}\n`);
if (!open || open.length === 0) {
  console.log('Nothing to close.');
  process.exit(0);
}

const now = new Date();
console.log(`Will close (set clock_out = ${now.toISOString()}):`);
const rows = [];
for (const r of open) {
  const inMs = new Date(r.clock_in).getTime();
  const outMs = now.getTime();
  const totalMs = outMs - inMs;

  // Sum break durations from breaks array
  let breakMs = 0;
  const breaks = Array.isArray(r.breaks) ? r.breaks : [];
  const closedBreaks = [];
  for (const b of breaks) {
    if (!b?.start) continue;
    const bs = new Date(b.start).getTime();
    const be = b.end ? new Date(b.end).getTime() : outMs; // close ongoing breaks too
    breakMs += Math.max(0, be - bs);
    closedBreaks.push({ ...b, end: b.end || now.toISOString() });
  }
  const workMs = Math.max(0, totalMs - breakMs);

  rows.push({
    id: r.id,
    user_id: r.user_id,
    name: r.profiles?.display_name || '?',
    role: r.profiles?.role || '?',
    date: r.date,
    clock_in: r.clock_in,
    work_ms: workMs,
    break_ms: breakMs,
    breaks: closedBreaks,
  });
  const dur = (workMs / 3_600_000).toFixed(2);
  console.log(`  ${r.profiles?.display_name?.padEnd(28) || '?'} ${r.profiles?.role?.padEnd(4) || '?'} date=${r.date}  in=${r.clock_in?.slice(11, 16)}  work=${dur}h  breaks=${closedBreaks.length}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN — re-run with --apply to close these shifts.');
  process.exit(0);
}

let ok = 0, fail = 0;
for (const r of rows) {
  const { error: ue } = await sb.from('attendance')
    .update({
      status: 'clocked-out',
      clock_out: now.toISOString(),
      total_work_ms: r.work_ms,
      total_break_ms: r.break_ms,
      breaks: r.breaks,
      auto_closed: true,
      auto_closed_at: now.toISOString(),
    })
    .eq('id', r.id);
  if (ue) { fail++; console.log(`  FAIL ${r.name}: ${ue.message}`); }
  else { ok++; }
}
console.log(`\nClosed ${ok}/${rows.length} shifts.${fail ? ` ${fail} failures.` : ''}`);
process.exit(0);
