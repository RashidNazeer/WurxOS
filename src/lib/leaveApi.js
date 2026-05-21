import { supabase } from './supabase';

// --------------------------------------------------------------
// Leave categories / types
//   v2 "type" column now accepts: wfh | medical | emergency | half_leave | other
//   "half_leave" counts as 0.5 days against the medical quota.
//   "other" consumes no quota (fully unpaid, requires a title).
// --------------------------------------------------------------
export const LEAVE_TYPES = [
  { v: 'wfh',        label: 'Work from home',  bucket: 'wfh'     },
  { v: 'medical',    label: 'Medical leave',   bucket: 'medical' },
  { v: 'emergency',  label: 'Emergency leave', bucket: 'emergency' },
  { v: 'half_leave', label: 'Half-day leave',  bucket: 'medical' },
  { v: 'other',      label: 'Other',           bucket: null      },
];
export const leaveTypeLabel = (v) => LEAVE_TYPES.find((t) => t.v === v)?.label || v;
export const leaveTypeBucket = (v) => LEAVE_TYPES.find((t) => t.v === v)?.bucket || null;

export const LEVEL_LABEL = { 1: 'Direct manager', 2: 'Senior approver', 3: 'Boss' };

// --------------------------------------------------------------
// Reads
// --------------------------------------------------------------
export async function listMyLeaves(uid) {
  const { data, error } = await supabase
    .from('leave_requests')
    .select('*, decider:decided_by(display_name), requester:requester_id(display_name)')
    .eq('requester_id', uid)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// Pending requests where the caller is the *current* approver, plus
// recently-decided ones (last 60 days) for context. RLS filters by
// leave_current_approver(id) so the list is already scoped correctly.
export async function listLeavesForApproval(uid) {
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('leave_requests')
    .select('*, requester:requester_id(id, display_name, email, role, leave_quota)')
    .or(`status.eq.pending,decided_at.gte.${since}`)
    .neq('requester_id', uid)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Submit — BEFORE INSERT trigger computes paid/unpaid. Caller
// may preview the split with computePaidPreview() first.
// --------------------------------------------------------------
export async function submitLeave({ type, startDate, endDate, reason, otherTitle = null }) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;

  // Client-side guard: one pending request at a time. The server-side
  // trigger in migration 064 is authoritative, but this gives us a
  // friendlier error message without the round-trip.
  if (uid) {
    const { data: existing, error: checkErr } = await supabase
      .from('leave_requests')
      .select('id, created_at')
      .eq('requester_id', uid)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();
    if (checkErr) throw new Error(checkErr.message);
    if (existing) {
      const when = new Date(existing.created_at).toLocaleDateString();
      throw new Error(
        `You already have a pending request from ${when}. Wait for it to be decided, or cancel it, before submitting another.`,
      );
    }
  }

  const payload = {
    requester_id: uid,
    type,
    start_date: startDate,
    end_date:   endDate,
    reason:     reason || '',
    other_title: type === 'other' ? (otherTitle || 'Time off') : null,
  };
  const { data, error } = await supabase
    .from('leave_requests')
    .insert(payload)
    .select()
    .single();
  if (error) {
    // Normalize the server-side trigger's message for consistency.
    if (/already have a pending leave/i.test(error.message)) throw new Error(error.message);
    throw new Error(error.message);
  }
  return data;
}

// Returns the user's current open pending request, or null.
export async function getMyPendingRequest(uid) {
  const { data, error } = await supabase
    .from('leave_requests')
    .select('id, type, start_date, end_date, created_at, current_level, reason, other_title')
    .eq('requester_id', uid)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function cancelLeave(id) {
  const { error } = await supabase
    .from('leave_requests')
    .update({ status: 'cancelled' })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Decide — approve / reject / forward (multi-stage). Wraps the
// leave_decide() RPC which validates authorization server-side.
// --------------------------------------------------------------
export async function decideLeave(id, { action, note = '' }) {
  if (!['approve', 'reject', 'forward'].includes(action)) {
    throw new Error(`invalid action: ${action}`);
  }
  // DIAGNOSTIC — leave-approval issue 2026-05-11. Log every decide call
  // so we can correlate UI click → RPC dispatch when the server claims
  // 'not authorized'. Remove after the bug is reproduced + fixed.
  // eslint-disable-next-line no-console
  console.log('[leave_decide] sending', { id, action, note });
  const { data, error } = await supabase.rpc('leave_decide', {
    p_request_id: id,
    p_action:     action,
    p_note:       note || null,
  });
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[leave_decide] error', { id, action, error });
    throw new Error(error.message);
  }
  // eslint-disable-next-line no-console
  console.log('[leave_decide] success', { id, action, returnedStatus: data?.status, returnedLevel: data?.current_level });
  return data;
}

// Boss-only: flip paid_override on a decided request.
export async function setPaidOverride(id, override, note = '') {
  const { data, error } = await supabase.rpc('leave_set_paid_override', {
    p_request_id: id,
    p_override:   !!override,
    p_note:       note || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Quota math
// --------------------------------------------------------------
export async function getConsumedLeaves(uid, year = new Date().getFullYear()) {
  const { data, error } = await supabase.rpc('consumed_leaves', { p_user: uid, p_year: year });
  if (error) throw new Error(error.message);
  return data || { wfh: 0, medical: 0, emergency: 0 };
}

// Per-month consumption — v1's quota model resets monthly.
export async function getConsumedLeavesMonth(uid, year, month /* 1..12 */) {
  const { data, error } = await supabase.rpc('consumed_leaves_month', {
    p_user: uid, p_year: year, p_month: month,
  });
  if (error) throw new Error(error.message);
  return data || { wfh: 0, medical: 0, emergency: 0 };
}

// Count working days (Mon-Fri) in an inclusive range. Sat + Sun are
// never charged against any leave quota — they're already off. Mirrors
// the server-side _leave_working_days() helper so client preview and
// server-computed paid_days / unpaid_days always agree.
export function daysBetween(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const s = new Date(`${startStr}T00:00:00`);
  const e = new Date(`${endStr}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) return 0;
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Client-side preview of what the server trigger will compute so
// the submit modal can show paid vs unpaid BEFORE the insert fires.
export function computePaidPreview({ type, startDate, endDate, quota, consumedMonth }) {
  const requested = type === 'half_leave' ? 0.5 : daysBetween(startDate, endDate);
  if (type === 'other') return { requested, paid: 0, unpaid: requested, bucket: null, remaining: 0, quotaMax: 0 };
  const bucket = leaveTypeBucket(type);
  const quotaMax = Number(quota?.[bucket] ?? 0);
  const used = Number(consumedMonth?.[bucket] ?? 0);
  const remaining = Math.max(0, quotaMax - used);
  const paid   = Math.min(requested, remaining);
  const unpaid = Math.max(0, requested - remaining);
  return { requested, paid, unpaid, bucket, remaining, quotaMax };
}

// --------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------
// Is a particular decision entry the "current" open stage, i.e.
// we're still waiting on someone at this level?
export function currentPendingLevel(req) {
  if (req.status !== 'pending') return null;
  return req.current_level || 1;
}

// Who approved/rejected/forwarded at each level, in order.
export function decisionTimeline(req) {
  return (req.decisions || []).map((d) => ({
    level:  d.level,
    label:  d.level === 99 ? 'Paid override' : (LEVEL_LABEL[d.level] || `Level ${d.level}`),
    action: d.action,
    by:     d.by_name || 'Someone',
    at:     d.at,
    note:   d.note || '',
  }));
}

// =====================================================================
// v1-compat layer — mirror v1's `leaveRequests` doc shape so the
// verbatim-ported v1 LeaveRequestPage / BossLeaveRequestsPage can
// read/write v2 without modification.
//
// v1 fields (Firestore):
//   { id, category('leave'|'wfh'|'half_leave'|'other'), leaveType('medical'|'emergency')?,
//     otherTitle?, startDate, endDate, reason,
//     paidDays, unpaidDays, isPaidTimeOff,
//     requestedBy, requesterName, requesterEmail, requesterRole, assignedTo,
//     status('pending_tl'|'pending_ol'|'pending_boss'|'approved'|'rejected'|'withdrawn'),
//     intermediateApproval?:{ approverId, approverName, approverRole, status, forwardToBoss, rejectReason, resolvedAt },
//     bossApproval?:{ rejectReason, approverName, approverId, resolvedAt, status },
//     bossOverrideToPaid?:bool, withdrawnAt?, createdAt }
// =====================================================================

// Firestore Timestamp shim (same shape v1 calls .toDate() / .seconds on).
function fsTsLeave(value) {
  if (!value) return null;
  if (typeof value === 'object' && (value.toDate || typeof value.seconds === 'number')) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return {
    toDate: () => d,
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    valueOf: () => d.getTime(),
  };
}

// Pick the level-1 decision from `decisions[]` (most recent at L1) and
// the boss-level (L3) decision separately so v1's intermediateApproval +
// bossApproval display logic continues to work.
function buildApprovalShim(req) {
  const ds = req.decisions || [];
  if (!ds.length) return { intermediate: null, boss: null };

  const isPending  = req.status === 'pending';
  const isRejected = req.status === 'rejected';

  // The decisions log is append-only — even a stale rejection sticks
  // around after the request is re-opened and re-forwarded. To keep
  // the banner truthful, pick the most recent decision at level 1 or
  // 2 whose action is still semantically valid for the current state:
  //   * pending  → only 'approve'/'forward' entries are valid; a
  //                stale 'reject' would mislead the viewer ("rejected"
  //                next to "pending boss").
  //   * approved → show whichever action led there ('approve'/'forward').
  //   * rejected → the latest 'reject' IS the final decision; show it.
  const reversed = [...ds].reverse();
  const validForIntermediate = (d) => {
    if (d.level !== 1 && d.level !== 2) return false;
    if (isPending)  return d.action === 'approve' || d.action === 'forward';
    if (isRejected) return true; // any intermediate decision is fine to surface
    return d.action === 'approve' || d.action === 'forward';
  };
  const intermediate = reversed.find(validForIntermediate) || null;

  // Most recent decision at level 3 (Boss)
  const boss = reversed.find((d) => d.level === 3) || null;

  function shim(d, defaultRole) {
    if (!d) return null;
    return {
      approverId:    d.by || null,
      approverName:  d.by_name || 'Someone',
      approverRole:  defaultRole || '',
      status:        d.action === 'approve' ? 'approved' : d.action === 'reject' ? 'rejected' : 'forwarded',
      forwardToBoss: d.action === 'forward',
      rejectReason:  d.action === 'reject' ? (d.note || '') : null,
      resolvedAt:    d.at || null,
      note:          d.note || '',
    };
  }

  return {
    intermediate: shim(intermediate, intermediate?.level === 1 ? 'tl' : 'ol'),
    boss:         shim(boss, 'boss'),
  };
}

// Map v2 (type, status, current_level) → v1 (category, leaveType, status).
function mapTypeToCategory(type) {
  switch (type) {
    case 'wfh':        return { category: 'wfh',        leaveType: null };
    case 'half_leave': return { category: 'half_leave', leaveType: 'medical' };
    case 'medical':    return { category: 'leave',      leaveType: 'medical' };
    case 'emergency':  return { category: 'leave',      leaveType: 'emergency' };
    case 'other':      return { category: 'other',      leaveType: null };
    default:           return { category: type || 'other', leaveType: null };
  }
}
// Map (status, level, requester_role) → v1 status label.
//
// The label drives which approver tier the UI shows as "yours". The
// historical mapping only used `current_level` and assumed the
// requester was always an APC — that's wrong: a TL request at level 1
// is OL's turn, not TL's, and a TL request at level 2 is Boss's turn.
// Mislabelling it as `pending_ol` let the OL click Approve twice and
// the server rejected the second click as "not authorized".
function mapStatusToV1(status, current_level, requester_role) {
  if (status === 'pending') {
    const r = requester_role || 'apc';
    if (r === 'apc') {
      // APC chain (per mig 169): APC → TL → Boss. OL is not in the
      // chain. Forward from TL bumps current_level straight to 3.
      if (current_level === 1) return 'pending_tl';
      return 'pending_boss';
    }
    if (r === 'ipc') {
      // IPC chain: IPC → PCTL → Boss (PCTL is the IPC's reports_to).
      // Use a distinct status label so the UI shows "Pending PCTL"
      // and the PCTL's Team tab/Approve button targets it correctly.
      if (current_level === 1) return 'pending_pctl';
      return 'pending_boss';
    }
    if (r === 'tl' || r === 'pctl') {
      if (current_level === 1) return 'pending_ol';
      return 'pending_boss';
    }
    if (r === 'ol') {
      return 'pending_boss';
    }
    // Unknown role — fall through to a safe label that the OL UI gate
    // won't auto-include (it only accepts pending_tl / pending_ol).
    return 'pending_boss';
  }
  if (status === 'cancelled') return 'withdrawn';
  return status; // 'approved' | 'rejected'
}

// Map v1 category+leaveType → v2 type for INSERT.
export function categoryToType(category, leaveType) {
  if (category === 'wfh')        return 'wfh';
  if (category === 'half_leave') return 'half_leave';
  if (category === 'other')      return 'other';
  if (category === 'leave') {
    if (leaveType === 'emergency') return 'emergency';
    return 'medical';
  }
  return 'other';
}

// v2 row → v1 doc shape. Caller passes the joined `requester:` object too.
export function _normLeave(row) {
  if (!row) return row;
  const { category, leaveType } = mapTypeToCategory(row.type);
  const { intermediate, boss } = buildApprovalShim(row);
  const overrideEntry = (row.decisions || []).find((d) => d.level === 99);

  return {
    id:              row.id,
    category,
    leaveType,
    otherTitle:      row.other_title || '',
    startDate:       row.start_date || '',
    endDate:         row.end_date || '',
    reason:          row.reason || '',
    paidDays:        Number(row.paid_days || 0),
    unpaidDays:      Number(row.unpaid_days || 0),
    isPaidTimeOff:   Number(row.unpaid_days || 0) === 0,
    requestedBy:     row.requester_id || null,
    requesterName:   row.requester?.display_name || '',
    requesterEmail:  row.requester?.email || '',
    requesterRole:   row.requester?.role || '',
    requesterQuota:  row.requester?.leave_quota || null,
    assignedTo:      null, // multi-stage approver derived server-side, not stored on row
    status:          mapStatusToV1(row.status, row.current_level, row.requester?.role),
    currentLevel:    row.current_level || 1,
    intermediateApproval: intermediate,
    bossApproval:    boss,
    bossOverrideToPaid: !!row.paid_override,
    paidOverrideNote:   overrideEntry?.note || '',
    paidOverrideAt:     fsTsLeave(overrideEntry?.at),
    paidOverrideBy:     overrideEntry?.by_name || '',
    withdrawnAt:     row.status === 'cancelled' ? fsTsLeave(row.decided_at) : null,
    createdAt:       fsTsLeave(row.created_at),
    decidedAt:       fsTsLeave(row.decided_at),
    decisions:       row.decisions || [],
    _raw:            row,
  };
}

// ---------------------------------------------------------------------
// Bulk loaders for v1 pages
// ---------------------------------------------------------------------

// All requests for the current user. v1 calls listMyLeaves(uid).
export async function listMyLeavesV1(uid) {
  const rows = await listMyLeaves(uid);
  return rows.map(_normLeave);
}

// All requests visible to the caller. v2's RLS gates this:
//   - APC sees own only
//   - TL sees own + APC reports
//   - OL sees own + everyone in their tree
//   - Boss sees everything
// So a single `select *` query gets us the right scope.
export async function listAllLeavesV1() {
  const { data, error } = await supabase
    .from('leave_requests')
    .select('*, requester:requester_id(id, display_name, email, role, leave_quota)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normLeave);
}

// Realtime: subscribe to all visible leave_requests.
export function subscribeLeaves(onChange) {
  let stopped = false;
  // Always call onChange (even with []) on the initial fetch, regardless
  // of whether it succeeds — otherwise a network blip or RLS quirk
  // leaves the page spinning forever. The caller flips `loading` off
  // inside the callback, so we MUST fire it for the UI to recover.
  (async () => {
    try {
      const rows = await listAllLeavesV1();
      if (!stopped) onChange(rows);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[subscribeLeaves] initial fetch failed', err);
      if (!stopped) onChange([]);
    }
  })();
  const ch = supabase
    .channel(`leave-requests-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' },
      async () => {
        try {
          const rows = await listAllLeavesV1();
          if (!stopped) onChange(rows);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[subscribeLeaves] refresh after change failed', err);
        }
      })
    .subscribe();
  return () => { stopped = true; supabase.removeChannel(ch); };
}

// Active Boss profile — used by the leave UI to label requests that
// have been forwarded ("Forwarded to <Boss name>") for everyone except
// the OL who did the forwarding and the Boss themselves.
export async function getActiveBoss() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name')
    .eq('role', 'boss')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}

// User's monthly leave_quota (load from profiles.leave_quota; falls back
// to the global default if blank).
export async function getMyLeaveQuota(uid) {
  const { data, error } = await supabase
    .from('profiles')
    .select('leave_quota')
    .eq('id', uid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const DEFAULT = { medical: 1, emergency: 1, wfh: 2 };
  const raw = data?.leave_quota || DEFAULT;
  return {
    medical:   raw.medical   ?? DEFAULT.medical,
    emergency: raw.emergency ?? DEFAULT.emergency,
    wfh:       raw.wfh       ?? DEFAULT.wfh,
  };
}

// ---------------------------------------------------------------------
// v1-shaped writes
// ---------------------------------------------------------------------

// v1 NewRequestModal payload:
//   { category, leaveType, otherTitle, startDate, endDate, reason,
//     paidDays, unpaidDays, isPaidTimeOff }
// Ports to v2 submitLeave. paid/unpaid is recomputed server-side, but we
// still pass the v1-style fields through for parity.
export async function submitLeaveV1(payload) {
  const type = categoryToType(payload.category, payload.leaveType);
  const data = await submitLeave({
    type,
    startDate:  payload.startDate,
    endDate:    payload.endDate,
    reason:     payload.reason || '',
    otherTitle: payload.otherTitle || null,
  });
  return _normLeave({ ...data, requester: null });
}

// Withdraw == cancel (v2 supports cancelling pending OR rejected after
// migration 102).
export async function withdrawLeave(id) {
  return cancelLeave(id);
}

// TL/OL approval: v1 passes a `forwardToBoss` boolean. Map to v2 action:
//   forwardToBoss=true → 'forward' (move to next level)
//   forwardToBoss=false → 'approve' (final approval at this level)
export async function teamApproveLeave(id, { forwardToBoss = false, note = '' } = {}) {
  return decideLeave(id, {
    action: forwardToBoss ? 'forward' : 'approve',
    note,
  });
}

export async function teamRejectLeave(id, reason) {
  return decideLeave(id, { action: 'reject', note: reason || '' });
}

// Boss reviews "fully approved" requests can flip paid → unpaid or vice
// versa retroactively. v1 expected an explicit endpoint.
export async function bossPaidOverride(id, override, note = '') {
  return setPaidOverride(id, override, note);
}
