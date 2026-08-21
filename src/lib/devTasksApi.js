import { supabase } from './supabase';

// Developer task management (mig 328). Two levels: a task ("pipeline") holding
// subtasks. Deliberately unrelated to public.tasks and to Change Management.

export const DEV_STATUSES = ['pending', 'in_progress', 'blocked', 'paused', 'done', 'cancelled'];
export const DEV_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const STATUS_META = {
  pending:     { label: 'Pending',     tone: 'var(--text-muted)',  icon: 'bi-circle' },
  in_progress: { label: 'In progress', tone: 'var(--primary)',     icon: 'bi-play-circle-fill' },
  blocked:     { label: 'Blocked',     tone: 'var(--danger)',      icon: 'bi-exclamation-octagon-fill' },
  paused:      { label: 'Paused',      tone: 'var(--warning)',     icon: 'bi-pause-circle-fill' },
  done:        { label: 'Done',        tone: 'var(--success)',     icon: 'bi-check-circle-fill' },
  cancelled:   { label: 'Cancelled',   tone: 'var(--text-muted)',  icon: 'bi-slash-circle' },
};

export const PRIORITY_META = {
  urgent: { label: 'Urgent', tone: 'var(--danger)',   rank: 0 },
  high:   { label: 'High',   tone: 'var(--warning)',  rank: 1 },
  medium: { label: 'Medium', tone: 'var(--primary)',  rank: 2 },
  low:    { label: 'Low',    tone: 'var(--text-muted)', rank: 3 },
};

// The four columns the board actually works in. Done and cancelled are
// terminal and live outside it, so finished work never dominates the view.
export const BOARD_COLUMNS = ['pending', 'in_progress', 'blocked', 'paused'];

const PERSON = 'id, display_name, email, role, avatar_url';

// ── Tasks ───────────────────────────────────────────────────────────
// Reads the VIEW, so progress_pct and is_overdue come from the database and
// can never drift from what the board shows.
export async function listDevTasks() {
  const { data, error } = await supabase
    .from('dev_tasks_with_progress')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return [];

  // The view is not a table, so PostgREST cannot embed relations through it.
  // One extra query for the people involved beats N per row.
  const ids = [...new Set(rows.flatMap((r) => [r.requested_by, r.created_by, r.assigned_to]).filter(Boolean))];
  let people = {};
  if (ids.length) {
    const { data: ppl } = await supabase.from('profiles').select(PERSON).in('id', ids);
    people = Object.fromEntries((ppl || []).map((p) => [p.id, p]));
  }
  return rows.map((r) => ({
    ...r,
    requester: people[r.requested_by] || null,
    creator:   people[r.created_by] || null,
    assignee:  people[r.assigned_to] || null,
  }));
}

export async function getDevTask(id) {
  const [{ data: task, error: te }, subs, notes] = await Promise.all([
    supabase.from('dev_tasks_with_progress').select('*').eq('id', id).maybeSingle(),
    listSubtasks(id),
    listNotes(id),
  ]);
  if (te) throw new Error(te.message);
  if (!task) return null;
  const ids = [task.requested_by, task.created_by, task.assigned_to].filter(Boolean);
  let people = {};
  if (ids.length) {
    const { data: ppl } = await supabase.from('profiles').select(PERSON).in('id', ids);
    people = Object.fromEntries((ppl || []).map((p) => [p.id, p]));
  }
  return {
    ...task,
    requester: people[task.requested_by] || null,
    creator:   people[task.created_by] || null,
    subtasks: subs,
    notes,
  };
}

