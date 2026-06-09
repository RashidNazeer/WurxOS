// Weekly Agenda Meetings — API wrapper.
//
// A standalone module, fully separate from the main task system
// (src/lib/tasksApi.js). It only borrows the role-aware brand/assignee
// pickers, which are generic, to avoid duplicating ~150 lines.

import { supabase } from './supabase';
import { listAssignableUsers, listBrandsForTaskCreate } from './tasksApi';

// Re-export the shared pickers under agenda-friendly names so agenda
// components depend only on this module.
export { listAssignableUsers as listAgendaAssignableUsers };
export { listBrandsForTaskCreate as listAgendaBrands };

// Active brands a specific APC is assigned to — used by the assign
// flow so the brand picker is scoped to that APC's brands (and can
// auto-select when there is only one).
export async function listBrandsForApc(apcId) {
  if (!apcId) return [];
  const { data, error } = await supabase
    .from('brand_assignments')
    .select('brand:brand_id(id, brand_name, status)')
    .eq('user_id', apcId);
  if (error) throw new Error(error.message);
  return (data || [])
    .map((r) => r.brand)
    .filter((b) => b && b.status === 'active')
    .sort((a, b) => (a.brand_name || '').localeCompare(b.brand_name || ''));
}

const TASK_SELECT = `
  *,
  brand:brand_id(id, brand_name, logo_url, owner_id, status),
  assignee:assignee_id(id, display_name, email, role, avatar_url),
  creator:created_by(id, display_name, role)
`;

// --------------------------------------------------------------
// Settings (single row, id = 1)
// --------------------------------------------------------------
export async function getAgendaSettings() {
  const { data, error } = await supabase
    .from('agenda_settings')
    .select('id, google_meet_link, meeting_day, updated_by, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || { id: 1, google_meet_link: '', meeting_day: 'tuesday' };
}

export async function updateAgendaSettings({ googleMeetLink, meetingDay }) {
  const { data: auth } = await supabase.auth.getUser();
  const patch = { updated_by: auth?.user?.id || null, updated_at: new Date().toISOString() };
  if (googleMeetLink !== undefined) patch.google_meet_link = (googleMeetLink || '').trim();
  if (meetingDay !== undefined)     patch.meeting_day = meetingDay;
  const { data, error } = await supabase
    .from('agenda_settings')
    .update(patch)
    .eq('id', 1)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Tasks
// --------------------------------------------------------------
export async function listAgendaTasks({
  assigneeMe = false,
  createdByMe = false,
  assigneeId = null,
  brandId = null,
  status = null,
  search = '',
} = {}) {
  let q = supabase
    .from('agenda_tasks')
    .select(TASK_SELECT)
    .order('created_at', { ascending: false });

  if (brandId) q = q.eq('brand_id', brandId);
  if (status)  q = q.eq('status', status);
  if (assigneeId) q = q.eq('assignee_id', assigneeId);

  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  if (assigneeMe && me)  q = q.eq('assignee_id', me);
  if (createdByMe && me) q = q.eq('created_by', me).neq('assignee_id', me);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let rows = data || [];
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) =>
      (r.title || '').toLowerCase().includes(s) ||
      (r.details || '').toLowerCase().includes(s) ||
      (r.brand?.brand_name || '').toLowerCase().includes(s) ||
      (r.assignee?.display_name || '').toLowerCase().includes(s),
    );
  }
  return rows;
}

// `notify` is opt-in; the assign notification fires from the DB trigger
// whenever assignee <> creator regardless, so a TL assigning always
// pings the APC.
export async function createAgendaTask({
  brandId = null,
  assigneeId,
  title,
  details = '',
  dueDate = null,
  link = '',
  notify = false,
}) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data, error } = await supabase
    .from('agenda_tasks')
    .insert({
      brand_id: brandId || null,
      assignee_id: assigneeId,
      title: title.trim(),
      details: (details || '').trim() || null,
      due_date: dueDate || null,
      link: (link || '').trim() || null,
      created_by: me,
      notify,
    })
    .select(TASK_SELECT)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// `notify` defaults false on every write so silent status ticks don't
