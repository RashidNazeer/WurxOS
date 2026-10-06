// Approvals inbox (spec F3). One query per source, keyed ['approvals', kind, uid],
// so a failing source never blanks the others. Every item is normalised to:
//   { kind, id, who, whoRole, title, detail, at, canAct, waitingOn, link, raw }
// Decisions reuse the existing mutations unchanged; the server stays
// authoritative (a "not authorized" comes back as an error and the row is restored).
import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui';
import { supabase } from './supabase';
import { listLeavesForApproval, _normLeave, teamApproveLeave, teamRejectLeave } from './leaveApi';
import {
  getPendingApprovals, getPendingEditClockOutRequests, listPendingEditRequests,
  listExpectedMembers, approveClockOut, rejectClockOut, decideAttendanceEdit, fmtTime,
} from './attendanceApi';
import { listReportStatuses, updateReportStatus } from './reportsApi';
import { deductPromptApcReport } from './apcReportingApi';
import { deductPrompt } from './tlPerfApi';
import { listBrandSwitchRequests, decideBrandSwitch } from './brandSwitchApi';
import { listChanges } from './changesApi';
import { reportUrl } from './reportLinks';

export const KINDS = ['leave', 'attendance', 'reports', 'brand', 'changes'];
export const KIND_LABEL = {
  leave: 'Leave', attendance: 'Attendance', reports: 'Reports', brand: 'Brand switches', changes: 'Changes',
};

// Which sources a role reviews.
export function kindsFor(role) {
  switch (role) {
    case 'tl':
    case 'pctl': return ['leave', 'attendance', ...(role === 'tl' ? ['reports'] : [])];
    case 'ol':   return ['leave', 'reports', 'brand'];
    case 'boss': return ['leave', 'reports', 'brand', 'changes'];
    default:     return [];
  }
}

// Same rule as the Leave page buttons (LeaveRequestPage / BossLeaveRequestsPage):
// you act only when it's your level in the chain.
const LEAVE_TURN = { tl: 'pending_tl', pctl: 'pending_pctl', ol: 'pending_ol', boss: 'pending_boss' };
const WAITING_ON = { pending_tl: 'TL', pending_pctl: 'PCTL', pending_ol: 'OL', pending_boss: 'Boss' };
const LEAVE_TYPE = { wfh: 'Work from home', half_leave: 'Half leave', other: 'Other request' };

const day = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const ts = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);

async function fetchLeave(uid, role) {
  const rows = (await listLeavesForApproval(uid)).filter((r) => r.status === 'pending').map(_normLeave);
  return rows.map((r) => {
    const label = r.category === 'leave'
      ? `${r.leaveType === 'emergency' ? 'Emergency' : 'Medical'} leave`
      : LEAVE_TYPE[r.category] || 'Leave';
    const days = r.paidDays + r.unpaidDays;
    const range = r.startDate === r.endDate ? day(r.startDate) : `${day(r.startDate)} – ${day(r.endDate)}`;
    const canAct = LEAVE_TURN[role] === r.status;
    return {
      kind: 'leave', id: r.id, who: r.requesterName, whoRole: r.requesterRole,
      title: label,
      detail: `${range}${days ? ` · ${days} day${days === 1 ? '' : 's'}${r.unpaidDays ? ` (${r.unpaidDays} unpaid)` : ''}` : ''}${r.reason ? ` · ${r.reason}` : ''}`,
      at: ts(r.createdAt), canAct, waitingOn: canAct ? null : WAITING_ON[r.status] || null,
      canForward: canAct && role !== 'boss',
      link: '/leave', raw: r,
    };
  });
}

async function fetchAttendance(uid) {
  const [outReqs, outEdits, edits, team] = await Promise.all([
    getPendingApprovals(uid),
    getPendingEditClockOutRequests(uid),
    listPendingEditRequests(),
    listExpectedMembers({ uid, isTL: true }),
  ]);
  const teamIds = new Set(team.map((m) => m.id));
  const items = [];
  outReqs.forEach((r) => items.push({
    kind: 'attendance', sub: 'clockout', id: `co:${r.id}`, targetId: r.id,
    who: r.userName, whoRole: r.userRole,
    title: 'Clock-out request',
    detail: `${fmtTime(r.clockOutRequestedAt || r.clock_out_requested_at)}${r.clockOutNote ? ` · ${r.clockOutNote}` : ''}`,
    at: ts(r.clockOutRequestedAt || r.clock_out_requested_at), canAct: true, link: '/attendance', raw: r,
  }));
  outEdits.forEach((r) => items.push({
    kind: 'attendance', sub: 'edit', id: `ed:${r.editClockOutRequest._editId}`, targetId: r.editClockOutRequest._editId,
    who: r.userName, whoRole: r.userRole,
    title: 'Clock-out time change',
    detail: `To ${fmtTime(r.editClockOutRequest.requestedClockOut)}${r.editClockOutRequest.reason ? ` · ${r.editClockOutRequest.reason}` : ''}`,
    at: ts(r.editClockOutRequest.requestedAt), canAct: true, link: '/attendance', raw: r,
  }));
  edits
    .filter((e) => e.field !== 'clock_out' && teamIds.has(e.user_id))
    .forEach((e) => items.push({
      kind: 'attendance', sub: 'edit', id: `ed:${e.id}`, targetId: e.id,
      who: e.user?.display_name || '', whoRole: e.user?.role,
      title: e.field === 'breaks' ? 'Break times change' : 'Clock-in time change',
      detail: `${e.field === 'clock_in' && e.requested_value ? `To ${fmtTime(e.requested_value)}` : ''}${e.reason ? ` · ${e.reason}` : ''}`.replace(/^ · /, ''),
      at: ts(e.created_at), canAct: true, link: '/attendance', raw: e,
    }));
  return items;
}

