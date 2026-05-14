// ============================================================
// attendanceApi.js — drop-in compatible with v1's
// src/utils/attendanceService.js plus everything the v2 UI used.
//
// v1 markup reads camelCase fields off attendance rows
// (userId, userName, clockIn, clockOut, ownerId, autoClosed, etc.).
// v2's Postgres schema is snake_case and a profile join is needed
// for userName/userRole/userEmail/ownerId. We normalise every row
// returned from Supabase so v1 markup keeps working without per-
// component translations.
//
// Every export under v1's name calls the equivalent v2 SECURITY
// DEFINER RPC. Live listeners (onActiveRecord / onTeamToday /
// onAllToday / onPendingApprovals / onPendingEditClockOutRequests)
// use Supabase Realtime under the hood and pass the same callback
// shape v1 used.
// ============================================================

import { supabase } from './supabase';
import { getNow } from './serverTime';

// ────────────────────────────────────────────────────────────
// Row shape adapter
// ────────────────────────────────────────────────────────────
// Returns a record with both snake_case (Postgres) and camelCase
// (v1) fields. v1 expects `clockIn.toMillis()` on Firestore
// Timestamps; we hand back ISO strings and the v1 helpers below
// transparently accept either.
function _normalize(r) {
  if (!r) return r;
  const u = r.user || {};
  // Pending edit requests for this attendance row, if any. v1
  // surfaces these as nested editClockInRequest / editClockOutRequest
  // fields; we attach them when present in the join.
  const editList = Array.isArray(r.attendance_edit_requests)
    ? r.attendance_edit_requests : [];
  const edit = (field) => {
    const e = editList.find((x) => x.field === field && x.status === 'pending');
    if (!e) return undefined;
    return {
      requestedClockIn:  field === 'clock_in'  ? e.requested_value : undefined,
      requestedClockOut: field === 'clock_out' ? e.requested_value : undefined,
      requestedBreaks:   field === 'breaks'    ? (e.requested_breaks || []) : undefined,
      reason: e.reason,
      status: e.status,
      requestedAt: e.created_at,
      reviewedBy: e.decided_by,
      reviewedAt: e.decided_at,
      rejectionReason: e.decision_note || '',
      _editId: e.id,                        // v1 doesn't have this; we use it internally
    };
  };
  return {
    ...r,
    // v1 names ⇄ v2 columns
    userId:        r.user_id,
    userName:      u.display_name || r.user_name || '',
    userEmail:     u.email        || r.user_email || '',
    userRole:      u.role         || r.user_role  || '',
    ownerId:       u.reports_to   || r.owner_id   || null,
    avatarUrl:     u.avatar_url   || null,
    clockIn:       r.clock_in,
    clockOut:      r.clock_out,
    clockOutNote:  r.clock_out_note || '',
    requestedAt:   r.requested_at,
    requestTimeMs: r.request_time_ms || 0,
    totalWorkMs:   r.total_work_ms   || 0,
    totalBreakMs:  r.total_break_ms  || 0,
    autoClosed:                  !!r.auto_closed,
    autoClosedAt:                r.auto_closed_at,
    autoClosedAcknowledged:      !!r.auto_closed_acknowledged,
    closedByManagerId:    r.closed_by_manager_id   || null,
    closedByManagerRole:  r.closed_by_manager_role || null,
    closedByManagerReason: r.closed_by_reason      || null,
    closedByManagerAt:    r.closed_by_at           || null,
    approvalBy:           r.approval_by || null,
    approvalAt:           r.approval_at || null,
    approvalNote:         r.approval_note || null,
    stillWorkingAckAt:    r.still_working_ack_at || null,
    autoClockOut:         r.auto_clock_out || false,
    autoClockOutNote:     r.auto_clock_out_note || '',
    editClockInRequest:   edit('clock_in'),
    editClockOutRequest:  edit('clock_out'),
    editBreaksRequest:    edit('breaks'),
  };
}
function _normalizeAll(rows) { return (rows || []).map(_normalize); }

// Common select string with the user join needed for v1 fields.
const SELECT_WITH_USER =
  '*, user:user_id(id, display_name, email, role, avatar_url, reports_to)';
// Same, plus pending edit requests for the row (so editClockInRequest /
// editClockOutRequest get populated automatically).
const SELECT_WITH_USER_AND_EDITS =
  SELECT_WITH_USER + ', attendance_edit_requests(id, field, requested_value, requested_breaks, reason, status, decided_by, decided_at, decision_note, created_at)';

// ────────────────────────────────────────────────────────────
// Time helpers — match v1 exactly (clamp at 16h MAX_SHIFT,
// subtract breaks + request-time idle)
// ────────────────────────────────────────────────────────────
const MAX_SHIFT_MS          = 16 * 60 * 60 * 1000;
const REMINDER_THRESHOLD_MS = 9  * 60 * 60 * 1000;
const STALE_THRESHOLD_MS    = 14 * 60 * 60 * 1000;
const ACK_WINDOW_MS         = 3  * 60 * 60 * 1000;

function _ms(t) {
  if (!t) return null;
  if (t.toMillis) return t.toMillis();
  return new Date(t).getTime();
}

export function calcTimes(record) {
  if (!record) return { totalWorkMs: 0, totalBreakMs: 0, requestTimeMs: 0 };
  const clockInRaw = record.clockIn ?? record.clock_in;
  if (!clockInRaw) return { totalWorkMs: 0, totalBreakMs: 0, requestTimeMs: 0 };

  const clockInMs   = _ms(clockInRaw);
  // Use server-anchored time so users with wrong system clocks still see a
  // correct running elapsed (otherwise nowMs < clockInMs → session clamps to 0).
  const nowMs       = getNow();
  const actualEndMs = (record.clockOut ?? record.clock_out)
    ? _ms(record.clockOut ?? record.clock_out)
    : nowMs;
  const maxEndMs    = clockInMs + MAX_SHIFT_MS;
  const endMs       = Math.min(actualEndMs, maxEndMs);

  let totalBreakMs = 0;
  (record.breaks || []).forEach((b) => {
    const bStart = _ms(b.start);
    if (bStart === null || bStart >= endMs) return;
    const bEndRaw = b.end ? _ms(b.end) : nowMs;
    const bEnd = Math.min(bEndRaw, endMs);
    totalBreakMs += Math.max(0, bEnd - bStart);
  });

  let requestTimeMs = 0;
  const reqRaw = record.requestedAt ?? record.requested_at;
  if (reqRaw) {
    const rStart  = _ms(reqRaw);
    const apprRaw = record.approvalAt ?? record.approval_at;
    const rEndRaw = apprRaw ? _ms(apprRaw)
      : ((record.status === 'pending-approval') ? nowMs : null);
    if (rEndRaw !== null) {
      const overlapStart = Math.max(rStart, clockInMs);
      const overlapEnd   = Math.min(rEndRaw, endMs);
      requestTimeMs = Math.max(0, overlapEnd - overlapStart);
    }
  }

  const totalWorkMs = Math.max(0, endMs - clockInMs - totalBreakMs - requestTimeMs);
  return { totalWorkMs, totalBreakMs, requestTimeMs };
}

