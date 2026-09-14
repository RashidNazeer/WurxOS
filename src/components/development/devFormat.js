// Formatting helpers for the Development workspace.
//
// The team plans its two-week blocks in Asia/Karachi, so "today" is that
// calendar day. A stored YYYY-MM-DD is formatted as the day it names, never
// shifted by the viewer's own timezone.

export const isoToday = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }))
  .toISOString()
  .slice(0, 10);

export function shortDate(value) {
  if (!value) return '—';
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  });
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

export const activityTime = (value) => new Date(value).toLocaleString('en-GB', {
  timeZone: 'Asia/Karachi',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
