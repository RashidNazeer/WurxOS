import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  ChecklistIcon, StoreIcon, ReportIcon, UsersIcon, MegaphoneIcon, AlertIcon,
  HomeIcon, CheckIcon, BellIcon,
} from '../../components/common/Icon';

async function fetchMyTasks(uid) {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, status, priority, due_date, category, brand:brand_id(brand_name)')
    .eq('assignee_id', uid)
    .neq('status', 'done')
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(12);
  if (error) throw new Error(error.message);
  return data || [];
}
async function fetchUnreadCount(uid) {
  const { count } = await supabase
    .from('notifications').select('id', { count: 'exact', head: true })
    .eq('recipient_id', uid).is('read_at', null);
  return count || 0;
}
async function fetchBrands() {
  const { data } = await supabase
    .from('brands')
    .select('id, brand_name, logo_url, gmv, status, paid_collab_status')
    .eq('status', 'active')
    .order('brand_name', { ascending: true })
    .limit(8);
  return data || [];
}
async function fetchReports() {
  const { data } = await supabase
    .from('reports')
    .select('id, type, status, period_start, period_end, brand:brand_id(brand_name)')
    .in('status', ['draft', 'submitted', 'rejected'])
    .order('period_start', { ascending: false })
    .limit(6);
  return data || [];
}
async function fetchMyPendingLeave(uid) {
  const { count } = await supabase
    .from('leave_requests').select('id', { count: 'exact', head: true })
    .eq('requester_id', uid).eq('status', 'pending');
  return count || 0;
}
async function fetchPendingApprovals(uid) {
  const { count } = await supabase
    .from('leave_requests').select('id', { count: 'exact', head: true })
    .eq('status', 'pending').neq('requester_id', uid);
  return count || 0;
}
async function fetchMyIpcs(uid) {
  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, email, is_active')
    .eq('role', 'ipc').eq('reports_to', uid);
  return data || [];
}
async function fetchGlobalCounts() {
  const [{ count: b }, { count: u }, { count: s }] = await Promise.all([
    supabase.from('brands').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('brand_switch_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);
  return { brands: b || 0, users: u || 0, switches: s || 0 };
}

export default function RoleDashboard() {
  const { profile, user } = useAuth();
  const role = profile?.role;
  const uid  = user?.id;

  const hasBrandAccess = ['tl', 'apc', 'ipc', 'pctl', 'ol', 'boss', 'developer'].includes(role);
  const hasReportAccess = ['tl', 'apc', 'ol', 'boss', 'developer'].includes(role);
  const isAdmin = ['boss', 'ol', 'developer'].includes(role);
  const isPctl  = role === 'pctl';

  const results = useQueries({
    queries: [
      { queryKey: ['dash', 'my-tasks', uid],          queryFn: () => fetchMyTasks(uid),        enabled: !!uid },
      { queryKey: ['dash', 'unread', uid],            queryFn: () => fetchUnreadCount(uid),    enabled: !!uid },
      { queryKey: ['dash', 'brands'],                 queryFn: fetchBrands,                    enabled: !!uid && hasBrandAccess },
      { queryKey: ['dash', 'reports'],                queryFn: fetchReports,                   enabled: !!uid && hasReportAccess },
      { queryKey: ['dash', 'my-pending-leave', uid],  queryFn: () => fetchMyPendingLeave(uid), enabled: !!uid },
      { queryKey: ['dash', 'pending-approvals', uid], queryFn: () => fetchPendingApprovals(uid), enabled: !!uid },
      { queryKey: ['dash', 'my-ipcs', uid],           queryFn: () => fetchMyIpcs(uid),         enabled: !!uid && isPctl },
      { queryKey: ['dash', 'global-counts'],          queryFn: fetchGlobalCounts,              enabled: !!uid && isAdmin },
    ],
  });
  const [myTasksQ, unreadQ, brandsQ, reportsQ, myLeaveQ, approvalsQ, ipcsQ, globalQ] = results;

  const err = results.find((r) => r.error)?.error?.message || '';
  // Only the very first load (no cached data yet) shows a blocking spinner.
  // Once cached, the page re-renders instantly on remount; each panel's
  // fresh data streams in individually during background revalidation.
  const isFirstLoad = myTasksQ.isPending;

  const myTasks = myTasksQ.data || [];
  const todayIso = new Date().toISOString().slice(0, 10);
  // Exclude completed tasks from "overdue" — a task you finished before its
  // deadline isn't overdue, it's just done. Also exclude recurring tasks
  // (daily/weekly/monthly): they reset on their own schedule and were
  // never meant to carry a due date.
  const isDeadlineTask = (t) => !t.category || t.category === 'general';
  const myTasksOverdue = myTasks.filter((t) => isDeadlineTask(t) && t.due_date && t.due_date < todayIso && t.status !== 'done').length;
  const myTasksToday   = myTasks.filter((t) => isDeadlineTask(t) && t.due_date === todayIso && t.status !== 'done').length;

  const data = {
    myTasks,
    myTasksOverdue,
    myTasksToday,
    unread: unreadQ.data ?? 0,
    brands: brandsQ.data,
    reports: reportsQ.data,
    myPendingLeave: myLeaveQ.data ?? 0,
    pendingApprovals: approvalsQ.data ?? 0,
    ipcs: ipcsQ.data,
    globalBrands: globalQ.data?.brands ?? 0,
    globalUsers:  globalQ.data?.users  ?? 0,
    pendingSwitches: globalQ.data?.switches ?? 0,
  };

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

  if (isFirstLoad) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">{greeting}{profile?.display_name ? `, ${profile.display_name}` : ''}</h1>
          <p className="page-subtitle">Loading your workspace…</p>
        </div>
        <div style={{ textAlign: 'center', padding: 40 }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{greeting}{profile?.display_name ? `, ${profile.display_name}` : ''}</h1>
        <p className="page-subtitle">Here's your snapshot for today.</p>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* Top stat grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 12, marginBottom: 16 }}>
        <Stat to="/tasks" icon={<ChecklistIcon width="18" height="18" />} label="My open tasks" value={data.myTasks.length}
          sub={data.myTasksOverdue > 0 ? `${data.myTasksOverdue} overdue` : data.myTasksToday > 0 ? `${data.myTasksToday} due today` : 'nothing pressing'}
          tone={data.myTasksOverdue > 0 ? 'warn' : undefined} />
        <Stat to="/notifications" icon={<BellIcon width="18" height="18" />} label="Unread notifications" value={data.unread} />
        <Stat to="/leave" icon={<HomeIcon width="18" height="18" />} label="My pending leaves" value={data.myPendingLeave} />
        {['boss', 'tl', 'pctl', 'ol', 'developer'].includes(role) && (
          <Stat to="/leave/approvals" icon={<CheckIcon width="18" height="18" />} label="Leaves to approve" value={data.pendingApprovals} />
        )}
        {['boss', 'ol', 'developer'].includes(role) && (
          <>
            <Stat to="/brands" icon={<StoreIcon width="18" height="18" />} label="Active brands" value={data.globalBrands} />
            <Stat to="/boss/manage/tls" icon={<UsersIcon width="18" height="18" />} label="Active users" value={data.globalUsers} />
            <Stat to="/boss/brand-switches" icon={<StoreIcon width="18" height="18" />} label="Switch requests" value={data.pendingSwitches} />
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 14 }}>
        {/* My tasks */}
        <Panel title="Tasks" linkTo="/tasks" linkLabel="Open tasks →">
          {data.myTasks.length === 0 ? (
            <Empty text="You're all caught up." />
          ) : data.myTasks.slice(0, 6).map((t) => (
            <div key={t.id} style={{
              display: 'grid', gridTemplateColumns: '1fr auto',
              gap: 10, padding: '8px 0',
              borderBottom: '1px solid var(--border-subtle)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{t.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {t.brand?.brand_name || 'Personal'}{t.priority !== 'normal' && ` · ${t.priority}`}
                </div>
              </div>
              <div style={{ fontSize: 11, color: dueColor(t.due_date), fontWeight: 600, whiteSpace: 'nowrap' }}>
                {(!t.category || t.category === 'general') ? dueLabel(t.due_date) : ''}
              </div>
            </div>
          ))}
        </Panel>

        {/* My brands */}
        {data.brands && data.brands.length > 0 && (
          <Panel title="Your brands" linkTo="/brands" linkLabel="Manage →">
            {data.brands.slice(0, 6).map((b) => (
              <div key={b.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
                <BrandAvatar brand={b} size={28} radius={6} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{b.brand_name}</div>
                  {b.paid_collab_status && b.paid_collab_status !== 'not_applicable' && (
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Paid collab</div>
                  )}
                </div>
                {Number(b.gmv) > 0 && (
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
                    ${formatBig(Number(b.gmv))}
                  </div>
                )}
              </div>
            ))}
          </Panel>
        )}

        {/* Reports */}
        {data.reports && data.reports.length > 0 && (
          <Panel title="Reports in flight" linkTo="/reports" linkLabel="All reports →">
            {data.reports.map((r) => (
              <div key={r.id} style={{
                display: 'grid', gridTemplateColumns: '1fr auto',
                alignItems: 'center',
                gap: 10, padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.brand?.brand_name || '—'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {r.type === 'biweekly' ? 'Bi-weekly' : 'Weekly'} · {fmt(r.period_start)}
                  </div>
                </div>
                <span style={{
                  justifySelf: 'end',
                  display: 'inline-block',
                  fontSize: 10.5, fontWeight: 700, textTransform: 'capitalize',
                  padding: '3px 10px', borderRadius: 999, lineHeight: 1.4,
                  background: statusTone(r.status).bg,
                  color: statusTone(r.status).fg,
                }}>{r.status}</span>
              </div>
            ))}
          </Panel>
        )}

        {/* PCTL — my IPCs */}
        {data.ipcs && (
          <Panel title="Your IPCs" linkTo="/pctl/ipcs" linkLabel="Manage IPCs →">
            {data.ipcs.length === 0 ? (
              <Empty text="You haven't added any IPCs yet." />
            ) : data.ipcs.map((ipc) => (
              <div key={ipc.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'var(--accent-soft)', color: 'var(--accent)',
                  display: 'grid', placeItems: 'center',
                  fontSize: 11, fontWeight: 700,
                }}>
                  {(ipc.display_name || '?').split(/\s+/).map(s => s[0]).slice(0,2).join('').toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{ipc.display_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ipc.email}</div>
                </div>
                <span className={`wx-badge ${ipc.is_active ? 'wx-badge-success' : 'wx-badge-muted'}`}>
                  {ipc.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
            ))}
          </Panel>
        )}

        {/* PCTL quick link */}
        {role === 'pctl' && (
          <Panel title="Paid Collab" linkTo="/paid-collab/brands" linkLabel="Open →">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
              <MegaphoneIcon width="20" height="20" style={{ color: 'var(--accent)' }} />
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                Jump into creators, videos and your selected brands.
              </div>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

function Stat({ to, icon, label, value, sub, tone }) {
  const body = (
    <div className="wx-card" style={{ padding: 16, cursor: to ? 'pointer' : 'default' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.06em', marginBottom: 6,
      }}>{icon} {label}</div>
      <div style={{
        fontSize: 22, fontWeight: 800,
        color: tone === 'warn' ? 'var(--warning)' : 'var(--text-primary)',
      }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{body}</Link> : body;
}

function Panel({ title, linkTo, linkLabel, children }) {
  return (
    <div className="wx-card" style={{ padding: '14px 18px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{title}</div>
        {linkTo && (
          <Link to={linkTo} style={{ fontSize: 11.5, color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>
            {linkLabel}
          </Link>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Empty({ text }) {
  return (
    <div style={{ padding: '18px 8px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
      {text}
    </div>
  );
}

function dueLabel(d) {
  if (!d) return 'No due';
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(d);   due.setHours(0,0,0,0);
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0)   return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff <= 7)  return `in ${diff}d`;
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function dueColor(d) {
  if (!d) return 'var(--text-muted)';
  const t = new Date(); t.setHours(0,0,0,0);
  const du = new Date(d); du.setHours(0,0,0,0);
  if (du < t) return 'var(--danger)';
  if (du.getTime() === t.getTime()) return 'var(--warning)';
  return 'var(--text-muted)';
}
function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatBig(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function statusTone(s) {
  if (s === 'submitted') return { bg: 'color-mix(in srgb, var(--accent) 20%, transparent)',   fg: 'var(--accent)' };
  if (s === 'verified')  return { bg: 'color-mix(in srgb, var(--success) 15%, transparent)',  fg: 'var(--success)' };
  if (s === 'approved')  return { bg: 'color-mix(in srgb, var(--success) 20%, transparent)',  fg: 'var(--success)' };
  if (s === 'rejected')  return { bg: 'color-mix(in srgb, var(--danger) 20%, transparent)',   fg: 'var(--danger)' };
  return { bg: 'var(--surface-3)', fg: 'var(--text-muted)' };
}