// ping anyone; the UI opts in explicitly on a status change.
export async function updateAgendaTask(id, patch) {
  const payload = { notify: false };
  if ('title'   in patch) payload.title    = patch.title.trim();
  if ('details' in patch) payload.details  = (patch.details || '').trim() || null;
  if ('status'  in patch) payload.status   = patch.status;
  if ('dueDate' in patch) payload.due_date = patch.dueDate || null;
  if ('link'    in patch) payload.link     = (patch.link || '').trim() || null;
  if ('notify'  in patch) payload.notify   = !!patch.notify;

  const { data, error } = await supabase
    .from('agenda_tasks')
    .update(payload)
    .eq('id', id)
    .select(TASK_SELECT)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteAgendaTask(id) {
  const { error } = await supabase.from('agenda_tasks').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Realtime — fire `onChange` on any agenda_tasks change.
export function subscribeAgendaTasks(onChange) {
  const ch = supabase
    .channel(`agenda-tasks-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda_tasks' },
      () => onChange())
    .subscribe();
  return () => supabase.removeChannel(ch);
}

// --------------------------------------------------------------
// Resources
// --------------------------------------------------------------
export async function listAgendaResources({ brandId = null, type = null, search = '' } = {}) {
  let q = supabase
    .from('agenda_resources')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url),
      creator:created_by(id, display_name)
    `)
    .order('created_at', { ascending: false });
  if (brandId) q = q.eq('brand_id', brandId);
  if (type)    q = q.eq('type', type);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) =>
      (r.name || '').toLowerCase().includes(s) ||
      (r.description || '').toLowerCase().includes(s) ||
      (r.brand?.brand_name || '').toLowerCase().includes(s),
    );
  }
  return rows;
}

