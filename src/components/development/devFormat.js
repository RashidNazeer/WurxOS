// Formatting helpers for the Development workspace.
//
// The team plans its two-week blocks in Asia/Karachi, so "today" is that
// calendar day. A stored YYYY-MM-DD is formatted as the day it names, never
// shifted by the viewer's own timezone.

const TIME_ZONE = 'Asia/Karachi';

const dayParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Karachi calendar day of a moment, as YYYY-MM-DD. */
export function isoDay(value) {
  const parts = Object.fromEntries(
    dayParts.formatToParts(new Date(value)).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The previous version parsed a Karachi wall-clock string as local time and
// converted it back to UTC, which returned YESTERDAY between midnight and 5am
// in Pakistan — so the page could not find the running block.
export const isoToday = () => isoDay(new Date());

export function shortDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
}

/** "15 – 28 Sept", or "29 Sept – 12 Oct" across a month boundary. */
export function dateRange(start, end) {
  if (!start || !end) return '—';
  if (start.slice(0, 7) === end.slice(0, 7)) return `${Number(start.slice(8, 10))} – ${shortDate(end)}`;
  return `${shortDate(start)} – ${shortDate(end)}`;
}

/** How long something has been waiting: 45m, 5h, 2d 3h. */
export function age(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function initials(person) {
  return String(person?.display_name || '?')
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function firstName(person) {
  return String(person?.display_name || '').trim().split(/\s+/)[0] || '';
}

/** The day and clock time of an activity entry, in the team's timezone. */
export function activityParts(value) {
  const date = new Date(value);
  return {
    day: date.toLocaleDateString('en-GB', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' }),
    clock: date.toLocaleTimeString('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }),
  };
}

/** "13 Sept 18:40" */
export function activityTime(value) {
  const { day, clock } = activityParts(value);
  return `${day} ${clock}`;
}