const TYPE_LABEL = { weekly: 'Weekly report', biweekly: 'Bi-weekly report', monthly: 'Monthly report' };

async function fetchReports(uid, role) {
  const wanted = role === 'tl' ? 'submitted' : 'verified';
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const rows = (await listReportStatuses({ since })).filter((r) => r.status === wanted);
  return rows.map((r) => ({
    kind: 'reports', id: r.id, who: r.authorName, whoRole: 'apc',
    title: `${TYPE_LABEL[r.type] || 'Report'} · ${r.brandName}`,
    detail: `${r.periodLabel || r.periodStart}${r.rejectionNote && wanted === 'submitted' ? ` · Returned by OL: ${r.rejectionNote}` : ''}`,
    at: ts(r.submittedAt || r.updatedAt), canAct: true,
    link: reportUrl({ id: r.id, brandId: r.brandId, type: r.type }), raw: r,
  }));
}

async function fetchBrandSwitches(uid, role) {
  const rows = (await listBrandSwitchRequests()).filter((r) => r.status === 'pending');
  return rows
    .filter((r) => role === 'boss' || r.requested_by === uid)
    .map((r) => {
      const target = r.to_apc?.display_name || r.to_owner?.display_name || '—';
      return {
        kind: 'brand', id: r.id, who: r.requester?.display_name || '', whoRole: r.requester?.role,
        title: `Brand switch · ${r.brand?.brand_name || ''}`,
        detail: `To ${target}${r.reason ? ` · ${r.reason}` : ''}`,
        at: ts(r.created_at), canAct: role === 'boss', waitingOn: role === 'boss' ? null : 'Boss',
        link: '/brand-switcher', raw: r,
      };
    });
}

async function fetchChanges() {
  const rows = await listChanges({ status: 'pending' });
  return rows.map((c) => ({
    kind: 'changes', id: c.id, who: c.submitted_by_name || c.submittedByName || '', whoRole: '',
    title: `Change request · ${c.title || c.change_code || ''}`,
    detail: c.change_code || '',
    at: ts(c.created_at), canAct: false, openOnly: true, link: '/changes', raw: c,
  }));
}

const FETCHERS = { leave: fetchLeave, attendance: fetchAttendance, reports: fetchReports, brand: fetchBrandSwitches, changes: fetchChanges };

export const approvalsKey = (kind, uid) => ['approvals', kind, uid];

export function approvalsPrefetchers(role, uid) {
  return kindsFor(role).map((k) => [approvalsKey(k, uid), () => FETCHERS[k](uid, role)]);
}

const itemKey = (x) => `${x.kind}:${x.id}`;
export const readsKey = (uid) => ['approvals', 'reads', uid];
const isActionable = (x) => x.canAct || x.openOnly;

async function fetchReadKeys(uid) {
  const { data, error } = await supabase.from('approval_reads').select('item_key').eq('user_id', uid);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.item_key);
}

