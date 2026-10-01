// Data for the role "Today" pages (spec F1). Every card owns one small,
// RLS-scoped query keyed under ['today', …] so cards load in parallel (no
// waterfalls), cache across visits, and fail independently.
import { supabase } from './supabase';
import { listReportStatuses } from './reportsApi';
import { listAgendaMeetings, agendaMeetingStartAt } from './agendaApi';
import { listToday, listExpectedMembers, getMyShiftStart } from './attendanceApi';
import { getMyLeaveQuota, getConsumedLeavesMonth } from './leaveApi';
import { listTikTokConnections } from './tiktokAdsApi';
import { approvalsPrefetchers } from './approvalsApi';

// Polling instead of new realtime channels (S10): only while the tab is visible.
export const POLL = { refetchInterval: 60_000, refetchIntervalInBackground: false };

export const todayKeys = {
  all: ['today'],
  tasks: (uid) => ['today', 'tasks', uid],
  reportStatuses: () => ['today', 'reportStatuses'],
  meetings: () => ['today', 'meetings'],
  leave: (uid) => ['today', 'leave', uid],
  shift: (uid) => ['today', 'shift', uid],
  teamToday: (uid) => ['today', 'teamToday', uid],
  headcount: () => ['today', 'headcount'],
  tiktok: (uid) => ['today', 'tiktok', uid],
};

// Same select as the old RoleDashboard card: my open tasks, nearest due first.
export async function fetchMyTasks(uid) {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, priority, due_date, category, brand:brand_id(brand_name)')
    .eq('assignee_id', uid)
    .neq('status', 'done')
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data || [];
}

// ~10 weeks back covers the current weekly period, the current bi-weekly
// period and this month's monthly report.
export function fetchReportStatuses() {
  const since = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10);
  return listReportStatuses({ since });
}

// The meeting to show: an ongoing one first, else the earliest that starts
// no more than 2h ago.
export async function fetchNextMeeting() {
  const rows = await listAgendaMeetings({ statuses: ['upcoming', 'ongoing', 'paused'] });
  const ongoing = rows.find((m) => m.status === 'ongoing' || m.status === 'paused');
  if (ongoing) return ongoing;
  const cutoff = Date.now() - 2 * 3600000;
  return rows
    .map((m) => ({ m, at: agendaMeetingStartAt(m) }))
    .filter((x) => x.at && x.at.getTime() >= cutoff)
    .sort((a, b) => a.at - b.at)[0]?.m || null;
}

export async function fetchLeaveSummary(uid) {
  const now = new Date();
  const [quota, used] = await Promise.all([
    getMyLeaveQuota(uid),
    getConsumedLeavesMonth(uid, now.getFullYear(), now.getMonth() + 1),
  ]);
  return { quota, used };
}

// Team today for a TL / PCTL: direct reports × today's attendance rows.
export async function fetchTeamToday(uid) {
  const [members, rows] = await Promise.all([
    listExpectedMembers({ uid, isTL: true }),
    listToday(),
  ]);
  const byUser = new Map(rows.map((r) => [r.userId || r.user_id, r]));
  return members.map((m) => ({ ...m, record: byUser.get(m.id) || null }));
}

// Boss: everyone expected vs today's rows (RLS lets the Boss read all).
export async function fetchCompanyToday() {
  const [members, rows] = await Promise.all([
    listExpectedMembers({ isBoss: true }),
    listToday(),
  ]);
  return { expected: members.length, present: rows.filter((r) => r.clockIn).length };
}

// Headcount by role, including Ads Managers.
export async function fetchHeadcount() {
  const { data, error } = await supabase.from('profiles').select('role').is('deleted_at', null).eq('is_active', true);
  if (error) throw new Error(error.message);
  const counts = {};
  (data || []).forEach((r) => { counts[r.role] = (counts[r.role] || 0) + 1; });
  return counts;
}

export const fetchShiftStart = () => getMyShiftStart();
export const fetchTikTokConnections = () => listTikTokConnections();

// Prefetch the landing data right after sign-in (S7b). Called by AppShell
// once `profile` exists; safe to call repeatedly (React Query dedupes).
export function prefetchToday(queryClient, profile) {
  const uid = profile?.id;
  if (!queryClient || !uid) return;
  const role = profile.role;
  const pf = (queryKey, queryFn) => queryClient.prefetchQuery({ queryKey, queryFn }).catch(() => {});
  pf(todayKeys.tasks(uid), () => fetchMyTasks(uid));
  pf(todayKeys.meetings(), fetchNextMeeting);
  if (role !== 'ads_manager') pf(todayKeys.reportStatuses(), fetchReportStatuses);
  if (role !== 'boss') pf(todayKeys.leave(uid), () => fetchLeaveSummary(uid));
  approvalsPrefetchers(role, uid).forEach(([key, fn]) => pf(key, fn));
}