export async function createDevTask({ title, description, priority = 'medium', dueDate = null, requestedBy = null, assignedTo = null, projectId = null }) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { data, error } = await supabase
    .from('dev_tasks')
    .insert({
      title: String(title || '').trim(),
      description: description || null,
      priority,
      due_date: dueDate || null,
      project_id: projectId || null,
      requested_by: requestedBy || null,
      // created_by is the truth and is never chosen; the insert policy also
      // requires it to equal auth.uid().
      created_by: user.id,
      assigned_to: assignedTo || null,
      // Logging your own request needs no acknowledgement from yourself.
      requested_confirmed_at: requestedBy && requestedBy === user.id ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateDevTask(id, patch) {
  const { error } = await supabase.from('dev_tasks').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

// Status changes go through here so a note is always written alongside, giving
// the timeline a complete history rather than silent jumps.
export async function setDevTaskStatus(id, from, to, note = '') {
  await updateDevTask(id, { status: to });
  await addNote({ taskId: id, statusFrom: from, statusTo: to, body: note });
}

// The Boss closing a pipeline that still has open subtasks. The override flag
// stops the rollup trigger immediately re-opening it.
export async function forceCompleteDevTask(id, from, note = '') {
  await updateDevTask(id, { status: 'done', completed_override: true });
  await addNote({ taskId: id, statusFrom: from, statusTo: 'done', body: note || 'Closed with subtasks still open.' });
}

export async function confirmRequested(id) {
  await updateDevTask(id, { requested_confirmed_at: new Date().toISOString() });
}

export async function deleteDevTask(id) {
  const { error } = await supabase.from('dev_tasks').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Subtasks ────────────────────────────────────────────────────────
export async function listSubtasks(taskId) {
  const { data, error } = await supabase
    .from('dev_subtasks').select('*').eq('task_id', taskId)
    .order('position', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createSubtask(taskId, { title, description = null, priority = 'medium', dueDate = null }) {
  const existing = await listSubtasks(taskId);
  const { data, error } = await supabase
    .from('dev_subtasks')
    .insert({
      task_id: taskId,
      title: String(title || '').trim(),
      description,
      priority,
      due_date: dueDate || null,
      position: existing.length,
    })
    .select('id').single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateSubtask(id, patch) {
  const { error } = await supabase.from('dev_subtasks').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setSubtaskStatus(subtask, to, note = '') {
  await updateSubtask(subtask.id, { status: to });
  await addNote({ taskId: subtask.task_id, subtaskId: subtask.id, statusFrom: subtask.status, statusTo: to, body: note });
}

export async function deleteSubtask(id) {
  const { error } = await supabase.from('dev_subtasks').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Notes (append-only) ─────────────────────────────────────────────
export async function listNotes(taskId) {
  const { data, error } = await supabase
    .from('dev_task_notes')
    .select(`*, author:author_id(${PERSON})`)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addNote({ taskId, subtaskId = null, statusFrom = null, statusTo = null, body = '' }) {
  const text = String(body || '').trim();
  // The table rejects a note carrying neither text nor a status move; skip
  // rather than surface a constraint error for an empty comment box.
  if (!text && !statusTo) return null;
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('dev_task_notes').insert({
    task_id: taskId,
    subtask_id: subtaskId,
    author_id: user?.id || null,
    status_from: statusFrom,
    status_to: statusTo,
    body: text || null,
  });
  if (error) throw new Error(error.message);
  return true;
}

// ── Projects (WurxOS, WurxMediaHub, Wurx Ads Reporting, ...) ────────
// Tokens rather than hex, so a project's colour stays legible in dark mode.
export const PROJECT_COLOURS = {
  slate:  'var(--text-muted)',
  blue:   'var(--primary)',
  green:  'var(--success)',
  amber:  'var(--warning)',
  violet: '#8b5cf6',
  rose:   'var(--danger)',
  teal:   '#14b8a6',
};

export async function listProjects({ includeArchived = false } = {}) {
  let q = supabase.from('dev_projects').select('*').order('name');
  if (!includeArchived) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createProject({ name, description = null, colour = 'slate' }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('dev_projects')
    .insert({ name: String(name || '').trim(), description, colour, created_by: user?.id || null })
    .select('id').single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateProject(id, patch) {
  const { error } = await supabase.from('dev_projects').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

// Archive rather than delete: tasks reference it, and the history of what was
// worked on is worth more than a tidy list.
export async function archiveProject(id) {
  await updateProject(id, { is_active: false });
}

// ── People who may be named as the requester ────────────────────────
export async function listRequesters() {
  const { data, error } = await supabase
    .from('profiles').select(PERSON)
    .in('role', ['boss', 'ol']).eq('is_active', true).is('deleted_at', null)
    .order('role').order('display_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Sorting used by the list: priority, then the nearest due date ────
export function sortTasks(rows) {
  return [...rows].sort((a, b) => {
    const ao = a.status === 'done' || a.status === 'cancelled';
    const bo = b.status === 'done' || b.status === 'cancelled';
    if (ao !== bo) return ao ? 1 : -1;                       // finished work sinks
    if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
    const pr = (PRIORITY_META[a.priority]?.rank ?? 9) - (PRIORITY_META[b.priority]?.rank ?? 9);
    if (pr) return pr;
    if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : 1;
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return 0;
  });
}

// The single thing the developer should do next: highest-priority subtask that
// is not finished and not waiting on somebody else.
export function nextUp(tasks, subtasksByTask) {
  const cands = [];
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'cancelled' || t.status === 'paused') continue;
    for (const s of (subtasksByTask[t.id] || [])) {
      if (['done', 'cancelled', 'blocked', 'paused'].includes(s.status)) continue;
      cands.push({ subtask: s, task: t });
    }
  }
  cands.sort((a, b) => {
    const pr = (PRIORITY_META[a.subtask.priority]?.rank ?? 9) - (PRIORITY_META[b.subtask.priority]?.rank ?? 9);
    if (pr) return pr;
    if (a.subtask.due_date && b.subtask.due_date) return a.subtask.due_date < b.subtask.due_date ? -1 : 1;
    return a.subtask.due_date ? -1 : b.subtask.due_date ? 1 : 0;
  });
  return cands[0] || null;
}