export function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDurationLive(ms) {
  const safe = Math.max(0, ms || 0);
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// All attendance display is locked to Pakistan time (Asia/Karachi)
// regardless of the viewer's browser TZ. WurxCrew shifts are defined
// in Pakistan time and the DB stores Karachi-locked timestamps; if a
// remote OL on a US laptop sees "6:37 AM" instead of "6:37 PM",
// the timezone slip downstream of fmtTime is what creates the
// "edit time says future" bugs (memory: project_overview /
// reference_wurxos_v2_supabase — Asia/Karachi is the canonical zone).
export function fmtTime(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Karachi',
  });
}

export function fmtMs(ms) {
  if (!ms || ms < 0) return '0h 0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function _clockInMsOf(record) {
  if (!record) return null;
  const ci = record.clockIn ?? record.clock_in;
  return ci ? _ms(ci) : null;
}

export function isOverShift(record) {
  if (!record) return false;
  if (record.clockOut ?? record.clock_out) return false;
  const ms = _clockInMsOf(record);
  return ms ? Date.now() - ms > STALE_THRESHOLD_MS : false;
}

export function isOverReminder(record) {
  if (!record) return false;
  if (record.clockOut ?? record.clock_out) return false;
  const ms = _clockInMsOf(record);
  return ms ? Date.now() - ms > REMINDER_THRESHOLD_MS : false;
}

export function needsRecoveryPrompt(record) {
  if (!record) return false;
  if (record.clockOut ?? record.clock_out) return false;
  if (record.editClockOutRequest?.status === 'pending') return false;
  const clockedMs = _clockInMsOf(record);
  if (!clockedMs) return false;
  const elapsed = Date.now() - clockedMs;
  if (elapsed > STALE_THRESHOLD_MS) return true;
  const inDate = new Date(clockedMs);
  const now    = new Date();
  return inDate.getFullYear() !== now.getFullYear()
      || inDate.getMonth()    !== now.getMonth()
      || inDate.getDate()     !== now.getDate();
}

export function sessionAge(record) {
  if (!record) return 'fresh';
  if (record.clockOut ?? record.clock_out) return 'fresh';
  const ms = _clockInMsOf(record);
  if (!ms) return 'fresh';
  const elapsed = Date.now() - ms;
  if (elapsed > STALE_THRESHOLD_MS)    return 'stale';
  if (elapsed > REMINDER_THRESHOLD_MS) return 'long';
  return 'fresh';
}

export function hasFreshStillWorkingAck(record, windowMs = ACK_WINDOW_MS) {
  const ack = record?.stillWorkingAckAt ?? record?.still_working_ack_at;
  if (!ack) return false;
  return Date.now() - _ms(ack) < windowMs;
}

// v1's display rule: any open shift past STALE shows as 'auto-closed'
// purely for display, even before the cron actually closes the row.
// v2's cron runs at 8h so this only matters in the few-minute window
// between 8h and the next cron tick.
export function getEffectiveStatus(record) {
  if (!record) return null;
  if (record.autoClosed || record.auto_closed) return 'auto-closed';
  if (['clocked-in', 'on-break', 'pending-approval'].includes(record.status) && isOverShift(record)) {
    return 'auto-closed';
  }
  return record.status;
}

