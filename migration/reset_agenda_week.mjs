import { sb } from './lib/supabase.js';

// Reset (wipe) a week's Weekly Agenda Meeting records so the team can start
// fresh. Deletes the agenda_meetings rows for the target week_start; child
// rows (agenda_meeting_attendance, agenda_presentations, agenda_task_reviews)
// cascade away with them (mig 179 FKs).
//
// Does NOT touch agenda_team_schedules (the recurring OL-set slots). After a
// reset, the OL opens Agenda -> Upcoming Meetings and clicks "Notify Teams"
// to re-materialise fresh 'upcoming' meetings for the week.
//
// By DEFAULT it only resets 'upcoming' + 'ongoing' meetings and PRESERVES
// 'completed' ones (they hold real attendance/evaluation history) — same
// principle as mig 197. Pass --include-completed to wipe those too.
//
// Safe by default: DRY RUN prints what would be deleted/kept. Pass --apply to
// actually delete. Target week defaults to the current week's Monday;
// override with --week=YYYY-MM-DD (must be the Monday / week_start).
//
// Usage:
//   node migration/reset_agenda_week.mjs                               # dry run, this week
//   node migration/reset_agenda_week.mjs --apply                       # reset upcoming+ongoing this week
//   node migration/reset_agenda_week.mjs --apply --include-completed   # also wipe completed
//   node migration/reset_agenda_week.mjs --week=2026-06-08 --apply

const args             = process.argv.slice(2);
const apply            = args.includes('--apply');
const includeCompleted = args.includes('--include-completed');
const weekArg          = (args.find((a) => a.startsWith('--week=')) || '').split('=')[1];

// Monday of the current week, as YYYY-MM-DD (local date).
function thisMonday() {
  const d = new Date();
  const dow = d.getDay();                    // 0=Sun .. 6=Sat
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const TARGET_STATUSES = includeCompleted
  ? ['upcoming', 'ongoing', 'completed']
  : ['upcoming', 'ongoing'];

async function main() {
  const weekStart = weekArg || thisMonday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    console.error(`Invalid --week value: "${weekStart}" (expected YYYY-MM-DD).`);
    process.exitCode = 1; return;
  }

  console.log(`Target week_start : ${weekStart}`);
  console.log(`Reset statuses    : ${TARGET_STATUSES.join(', ')}${includeCompleted ? '' : '  (completed meetings preserved)'}`);
  console.log(apply ? '*** APPLY MODE — meetings WILL be deleted ***'
                    : 'DRY RUN — no changes. Re-run with --apply to delete.');

  const { data: meetings, error } = await sb
    .from('agenda_meetings')
    .select('id, tl_id, meeting_date, meeting_time, status, tl:tl_id(display_name)')
    .eq('week_start', weekStart)
    .order('meeting_date', { ascending: true });
  if (error) { console.error('Fetch failed:', error.message); process.exitCode = 1; return; }

  if (!meetings.length) {
    console.log(`\nNo agenda meetings found for week ${weekStart}. Nothing to reset.`);
    return;
  }

  const toDelete = meetings.filter((m) => TARGET_STATUSES.includes(m.status));
  const toKeep   = meetings.filter((m) => !TARGET_STATUSES.includes(m.status));

  console.log(`\nWeek ${weekStart}: ${meetings.length} meeting(s) — ${toDelete.length} to delete, ${toKeep.length} kept.`);
  for (const m of meetings) {
    const mark = TARGET_STATUSES.includes(m.status) ? 'DELETE' : 'keep  ';
    console.log(`  [${mark}] ${(m.tl?.display_name || m.tl_id).padEnd(28)} ${m.meeting_date} ${m.meeting_time}  [${m.status}]`);
  }

  if (!toDelete.length) { console.log('\nNothing matches the target statuses. Done.'); return; }

  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to delete the marked rows');
    console.log('(child attendance / presentations / task reviews cascade automatically).');
    return;
  }

  const { error: delErr } = await sb
    .from('agenda_meetings')
    .delete()
    .eq('week_start', weekStart)
    .in('status', TARGET_STATUSES);
  if (delErr) { console.error('Delete failed:', delErr.message); process.exitCode = 1; return; }

  console.log(`\nDeleted ${toDelete.length} meeting(s) for week ${weekStart}. Child rows cascaded.`);
  console.log('Next: OL opens Agenda -> Upcoming Meetings and clicks "Notify Teams" to start fresh.');
}

main();
