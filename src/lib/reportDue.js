// What report is due now, and what state it's in — pure helpers for Today.
//
// Weekly periods are the same 7-day chain the editors use (week 1 starts
// Sun 2026-03-29, see getFirstTimeWeekOptions). The "current reportable week"
// is the most recent week that has already ended (the APC reports on the week
// just finished); before the first one ends it is the week containing today.
// Unlike getFirstTimeWeekOptions this isn't capped at 20 weeks.
import { makeWeekFromStart } from './reportsApi';

const ANCHOR = new Date(2026, 2, 29);
const DAY = 86400000;

// Today's date in Pakistan time as YYYY-MM-DD.
export function pktToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(now);
}

export function currentReportableWeek(todayYmd = pktToday()) {
  const [y, m, d] = todayYmd.split('-').map(Number);
  const today = new Date(y, m - 1, d);
  // round, not floor: a DST change in the viewer's zone makes the gap ±1h.
  const daysSince = Math.round((today - ANCHOR) / DAY);
  if (daysSince < 7) return makeWeekFromStart(new Date(ANCHOR), 1);
  // Week i (0-based) covers ANCHOR+7i … ANCHOR+7i+6; the last ended one ends before today.
  const i = Math.floor(daysSince / 7) - 1;
  const start = new Date(ANCHOR);
  start.setDate(start.getDate() + i * 7);
  return makeWeekFromStart(start, i + 1);
}

// 'returned' (draft sent back with a note) is derived, never stored.
export function reportState(row) {
  if (!row) return 'not_started';
  if (row.status === 'draft') return row.rejectionNote ? 'returned' : 'draft';
  return row.status; // submitted | verified | approved
}

export const DONE_STATES = new Set(['submitted', 'verified', 'approved']);

// Sort weight: returned → overdue/not started → draft → done.
export function dueRank(state, overdue) {
  if (state === 'returned') return 0;
  if (state === 'not_started') return overdue ? 1 : 3;
  if (state === 'draft') return overdue ? 1 : 2;
  return 9;
}
