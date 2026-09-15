// Shared vocabulary for the Development workspace: statuses, priorities, the
// roadmap branches, project colours, permissions and small derivations.
//
// Everything a page needs to agree on lives here, so the tree, the list, the
// board and the task panel can never disagree about what "blocked" means or
// who may edit a task.

export const STATUSES = [
  { key: 'todo',        label: 'To do',       tone: 'todo' },
  { key: 'in_progress', label: 'In progress', tone: 'progress' },
  { key: 'in_review',   label: 'In review',   tone: 'review' },
  { key: 'blocked',     label: 'Blocked',     tone: 'blocked' },
  { key: 'done',        label: 'Done',        tone: 'done' },
];
export const STATUS_BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.key, s]));

export const PRIORITIES = [
  { key: 'urgent', label: 'Urgent', rank: 0 },
  { key: 'high',   label: 'High',   rank: 1 },
  { key: 'normal', label: 'Normal', rank: 2 },
  { key: 'low',    label: 'Low',    rank: 3 },
];
export const PRIORITY_BY_KEY = Object.fromEntries(PRIORITIES.map((p) => [p.key, p]));

export const TYPES = [
  { key: 'feature', label: 'Feature', icon: 'bi-check2-square' },
  { key: 'bug',     label: 'Bug',     icon: 'bi-bug' },
];
export const TYPE_BY_KEY = Object.fromEntries(TYPES.map((t) => [t.key, t]));

// The roadmap tree. Order is the left-to-right order of the branches.
// `dropStatus` is what a card becomes when it is dragged into the branch.
export const BRANCHES = [
  {
    key: 'blocked', name: 'Needs a decision', hint: 'Blocked, waiting on a call',
    statuses: ['blocked'], dropStatus: 'blocked', icon: 'bi-exclamation-triangle',
    empty: 'No blockers. Clear to move.', addLabel: 'Flag a blocker',
  },
  {
    key: 'moving', name: 'Moving forward', hint: 'In progress and in review',
    statuses: ['in_progress', 'in_review'], dropStatus: 'in_progress', icon: 'bi-activity',
    empty: 'Nothing is moving yet.', addLabel: 'Add work in progress',
  },
  {
    key: 'next', name: 'Up next', hint: 'Assigned and ready to start',
    statuses: ['todo'], dropStatus: 'todo', icon: 'bi-clock',
    empty: 'Nothing queued.', addLabel: 'Assign a task',
  },
  {
    key: 'done', name: 'Completed', hint: 'Delivered work',
    statuses: ['done'], dropStatus: 'done', icon: 'bi-check2-circle',
    empty: 'Completed work will appear here.', addLabel: null,
  },
];

export const PROJECT_COLORS = ['orange', 'violet', 'teal', 'blue', 'green', 'rose', 'amber', 'slate'];

export const HEALTH = [
  { key: 'on_track',  label: 'On track',  tone: 'good' },
  { key: 'at_risk',   label: 'At risk',   tone: 'warn' },
  { key: 'off_track', label: 'Off track', tone: 'bad' },
];
export const HEALTH_BY_KEY = Object.fromEntries(HEALTH.map((h) => [h.key, h]));

export const RELEASE_STATUSES = [
  { key: 'planned', label: 'Planned' },
  { key: 'current', label: 'Current' },
  { key: 'shipped', label: 'Shipped' },
];

// ── Permissions (the database enforces the same rules) ───────────────────
export const isBoss = (profile) => profile?.role === 'boss';

// The Boss changes everything. A developer changes only the tasks assigned to
// them; they can still read and comment on everything else.
export function canEditTask(profile, task) {
  if (!profile || !task) return false;
  if (isBoss(profile)) return true;
  return profile.role === 'developer' && task.assignee_id === profile.id;
}

// ── Formatting ───────────────────────────────────────────────────────────
export const taskCode = (task) => (task?.number ? `WRX-${task.number}` : 'WRX');

// Today as YYYY-MM-DD in Pakistan time, whatever the viewer's clock says.
export function todayPkt() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// A date-only value ("2026-09-28") is a calendar day, not an instant: format it
// in UTC so no timezone shifts it to the day before.
export function shortDate(iso, { year = false } = {}) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}),
  });
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dateRangeLabel(startIso, endIso) {
  const a = new Date(`${startIso}T00:00:00Z`);
  const b = new Date(`${endIso}T00:00:00Z`);
  const month = (d) => d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
  if (a.getUTCMonth() === b.getUTCMonth()) return `${month(a)} ${a.getUTCDate()}–${b.getUTCDate()}`;
  return `${month(a)} ${a.getUTCDate()}–${month(b)} ${b.getUTCDate()}`;
}

// Relative time for activity and comments ("just now", "5 min ago", "Sep 14").
export function timeAgo(isoTs) {
  if (!isoTs) return '';
  const then = new Date(isoTs).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(isoTs).toLocaleDateString('en-US', { timeZone: 'Asia/Karachi', month: 'short', day: 'numeric' });
}

export function exactTime(isoTs) {
  if (!isoTs) return '';
  return `${new Date(isoTs).toLocaleString('en-US', {
    timeZone: 'Asia/Karachi', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })} PKT`;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'Someone';

// ── Derivations ──────────────────────────────────────────────────────────
export function isOverdue(task, today = todayPkt()) {
  return !!task?.due_date && task.status !== 'done' && task.due_date < today;
}

// Urgent first, then the earliest due date, then the oldest task number.
export function compareTasks(a, b) {
  const pa = PRIORITY_BY_KEY[a.priority]?.rank ?? 9;
  const pb = PRIORITY_BY_KEY[b.priority]?.rank ?? 9;
  if (pa !== pb) return pa - pb;
  const da = a.due_date || '9999-12-31';
  const db = b.due_date || '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  return (a.number || 0) - (b.number || 0);
}

export function progressOf(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

// The label on a release or project card. A blocker always outranks the
// manual health setting, because it is the one thing that needs someone now.
export function deliveryState(tasks, { shipped = false } = {}) {
  if (shipped) return { label: 'Shipped', tone: 'good' };
  const { total, done } = progressOf(tasks);
  if (tasks.some((t) => t.status === 'blocked')) return { label: 'Needs attention', tone: 'warn' };
  if (total > 0 && done === total) return { label: 'Delivered', tone: 'good' };
  return { label: 'On track', tone: 'good' };
}

export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

// Two-week delivery windows for the release timeline, starting on the Monday
// of the current week (Pakistan time).
export function deliveryWindows(today = todayPkt()) {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = addDays(today, -dow);
  const names = ['Now', 'Next', 'After'];
  const windows = names.map((name, i) => {
    const start = addDays(monday, i * 14);
    const end = addDays(start, 13);
    return { key: name.toLowerCase(), name, start, end, label: `${name} · ${dateRangeLabel(start, end)}` };
  });
  windows.push({ key: 'later', name: 'Later', start: null, end: null, label: 'Later · Unscheduled' });
  return windows;
}

export function windowForDate(windows, iso) {
  if (!iso) return 'later';
  const hit = windows.find((w) => w.start && iso >= w.start && iso <= w.end);
  if (hit) return hit.key;
  return iso < windows[0].start ? 'now' : 'later';
}
