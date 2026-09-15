// Data access for the Development workspace (migration 364).
//
// Row level security is the boundary: a developer who tries to change a task
// that is not theirs gets zero rows back rather than an error, so every write
// here checks what came back and turns "nothing changed" into a clear message.
import { supabase } from './supabase';

const TASK_LIST_COLUMNS = [
  'id', 'number', 'project_id', 'release_id', 'type', 'title', 'status', 'priority',
  'assignee_id', 'created_by', 'due_date', 'blocked_reason', 'status_changed_at',
  'completed_at', 'created_at', 'updated_at',
].join(', ');

export const FILE_BUCKET = 'dev-files';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const NOT_ALLOWED = 'Only the Boss or the person this task is assigned to can change it.';

export function friendlyError(error) {
  const message = String(error?.message || error || 'Something went wrong.');
  if (/row-level security|permission denied/i.test(message)) {
    return 'You don’t have permission to do that.';
  }
  if (/dev_projects_key_key|duplicate key value.*key/i.test(message)) {
    return 'Another project already uses that short name.';
  }
  if (/Failed to fetch|NetworkError/i.test(message)) {
    return 'Can’t reach the server. Check your connection and try again.';
  }
  return message;
}

function fail(error) {
  throw new Error(friendlyError(error));
}

// PostgREST returns at most 1000 rows per request; page until the end.
async function selectAll(build) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) fail(error);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

// ── Workspace ────────────────────────────────────────────────────────────
export async function loadWorkspace() {
  const [projects, releases, tasks, stats, peopleResult] = await Promise.all([
    selectAll(() => supabase.from('dev_projects').select('*').order('sort_order').order('created_at')),
    selectAll(() => supabase.from('dev_releases').select('*').order('created_at')),
    selectAll(() => supabase.from('dev_tasks').select(TASK_LIST_COLUMNS).order('number')),
    selectAll(() => supabase.from('dev_task_stats').select('*')),
    supabase
      .from('profiles')
      .select('id, display_name, avatar_url, role')
      .in('role', ['boss', 'developer'])
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('created_at'),
  ]);
  if (peopleResult.error) fail(peopleResult.error);
  return {
    projects,
    releases,
    tasks,
    statsByTask: Object.fromEntries(stats.map((row) => [row.task_id, row])),
    people: peopleResult.data || [],
  };
}

// ── Tasks ────────────────────────────────────────────────────────────────
export async function getTask(id) {
  const { data, error } = await supabase.from('dev_tasks').select('*').eq('id', id).maybeSingle();
  if (error) fail(error);
  return data;
}

export async function createTask(fields) {
  const { data, error } = await supabase.from('dev_tasks').insert(fields).select('*').single();
  if (error) fail(error);
  return data;
}

export async function updateTask(id, patch) {
  const { data, error } = await supabase.from('dev_tasks').update(patch).eq('id', id).select('*');
  if (error) fail(error);
  if (!data?.length) throw new Error(NOT_ALLOWED);
  return data[0];
}

export async function deleteTask(id) {
  const { data, error } = await supabase.from('dev_tasks').delete().eq('id', id).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error('Only the Boss can delete a task.');
}

// ── Projects and releases (Boss) ─────────────────────────────────────────
export async function createProject(fields) {
  const { data, error } = await supabase.from('dev_projects').insert(fields).select('*').single();
  if (error) fail(error);
  return data;
}

export async function updateProject(id, patch) {
  const { data, error } = await supabase.from('dev_projects').update(patch).eq('id', id).select('*');
  if (error) fail(error);
  if (!data?.length) throw new Error('Only the Boss can change a project.');
  return data[0];
}

export async function createRelease(fields) {
  const { data, error } = await supabase.from('dev_releases').insert(fields).select('*').single();
  if (error) fail(error);
  return data;
}

export async function updateRelease(id, patch) {
  const { data, error } = await supabase.from('dev_releases').update(patch).eq('id', id).select('*');
  if (error) fail(error);
  if (!data?.length) throw new Error('Only the Boss can change a release.');
  return data[0];
}

export async function deleteRelease(id) {
  const { data, error } = await supabase.from('dev_releases').delete().eq('id', id).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error('Only the Boss can delete a release.');
}

// ── Checklist ────────────────────────────────────────────────────────────
export async function listChecklist(taskId) {
  const { data, error } = await supabase
    .from('dev_checklist').select('*').eq('task_id', taskId)
    .order('sort_order').order('created_at');
  if (error) fail(error);
  return data || [];
}

