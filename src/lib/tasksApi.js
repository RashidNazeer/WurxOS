import { supabase } from './supabase';

// --------------------------------------------------------------
// Reads
// --------------------------------------------------------------
// Returns tasks visible to the current user (RLS filters).
// The caller can narrow with filters (assigneeMe, personal, createdByMe,
// brandId, status). createdByMe = "tasks I assigned to others" — used by
// IPCs/TLs who fan out tasks to APCs and want to see what they created
// (excludes self-assigned personal rows so the bucket stays clean).
export async function listTasks({
  assigneeMe = false,
  personalOnly = false,
  createdByMe = false,
  brandId = null,
  status = null,
  search = '',
} = {}) {
  let q = supabase
    .from('tasks')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url, owner_id, status),
      assignee:assignee_id(id, display_name, email, role, reports_to, current_tl:reports_to(id, display_name)),
      creator:created_by(id, display_name, role)
    `)
    .order('created_at', { ascending: false });

  if (brandId) q = q.eq('brand_id', brandId);
  if (status)  q = q.eq('status', status);

  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;

  if (assigneeMe && me) q = q.eq('assignee_id', me);

  if (personalOnly && me) {
    q = q.is('brand_id', null).eq('created_by', me).eq('assignee_id', me);
  }

  if (createdByMe && me) {
    // Tasks I assigned to someone else. Exclude self-assigned to keep the
    // "Assigned by me" bucket distinct from "Personal".
    q = q.eq('created_by', me).neq('assignee_id', me);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let rows = data || [];
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) =>
      (r.title || '').toLowerCase().includes(s) ||
      (r.description || '').toLowerCase().includes(s) ||
      (r.brand?.brand_name || '').toLowerCase().includes(s) ||
      (r.assignee?.display_name || '').toLowerCase().includes(s),
    );
  }
  return rows;
}

// --------------------------------------------------------------
// Writes
// --------------------------------------------------------------
// `notify` is opt-in (default false) — the DB trigger only emits
// task.created when the caller sets it to true on the insert.
export async function createTask({
  brandId = null,
  assigneeId,
  title,
  description = '',
  category = 'general',
  priority = 'medium',
  dueDate = null,
  link = '',
  notify = false,
}) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      brand_id: brandId || null,
      assignee_id: assigneeId,
      title: title.trim(),
      description: (description || '').trim(),
      category,
      priority,
      due_date: dueDate || null,
      link: (link || '').trim() || null,
      created_by: me,
      notify,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Accept `notify` as a regular patch field — false on every write
// unless the UI explicitly opts in, so TLs/creators aren't pinged
// on silent status ticks.
export async function updateTask(id, patch) {
  const payload = { notify: false };
  if ('title'       in patch) payload.title       = patch.title.trim();
  if ('description' in patch) payload.description = (patch.description || '').trim();
  if ('status'      in patch) payload.status      = patch.status;
  if ('priority'    in patch) payload.priority    = patch.priority;
  if ('category'    in patch) payload.category    = patch.category;
  if ('dueDate'     in patch) payload.due_date    = patch.dueDate || null;
  if ('link'        in patch) payload.link        = (patch.link || '').trim() || null;
  if ('assigneeId'  in patch) payload.assignee_id = patch.assigneeId;
  if ('notify'      in patch) payload.notify      = !!patch.notify;

  const { data, error } = await supabase
    .from('tasks')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteTask(id) {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Group task fan-out (TL only)
// Accepts an array of {brandId, assigneeId} pairs so we write them all
// in one insert. Front-end computes the pairs from selected brands × APCs.
// --------------------------------------------------------------
export async function createGroupTasks({
  pairs,            // [{ brandId, assigneeId }, ...]
  title,
  description = '',
  category = 'general',
  priority = 'medium',
  dueDate = null,
  link = '',
  notify = false,
}) {
  if (!pairs?.length) throw new Error('No brand/APC pairs given.');
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const rows = pairs.map((p) => ({
    brand_id: p.brandId,
    assignee_id: p.assigneeId,
    title: title.trim(),
    description: (description || '').trim(),
    category,
    priority,
    due_date: dueDate || null,
    link: (link || '').trim() || null,
    created_by: me,
    notify,
  }));
  const { data, error } = await supabase.from('tasks').insert(rows).select();
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Reset schedule helpers
// --------------------------------------------------------------
export const DEFAULT_RESET_SCHEDULE = {
  daily:   { time: '00:00' },
  weekly:  { dayOfWeek: 1, time: '00:00' },
  monthly: { dayOfMonth: 1, time: '00:00' },
};

// Browser's best guess for the user's IANA timezone
export function detectBrowserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function getUserResetSchedule(userId) {
  if (!userId) return { schedule: DEFAULT_RESET_SCHEDULE, timezone: 'UTC' };
  const { data, error } = await supabase
    .from('profiles')
    .select('reset_schedule, timezone')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const schedule = {
    daily:   { ...DEFAULT_RESET_SCHEDULE.daily,   ...(data?.reset_schedule?.daily   || {}) },
    weekly:  { ...DEFAULT_RESET_SCHEDULE.weekly,  ...(data?.reset_schedule?.weekly  || {}) },
    monthly: { ...DEFAULT_RESET_SCHEDULE.monthly, ...(data?.reset_schedule?.monthly || {}) },
  };
  return { schedule, timezone: data?.timezone || 'UTC' };
}

export async function updateResetSchedule(userId, { schedule /*, timezone */ }) {
  // timezone is locked to Asia/Karachi at the DB level (migration 095);
  // ignore any caller-provided value to avoid tripping the CHECK constraint.
  const patch = {};
  if (schedule) patch.reset_schedule = schedule;
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Formats a schedule block (daily/weekly/monthly) into a human hint like
// "Resets daily at 09:00" for the create-task modal.
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function formatResetHint(category, schedule) {
  if (!schedule || category === 'general') return '';
  const s = schedule[category];
  if (!s) return '';
  if (category === 'daily')  return `Resets daily at ${s.time}`;
  if (category === 'weekly') return `Resets weekly on ${DOW_NAMES[s.dayOfWeek] || 'Mon'} at ${s.time}`;
  if (category === 'monthly') return `Resets monthly on day ${s.dayOfMonth} at ${s.time}`;
  return '';
}

// --------------------------------------------------------------
// Assignee pickers per creator role (for CreateTaskModal)
// --------------------------------------------------------------
export async function listAssignableUsers({ creatorRole, creatorId, brandId }) {
  // Boss/OL/Developer:
  //   * No brand selected — assign to anyone active (general task)
  //   * Brand selected — narrow to the people actually managing the
  //     brand: its owner (the TL), everyone in brand_assignments
  //     (APCs / IPCs), and any PCTL who selected the brand.
  // PCTL is in this branch by the Boss's ruling: they assign to ANYONE, including
  // OL and TL. They used to be limited to "IPCs who report to me" — a frontend
  // restriction only; can_create_tasks (mig 022) already returned true for pctl
  // and tasks_insert never gated who the assignee could be.
  if (creatorRole === 'boss' || creatorRole === 'ol' || creatorRole === 'developer'
      || creatorRole === 'pctl') {
    if (!brandId) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, email, role')
        .eq('is_active', true)
        .order('display_name');
      if (error) throw new Error(error.message);
      return data || [];
    }

    // Resolve the team for this brand. Run the lookups in parallel.
    // pctl_brand_selections may not exist in older DBs — treat its
    // failure as an empty set rather than blocking the dropdown.
    const [brandRes, assignsRes, pctlsRes] = await Promise.all([
      supabase.from('brands').select('owner_id').eq('id', brandId).maybeSingle(),
      supabase.from('brand_assignments').select('user_id').eq('brand_id', brandId),
      supabase.from('pctl_brand_selections').select('pctl_id').eq('brand_id', brandId)
        .then((r) => r, () => ({ data: [], error: null })),
    ]);
    if (brandRes.error)   throw new Error(brandRes.error.message);
    if (assignsRes.error) throw new Error(assignsRes.error.message);

    const ids = new Set();
    if (brandRes.data?.owner_id) ids.add(brandRes.data.owner_id);
    (assignsRes.data || []).forEach((r) => r.user_id && ids.add(r.user_id));
    (pctlsRes.data    || []).forEach((r) => r.pctl_id && ids.add(r.pctl_id));

    if (ids.size === 0) return [];

    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, email, role')
      .in('id', Array.from(ids))
      .eq('is_active', true)
      .order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }

  // TL assigns to APCs that report to them; when a brand is chosen, limit
  // further to APCs assigned to that brand.
  if (creatorRole === 'tl') {
    const { data: team, error: tErr } = await supabase
      .from('profiles')
      .select('id, display_name, email, role')
      .eq('role', 'apc')
      .eq('is_active', true)
      .eq('reports_to', creatorId)
      .order('display_name');
    if (tErr) throw new Error(tErr.message);
    let list = team || [];
    if (brandId) {
      const { data: assigned, error: aErr } = await supabase
        .from('brand_assignments')
        .select('user_id')
        .eq('brand_id', brandId);
      if (aErr) throw new Error(aErr.message);
      const ids = new Set((assigned || []).map((r) => r.user_id));
      list = list.filter((u) => ids.has(u.id));
    }
    return list;
  }

  // (PCTL used to be limited to "IPCs that report to me" here — now handled in
  // the Boss/OL branch above, so they can assign to anyone.)

  // APCs always self-assign.
  if (creatorRole === 'apc') {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, email, role')
      .eq('id', creatorId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? [data] : [];
  }

  // IPCs: when they have canManageTasks=true, they can assign to any
  // active APC (group-task fan-out). The DB-side RLS still gates the
  // insert via can_create_tasks(), so an IPC without the permission
  // who calls this gets an empty list and the modal will hide the picker.
  if (creatorRole === 'ipc') {
    const { data: meRow } = await supabase
      .from('profiles')
      .select('permissions')
      .eq('id', creatorId)
      .maybeSingle();
    const canManage = !!(meRow?.permissions?.canManageTasks);
    if (!canManage) {
      // Fall back to self-only — modal stays in self-assign mode.
      const { data, error } = await supabase
        .from('profiles').select('id, display_name, email, role')
        .eq('id', creatorId).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? [data] : [];
    }
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, email, role')
      .eq('role', 'apc')
      .eq('is_active', true)
      .order('display_name');
    if (error) throw new Error(error.message);
    return data || [];
  }

  return [];
}

// Brands the creator can use when assigning a task.
//   Boss/OL/Developer/PCTL: all active brands
//   TL:                     brands they own
//   APC/IPC:                brands they're assigned to via brand_assignments
//                           (so they can attach a self-assigned task to a
//                           brand they actually work on, without being able
//                           to assign work to anyone else)
export async function listBrandsForTaskCreate({ creatorRole, creatorId }) {
  // PCTL sees every brand (mig 247). It used to read pctl_brand_selections, which
  // is EMPTY in prod — so the brand picker was silently blank for both PCTLs.
  if (['boss', 'ol', 'developer', 'tl', 'pctl'].includes(creatorRole)) {
    let q = supabase
      .from('brands')
      .select('id, brand_name, logo_url, owner_id')
      .eq('status', 'active')
      .order('brand_name');
    if (creatorRole === 'tl') q = q.eq('owner_id', creatorId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  }

  if (creatorRole === 'apc' || creatorRole === 'ipc') {
    // brand_assignments → brand rows. Filter to active brands only.
    const { data, error } = await supabase
      .from('brand_assignments')
      .select('brand:brand_id (id, brand_name, logo_url, owner_id, status)')
      .eq('user_id', creatorId);
    if (error) throw new Error(error.message);
    return (data || [])
      .map((r) => r.brand)
      .filter((b) => b && b.status === 'active')
      .sort((a, b) => (a.brand_name || '').localeCompare(b.brand_name || ''));
  }

  return [];
}

// Brands + APC assignments (needed for group-task modal)
export async function listBrandsWithAssignedAPCs(ownerTlId) {
  const { data, error } = await supabase
    .from('brands')
    .select(`
      id, brand_name, logo_url, owner_id,
      assignments:brand_assignments(user_id, profile:user_id(id, display_name))
    `)
    .eq('status', 'active')
    .eq('owner_id', ownerTlId)
    .order('brand_name');
  if (error) throw new Error(error.message);
  return (data || []).map((b) => ({
    ...b,
    assignedUsers: (b.assignments || [])
      .map((a) => a.profile)
      .filter(Boolean),
  }));
}