// All sources for the signed-in user. Polls at 60 s while the tab is visible.
// `count` is the unread actionable total: what the sidebar and bottom tab show.
export function useApprovals() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const role = profile?.role;
  const kinds = kindsFor(role);
  const results = useQueries({
    queries: kinds.map((k) => ({
      queryKey: approvalsKey(k, uid),
      queryFn: () => FETCHERS[k](uid, role),
      enabled: !!uid,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      staleTime: 30_000,
    })),
  });
  const readsQuery = useQuery({
    queryKey: readsKey(uid),
    queryFn: () => fetchReadKeys(uid),
    enabled: !!uid && kinds.length > 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const readSet = new Set(readsQuery.data || []);
    const sources = {};
    let items = [];
    kinds.forEach((k, i) => {
      const r = results[i];
      const rows = (r.data || []).map((x) => ({ ...x, read: readSet.has(itemKey(x)) }));
      const actionable = rows.filter(isActionable);
      sources[k] = {
        loading: r.isPending, error: r.error, refetch: r.refetch,
        count: actionable.filter((x) => !x.read).length,
        total: actionable.length,
      };
      items = items.concat(rows);
    });
    items.sort((a, b) => (b.canAct - a.canAct) || ((a.at?.getTime() || 0) - (b.at?.getTime() || 0)));
    const actionable = items.filter(isActionable);
    return {
      kinds, sources, items, loading: results.some((r) => r.isPending),
      count: actionable.filter((x) => !x.read).length,
      pendingTotal: actionable.length,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, readsQuery.dataUpdatedAt, ...results.map((r) => r.dataUpdatedAt), ...results.map((r) => r.status)]);
}

// Marks the given inbox items read for this user. Optimistic: the badge drops
// before the write lands, and rolls back if it fails.
export function useMarkApprovalsRead() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const uid = user?.id;
  return useMutation({
    mutationFn: async (items) => {
      const rows = items.filter(isActionable).map((x) => ({ user_id: uid, item_key: itemKey(x) }));
      if (!rows.length) return;
      const { error } = await supabase.from('approval_reads').upsert(rows, { onConflict: 'user_id,item_key', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    },
    onMutate: async (items) => {
      const key = readsKey(uid);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      const added = items.filter(isActionable).map(itemKey);
      qc.setQueryData(key, (old) => [...new Set([...(old || []), ...added])]);
      return { prev };
    },
    onError: (err, _items, ctx) => {
      qc.setQueryData(readsKey(uid), ctx?.prev);
      toast.error(err.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: readsKey(uid) }),
  });
}

// Badge count (bottom tab bar / menu). Shares the same cache as the inbox.
export function useApprovalsCount() {
  return useApprovals().count;
}

// One action on one item: optimistic removal from its source list, rollback +
// toast on error, then refresh approvals and Today. action ∈
// 'approve' | 'forward' | 'reject'. `note` is the typed reason (reject) or
// optional approve note.
async function runAction(item, action, note, me) {
  const r = item.raw;
  switch (item.kind) {
    case 'leave':
      if (action === 'reject') return teamRejectLeave(item.id, note);
      return teamApproveLeave(item.id, { forwardToBoss: action === 'forward', note: note || '' });
    case 'attendance':
      if (item.sub === 'clockout') {
        return action === 'reject' ? rejectClockOut(item.targetId, null, note) : approveClockOut(item.targetId, true, note || null);
      }
      return decideAttendanceEdit({ editId: item.targetId, approve: action !== 'reject', note: note || null });
    case 'reports': {
      const now = new Date().toISOString();
      if (me.role === 'tl') {
        if (action === 'reject') {
          await updateReportStatus(item.id, 'draft', { rejectionNote: note, rejectedBy: me.uid, rejectedByName: me.name, rejectedAt: now });
          try { await deductPromptApcReport(item.id); } catch { /* best-effort, as on the report page */ }
          return null;
        }
        return updateReportStatus(item.id, 'verified', { verifiedBy: me.uid, verifiedByName: me.name, verifiedAt: now });
      }
      if (action === 'reject') {
        await updateReportStatus(item.id, 'submitted', { rejectionNote: note, rejectedBy: me.uid, rejectedByName: me.name, rejectedAt: now });
        try { await deductPrompt(item.id); } catch { /* best-effort, as on the All reports page */ }
        return null;
      }
      return updateReportStatus(item.id, 'approved', { approvedBy: me.uid, approvedByName: me.name, approvedAt: now });
    }
    case 'brand':
      return decideBrandSwitch(r.id, { approve: action !== 'reject', note: note || '' });
    default:
      throw new Error('This item can only be opened, not decided here.');
  }
}

const DONE_MSG = { approve: 'Approved', forward: 'Forwarded to Boss', reject: 'Sent back' };

export function useApprovalAction() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, profile } = useAuth();
  const me = { uid: user?.id, role: profile?.role, name: profile?.display_name || '' };
  return useMutation({
    mutationFn: ({ item, action, note }) => runAction(item, action, note, me),
    onMutate: async ({ item }) => {
      const key = approvalsKey(item.kind, me.uid);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData(key);
      qc.setQueryData(key, (old) => (old || []).filter((x) => x.id !== item.id));
      return { key, prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toast.error(/already decided/i.test(err.message) ? 'Already decided by someone else.' : err.message);
    },
    onSuccess: (_d, { action }) => toast.success(DONE_MSG[action] || 'Done'),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['approvals'] });
      qc.invalidateQueries({ queryKey: ['today'] });
    },
  });
}