export async function addChecklistItem(taskId, body, sortOrder) {
  const { data, error } = await supabase
    .from('dev_checklist').insert({ task_id: taskId, body, sort_order: sortOrder })
    .select('*').single();
  if (error) fail(error);
  return data;
}

export async function updateChecklistItem(id, patch) {
  const { data, error } = await supabase.from('dev_checklist').update(patch).eq('id', id).select('*');
  if (error) fail(error);
  if (!data?.length) throw new Error(NOT_ALLOWED);
  return data[0];
}

export async function deleteChecklistItem(id) {
  const { data, error } = await supabase.from('dev_checklist').delete().eq('id', id).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error(NOT_ALLOWED);
}

// ── Comments ─────────────────────────────────────────────────────────────
export async function listComments(taskId) {
  const { data, error } = await supabase
    .from('dev_comments').select('*').eq('task_id', taskId).order('created_at');
  if (error) fail(error);
  return data || [];
}

export async function addComment({ taskId, parentId = null, body, mentions = [] }) {
  const { data, error } = await supabase
    .from('dev_comments')
    .insert({ task_id: taskId, parent_id: parentId, body, mentions })
    .select('*').single();
  if (error) fail(error);
  return data;
}

export async function editComment(id, body, mentions = []) {
  const { data, error } = await supabase
    .from('dev_comments').update({ body, mentions }).eq('id', id).select('*');
  if (error) fail(error);
  if (!data?.length) throw new Error('You can only edit your own comments.');
  return data[0];
}

export async function deleteComment(id) {
  const { data, error } = await supabase
    .from('dev_comments').update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error('You can only delete your own comments.');
}

// ── Files ────────────────────────────────────────────────────────────────
export async function listFiles(taskId) {
  const { data, error } = await supabase
    .from('dev_files').select('*').eq('task_id', taskId).order('created_at');
  if (error) fail(error);
  return data || [];
}

function safeFileName(name) {
  const cleaned = String(name || 'file').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-80);
  return cleaned || 'file';
}

export async function uploadFile({ taskId, commentId = null, file }) {
  if (!file) throw new Error('Choose a file first.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Files can be up to 25 MB.');
  const id = crypto.randomUUID();
  const path = `${taskId}/${id}-${safeFileName(file.name)}`;
  const { error: uploadError } = await supabase.storage
    .from(FILE_BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (uploadError) fail(uploadError);

  const { data, error } = await supabase
    .from('dev_files')
    .insert({
      task_id: taskId,
      comment_id: commentId,
      path,
      name: String(file.name || 'file').slice(0, 200),
      mime: file.type || null,
      size_bytes: file.size,
    })
    .select('*').single();
  if (error) {
    // Don't leave an orphaned object behind when the record is refused.
    await supabase.storage.from(FILE_BUCKET).remove([path]);
    fail(error);
  }
  return data;
}

export async function deleteFile(row) {
  const { data, error } = await supabase.from('dev_files').delete().eq('id', row.id).select('id');
  if (error) fail(error);
  if (!data?.length) throw new Error('Only the person who added a file, or the Boss, can remove it.');
  await supabase.storage.from(FILE_BUCKET).remove([row.path]);
}

export async function fileUrl(path, { download = false, name } = {}) {
  const { data, error } = await supabase.storage
    .from(FILE_BUCKET)
    .createSignedUrl(path, 600, download ? { download: name || true } : undefined);
  if (error) fail(error);
  return data?.signedUrl;
}

// ── History ──────────────────────────────────────────────────────────────
export async function listActivity({ taskId, projectId, actorId, before, limit = 40 } = {}) {
  let query = supabase.from('dev_activity').select('*').order('created_at', { ascending: false }).limit(limit);
  if (taskId) query = query.eq('task_id', taskId);
  if (projectId) query = query.eq('project_id', projectId);
  if (actorId) query = query.eq('actor_id', actorId);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) fail(error);
  return data || [];
}

// ── Live updates ─────────────────────────────────────────────────────────
const LIVE_TABLES = ['dev_projects', 'dev_releases', 'dev_tasks', 'dev_checklist', 'dev_comments', 'dev_files', 'dev_activity'];

export function subscribeWorkspace(onChange) {
  // A random suffix: a remount must never collide with a channel that is
  // still closing (see BrandsContext).
  const channel = supabase.channel(`development-${Math.random().toString(36).slice(2)}`);
  for (const table of LIVE_TABLES) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => onChange(table, payload));
  }
  channel.subscribe();
  return () => supabase.removeChannel(channel);
}
