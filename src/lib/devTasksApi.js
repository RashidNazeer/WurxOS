import { supabase } from './supabase';

export const DEV_STATUSES = [
  'backlog', 'planned', 'in_progress', 'blocked',
  'dev_review', 'your_review', 'tested', 'live',
];
export const DEV_PRIORITIES = ['normal', 'high', 'urgent'];

export const STATUS_META = {
  backlog:      { label: 'Backlog',        tone: 'muted', icon: 'bi-circle-fill' },
  planned:      { label: 'Planned',        tone: 'planned', icon: 'bi-circle' },
  in_progress:  { label: 'In progress',    tone: 'primary', icon: 'bi-play-fill' },
  blocked:      { label: 'Blocked',        tone: 'danger', icon: 'bi-exclamation-octagon-fill' },
  dev_review:   { label: 'Dev review',     tone: 'warning', icon: 'bi-code-slash' },
  your_review:  { label: 'Needs Usman',    tone: 'warning', icon: 'bi-person-check-fill' },
  tested:       { label: 'Tested & ready', tone: 'success', icon: 'bi-check2-circle' },
  live:         { label: 'Live',           tone: 'live', icon: 'bi-check-circle-fill' },
};

export const PRIORITY_META = {
  urgent: { label: 'Urgent', tone: 'danger', rank: 0 },
  high:   { label: 'High', tone: 'warning', rank: 1 },
  normal: { label: 'Normal', tone: 'muted', rank: 2 },
};

export const ROLLUP_META = {
  backlog: { label: 'Not started', tone: 'muted' },
  in_progress: { label: 'In progress', tone: 'primary' },
  review: { label: 'In review', tone: 'warning' },
  blocked: { label: 'Something blocked', tone: 'danger' },
  complete: { label: 'All tasks tested', tone: 'success' },
};

const PERSON_FIELDS = 'id, display_name, email, role, avatar_url';

function throwIf(error) {
  if (error) throw new Error(error.message);
}

function attachPeople(rows, people) {
  const byId = Object.fromEntries(people.map((person) => [person.id, person]));
  return rows.map((row) => ({
    ...row,
    owner: byId[row.owner_id] || null,
    reviewer: byId[row.reviewer_id] || null,
    finalReviewer: byId[row.final_reviewer_id] || null,
    reporter: byId[row.reporter_id] || null,
  }));
}

export async function loadDevelopmentWorkspace() {
  const ensured = await supabase.rpc('dev_ensure_blocks', {});
  throwIf(ensured.error);
  const results = await Promise.all([
    supabase.from('dev_projects').select('*').eq('is_active', true).order('name'),
    supabase.from('dev_tasks_with_progress').select('*').order('created_at'),
    supabase.from('dev_subtasks').select('*').order('position').order('created_at'),
    supabase.from('profiles').select(PERSON_FIELDS)
      .in('role', ['boss', 'developer']).eq('is_active', true).is('deleted_at', null)
      .order('created_at'),
    supabase.from('dev_team_members').select('*'),
  ]);
  results.forEach((result) => throwIf(result.error));
  const [productResult, featureResult, taskResult, peopleResult, teamResult] = results;
  const people = peopleResult.data || [];
  const tasks = attachPeople(taskResult.data || [], people);
  const tasksByFeature = Object.fromEntries((featureResult.data || []).map((feature) => [feature.id, []]));
  tasks.forEach((task) => { (tasksByFeature[task.task_id] ||= []).push(task); });
  return {
    products: productResult.data || [], blocks: ensured.data || [], people,
    team: teamResult.data || [], features: attachPeople(featureResult.data || [], people),
    tasks, tasksByFeature,
  };
}

export async function listTaskActivity(featureId) {
  const { data, error } = await supabase.from('dev_task_notes')
    .select(`*, author:author_id(${PERSON_FIELDS})`).eq('task_id', featureId)
    .order('created_at', { ascending: false });
  throwIf(error);
  return data || [];
}

export async function createFeature({ name, description, productId, ownerId, priority = 'normal' }) {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) throw new Error('Not signed in.');
  const { data, error } = await supabase.from('dev_tasks').insert({
    title: String(name || '').trim(), description: description?.trim() || null,
    project_id: productId, owner_id: ownerId || null, assigned_to: ownerId || null,
    priority, created_by: uid, status: 'pending',
  }).select('id').single();
  throwIf(error);
  return data;
}

export async function updateFeature(id, patch) {
  const { error } = await supabase.from('dev_tasks').update(patch).eq('id', id);
  throwIf(error);
}

export async function moveFeature(featureId, blockId) {
  const { data, error } = await supabase.rpc('dev_move_feature', {
    p_feature: featureId, p_block: blockId || null,
  });
  throwIf(error);
  return data;
}

export async function createWorkTask(feature, { title, acceptance, ownerId, priority = null, due = null }) {
  if (feature.block_id && !String(acceptance || '').trim()) {
    throw new Error('Add an acceptance check before scheduling');
  }
  const { data, error } = await supabase.from('dev_subtasks').insert({
    task_id: feature.id, title: String(title || '').trim(),
    acceptance_check: String(acceptance || '').trim() || null,
    owner_id: ownerId || feature.owner_id || null,
    priority: priority || feature.priority || 'normal',
    due_date: due || feature.block_ends_on || null,
    status: feature.block_id ? 'planned' : 'backlog',
  }).select('id').single();
  throwIf(error);
  return data;
}