// ────────────────────────────────────────────────────────────
// Active record (cross-midnight safe)
// ────────────────────────────────────────────────────────────
export async function getActiveRecord(uid) {
  const { data, error } = await supabase
    .from('attendance')
    .select(SELECT_WITH_USER_AND_EDITS)
    .eq('user_id', uid)
    .is('clock_out', null)
    .in('status', ['clocked-in', 'on-break', 'pending-approval'])
    .order('clock_in', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// Drop-in for v1's onActiveRecord(uid, callback). Returns an
// unsubscribe function. Subscribes to ALL writes on the
// attendance table (RLS scopes to rows the user can see), and
// on every event re-fetches the active record.
// Returns { unsubscribe, refetch }. The realtime channel will refetch
// automatically when events arrive — but realtime can be flaky depending
// on Supabase plan / network, so callers should ALSO call refetch()
// after they perform actions (clock-in / clock-out / break) to guarantee
// the UI reflects the new state without waiting for realtime.
export function onActiveRecord(uid, callback) {
  let alive = true;
  const refetch = async () => {
    try {
      const r = await getActiveRecord(uid);
      if (alive) callback(r || null);
    } catch (e) {
      if (alive) callback(null);
    }
  };
  // Initial fetch.
  refetch();
  const ch = supabase
    .channel(`att-active-${uid}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'attendance', filter: `user_id=eq.${uid}` },
        refetch)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'attendance_edit_requests', filter: `user_id=eq.${uid}` },
        refetch)
    .subscribe();
  const unsubscribe = () => { alive = false; supabase.removeChannel(ch); };
  // Backward-compatible: callers that did `const unsub = onActiveRecord(...)`
  // and then called `unsub()` still work because Function.prototype is the
  // returned function. We attach `refetch` as a property on it so callers
  // that need it can do `unsub.refetch()`.
  unsubscribe.refetch = refetch;
  return unsubscribe;
}

// Today / Team / All — used by v1's manager dashboards.
export async function getTodayRecord(uid) {
  const d = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('attendance')
    .select(SELECT_WITH_USER_AND_EDITS)
    .eq('user_id', uid).eq('date', d).maybeSingle();
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function getTodayActiveOrToday(uid) {
  const open = await getActiveRecord(uid);
  if (open) return open;
  return getTodayRecord(uid);
}
// Alias for v2 callers using the original name.
export const getToday = getTodayActiveOrToday;

const OPEN_STATUSES = ['clocked-in', 'on-break', 'pending-approval'];

async function _fetchTeamToday(ownerId) {
  const today = new Date().toISOString().slice(0, 10);
  // Two queries — today's records + open records from any date —
  // merged by id so a night shift that started yesterday and is
  // still open shows up on today's team view.
  const [todayQ, openQ] = await Promise.all([
    supabase.from('attendance').select(SELECT_WITH_USER_AND_EDITS).eq('date', today),
    supabase.from('attendance').select(SELECT_WITH_USER_AND_EDITS).in('status', OPEN_STATUSES),
  ]);
  if (todayQ.error) throw new Error(todayQ.error.message);
  if (openQ.error)  throw new Error(openQ.error.message);
  const map = new Map();
  for (const r of todayQ.data || []) map.set(r.id, r);
  for (const r of openQ.data  || []) map.set(r.id, r);
  let rows = Array.from(map.values());
  if (ownerId) {
    // RLS already filters to the caller's scope; the ownerId arg
    // narrows further to the caller's direct reports + their own
    // record. Match v1's onTeamToday behaviour.
    rows = rows.filter((r) => {
      const u = r.user || {};
      return r.user_id === ownerId || u.reports_to === ownerId;
    });
  }
  return _normalizeAll(rows);
}

export function onTeamToday(ownerId, callback) {
  let alive = true;
  const refetch = async () => {
    try { const list = await _fetchTeamToday(ownerId); if (alive) callback(list); }
    catch { if (alive) callback([]); }
  };
  refetch();
  const ch = supabase
    .channel(`att-team-${ownerId}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, refetch)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_edit_requests' }, refetch)
    .subscribe();
  return () => { alive = false; supabase.removeChannel(ch); };
}

export function onAllToday(callback) {
  // null ownerId → no client-side filter; RLS lets Boss/OL see
  // everyone, TL sees their team, regular users see only their
  // own record. Same realtime pattern.
  return onTeamToday(null, callback);
}

export async function getPendingApprovals(ownerId) {
  let q = supabase.from('attendance')
    .select(SELECT_WITH_USER_AND_EDITS)
    .eq('status', 'pending-approval');
  if (ownerId) {
    // Caller wants their direct reports' pending requests. The
    // join filter on profiles.reports_to needs an explicit "exists"
    // — we just fetch & filter client-side since the row count is
    // tiny.
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (ownerId) rows = rows.filter((r) => r.user?.reports_to === ownerId);
  return _normalizeAll(rows);
}

export function onPendingApprovals(ownerId, callback) {
  let alive = true;
  const refetch = async () => {
    try { const list = await getPendingApprovals(ownerId); if (alive) callback(list); }
    catch { if (alive) callback([]); }
  };
  refetch();
  const ch = supabase
    .channel(`att-pending-${ownerId || 'all'}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, refetch)
    .subscribe();
  return () => { alive = false; supabase.removeChannel(ch); };
}

// Pending clock-out edit requests for one TL's reports.
export async function getPendingEditClockOutRequests(ownerId) {
  const { data, error } = await supabase
    .from('attendance_edit_requests')
    .select(`
      id, attendance_id, user_id, field, requested_value, reason, status, created_at,
      user:user_id(display_name, email, role, reports_to),
      attendance:attendance_id(*, user:user_id(display_name, email, role, reports_to))
    `)
    .eq('field', 'clock_out')
    .eq('status', 'pending');
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (ownerId) rows = rows.filter((r) => r.user?.reports_to === ownerId);
  // Reshape so v1 markup that reads `record.editClockOutRequest`
  // off an attendance-shaped row keeps working.
  return rows.map((req) => {
    const att = _normalize(req.attendance);
    return {
      ...att,
      editClockOutRequest: {
        requestedClockOut: req.requested_value,
        reason: req.reason,
        status: req.status,
        requestedAt: req.created_at,
        _editId: req.id,
      },
    };
  });
}

export function onPendingEditClockOutRequests(ownerId, callback) {
  let alive = true;
  const refetch = async () => {
    try { const list = await getPendingEditClockOutRequests(ownerId); if (alive) callback(list); }
    catch { if (alive) callback([]); }
  };
  refetch();
  const ch = supabase
    .channel(`att-edit-clockout-${ownerId || 'all'}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance_edit_requests' }, refetch)
    .subscribe();
  return () => { alive = false; supabase.removeChannel(ch); };
}

// ────────────────────────────────────────────────────────────
// Clock in / out / break — RPCs already exist
// ────────────────────────────────────────────────────────────
export async function clockIn(arg = 'wfh') {
  // v1 sig: clockIn({ userId, userName, ..., location })
  // v2 sig: clockIn(location)
  // Accept both so v1 markup keeps working.
  const location = (typeof arg === 'string') ? arg : (arg?.location || 'wfh');
  const { data, error } = await supabase.rpc('att_clock_in', { p_location: location });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// Direct clock out (for TL/OL/Boss — no approval). Just calls
// requestClockOut RPC — server decides based on the caller's role.
export async function clockOut(_userId) {
  const { data, error } = await supabase.rpc('att_request_clock_out', { p_note: null });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function requestClockOut(arg = null) {
  // v1: requestClockOut({ userId, clockOutNote, ... })
  // v2: requestClockOut(note) — string OR null
  let note = null;
  if (typeof arg === 'string') note = arg;
  else if (arg && typeof arg === 'object') note = arg.clockOutNote || null;
  const { data, error } = await supabase.rpc('att_request_clock_out', { p_note: note });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function startBreak(_userId) {
  const { data, error } = await supabase.rpc('att_start_break');
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function endBreak(_userId) {
  const { data, error } = await supabase.rpc('att_end_break');
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// v1 approveClockOut(attendanceId, approverId)
// v2 approveClockOut(id, approve, note=null) — already in api
export async function approveClockOut(attendanceId, approveOrApproverId, note = null) {
  // Disambiguate: if the second arg is a uuid string assume v1 (just approve);
  // if boolean treat as v2 signature.
  let approve = true, finalNote = note;
  if (typeof approveOrApproverId === 'boolean') {
    approve = approveOrApproverId;
  } else {
    // v1 caller passed approverId — we don't need it (auth.uid()
    // is used server-side); approve defaults to true.
  }
  const { data, error } = await supabase.rpc('att_approve_clock_out', {
    p_id: attendanceId, p_approve: approve, p_note: finalNote,
  });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

export async function rejectClockOut(attendanceId, _approverId, reason) {
  const { data, error } = await supabase.rpc('att_approve_clock_out', {
    p_id: attendanceId, p_approve: false, p_note: reason || null,
  });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// ────────────────────────────────────────────────────────────
// Auto-close acknowledgement
// ────────────────────────────────────────────────────────────
export async function getUnacknowledgedAutoCloses(uid) {
  const { data, error } = await supabase
    .from('attendance')
    .select(SELECT_WITH_USER)
    .eq('user_id', uid)
    .eq('auto_closed', true)
    .eq('auto_closed_acknowledged', false)
    .order('date', { ascending: false });
  if (error) throw new Error(error.message);
  return _normalizeAll(data);
}

export async function acknowledgeAutoClose(attendanceId) {
  const { data, error } = await supabase.rpc('att_acknowledge_auto_close', {
    p_attendance_id: attendanceId,
  });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// ────────────────────────────────────────────────────────────
// Edit clock-in / clock-out — request, approve, reject, direct
// ────────────────────────────────────────────────────────────
export async function requestEditClockIn({
  attendanceId, requestedClockInMs, reason,
}) {
  const iso = new Date(requestedClockInMs).toISOString();
  const { data, error } = await supabase.rpc('att_request_edit', {
    p_attendance_id: attendanceId,
    p_field: 'clock_in',
    p_requested: iso,
    p_reason: reason || '',
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function requestEditClockOut({
  attendanceId, requestedClockOutMs, reason,
}) {
  const iso = new Date(requestedClockOutMs).toISOString();
  const { data, error } = await supabase.rpc('att_request_edit', {
    p_attendance_id: attendanceId,
    p_field: 'clock_out',
    p_requested: iso,
    p_reason: reason || '',
  });
  if (error) throw new Error(error.message);
  return data;
}

// Generic edit-request submission used by v2 internals.
export async function requestAttendanceEdit({ attendanceId, field, requestedValue, reason }) {
  const { data, error } = await supabase.rpc('att_request_edit', {
    p_attendance_id: attendanceId,
    p_field:         field,
    p_requested:     requestedValue,
    p_reason:        reason,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Submit a break-edit request — APC asks their TL to apply a new
// breaks array to the attendance row. The new array fully replaces
// the existing one on approve. Each entry is { start, end } ISO
// strings; an open in-progress break can be sent with end=null and
// will be ignored by total_break_ms but stored in the row.
//
// Mig 168 added field='breaks' and a requested_breaks jsonb column.
export async function requestBreakEdit({ attendanceId, breaks, reason }) {
  const payload = Array.isArray(breaks)
    ? breaks.map((b) => ({
        start: b.start ? new Date(b.start).toISOString() : null,
        end:   b.end   ? new Date(b.end).toISOString()   : null,
      }))
    : [];
  const { data, error } = await supabase.rpc('att_request_break_edit', {
    p_attendance_id: attendanceId,
    p_breaks:        payload,
    p_reason:        reason || '',
  });
  if (error) throw new Error(error.message);
  return data;
}

// Decide a pending break edit (TL / OL / Boss). Same approve/reject
// flow as clock_in/clock_out. The applied breaks array fully
// replaces the row's existing breaks; total_break_ms + total_work_ms
// get recomputed server-side.
export async function approveBreakEdit(attendanceId) {
  return _decideEdit(attendanceId, 'breaks', true, null);
}
export async function rejectBreakEdit(attendanceId, rejectionReason) {
  return _decideEdit(attendanceId, 'breaks', false, rejectionReason || '');
}

async function _decideEdit(attendanceId, field, approve, note = null) {
  // Look up the latest edit-request for (attendance, field). Used to
  // resolve the editId for v1-style callers that pass attendanceId.
  //
  // Idempotency: if the latest request is already decided, return it
  // as a no-op success. A double-click would otherwise hit either
  // "No pending edit request" here or "already decided" server-side —
  // both are benign once the first click went through, and the user
  // doesn't want to see them as a failed action.
  const { data: latest, error: pErr } = await supabase
    .from('attendance_edit_requests')
    .select('id, status, field')
    .eq('attendance_id', attendanceId)
    .eq('field', field)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!latest) throw new Error('No edit request found for this attendance row.');
  if (latest.status !== 'pending') {
    // Already approved or rejected — treat as success.
    return latest;
  }
  const { data, error } = await supabase.rpc('att_decide_edit', {
    p_edit_id: latest.id,
    p_approve: !!approve,
    p_note:    note,
  });
  if (error) {
    // Server can also race and say "already decided" if another tab
    // beat us. Same idempotent treatment.
    if (/already decided/i.test(error.message)) return latest;
    throw new Error(error.message);
  }
  return data;
}

export async function approveEditClockIn(attendanceId, _approverId) {
  return _decideEdit(attendanceId, 'clock_in', true, null);
}
export async function rejectEditClockIn(attendanceId, _approverId, rejectionReason) {
  return _decideEdit(attendanceId, 'clock_in', false, rejectionReason || '');
}
export async function approveEditClockOut(attendanceId, _approverId) {
  return _decideEdit(attendanceId, 'clock_out', true, null);
}
export async function rejectEditClockOut(attendanceId, _approverId, rejectionReason) {
  return _decideEdit(attendanceId, 'clock_out', false, rejectionReason || '');
}

// Decide-by-edit-request-id — for v2 callers that already hold the id.
// Idempotent: "already decided" is treated as a successful no-op so a
// double-click doesn't surface an error to the manager.
export async function decideAttendanceEdit({ editId, approve, note = null }) {
  const { data, error } = await supabase.rpc('att_decide_edit', {
    p_edit_id: editId,
    p_approve: !!approve,
    p_note:    note,
  });
  if (error) {
    if (/already decided/i.test(error.message)) {
      const { data: existing } = await supabase
        .from('attendance_edit_requests')
        .select('id, status, field, decided_by, decided_at')
        .eq('id', editId)
        .maybeSingle();
      return existing || { id: editId, status: approve ? 'approved' : 'rejected' };
    }
    throw new Error(error.message);
  }
  return data;
}

// Direct edits (TL/OL/Boss). The SECURITY DEFINER decide path
// requires a request row, so we synthesise one and immediately
// approve. This keeps the audit trail consistent.
async function _directEdit(attendanceId, field, ms) {
  const iso = new Date(ms).toISOString();
  const { data: req, error: e1 } = await supabase.rpc('att_request_edit', {
    p_attendance_id: attendanceId,
    p_field:         field,
    p_requested:     iso,
    p_reason:        'manager direct edit',
  });
  if (e1) throw new Error(e1.message);
  const editId = req?.id ?? req?.[0]?.id ?? null;
  if (!editId) throw new Error('Could not create edit request for direct edit.');
  const { data, error } = await supabase.rpc('att_decide_edit', {
    p_edit_id: editId, p_approve: true, p_note: null,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function editClockInDirect(attendanceId, newClockInMs) {
  return _directEdit(attendanceId, 'clock_in', newClockInMs);
}
export async function editClockOutDirect(attendanceId, newClockOutMs) {
  return _directEdit(attendanceId, 'clock_out', newClockOutMs);
}

export async function listMyEditRequests(uid) {
  const { data, error } = await supabase
    .from('attendance_edit_requests')
    .select('*, attendance:attendance_id(date, clock_in, clock_out)')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listPendingEditRequests() {
  const { data, error } = await supabase
    .from('attendance_edit_requests')
    .select('*, user:user_id(display_name, email, role), attendance:attendance_id(date, clock_in, clock_out, breaks)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// ────────────────────────────────────────────────────────────
// Force-close (Boss / Developer only — v2 cron retires the OL case)
// ────────────────────────────────────────────────────────────
export async function forceCloseSession(arg) {
  // v1 sig:  forceCloseSession({ attendanceId, newClockOutMs, closerId, closerName, closerRole, reason })
  // v2 sig:  forceCloseSession({ attendanceId, clockOut, reason })
  const attendanceId = arg.attendanceId;
  const reason       = arg.reason || null;
  const ms           = arg.newClockOutMs;
  const clockOutIso  = arg.clockOut || (ms ? new Date(ms).toISOString() : null);
  if (!clockOutIso) throw new Error('clock_out timestamp required');
  const { data, error } = await supabase.rpc('att_force_close', {
    p_attendance_id: attendanceId,
    p_clock_out:     clockOutIso,
    p_reason:        reason,
  });
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// ────────────────────────────────────────────────────────────
// Still-working acknowledgement
// ────────────────────────────────────────────────────────────
export async function markStillWorking(_attendanceId) {
  // v1 takes attendanceId; v2 RPC stamps the caller's latest open
  // row server-side. We accept and ignore the arg for compatibility.
  const { data, error } = await supabase.rpc('att_mark_still_working');
  if (error) throw new Error(error.message);
  return _normalize(data);
}

// ────────────────────────────────────────────────────────────
// History queries
// ────────────────────────────────────────────────────────────
export async function getUserHistory(uid, startDate, endDate) {
  let q = supabase
    .from('attendance')
    .select(SELECT_WITH_USER_AND_EDITS)
    .eq('user_id', uid);
  if (startDate) q = q.gte('date', startDate);
  if (endDate)   q = q.lte('date', endDate);
  q = q.order('date', { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return _normalizeAll(data);
}

export async function getTeamHistory(ownerId, startDate, endDate) {
  let q = supabase.from('attendance').select(SELECT_WITH_USER_AND_EDITS);
  if (startDate) q = q.gte('date', startDate);
  if (endDate)   q = q.lte('date', endDate);
  q = q.order('date', { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (ownerId) rows = rows.filter((r) => r.user?.reports_to === ownerId);
  return _normalizeAll(rows);
}

export async function getAllHistory(startDate, endDate) {
  // Boss/OL — RLS lets them see every row.
  let q = supabase.from('attendance').select(SELECT_WITH_USER_AND_EDITS);
  if (startDate) q = q.gte('date', startDate);
  if (endDate)   q = q.lte('date', endDate);
  q = q.order('date', { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return _normalizeAll(data);
}

export async function getTeamAndSelfHistory(uid, startDate, endDate) {
  // Team rows where reports_to = uid, plus the caller's own.
  const team = await getTeamHistory(uid, startDate, endDate);
  const self = await getUserHistory(uid, startDate, endDate);
  const map = new Map();
  for (const r of [...team, ...self]) map.set(r.id, r);
  return Array.from(map.values()).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// v2-style range-shaped history wrappers (kept for the existing
// AttendancePage.jsx pieces that use them while we finish stage 4).
export async function listHistory(uid, { from, to } = {}) {
  return getUserHistory(uid, from, to);
}
export async function listTeamHistory({ from, to } = {}) {
  // No ownerId filter — RLS scopes the result naturally.
  return getAllHistory(from, to);
}
export async function listToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('attendance')
    .select(SELECT_WITH_USER_AND_EDITS)
    .eq('date', today)
    .order('clock_in', { ascending: true });
  if (error) throw new Error(error.message);
  return _normalizeAll(data);
}
// v2-style wrapper that returns ALL pending approvals (RLS scoped).
export async function listPendingApprovals() {
  const { data, error } = await supabase.from('attendance')
    .select(SELECT_WITH_USER_AND_EDITS)
    .eq('status', 'pending-approval')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return _normalizeAll(data);
}

// ────────────────────────────────────────────────────────────
// Roster — manual attendance adjustments
// ────────────────────────────────────────────────────────────
export async function listAdjustmentsForMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const last  = new Date(y, m, 0).getDate();
  const end   = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  const { data, error } = await supabase
    .from('attendance_adjustments')
    .select('id, user_id, date, note, bulk, created_by, created_by_role, created_at')
    .gte('date', start).lte('date', end)
    .order('date', { ascending: true });
  if (error) throw new Error(error.message);
  // Add v1 alias fields so markup that reads `userId` works.
  return (data || []).map((a) => ({ ...a, userId: a.user_id, addedBy: a.created_by, addedAt: a.created_at }));
}

export async function listAdjustmentsForUserMonth(userId, monthStr) {
  const all = await listAdjustmentsForMonth(monthStr);
  return all.filter((a) => a.user_id === userId);
}

// v1 alias — same shape.
export const getAdjustmentsForMonth = listAdjustmentsForMonth;

// v1: createAttendanceAdjustment({ userId, userName, userRole, date, note, addedBy, addedByName, addedByRole })
export async function createAttendanceAdjustment(arg) {
  const userId = arg.userId;
  const date   = arg.date;
  const note   = arg.note || null;
  const { data, error } = await supabase.rpc('att_adjust_create', {
    p_user_id: userId, p_date: date, p_note: note,
  });
  if (error) throw new Error(error.message);
  return data?.id || data;
}
// v2 short form
export async function addAdjustment({ userId, date, note = null }) {
  const { data, error } = await supabase.rpc('att_adjust_create', {
    p_user_id: userId, p_date: date, p_note: note,
  });
  if (error) throw new Error(error.message);
  return data;
}

// v1 sig: updateAttendanceAdjustment(adjustmentId, { note, ... })
// We resolve adjustmentId → (userId, date) and call the RPC.
export async function updateAttendanceAdjustment(adjustmentId, { note }) {
  const { data: row, error: e1 } = await supabase
    .from('attendance_adjustments')
    .select('user_id, date')
    .eq('id', adjustmentId).maybeSingle();
  if (e1) throw new Error(e1.message);
  if (!row) throw new Error('Adjustment not found.');
  const { data, error } = await supabase.rpc('att_adjust_update_note', {
    p_user_id: row.user_id, p_date: row.date, p_note: note ?? null,
  });
  if (error) throw new Error(error.message);
  return data;
}

// v1 sig: deleteAttendanceAdjustment(adjustmentId)
export async function deleteAttendanceAdjustment(adjustmentId) {
  const { data: row, error: e1 } = await supabase
    .from('attendance_adjustments')
    .select('user_id, date')
    .eq('id', adjustmentId).maybeSingle();
  if (e1) throw new Error(e1.message);
  if (!row) throw new Error('Adjustment not found.');
  return deleteAdjustment({ userId: row.user_id, date: row.date });
}

// v2 short form
export async function deleteAdjustment({ userId, date }) {
  const { data, error } = await supabase.rpc('att_adjust_delete', {
    p_user_id: userId, p_date: date,
  });
  if (error) throw new Error(error.message);
  return data;
}

// v1 sig: bulkMarkMissedAsPresent({ monthStr, targetUsers, monthRecords, monthAdjusts, monthLeaves, note, actor, onProgress })
// v2 sig: bulkMarkMissedAsPresent({ monthStr, userIds, note })
// Server-side does the missed-day computation; we ignore the
// pre-computed records/adjusts/leaves args from v1 if passed.
export async function bulkMarkMissedAsPresent(arg) {
  const monthStr = arg.monthStr;
  const note     = arg.note || null;
  const userIds  = arg.userIds
    || (Array.isArray(arg.targetUsers) ? arg.targetUsers.map((u) => u.id) : []);
  const { data, error } = await supabase.rpc('att_adjust_bulk_mark_missed', {
    p_month: monthStr, p_user_ids: userIds, p_note: note,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    adjustmentsCreated: row?.days_added || 0,
    usersTouched:       row?.users_touched || 0,
    days_added:         row?.days_added || 0,
    users_touched:      row?.users_touched || 0,
  };
}

// ────────────────────────────────────────────────────────────
// Roster maths — unchanged from v1 (pure JS)
// ────────────────────────────────────────────────────────────

// True if `ds` (YYYY-MM-DD) is a Sat/Sun in the local calendar. Used
// to ensure weekend dates never count for or against attendance.
export function isWeekendDate(ds) {
  if (!ds) return false;
  const [y, m, d] = ds.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

// Expand a leave range into a Set of YYYY-MM-DD strings, skipping
// Sat/Sun and any date present in `holidaySet` (a Set of YYYY-MM-DD
// holiday dates). Optionally clip to [mStart, mEnd]. Use this anywhere
// you previously expanded a leave range by adding every calendar day —
// a Fri+Mon leave is 2 days, not 4, and a leave that overlaps a
// company holiday should not double-count those days either.
export function expandLeaveWeekdays(startDate, endDate, { mStart, mEnd, holidaySet } = {}) {
  const out = new Set();
  if (!startDate || !endDate) return out;
  const pad = (n) => String(n).padStart(2, '0');
  const a = new Date(startDate + 'T00:00:00').getTime();
  const b = new Date(endDate   + 'T00:00:00').getTime();
  for (let t = a; t <= b; t += 86400000) {
    const d = new Date(t);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (mStart && ds < mStart) continue;
    if (mEnd   && ds > mEnd)   continue;
    if (holidaySet && holidaySet.has(ds)) continue;
    out.add(ds);
  }
  return out;
}

export function missedWeekdayDatesFor(userId, monthStr, monthRecords, monthAdjusts, monthLeaves) {
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const today = _ymd(new Date());

  const userRecords = (monthRecords || []).filter((r) => (r.userId || r.user_id) === userId);
  const userAdjusts = (monthAdjusts || []).filter((a) => (a.userId || a.user_id) === userId);
  const userLeaves  = (monthLeaves  || []).filter(
    (l) => (l.requestedBy || l.requester_id) === userId &&
           (l.category === 'leave' || ['medical', 'emergency'].includes(l.type)),
  );

  const presentSet = new Set();
  userRecords.forEach((r) => { if (r.date && (r.clockIn || r.clock_in)) presentSet.add(r.date); });
  const adjustedSet = new Set(userAdjusts.map((a) => a.date).filter(Boolean));
  const leaveSet = new Set();
  userLeaves.forEach((l) => {
    const startDate = l.startDate || l.start_date;
    const endDate   = l.endDate   || l.end_date;
    if (!startDate || !endDate) return;
    const a = new Date(startDate + 'T00:00:00').getTime();
    const b = new Date(endDate   + 'T00:00:00').getTime();
    for (let t = a; t <= b; t += 86400000) leaveSet.add(_ymd(new Date(t)));
  });

  const missed = [];
  for (let day = 1; day <= lastDay; day++) {
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (ds > today) continue;
    const dow = new Date(y, m - 1, day).getDay();
    if (dow === 0 || dow === 6) continue;
    if (presentSet.has(ds))  continue;
    if (adjustedSet.has(ds)) continue;
    if (leaveSet.has(ds))    continue;
    missed.push(ds);
  }
  return missed;
}

export function computeMonthlyDays(userId, monthRecords, monthAdjusts) {
  const userRecords = (monthRecords || []).filter((r) => (r.userId || r.user_id) === userId);
  const userAdjusts = (monthAdjusts || []).filter((a) => (a.userId || a.user_id) === userId);
  // Weekend clock-ins / adjustments are ignored for performance scoring —
  // Sat/Sun are not working days, so they cannot compensate for missed
  // weekdays (which would otherwise let someone hit 100% by working two
  // Saturdays while skipping two Mon-Fri).
  const actualDateSet = new Set();
  userRecords.forEach((r) => {
    if (!r.date) return;
    if (isWeekendDate(r.date)) return;
    if (r.clockIn || r.clock_in) actualDateSet.add(r.date);
  });
  const effectiveSet = new Set(actualDateSet);
  userAdjusts.forEach((a) => {
    if (!a.date || isWeekendDate(a.date)) return;
    effectiveSet.add(a.date);
  });
  return { actualDays: actualDateSet.size, effectiveDays: effectiveSet.size, adjustments: userAdjusts };
}

// Same shape as v1's; preserved for the v2 widget.
// Optional `holidayDates` is a Set of YYYY-MM-DD strings inside the month;
// holiday weekdays count as accounted (present-equivalent) so users get
// credit for company-wide off days without needing a clock-in.
export function summarizeMonth({ rows, adjustments, leaveDates, holidayDates, monthStr, today = new Date() }) {
  const [y, m] = monthStr.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd   = new Date(y, m, 0);

  let workingDays = 0;
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) workingDays++;
  }

  // Weekend clock-ins are ignored — see computeMonthlyDays for rationale.
  const presentDates = new Set();
  let totalWorkMs = 0;
  (rows || []).forEach((r) => {
    if (!r.date) return;
    const ds = String(r.date);
    if (ds.slice(0, 7) !== monthStr) return;
    if (isWeekendDate(ds)) {
      // Hours worked stat still totals every row so the "Hours worked this
      // month" tile reflects actual time. Only the present-day count skips.
      totalWorkMs += r.total_work_ms || r.totalWorkMs || 0;
      return;
    }
    if (r.clock_in || r.clockIn) presentDates.add(ds);
    totalWorkMs += r.total_work_ms || r.totalWorkMs || 0;
  });

  const adjustedDates = new Set(
    (adjustments || []).map((a) => a.date).filter((d) => d && !isWeekendDate(d)),
  );
  const leaveSet   = leaveDates   instanceof Set ? leaveDates   : new Set(leaveDates   || []);
  const holidaySet = holidayDates instanceof Set ? holidayDates : new Set(holidayDates || []);
  const accountedDates = new Set([...presentDates, ...adjustedDates, ...leaveSet, ...holidaySet]);

  const todayMid = new Date(today); todayMid.setHours(0, 0, 0, 0);
  let missed = 0;
  for (let d = new Date(monthStart); d <= monthEnd && d < todayMid; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const ds = _ymd(d);
    if (!accountedDates.has(ds)) missed++;
  }
  return {
    workingDays,
    presentDays:   presentDates.size,
    leaveDays:     leaveSet.size,
    holidayDays:   holidaySet.size,
    adjustedDays:  adjustedDates.size,
    accountedDays: accountedDates.size,
    missedDays:    missed,
    totalWorkMs,
    presentDates,
    adjustedDates,
    leaveDates:    leaveSet,
    holidayDates:  holidaySet,
  };
}

// Approved-leave dates for one user inside a month, expanded
// day-by-day (weekends excluded). WFH excluded.
export async function listApprovedLeaveDatesForMonth(userId, monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const last  = new Date(y, m, 0).getDate();
  const end   = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  const { data, error } = await supabase
    .from('leave_requests')
    .select('start_date, end_date')
    .eq('requester_id', userId)
    .eq('status', 'approved')
    .in('type', ['medical', 'emergency'])
    .lte('start_date', end)
    .gte('end_date',   start);
  if (error) throw new Error(error.message);
  const out = new Set();
  (data || []).forEach((lv) => {
    const cur  = new Date(lv.start_date + 'T00:00:00');
    const stop = new Date(lv.end_date   + 'T00:00:00');
    while (cur <= stop) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) {
        const ds = _ymd(cur);
        if (ds >= start && ds <= end) out.add(ds);
      }
      cur.setDate(cur.getDate() + 1);
    }
  });
  return out;
}

function _ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ────────────────────────────────────────────────────────────
// Roster bulk fetch — every attendance row + every approved
// leave overlapping the given month. v1 used two parallel
// Firestore reads; v2 mirrors it via two parallel Supabase
// queries. RLS scopes the result for non-Boss/OL callers.
// ────────────────────────────────────────────────────────────
export async function fetchRosterMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const last  = new Date(y, m, 0).getDate();
  const end   = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  const [attQ, leaveQ] = await Promise.all([
    supabase.from('attendance').select(SELECT_WITH_USER).gte('date', start).lte('date', end),
    supabase.from('leave_requests')
      .select('id, requester_id, type, status, start_date, end_date')
      .eq('status', 'approved')
      .in('type', ['medical', 'emergency'])
      .lte('start_date', end).gte('end_date', start),
  ]);
  if (attQ.error)   throw new Error(attQ.error.message);
  if (leaveQ.error) throw new Error(leaveQ.error.message);
  // Map leave rows to v1 shape: { requestedBy, category, startDate, endDate }.
  const leaves = (leaveQ.data || []).map((l) => ({
    id: l.id,
    requestedBy: l.requester_id,
    requester_id: l.requester_id,
    category: 'leave',
    type: l.type,
    startDate: l.start_date,
    endDate:   l.end_date,
    start_date: l.start_date,
    end_date:   l.end_date,
  }));
  return {
    records: _normalizeAll(attQ.data),
    leaves,
  };
}

// ────────────────────────────────────────────────────────────
// Roster + Today's "expected members" list. v1 read both `users`
// and `teamUsers` collections; v2 has a single `profiles` table.
// Returns the same shape v1's UI expects:
//   [{ id, name, role, email }]
// Boss / OL → everyone with a clock-in role
// TL / PCTL → their direct reports (profiles.reports_to = uid)
// ────────────────────────────────────────────────────────────
export async function listExpectedMembers({ uid, isBoss, isOL, isTL }) {
  let q = supabase
    .from('profiles')
    .select('id, display_name, email, role, is_active, reports_to')
    .is('deleted_at', null)
    .eq('is_active', true)
    .in('role', ['tl', 'pctl', 'ol', 'apc', 'ipc']);
  if (isTL && !isBoss && !isOL) q = q.eq('reports_to', uid);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id:    p.id,
    name:  p.display_name || p.email || '(unnamed)',
    role:  p.role || 'apc',
    email: p.email || '',
  }));
}

// ────────────────────────────────────────────────────────────
// Boss leave-quota config — global defaults applied to new
// profiles via the trigger added in mig 058.
// ────────────────────────────────────────────────────────────
export async function getLeaveQuotaDefault() {
  const { data, error } = await supabase
    .from('app_config').select('value').eq('key', 'leave_quota_default').maybeSingle();
  if (error) throw new Error(error.message);
  const v = data?.value || { wfh: 2, medical: 1, emergency: 1 };
  return {
    medical:   Number(v.medical   ?? 1),
    emergency: Number(v.emergency ?? 1),
    wfh:       Number(v.wfh       ?? 2),
  };
}

export async function setLeaveQuotaDefault({ medical, emergency, wfh }) {
  const value = {
    medical:   Number(medical) || 0,
    emergency: Number(emergency) || 0,
    wfh:       Number(wfh) || 0,
  };
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'leave_quota_default', value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return value;
}

// Scan approved+pending leave/wfh requests starting in the
// current month, tally per user per type. Used by the Boss
// quota-update flow to surface conflicts before applying.
// Returns [{ userName, type, used, newQuota }] for any user
// already over the proposed limit this month.
export async function scanLeaveQuotaConflicts(newQuota) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('leave_requests')
    .select('id, type, status, start_date, end_date, requester_id, requester:requester_id(display_name)')
    .neq('status', 'rejected')
    .gte('start_date', monthStart)
    .lte('start_date', monthEnd);
  if (error) throw new Error(error.message);

  const perUser = new Map();
  (data || []).forEach((r) => {
    const days = Math.max(1, Math.ceil((new Date(r.end_date) - new Date(r.start_date)) / 86400000) + 1);
    const uid = r.requester_id;
    if (!uid) return;
    if (!perUser.has(uid)) perUser.set(uid, {
      name: r.requester?.display_name || 'Unknown',
      used: { medical: 0, emergency: 0, wfh: 0 },
    });
    const e = perUser.get(uid);
    if (r.type === 'medical')   e.used.medical   += days;
    if (r.type === 'emergency') e.used.emergency += days;
    if (r.type === 'wfh')       e.used.wfh       += days;
  });

  const conflicts = [];
  perUser.forEach(({ name, used }) => {
    ['medical', 'emergency', 'wfh'].forEach((t) => {
      if (used[t] > (newQuota[t] || 0)) {
        conflicts.push({ userName: name, type: t, used: used[t], newQuota: newQuota[t] || 0 });
      }
    });
  });
  return conflicts;
}

// ────────────────────────────────────────────────────────────
// Pre-clock-out check for APC/IPC: do they have any incomplete
// daily tasks across their assigned brands? Mirrors v1's
// checkDailyTasks() — returns { ok: true } when all daily tasks
// are done/completed, or { ok: false, count, brandName } so the
// caller can render a blocker message.
// ────────────────────────────────────────────────────────────
export async function checkApcDailyTasks(uid) {
  // Daily tasks assigned to me, not done/completed.
  const { data, error } = await supabase
    .from('tasks')
    .select('id, brand_id, status, brand:brand_id(brand_name)')
    .eq('assignee_id', uid)
    .eq('category', 'daily')
    .not('status', 'in', '(done,completed)');
  if (error) throw new Error(error.message);
  const incomplete = data || [];
  if (incomplete.length === 0) return { ok: true };
  // Surface the brand of the FIRST incomplete task — same UX as v1.
  const first = incomplete[0];
  return {
    ok: false,
    count: incomplete.length,
    brandName: first.brand?.brand_name || 'a brand',
  };
}

// ────────────────────────────────────────────────────────────
// TL "auto-clock-out for my APCs" toggle. Patches the TL's own
// attendance row for today. Mirrors v1's pattern (clientside
// updateDoc on `${uid}_${today}` doc). v2 row id ≠ that string,
// so we look it up by (user_id, date) first.
// ────────────────────────────────────────────────────────────
async function _todayRow(uid) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('attendance').select('id')
    .eq('user_id', uid).eq('date', today).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id || null;
}

export async function setAutoClockOut(uid, enabled, note = null) {
  const id = await _todayRow(uid);
  if (!id) throw new Error('No attendance row for today.');
  const { error } = await supabase
    .from('attendance')
    .update({
      auto_clock_out:      !!enabled,
      auto_clock_out_note: enabled ? (note || null) : null,
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function setAutoClockOutNote(uid, note) {
  const id = await _todayRow(uid);
  if (!id) throw new Error('No attendance row for today.');
  const { error } = await supabase
    .from('attendance').update({ auto_clock_out_note: note ?? null }).eq('id', id);
  if (error) throw new Error(error.message);
}

// ────────────────────────────────────────────────────────────
// CSV export — mirror of v1's exportToCSV
// ────────────────────────────────────────────────────────────
export function exportToCSV(records) {
  const headers = ['Date', 'Name', 'Role', 'Location', 'Clock In', 'Clock Out', 'Status', 'Work Hours', 'Break Time', 'Request Time', 'Note'];
  const rows = (records || []).map((r) => {
    const t = calcTimes(r);
    const loc = r.location === 'wfh' ? 'Work From Home'
      : r.location === 'bahria' ? 'Bahria Office'
      : r.location === 'lakecity' ? 'Lake City Office'
      : r.location || '';
    return [
      r.date,
      r.userName || r.user?.display_name || '',
      r.userRole || r.user?.role || '',
      loc,
      fmtTime(r.clockIn ?? r.clock_in),
      fmtTime(r.clockOut ?? r.clock_out),
      r.status,
      fmtDuration(t.totalWorkMs),
      fmtDuration(t.totalBreakMs),
      fmtDuration(t.requestTimeMs),
      r.clockOutNote || r.clock_out_note || '',
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `attendance_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
