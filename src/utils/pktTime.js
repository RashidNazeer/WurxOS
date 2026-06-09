// Pakistan-time formatting for the agenda feature (and anywhere times must
// read the same for every viewer regardless of their browser timezone).
//
// The org runs on Pakistan time (Asia/Karachi, UTC+5, no DST) and the DB is
// PK-locked (mig 095). Two kinds of values:
//   * stored time-of-day strings ("HH:MM[:SS]") — already PK wall-clock, so we
//     only reformat to 12h (no Date / no tz conversion).
//   * absolute timestamps (started_at, finished_at, presentation times) — these
//     are instants; format them explicitly in Asia/Karachi so a viewer abroad
//     still sees the Pakistan wall-clock, not their own.

const TZ = 'Asia/Karachi';

export const PKT_LABEL = 'PKT';
export const PKT_NOTE = 'All times shown in Pakistan time (PKT)';

// "HH:MM[:SS]" (PK wall-clock) -> "h:MM AM/PM". Pure string, tz-agnostic.
export function fmtPktTime(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  let hh = Number(h);
  const ap = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  return `${hh}:${m} ${ap}`;
}

// "YYYY-MM-DD" calendar day -> "Mon, Jun 9" (optionally with weekday/year).
// Rendered at local midnight, which is calendar-date-safe across timezones.
export function fmtPktDate(dateStr, { weekday = true, year = false } = {}) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', {
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
  });
}

// Absolute ISO timestamp -> Pakistan wall-clock time "h:MM AM/PM".
export function fmtPktClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

// Absolute ISO timestamp -> Pakistan date + time "Jun 9, 10:48 AM".
export function fmtPktStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}