export async function updateWorkTask(id, patch) {
  const { error } = await supabase.from('dev_subtasks').update(patch).eq('id', id);
  throwIf(error);
}

export async function transitionWorkTask(id, to, { note = '', blockedReason = '' } = {}) {
  const { data, error } = await supabase.rpc('dev_transition_task', {
    p_task: id, p_to: to, p_note: note || null, p_blocked_reason: blockedReason || null,
  });
  throwIf(error);
  return data;
}

export async function markBugDuplicate(id, duplicateId, note = '') {
  const { data, error } = await supabase.rpc('dev_mark_duplicate', {
    p_task: id, p_duplicate: duplicateId, p_note: note || null,
  });
  throwIf(error);
  return data;
}

export async function addActivity(featureId, taskId, body) {
  const text = String(body || '').trim();
  if (!text) return;
  const { data: auth } = await supabase.auth.getUser();
  const { error } = await supabase.from('dev_task_notes').insert({
    task_id: featureId, subtask_id: taskId || null,
    author_id: auth.user?.id || null, body: text,
  });
  throwIf(error);
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function matchEodEntries(message, tasks) {
  return String(message || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      if (/^blocked\s*:\s*none\.?$/i.test(line)) return null;
      const lineNorm = normalize(line);
      const task = [...tasks].sort((a, b) => b.title.length - a.title.length).find((item) => {
        const words = normalize(item.title).split(' ');
        return lineNorm.startsWith(words.slice(0, Math.min(3, words.length)).join(' '));
      });
      if (!task) return null;
      const colon = line.indexOf(':');
      return { task_id: task.id, body: colon >= 0 ? line.slice(colon + 1).trim() : line };
    }).filter((entry) => entry?.body);
}

export async function postEod(message, tasks) {
  const entries = matchEodEntries(message, tasks);
  if (!entries.length) throw new Error('Start each line with a task name so I know where to post it.');
  const { data, error } = await supabase.rpc('dev_post_eod', {
    p_entries: entries, p_message: String(message || '').trim(),
  });
  throwIf(error);
  return data;
}

export async function reportIssue({ pageUrl, happened, expected, screenshot }) {
  const { data: taskId, error } = await supabase.rpc('dev_report_issue', {
    p_page_url: pageUrl, p_happened: happened, p_expected: expected || null,
  });
  throwIf(error);
  if (screenshot) {
    if (!screenshot.type.startsWith('image/')) throw new Error('The screenshot must be an image.');
    if (screenshot.size > 10 * 1024 * 1024) throw new Error('The screenshot must be 10 MB or smaller.');
    const { data: auth } = await supabase.auth.getUser();
    const ext = screenshot.name.includes('.') ? screenshot.name.split('.').pop() : 'png';
    const path = `${auth.user.id}/${taskId}/${Date.now()}.${ext}`;
    const upload = await supabase.storage.from('dev-issue-screenshots').upload(path, screenshot, {
      contentType: screenshot.type, cacheControl: '3600',
    });
    throwIf(upload.error);
    const attached = await supabase.rpc('dev_attach_issue_screenshot', { p_task: taskId, p_path: path });
    throwIf(attached.error);
  }
  return taskId;
}

export async function issueScreenshotUrl(path) {
  if (!path) return null;
  const { data, error } = await supabase.storage.from('dev-issue-screenshots').createSignedUrl(path, 300);
  throwIf(error);
  return data.signedUrl;
}

export function sortWorkTasks(rows) {
  return [...rows].sort((a, b) => {
    const priority = (PRIORITY_META[a.priority]?.rank ?? 9) - (PRIORITY_META[b.priority]?.rank ?? 9);
    if (priority) return priority;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    return a.due_date ? -1 : b.due_date ? 1 : 0;
  });
}

export function allowedTaskActions(task, viewerId, team) {
  const ownerLevel = team.find((member) => member.user_id === task.owner_id)?.level;
  if (task.status === 'planned' && viewerId === task.owner_id) return [{ to: 'in_progress', label: 'Start' }];
  if (task.status === 'in_progress' && viewerId === task.owner_id) return [
    { to: ownerLevel === 'junior' ? 'dev_review' : 'your_review', label: 'Submit for review', primary: true },
    { to: 'blocked', label: 'Mark blocked', note: 'blocked' },
  ];
  if (task.status === 'blocked' && viewerId === task.owner_id) return [{ to: 'in_progress', label: 'Unblock', primary: true }];
  if (task.status === 'dev_review' && viewerId === task.reviewer_id && viewerId !== task.owner_id) return [
    { to: 'your_review', label: 'Pass to Usman', primary: true },
    { to: 'in_progress', label: 'Send back', note: 'required' },
  ];
  if (task.status === 'your_review' && viewerId === task.final_reviewer_id && viewerId !== task.owner_id) return [
    { to: 'tested', label: 'Tested & ready', primary: true },
    { to: 'in_progress', label: 'Send back', note: 'required' },
  ];
  if (task.status === 'tested' && viewerId === task.owner_id) return [{ to: 'live', label: 'Mark live', primary: true }];
  return [];
}

export function waitingLabel(task) {
  if (task.status === 'dev_review') return task.reviewer?.display_name || 'senior developer';
  if (task.status === 'your_review') return task.finalReviewer?.display_name || 'Usman';
  if (task.status === 'tested') return task.owner?.display_name || 'developer';
  if (task.status === 'blocked') return 'a blocker';
  return task.owner?.display_name || 'developer';
}