export async function createAgendaResource({ brandId = null, type = 'link', name, url, description = '' }) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data, error } = await supabase
    .from('agenda_resources')
    .insert({
      brand_id: brandId || null,
      type,
      name: name.trim(),
      url: url.trim(),
      description: (description || '').trim(),
      created_by: me,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateAgendaResource(id, patch) {
  const payload = {};
  if ('type'        in patch) payload.type        = patch.type;
  if ('name'        in patch) payload.name        = patch.name.trim();
  if ('url'         in patch) payload.url         = patch.url.trim();
  if ('description' in patch) payload.description = (patch.description || '').trim();
  if ('brandId'     in patch) payload.brand_id    = patch.brandId || null;
  const { data, error } = await supabase
    .from('agenda_resources')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteAgendaResource(id) {
  const { error } = await supabase.from('agenda_resources').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export function subscribeAgendaResources(onChange) {
  const ch = supabase
    .channel(`agenda-resources-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda_resources' },
      () => onChange())
    .subscribe();
  return () => supabase.removeChannel(ch);
}

// --------------------------------------------------------------
// Per-user agenda reset schedule (profiles.agenda_reset)
// --------------------------------------------------------------
export const DEFAULT_AGENDA_RESET = {
  cadence: 'weekly',
  daily:   { time: '00:00' },
  weekly:  { dayOfWeek: 1, time: '00:00' },
  monthly: { dayOfMonth: 1, time: '00:00' },
};

export async function getAgendaResetSchedule(userId) {
  if (!userId) return { ...DEFAULT_AGENDA_RESET };
  const { data, error } = await supabase
    .from('profiles')
    .select('agenda_reset')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const r = data?.agenda_reset || {};
  return {
    cadence: r.cadence || DEFAULT_AGENDA_RESET.cadence,
    daily:   { ...DEFAULT_AGENDA_RESET.daily,   ...(r.daily   || {}) },
    weekly:  { ...DEFAULT_AGENDA_RESET.weekly,  ...(r.weekly  || {}) },
    monthly: { ...DEFAULT_AGENDA_RESET.monthly, ...(r.monthly || {}) },
  };
}

export async function updateAgendaResetSchedule(userId, schedule) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ agenda_reset: schedule })
    .eq('id', userId)
    .select('agenda_reset')
    .single();
  if (error) throw new Error(error.message);
  return data?.agenda_reset;
}

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function formatAgendaResetHint(schedule) {
  if (!schedule) return '';
  const c = schedule.cadence || 'weekly';
  if (c === 'daily')   return `Your agenda tasks reset daily at ${schedule.daily?.time || '00:00'}`;
  if (c === 'monthly') return `Your agenda tasks reset monthly on day ${schedule.monthly?.dayOfMonth || 1} at ${schedule.monthly?.time || '00:00'}`;
  return `Your agenda tasks reset weekly on ${DOW_NAMES[schedule.weekly?.dayOfWeek ?? 1]} at ${schedule.weekly?.time || '00:00'}`;
}

// --------------------------------------------------------------
// Teams + meeting schedules (phase 2)
// --------------------------------------------------------------

// All active TL-teams with the APCs reporting to each.
export async function listAgendaTeams() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to, avatar_url')
    .in('role', ['tl', 'apc'])
    .eq('is_active', true)
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  const people = data || [];
  const tls  = people.filter((p) => p.role === 'tl');
  const apcs = people.filter((p) => p.role === 'apc');
  return tls
    .map((tl) => ({ tl, apcs: apcs.filter((a) => a.reports_to === tl.id) }))
    .sort((a, b) => (a.tl.display_name || '').localeCompare(b.tl.display_name || ''));
}

export async function getAgendaTeamSchedules() {
  const { data, error } = await supabase.from('agenda_team_schedules').select('*');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function upsertAgendaTeamSchedule(tlId, meetingDay, meetingTime) {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('agenda_team_schedules')
    .upsert(
      { tl_id: tlId, meeting_day: meetingDay, meeting_time: meetingTime,
        updated_by: auth?.user?.id || null, updated_at: new Date().toISOString() },
      { onConflict: 'tl_id' },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteAgendaTeamSchedule(tlId) {
  const { error } = await supabase.from('agenda_team_schedules').delete().eq('tl_id', tlId);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Meetings (phase 2)
// --------------------------------------------------------------

// Absolute instant a meeting is scheduled to start. meeting_date +
// meeting_time are stored as Asia/Karachi wall-clock (the DB is PK-locked,
// mig 095), so we pin to +05:00 (Pakistan has no DST). The comparison is
// then correct regardless of the viewer's browser timezone.
export function agendaMeetingStartAt(meeting) {
  const date = meeting?.meeting_date;
  let time = meeting?.meeting_time;
  if (!date || !time) return null;
  if (time.length === 5) time = `${time}:00`;        // HH:MM -> HH:MM:SS
  const at = new Date(`${date}T${time}+05:00`);
  return Number.isNaN(at.getTime()) ? null : at;
}

// The earliest start instant among a set of meetings (e.g. a week's), or null.
export function agendaEarliestStart(meetings) {
  const ms = (meetings || [])
    .map(agendaMeetingStartAt)
    .filter(Boolean)
    .map((d) => d.getTime());
  return ms.length ? new Date(Math.min(...ms)) : null;
}

export async function listAgendaMeetings({ status = null } = {}) {
  let q = supabase
    .from('agenda_meetings')
    .select('*, tl:tl_id(id, display_name, email, avatar_url)')
    .order('meeting_date', { ascending: true });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// OL only — materialise + notify the given week's meetings (week start
// must be a Monday).
export async function notifyWeek(weekStart) {
  const { data, error } = await supabase.rpc('agenda_notify_week', { p_week_start: weekStart });
  if (error) throw new Error(error.message);
  return data;
}

// OL only — apply the latest schedules to a week's still-upcoming
// meetings (silent; used when the OL edits schedules mid-week).
export async function resyncWeek(weekStart) {
  const { data, error } = await supabase.rpc('agenda_resync_week', { p_week_start: weekStart });
  if (error) throw new Error(error.message);
  return data;
}

export async function startMeeting(id) {
  const { data, error } = await supabase.rpc('agenda_start_meeting', { p_meeting: id });
  if (error) throw new Error(error.message);
  return data;
}

export async function finishMeeting(id) {
  const { data, error } = await supabase.rpc('agenda_finish_meeting', { p_meeting: id });
  if (error) throw new Error(error.message);
  return data;
}

export function subscribeAgendaMeetings(onChange) {
  const ch = supabase
    .channel(`agenda-meetings-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda_meetings' },
      () => onChange())
    .subscribe();
  return () => supabase.removeChannel(ch);
}

// --------------------------------------------------------------
// Ongoing meeting room (phase 3)
// --------------------------------------------------------------

// Attendance ---------------------------------------------------
export async function listMeetingAttendance(meetingId) {
  const { data, error } = await supabase
    .from('agenda_meeting_attendance')
    .select('*, apc:apc_id(id, display_name, avatar_url)')
    .eq('meeting_id', meetingId);
  if (error) throw new Error(error.message);
  return data || [];
}

// TL only — mark an APC present/absent (status null clears it).
export async function markAttendance(meetingId, apcId, status) {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('agenda_meeting_attendance')
    .upsert(
      { meeting_id: meetingId, apc_id: apcId, status,
        marked_by: auth?.user?.id || null, marked_at: new Date().toISOString() },
      { onConflict: 'meeting_id,apc_id' },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Presentations ------------------------------------------------
export async function listPresentations(meetingId) {
  const { data, error } = await supabase
    .from('agenda_presentations')
    .select('*, apc:apc_id(id, display_name, email, avatar_url), reviewer:reviewed_by(id, display_name)')
    .eq('meeting_id', meetingId);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function startPresenting(meetingId) {
  const { data, error } = await supabase.rpc('agenda_start_presenting', { p_meeting: meetingId });
  if (error) throw new Error(error.message);
  return data;
}

export async function stopPresenting(meetingId, apcId) {
  const { data, error } = await supabase.rpc('agenda_stop_presenting', { p_meeting: meetingId, p_apc: apcId });
  if (error) throw new Error(error.message);
  return data;
}

// OL — the per-APC overall rating + summary on the presentation row.
export async function updatePresentationReview(presentationId, { rating, summary }) {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('agenda_presentations')
    .update({ overall_rating: rating ?? null, overall_summary: summary ?? null, reviewed_by: auth?.user?.id || null })
    .eq('id', presentationId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Task reviews (OL) --------------------------------------------
export async function listTaskReviews(meetingId) {
  const { data, error } = await supabase
    .from('agenda_task_reviews')
    .select('*, task:task_id(id, title, details, due_date, status, link, brand:brand_id(brand_name)), reviewer:reviewed_by(id, display_name)')
    .eq('meeting_id', meetingId);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function saveTaskReview(meetingId, apcId, taskId, { rating, notes }) {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('agenda_task_reviews')
    .upsert(
      { meeting_id: meetingId, apc_id: apcId, task_id: taskId,
        rating: rating ?? null, notes: notes ?? null, reviewed_by: auth?.user?.id || null },
      { onConflict: 'meeting_id,task_id' },
    )
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// OL — TL remark, stored on the meeting row.
export async function updateTlRemark(meetingId, { rating, remark }) {
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('agenda_meetings')
    .update({ tl_rating: rating ?? null, tl_remark: remark ?? null, tl_reviewed_by: auth?.user?.id || null })
    .eq('id', meetingId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Realtime — every table the live room depends on, scoped to one meeting.
export function subscribeAgendaRoom(meetingId, onChange) {
  const ch = supabase
    .channel(`agenda-room-${meetingId}-${Math.random().toString(36).slice(2, 6)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda_meetings', filter: `id=eq.${meetingId}` }, () => onChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda_presentations', filter: `meeting_id=eq.${meetingId}` }, () => onChange())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'agenda_meeting_attendance', filter: `meeting_id=eq.${meetingId}` }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(ch);
}
