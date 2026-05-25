// Reset the current week's Weekly Agenda Meetings data (test cleanup).
//
// Clears ONLY agenda-module tables:
//   * agenda_resources        — all rows
//   * agenda_tasks            — all rows (agenda_task_reviews cascade)
//   * agenda_meetings         — current week only (attendance /
//                               presentations / task_reviews cascade)
//
// Does NOT touch: normal `tasks` / `resources`, agenda_team_schedules,
// agenda_settings, profiles.agenda_reset, users, teams, or any other
// module. Previous/future weeks' agenda_meetings are left intact.
import { sb } from './lib/supabase.js';

const ALL = '00000000-0000-0000-0000-000000000000';

function currentMonday() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const MON = currentMonday();

async function count(table, filter) {
  let q = sb.from(table).select('id', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) { console.log(`  ! ${table}: ${error.message}`); return -1; }
  return c ?? 0;
}

console.log(`Current week Monday (week_start): ${MON}\n`);

console.log('— BEFORE —');
console.log(`  agenda_tasks:         ${await count('agenda_tasks')}`);
console.log(`  agenda_resources:     ${await count('agenda_resources')}`);
console.log(`  agenda_task_reviews:  ${await count('agenda_task_reviews')}`);
console.log(`  agenda_presentations: ${await count('agenda_presentations')}`);
console.log(`  agenda_meeting_attendance: ${await count('agenda_meeting_attendance')}`);
const { data: wk } = await sb.from('agenda_meetings').select('week_start');
const byWeek = {};
(wk || []).forEach((r) => { byWeek[r.week_start] = (byWeek[r.week_start] || 0) + 1; });
console.log(`  agenda_meetings by week_start: ${JSON.stringify(byWeek)}`);

console.log('\n— DELETING (agenda module only) —');
let r;
r = await sb.from('agenda_resources').delete().neq('id', ALL);
console.log(`  agenda_resources       ${r.error ? 'ERR ' + r.error.message : 'cleared'}`);
r = await sb.from('agenda_tasks').delete().neq('id', ALL);
console.log(`  agenda_tasks           ${r.error ? 'ERR ' + r.error.message : 'cleared (task_reviews cascade)'}`);
r = await sb.from('agenda_meetings').delete().eq('week_start', MON);
console.log(`  agenda_meetings@${MON}  ${r.error ? 'ERR ' + r.error.message : 'cleared (attendance/presentations/reviews cascade)'}`);

console.log('\n— AFTER —');
console.log(`  agenda_tasks:              ${await count('agenda_tasks')}`);
console.log(`  agenda_resources:          ${await count('agenda_resources')}`);
console.log(`  agenda_task_reviews:       ${await count('agenda_task_reviews')}`);
console.log(`  agenda_presentations:      ${await count('agenda_presentations')}`);
console.log(`  agenda_meeting_attendance: ${await count('agenda_meeting_attendance')}`);
console.log(`  agenda_meetings (this wk): ${await count('agenda_meetings', (q) => q.eq('week_start', MON))}`);
console.log(`  agenda_meetings (total):   ${await count('agenda_meetings')}`);
console.log(`  agenda_team_schedules:     ${await count('agenda_team_schedules')}  (kept)`);
console.log('\nDone — current week is reset. Schedules, settings and all normal tasks/resources untouched.');
