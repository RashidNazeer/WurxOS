import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { listProfilesByRole } from '../../lib/adminApi';
import {
  currentMonth, getIncentives, listIncentivesForMonth, upsertIncentives,
  recomputeCompletion, earnedTotal, potentialTotal, completionCounts,
  verifyIncentives, clearIncentivePayout, notifyIncentiveEmployee,
  resetAndRoll, listAvailableMonths,
} from '../../lib/incentivesApi';
import {
  AlertIcon, RefreshIcon, PlusIcon, XIcon, CheckIcon, SearchIcon, BellIcon,
  EyeIcon, PencilIcon, ShieldIcon, UserIcon, ChartIcon, StarIcon, TargetIcon,
} from '../../components/common/Icon';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function pctOf(achieved, target) {
  if (!target || Number(target) <= 0) return 0;
  return Math.min(Math.round((Number(achieved) / Number(target)) * 100), 100);
}
function initialsOf(name) {
  return (name || '?').slice(0, 2).toUpperCase();
}
function roleLabel(r) {
  return ({ apc: 'APC', ipc: 'IPC', tl: 'Team Lead', pctl: 'Product TL', ol: 'Operation Lead', boss: 'Boss', developer: 'Developer' })[r] || r;
}

// Tabs config per viewer role.
const TABS_BY_ROLE = {
  boss:      [{ k: 'apc', l: 'APCs' }, { k: 'tl', l: 'Team Leads' }, { k: 'ol', l: 'Operation Leads' }],
  developer: [{ k: 'apc', l: 'APCs' }, { k: 'tl', l: 'Team Leads' }, { k: 'ol', l: 'Operation Leads' }],
  ol:        [{ k: 'my', l: 'My Plan' }, { k: 'apc', l: 'APCs' }, { k: 'ipc', l: 'IPCs' }],
};

// ------------------------------------------------------------
// Page
// ------------------------------------------------------------
export default function IncentivesPage() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isBoss     = role === 'boss' || role === 'developer';
  const isOL       = role === 'ol';
  const isAdmin    = isBoss || isOL;
  const isManager  = ['tl', 'pctl'].includes(role);
  const hasOwnPlan = !isBoss; // Boss has no personal plan.

  const tabs = TABS_BY_ROLE[role] || [];
  // Honour the `?tab=` query param when arriving from the editor save
  // flow, so editing an APC's plan brings the user back to the APC tab
  // (instead of always defaulting to the first tab — typically "My Plan").
  const [searchParams] = useSearchParams();
  const initialTab = (() => {
    const requested = searchParams.get('tab');
    if (requested && tabs.some((t) => t.k === requested)) return requested;
    return tabs[0]?.k || 'my';
  })();
  const [tab, setTab] = useState(initialTab);
  const [month, setMonth]         = useState(currentMonth());
  // Self "Update progress" modal — admin Edit/Create now navigates to a route page.
  const [progressRow, setProgressRow] = useState(null);
  const [resetOpen, setResetOpen] = useState(false);
  // v1-style: Details opens a popup for the selected record.
  const [detailsRec, setDetailsRec] = useState(null);

  // Build the URL the admin Edit/Create buttons go to.
  const editUrlFor = (userId) => `/incentives/edit/${userId}?month=${month}`;
  const newPlanUrl = `/incentives/new?month=${month}`;

  const qc = useQueryClient();
  const reload = () => qc.invalidateQueries({ queryKey: ['incentives'] });

  // Live updates — subscribe to incentives table changes so verify,
  // clear-payout, progress edits and new plans reflect instantly
  // without a reload. RLS gates events to rows the viewer can SELECT.
  useEffect(() => {
    const channel = supabase
      .channel('incentives-live')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'incentives' },
        () => { qc.invalidateQueries({ queryKey: ['incentives'] }); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [qc]);

  // --- Own plan (everyone except Boss) ---
  const mineQ = useQuery({
    queryKey: ['incentives', 'mine', user?.id, month],
    queryFn: () => getIncentives(user.id, month),
    enabled: !!user?.id && hasOwnPlan,
  });

  // --- Records for the month (admin tabs + manager team list) ---
  const recordsQ = useQuery({
    queryKey: ['incentives', 'month', month],
    queryFn: () => listIncentivesForMonth(month),
    enabled: !!user?.id && (isAdmin || isManager),
  });

  // --- Users by role (admin tabs) — so cards show even for users without a plan ---
  const adminTab = isAdmin ? tab : null;
  const adminTabIsRole = adminTab && adminTab !== 'my';
  const tabRoleQ = useQuery({
    queryKey: ['profiles', 'byRole', adminTab],
    queryFn: () => listProfilesByRole(adminTab),
    enabled: !!adminTabIsRole,
  });

  // --- Direct reports (manager team list) ---
  const reportsQ = useQuery({
    queryKey: ['profiles', 'directReports', user?.id],
    queryFn: async () => {
      const { supabase } = await import('../../lib/supabase');
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, role, reports_to, is_active')
        .eq('reports_to', user.id)
        .is('deleted_at', null)
        .order('display_name', { ascending: true });
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: !!user?.id && isManager,
  });

  const showingMyPlan = (isOL && tab === 'my') || isManager || (!isAdmin && !isManager && hasOwnPlan);
  const showingAdminGrid = isAdmin && tab !== 'my';
  const showingManagerTeam = isManager;

  return (
    <>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Bonus & Incentives</h1>
          <p className="page-subtitle">{monthLabel(month)} · monthly plans, progress and payouts.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="month" className="wx-input" value={month}
            onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 170 }} />
          {isBoss && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setResetOpen(true)}>
              <RefreshIcon width="14" height="14" /> Reset & roll
            </button>
          )}
          <button className="wx-btn wx-btn-ghost" onClick={reload} title="Refresh">
            <RefreshIcon width="15" height="15" />
          </button>
        </div>
      </div>

      {/* Tabs (admin views only) */}
      {isAdmin && tabs.length > 0 && (
        <RoleTabs tabs={tabs} active={tab} setActive={setTab} />
      )}

      {/* Errors */}
      {(mineQ.error || recordsQ.error || tabRoleQ.error || reportsQ.error) && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" />
          <span>{(mineQ.error || recordsQ.error || tabRoleQ.error || reportsQ.error)?.message}</span>
        </div>
      )}

      {/* My Plan */}
      {showingMyPlan && (
        <MyPlanHero
          row={mineQ.data || null}
          loading={mineQ.isLoading}
          month={month}
          name={profile?.display_name || 'You'}
          role={role}
          onEdit={() => setProgressRow(mineQ.data || { user_id: user.id, month, basic_salary: 0, incentives: [], bonuses: [] })}
        />
      )}

      {/* Manager team (read-only) */}
      {showingManagerTeam && (
        <div style={{ marginTop: 22 }}>
          <ManagerTeamSection
            reports={reportsQ.data || []}
            records={recordsQ.data || []}
            loading={reportsQ.isLoading || recordsQ.isLoading}
            month={month}
            onShowDetails={(rec) => setDetailsRec(rec)}
          />
        </div>
      )}

      {/* Admin grid (Boss tabs / OL APCs+IPCs tabs) */}
      {showingAdminGrid && (
        <AdminGridSection
          users={tabRoleQ.data || []}
          records={recordsQ.data || []}
          loading={tabRoleQ.isLoading || recordsQ.isLoading}
          tabKey={tab}
          month={month}
          isBoss={isBoss}
          isOL={isOL}
          onShowDetails={(rec) => setDetailsRec(rec)}
          onAddPlan={() => navigate(newPlanUrl)}
          onEditPlan={(rec) => navigate(editUrlFor(rec.user_id))}
          onCreatePlanFor={(userId) => navigate(editUrlFor(userId))}
          onVerify={async (rec, val) => {
            try { await verifyIncentives(rec.id, val); reload(); }
            catch (e) { alert(e.message); }
          }}
          onClear={async (rec, val) => {
            try { await clearIncentivePayout(rec.id, val); reload(); }
            catch (e) { alert(e.message); }
          }}
          onNotify={async (rec) => {
            try { await notifyIncentiveEmployee(rec.id); reload(); }
            catch (e) { alert(e.message); }
          }}
        />
      )}

      {/* Modals */}
      {/* Self "Update progress" modal — admin edits navigate to a separate page. */}
      {progressRow && (
        <PlanEditor
          row={progressRow}
          month={month}
          isAdmin={false}
          viewerRole={role}
          onClose={() => setProgressRow(null)}
          onSaved={() => { setProgressRow(null); reload(); }}
        />
      )}

      {resetOpen && (
        <ResetAndRollModal
          currentMonth={month}
          onClose={() => setResetOpen(false)}
          onDone={() => { setResetOpen(false); reload(); }}
        />
      )}

      {detailsRec && (
        <DetailsModal
          rec={detailsRec}
          month={month}
          onClose={() => setDetailsRec(null)}
        />
      )}
    </>
  );
}

// ============================================================
// Role Tabs (top of admin views)
// ============================================================
function RoleTabs({ tabs, active, setActive }) {
  return (
    <div style={{
      display: 'flex', gap: 4, marginTop: 12, marginBottom: 16,
      borderBottom: '2px solid var(--border-subtle)',
    }}>
      {tabs.map((t) => {
        const isActive = active === t.k;
        return (
          <button key={t.k} type="button" onClick={() => setActive(t.k)}
            style={{
              border: 0, background: 'transparent', cursor: 'pointer',
              padding: '10px 16px', fontWeight: 600, fontSize: 13,
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
              marginBottom: -2,
              transition: 'color var(--dur-fast), border-color var(--dur-fast)',
            }}>
            {t.l}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// My Plan hero card
// ============================================================
function MyPlanHero({ row, loading, month, name, role, onEdit }) {
  if (loading) {
    return (
      <div className="wx-card" style={{ padding: 18, marginTop: 6 }}>
        <div className="wx-empty"><span className="wx-spinner" /> Loading your plan…</div>
      </div>
    );
  }

  if (!row) {
    return (
      <div style={{
        marginTop: 6, padding: '32px 20px', textAlign: 'center',
        border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius-lg)',
        background: 'var(--surface-1)',
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: 'var(--surface-2)',
          margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <ShieldIcon width="22" height="22" style={{ color: 'var(--text-muted)' }} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>No incentive plan yet</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: 4 }}>
          No plan has been set for {monthLabel(month)}.
        </div>
      </div>
    );
  }

  const earned    = earnedTotal(row);
  const potential = potentialTotal(row);
  const { completedItems, totalItems } = completionCounts(row);
  const completionPct = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  return (
    <div style={{ maxWidth: 720, marginTop: 6 }}>
      <div className="wx-card" style={{ padding: 0, overflow: 'hidden', borderRadius: 'var(--radius-lg)' }}>
        {/* Top status bar */}
        <div style={{
          height: 4,
          background: row.payout_cleared
            ? 'linear-gradient(90deg, var(--info), color-mix(in srgb, var(--info) 60%, white))'
            : row.verified
            ? 'linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 60%, white))'
            : 'linear-gradient(90deg, var(--warning), color-mix(in srgb, var(--warning) 60%, white))',
        }} />
        {/* Identity strip */}
        <div style={{
          padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12,
          background: 'linear-gradient(135deg, var(--surface-3), var(--surface-2))',
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'var(--accent)', color: 'var(--on-accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 14, flexShrink: 0,
          }}>{initialsOf(name)}</div>
          <div style={{ flexGrow: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {monthLabel(month)} · {roleLabel(role)}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
            {row.verified && <Pill kind="success">Verified</Pill>}
            {row.payout_cleared && <Pill kind="info">Payout cleared</Pill>}
            {!row.verified && <Pill kind="warning">Awaiting verification</Pill>}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 18 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
            <BreakdownRow label="Basic salary"    value={`${Number(row.basic_salary || 0).toLocaleString()} PKR`} />
            <BreakdownRow label={`Earned (${completedItems}/${totalItems} items)`}
              value={`+${Math.max(0, earned - Number(row.basic_salary || 0)).toLocaleString()} PKR`} valueColor="var(--success)" />
            <div style={{
              display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 14.5,
              paddingTop: 8, marginTop: 4, borderTop: '1.5px solid var(--border-subtle)',
            }}>
              <span>Total earned</span>
              <span>{earned.toLocaleString()} PKR</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'right' }}>
              Potential: {potential.toLocaleString()} PKR
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
              <span style={{ color: 'var(--text-muted)' }}>Completion</span>
              <span style={{ fontWeight: 700 }}>{completedItems}/{totalItems} ({completionPct}%)</span>
            </div>
            <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${completionPct}%`,
                background: completionPct === 100 ? 'var(--success)' : 'var(--accent)',
                transition: 'width 0.4s',
              }} />
            </div>
          </div>

          {/* Item lists */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 14, marginTop: 16 }}>
            <ItemList title="Incentives" items={row.incentives || []} />
            <ItemList title="Bonuses"    items={row.bonuses    || []} />
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
            Items auto-complete at ≥ 90% of target. Final payout is verified by{' '}
            {role === 'apc' || role === 'ipc' ? 'your Operation Lead' : 'the Boss'}.
          </div>

          {!row.payout_cleared && (
            <div style={{ marginTop: 14 }}>
              <button className="wx-btn wx-btn-primary" onClick={onEdit} style={{ width: '100%' }}>
                <PencilIcon width="14" height="14" /> Update progress
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BreakdownRow({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor || 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

function ItemList({ title, items }) {
  return (
    <div>
      <div style={{
        fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
      }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>No items.</div>
      ) : items.map((it) => {
        const t = Number(it.targetValue), a = Number(it.achievedValue);
        const pct = t > 0 ? Math.min(100, Math.round((a / t) * 100)) : (it.completed ? 100 : 0);
        return (
          <div key={it.id} style={{
            padding: '10px 11px', marginBottom: 6,
            background: it.completed ? 'var(--success-soft)' : 'var(--surface-2)',
            border: `1px solid ${it.completed ? 'color-mix(in srgb, var(--success) 30%, transparent)' : 'var(--border-subtle)'}`,
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)' }}>{it.text || '—'}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {(a || 0).toLocaleString()}{it.suffix || ''} / {(t || 0).toLocaleString()}{it.suffix || ''}
                  {it.completed && ' · completed'}
                </div>
              </div>
              <span style={{
                fontWeight: 700, fontSize: 12,
                color: it.completed ? 'var(--success)' : 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}>
                +{Number(it.amount || 0).toLocaleString()} PKR
              </span>
            </div>
            <div style={{ height: 4, marginTop: 6, background: 'var(--surface-1)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${pct}%`,
                background: it.completed ? 'var(--success)' : 'var(--accent)',
                transition: 'width 0.3s',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Pill({ kind = 'muted', children }) {
  const styles = {
    success: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    warning: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    info:    { bg: 'var(--info-soft)',    fg: 'var(--info)' },
    danger:  { bg: 'var(--danger-soft)',  fg: 'var(--danger)' },
    muted:   { bg: 'var(--surface-2)',    fg: 'var(--text-secondary)' },
  }[kind];
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 999,
      background: styles.bg, color: styles.fg,
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.02em',
      display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// ============================================================
// Manager (TL/PCTL) team list — read-only
// ============================================================
function ManagerTeamSection({ reports, records, loading, month, onShowDetails }) {
  const [search, setSearch] = useState('');

  const recByUser = useMemo(() => {
    const m = {};
    (records || []).forEach((r) => { if (r.user_id) m[r.user_id] = r; });
    return m;
  }, [records]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (reports || []).filter((u) =>
      !s || (u.display_name || '').toLowerCase().includes(s)
    );
  }, [reports, search]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>My team</h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
            Read-only view of your direct reports' incentives.
          </p>
        </div>
        <div className="wx-input-group" style={{ maxWidth: 260, flex: 1 }}>
          <span className="wx-input-group-icon"><SearchIcon width="15" height="15" /></span>
          <input className="wx-input" placeholder="Search team…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading team…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          message={reports.length === 0 ? 'You have no direct reports yet.' : 'Nothing matches your search.'}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: 14 }}>
          {filtered.map((u) => {
            const rec = recByUser[u.id];
            return (
              <UserCard
                key={u.id}
                user={u}
                rec={rec}
                month={month}
                actions={
                  rec
                    ? <button
                        className="wx-btn wx-btn-ghost"
                        style={{ flex: 1 }}
                        onClick={() => onShowDetails(rec)}>
                        <EyeIcon width="13" height="13" /> Details
                      </button>
                    : <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>No plan for {monthLabel(month)}</span>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Admin (Boss / OL) grid — full control
// ============================================================
function AdminGridSection({
  users, records, loading, tabKey, month, isBoss, isOL,
  onShowDetails,
  onAddPlan, onEditPlan, onCreatePlanFor, onVerify, onClear, onNotify,
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const recByUser = useMemo(() => {
    const m = {};
    (records || []).forEach((r) => { if (r.user_id) m[r.user_id] = r; });
    return m;
  }, [records]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (users || []).filter((u) => {
      const rec = recByUser[u.id];
      if (s && !(u.display_name || '').toLowerCase().includes(s)) return false;
      if (statusFilter === 'no_plan'    && rec) return false;
      if (statusFilter === 'has_plan'   && !rec) return false;
      if (statusFilter === 'verified'   && !rec?.verified) return false;
      if (statusFilter === 'unverified' && (!rec || rec.verified)) return false;
      if (statusFilter === 'cleared'    && !rec?.payout_cleared) return false;
      if (statusFilter === 'pending'    && (!rec || rec.payout_cleared)) return false;
      return true;
    });
  }, [users, recByUser, search, statusFilter]);

  // Stats (only over filtered set with records)
  const stats = useMemo(() => {
    const withPlan   = filtered.filter((u) => recByUser[u.id]).map((u) => recByUser[u.id]);
    const totalPay   = withPlan.reduce((s, r) => s + earnedTotal(r), 0);
    const verified   = withPlan.filter((r) => r.verified).length;
    const cleared    = withPlan.filter((r) => r.payout_cleared).length;
    return { totalPay, verified, cleared, withPlan: withPlan.length, total: filtered.length };
  }, [filtered, recByUser]);

  const tabName = ({ apc: 'APC', ipc: 'IPC', tl: 'TL', ol: 'OL' })[tabKey] || tabKey;

  return (
    <div>
      {/* Stats strip */}
      {!loading && stats.withPlan > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
          gap: 10, marginBottom: 14,
        }}>
          <Stat label="Total payout" value={`${stats.totalPay.toLocaleString()} PKR`} accent />
          <Stat label="With plans"   value={`${stats.withPlan} / ${stats.total}`} />
          <Stat label="Verified"     value={`${stats.verified} / ${stats.withPlan}`} kind="success" />
          <Stat label="Cleared"      value={`${stats.cleared} / ${stats.withPlan}`} kind="info" />
        </div>
      )}

      {/* Filter toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div className="wx-input-group" style={{ maxWidth: 280, flex: 1, minWidth: 200 }}>
          <span className="wx-input-group-icon"><SearchIcon width="15" height="15" /></span>
          <input className="wx-input" placeholder={`Search ${tabName}s…`}
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="wx-input" value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ maxWidth: 180 }}>
          <option value="all">All statuses</option>
          <option value="no_plan">No plan</option>
          <option value="has_plan">With plan</option>
          <option value="unverified">Unverified</option>
          <option value="verified">Verified</option>
          <option value="pending">Payout pending</option>
          <option value="cleared">Payout cleared</option>
        </select>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', alignSelf: 'center' }}>
            {filtered.length} of {users.length}
          </span>
          <button className="wx-btn wx-btn-primary" onClick={onAddPlan}>
            <PlusIcon width="13" height="13" /> New plan
          </button>
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          message={search || statusFilter !== 'all'
            ? 'No matching results.'
            : `No ${tabName}s found.`}
        />
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(290px, 100%), 1fr))', gap: 14,
        }}>
          {filtered.map((u) => {
            const rec = recByUser[u.id];
            const hasData = !!rec;
            // Verify shown only for Boss on TL/OL tabs (APCs/IPCs are verified by OL).
            const canVerifyHere = (isBoss && (tabKey === 'tl' || tabKey === 'ol')) ||
                                  (isOL   && (tabKey === 'apc' || tabKey === 'ipc'));
            // Clear payout: Boss only.
            const canClearHere  = isBoss;
            return (
              <UserCard
                key={u.id} user={u} rec={rec} month={month}
                actions={
                  hasData ? (
                    <>
                      <button
                        className="wx-btn wx-btn-ghost"
                        onClick={() => onShowDetails(rec)}>
                        <EyeIcon width="13" height="13" /> Details
                      </button>
                      <button className="wx-btn wx-btn-primary" onClick={() => onEditPlan(rec)}>
                        <PencilIcon width="13" height="13" /> Edit
                      </button>
                    </>
                  ) : (
                    <button className="wx-btn wx-btn-primary" style={{ flex: 1 }}
                      onClick={() => onCreatePlanFor(u.id)}>
                      <PlusIcon width="13" height="13" /> Create plan
                    </button>
                  )
                }
                secondaryActions={
                  hasData && (
                    <>
                      <button className="wx-btn wx-btn-ghost" title="Send reminder" onClick={() => onNotify(rec)}>
                        <BellIcon width="13" height="13" />
                      </button>
                      {canVerifyHere && (
                        <button
                          className={`wx-btn ${rec.verified ? 'wx-btn-ghost' : 'wx-btn-primary'}`}
                          onClick={() => onVerify(rec, !rec.verified)}>
                          <ShieldIcon width="12" height="12" /> {rec.verified ? 'Unverify' : 'Verify'}
                        </button>
                      )}
                      {canClearHere && (
                        <button
                          className={`wx-btn ${rec.payout_cleared ? 'wx-btn-ghost' : 'wx-btn-primary'}`}
                          disabled={!rec.verified}
                          title={rec.verified ? '' : 'Verify first'}
                          onClick={() => onClear(rec, !rec.payout_cleared)}>
                          <CheckIcon width="12" height="12" /> {rec.payout_cleared ? 'Un-clear' : 'Clear payout'}
                        </button>
                      )}
                    </>
                  )
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Reusable card for one user (with or without a plan)
// ============================================================
function UserCard({ user, rec, month, actions, secondaryActions }) {
  const hasData    = !!rec;
  const breakdown  = hasData ? {
    basic:       Number(rec.basic_salary || 0),
    incTotal:    (rec.incentives || []).reduce((s, i) => s + Number(i.amount || 0), 0),
    bonTotal:    (rec.bonuses    || []).reduce((s, b) => s + Number(b.amount || 0), 0),
    incAchieved: (rec.incentives || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0),
    bonAchieved: (rec.bonuses    || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0),
  } : null;
  const totalEarned = hasData ? breakdown.basic + breakdown.incAchieved + breakdown.bonAchieved : 0;
  const totalItems  = hasData ? (rec.incentives || []).length + (rec.bonuses || []).length : 0;
  const completedItems = hasData
    ? (rec.incentives || []).filter((i) => i.completed).length + (rec.bonuses || []).filter((i) => i.completed).length
    : 0;
  const completionPct  = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0;

  // Top-bar color based on state
  const barBg = !hasData
    ? 'var(--border-subtle)'
    : rec.payout_cleared
    ? 'linear-gradient(90deg, var(--info), color-mix(in srgb, var(--info) 60%, white))'
    : rec.verified
    ? 'linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 60%, white))'
    : 'linear-gradient(90deg, var(--warning), color-mix(in srgb, var(--warning) 60%, white))';

  return (
    <div className="wx-card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 4, background: barBg }} />
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', flex: 1 }}>
        {/* Identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: 'var(--accent)', color: 'var(--on-accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 12, flexShrink: 0,
          }}>{initialsOf(user.display_name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user.display_name || '—'}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {roleLabel(user.role)}
            </div>
          </div>
          {hasData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
              <Pill kind={rec.verified ? 'success' : 'warning'}>
                {rec.verified ? 'Verified' : 'Unverified'}
              </Pill>
              {rec.payout_cleared && <Pill kind="info">Cleared</Pill>}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1 }}>
          {hasData ? (
            <>
              <div style={{ fontSize: 12 }}>
                <BreakdownRow label="Basic" value={`${breakdown.basic.toLocaleString()} PKR`} />
                <BreakdownRow label="Incentives"
                  value={`+${breakdown.incAchieved.toLocaleString()} / ${breakdown.incTotal.toLocaleString()} PKR`}
                  valueColor="var(--success)" />
                <BreakdownRow label="Bonuses"
                  value={`+${breakdown.bonAchieved.toLocaleString()} / ${breakdown.bonTotal.toLocaleString()} PKR`}
                  valueColor="var(--info)" />
                <div style={{
                  display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 13,
                  paddingTop: 8, marginTop: 6, borderTop: '1px dashed var(--border-subtle)',
                }}>
                  <span>Payable</span>
                  <span>{totalEarned.toLocaleString()} PKR</span>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Completed</span>
                  <span style={{ fontWeight: 700 }}>{completedItems}/{totalItems} ({completionPct}%)</span>
                </div>
                <div style={{ height: 5, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', width: `${completionPct}%`,
                    background: completionPct === 100 ? 'var(--success)' : 'var(--accent)',
                    transition: 'width 0.4s',
                  }} />
                </div>
              </div>
            </>
          ) : (
            <div style={{
              padding: '14px 12px', textAlign: 'center', fontSize: 12,
              background: 'var(--surface-2)', borderRadius: 'var(--radius-md)',
              color: 'var(--text-muted)',
            }}>
              No plan for {monthLabel(month)}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6 }}>{actions}</div>
          {secondaryActions && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{secondaryActions}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Details popup — v1-style modal that shows the breakdown for one record.
// ============================================================
function DetailsModal({ rec, month, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const incTotal    = (rec.incentives || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const bonTotal    = (rec.bonuses    || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const incAchieved = (rec.incentives || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0);
  const bonAchieved = (rec.bonuses    || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="wx-card"
        style={{
          width: '100%', maxWidth: 560, maxHeight: '90vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          padding: 0,
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>Incentive details</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              {monthLabel(month)}
            </div>
          </div>
          <button className="wx-btn wx-btn-ghost" onClick={onClose} aria-label="Close">
            <XIcon width="14" height="14" />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Summary tile */}
          <div style={{
            padding: 12, borderRadius: 'var(--radius-md)', background: 'var(--surface-2)',
            fontSize: 12.5,
          }}>
            <BreakdownRow label="Basic" value={`${Number(rec.basic_salary || 0).toLocaleString()} PKR`} />
            <BreakdownRow label="Incentives earned"
              value={`+${incAchieved.toLocaleString()} / ${incTotal.toLocaleString()} PKR`}
              valueColor="var(--success)" />
            <BreakdownRow label="Bonuses earned"
              value={`+${bonAchieved.toLocaleString()} / ${bonTotal.toLocaleString()} PKR`}
              valueColor="var(--info)" />
            <div style={{
              display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 13.5,
              paddingTop: 8, marginTop: 6, borderTop: '1px dashed var(--border-subtle)',
            }}>
              <span>Total earned</span>
              <span>{earnedTotal(rec).toLocaleString()} PKR</span>
            </div>
          </div>

          {(rec.incentives || []).length > 0 && (
            <div>
              <div style={{
                fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
              }}>
                Incentives
              </div>
              {rec.incentives.map((i) => <DetailItem key={i.id} item={i} />)}
            </div>
          )}
          {(rec.bonuses || []).length > 0 && (
            <div>
              <div style={{
                fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)',
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
              }}>
                Bonuses
              </div>
              {rec.bonuses.map((b) => <DetailItem key={b.id} item={b} />)}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--border-subtle)',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button className="wx-btn wx-btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Stat tile
// ============================================================
function Stat({ label, value, accent, kind }) {
  const valueColor = accent
    ? 'var(--accent)'
    : kind === 'success' ? 'var(--success)'
    : kind === 'info'    ? 'var(--info)'
    : 'var(--text-primary)';
  return (
    <div className="wx-card" style={{ padding: 12 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: valueColor, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div style={{
      padding: '40px 20px', textAlign: 'center',
      border: '2px dashed var(--border-subtle)', borderRadius: 'var(--radius-lg)',
      background: 'var(--surface-1)',
    }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{message}</div>
    </div>
  );
}

// ============================================================
// One labeled item row (incentive or bonus) — used inside DetailsPanel
// ============================================================
function DetailItem({ item }) {
  const t = Number(item.targetValue), a = Number(item.achievedValue);
  const p = pctOf(a, t);
  const sfx = item.suffix || '';
  return (
    <div style={{
      padding: '10px 11px', marginBottom: 6,
      background: item.completed ? 'var(--success-soft)' : 'var(--surface-2)',
      border: `1px solid ${item.completed ? 'color-mix(in srgb, var(--success) 30%, transparent)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>{item.text || '—'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
            +{Number(item.amount || 0).toLocaleString()} PKR
            {t > 0 && <> · Target: {t.toLocaleString()}{sfx}</>}
            {(a > 0 || t > 0) && <> · Achieved: {(a || 0).toLocaleString()}{sfx} ({p}%)</>}
          </div>
        </div>
        <Pill kind={item.completed ? 'success' : 'muted'}>
          {item.completed ? '✓ Done' : `${p}%`}
        </Pill>
      </div>
      {t > 0 && (
        <div style={{ height: 3, background: 'var(--surface-1)', borderRadius: 999, marginTop: 6, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${p}%`,
            background: item.completed ? 'var(--success)' : 'var(--accent)',
            transition: 'width 0.3s',
          }} />
        </div>
      )}
    </div>
  );
}

// ============================================================
// Plan editor (admin builds structure; staff updates progress)
// ============================================================
function PlanEditor({ row, month, isAdmin, viewerRole, onClose, onSaved }) {
  const [targetUserId, setTargetUserId] = useState(row?.user_id || '');
  const [basic, setBasic]   = useState(row?.basic_salary ? String(row.basic_salary) : '');
  const [inc, setInc]       = useState(() => [...(row?.incentives || [])]);
  const [bon, setBon]       = useState(() => [...(row?.bonuses || [])]);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  const isNew = !row?.id && !row?.user_id;

  // Boss can pick anyone except boss; OL can pick APCs/IPCs only.
  const userPickerRoles = viewerRole === 'ol' ? ['apc', 'ipc'] : ['apc', 'ipc', 'tl', 'pctl', 'ol'];
  const { data: users = [] } = useQuery({
    queryKey: ['incentives', 'pickusers', viewerRole],
    queryFn: async () => {
      const { supabase } = await import('../../lib/supabase');
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, role')
        .eq('is_active', true)
        .is('deleted_at', null)
        .in('role', userPickerRoles)
        .order('display_name');
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: !!isAdmin && isNew,
  });

  async function save() {
    setSaving(true); setErr('');
    try {
      if (isNew && !targetUserId) { setErr('Pick the user this plan belongs to.'); setSaving(false); return; }
      const uid = targetUserId || row.user_id;
      const patch = {
        incentives: recomputeCompletion(inc),
        bonuses:    recomputeCompletion(bon),
      };
      if (isAdmin) patch.basic_salary = Number(basic) || 0;
      await upsertIncentives(uid, month, patch);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  // Picked-user details for the identity banner (admin creating a NEW plan).
  const pickedUser = users.find((u) => u.id === targetUserId);
  const headerName = pickedUser?.display_name || row?.user?.display_name || row?.userName || 'User';
  const headerRole = pickedUser?.role || row?.user?.role || row?.userRole;

  // Live totals for the summary card.
  const incTotal   = inc.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal   = bon.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const grandTotal = (Number(basic) || 0) + incTotal + bonTotal;

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">
            {isAdmin ? (isNew ? 'New incentive plan' : 'Edit plan') : 'Update progress'}
          </div>
          <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          {/* Identity banner */}
          {(headerName && (!isNew || pickedUser)) && (
            <div style={{
              padding: '14px 16px', marginBottom: 14, borderRadius: 'var(--radius-md)',
              background: 'linear-gradient(135deg, var(--surface-3), var(--surface-2))',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: 'var(--accent)', color: 'var(--on-accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 14, flexShrink: 0,
              }}>{initialsOf(headerName)}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{headerName}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {roleLabel(headerRole)} · {monthLabel(month)}
                </div>
              </div>
            </div>
          )}

          {/* Assign-to picker (admin, new plan only) */}
          {isAdmin && isNew && (
            <SectionCard
              icon={<UserIcon width="14" height="14" />}
              title="Assign to"
              subtitle="Choose the user this plan belongs to."
            >
              <select className="wx-input" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
                <option value="">— pick a user —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} · {roleLabel(u.role)}</option>)}
              </select>
            </SectionCard>
          )}

          {/* Basic Salary */}
          {isAdmin && (
            <SectionCard
              icon={<WalletIcon />}
              title="Basic / fixed salary"
              subtitle="Paid every month regardless of incentive completion."
            >
              <div style={{ display: 'flex', alignItems: 'stretch', maxWidth: 280 }}>
                <input className="wx-input" type="number" min="0"
                  placeholder="e.g. 60000"
                  value={basic} onChange={(e) => setBasic(e.target.value)}
                  style={{ borderRadius: 'var(--radius-md) 0 0 var(--radius-md)' }} />
                <span style={{
                  display: 'inline-flex', alignItems: 'center', padding: '0 14px',
                  background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
                  borderLeft: 0, borderRadius: '0 var(--radius-md) var(--radius-md) 0',
                  fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)',
                }}>PKR</span>
              </div>
            </SectionCard>
          )}

          {/* Incentives */}
          <ItemSection
            title="Incentives"
            subtitle="Performance-based — earned when target is hit."
            accentColor="var(--success)"
            items={inc} setItems={setInc}
            canEditStructure={isAdmin}
            addLabel="Add incentive"
            descPlaceholder="e.g. 250 affiliates with 3+ videos"
            emptyText="No incentives added yet."
          />

          {/* Bonuses */}
          <ItemSection
            title="Bonuses"
            subtitle="Special rewards — typically one-off."
            accentColor="var(--info)"
            items={bon} setItems={setBon}
            canEditStructure={isAdmin}
            addLabel="Add bonus"
            descPlaceholder="e.g. Top performer bonus"
            emptyText="No bonuses added yet."
          />

          {/* Summary */}
          <SectionCard
            icon={<ChartIcon width="14" height="14" />}
            title="Summary"
            subtitle="Total payable when every item is achieved."
            tone="muted"
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
              <SummaryRow label="Basic salary" value={`${(Number(basic) || 0).toLocaleString()} PKR`} />
              <SummaryRow label={`Total incentives (${inc.length})`}
                value={`+${incTotal.toLocaleString()} PKR`} valueColor="var(--success)" />
              <SummaryRow label={`Total bonuses (${bon.length})`}
                value={`+${bonTotal.toLocaleString()} PKR`} valueColor="var(--info)" />
              <div style={{
                display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 14,
                paddingTop: 8, marginTop: 4, borderTop: '1.5px solid var(--border-subtle)',
              }}>
                <span>Total potential salary</span>
                <span>{grandTotal.toLocaleString()} PKR</span>
              </div>
            </div>
          </SectionCard>

          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
            Items auto-complete when achieved ≥ 90% of target.
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={saving}>
            {saving
              ? <><span className="wx-spinner" /> Saving…</>
              : <><CheckIcon width="14" height="14" /> Save</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Light wrapper card — gives every section in the editor a consistent
// header (icon + title + subtitle) and inner padding.
function SectionCard({ icon, title, subtitle, tone, children, headerExtra }) {
  return (
    <div style={{
      background: tone === 'muted' ? 'var(--surface-2)' : 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: 14, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          {icon && (
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>{icon}</div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{subtitle}</div>
            )}
          </div>
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  );
}

function SummaryRow({ label, value, valueColor }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600, color: valueColor || 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

// Inline icons used inside the editor header tiles only.
// (Wallet/Chart aren't in our shared Icon.jsx yet, so define here.)
function WalletIcon(p) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v3" />
      <path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-3" />
      <path d="M21 12h-5a2 2 0 1 0 0 4h5z" />
    </svg>
  );
}

// ============================================================
// Item section — Incentives or Bonuses block with row-cards
// ============================================================
function ItemSection({
  title, subtitle, accentColor, items, setItems, canEditStructure,
  addLabel, descPlaceholder, emptyText,
}) {
  function update(i, patch) {
    setItems(items.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  }
  function add() {
    setItems([...items, {
      id: crypto.randomUUID(), text: '', amount: 0,
      targetValue: 0, achievedValue: 0, suffix: '', completed: false,
    }]);
  }
  function remove(i) { setItems(items.filter((_, idx) => idx !== i)); }

  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  return (
    <div style={{
      background: 'var(--surface-1)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)',
      padding: 14, marginBottom: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: `color-mix(in srgb, ${accentColor} 14%, transparent)`,
            color: accentColor,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {title === 'Bonuses' ? <StarIcon width="14" height="14" /> : <TargetIcon width="14" height="14" />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 1 }}>{subtitle}</div>
            )}
          </div>
        </div>
        {total > 0 && (
          <span style={{ fontWeight: 700, fontSize: 13, color: accentColor, whiteSpace: 'nowrap' }}>
            +{total.toLocaleString()} PKR
          </span>
        )}
      </div>

      {/* Lines */}
      {items.length === 0 ? (
        <div style={{
          padding: '14px 12px', textAlign: 'center', fontSize: 12.5,
          color: 'var(--text-muted)', background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
        }}>
          {emptyText}
        </div>
      ) : items.map((it, i) => (
        <ItemRowCard
          key={it.id} item={it} index={i}
          accentColor={accentColor}
          canEditStructure={canEditStructure}
          descPlaceholder={descPlaceholder}
          onChange={update}
          onRemove={remove}
        />
      ))}

      {canEditStructure && (
        <button type="button" className="wx-btn wx-btn-ghost"
          onClick={add}
          style={{ marginTop: items.length ? 4 : 10, fontSize: 12 }}>
          <PlusIcon width="12" height="12" /> {addLabel}
        </button>
      )}
    </div>
  );
}

// One labeled row-card for an incentive / bonus line.
function ItemRowCard({ item, index, accentColor, canEditStructure, descPlaceholder, onChange, onRemove }) {
  const t = Number(item.targetValue), a = Number(item.achievedValue);
  const pct = t > 0 ? Math.min(100, Math.round((a / t) * 100)) : (item.completed ? 100 : 0);
  const isAchieved = pct >= 90;

  return (
    <div style={{
      padding: 12, marginBottom: 8,
      background: isAchieved ? 'var(--success-soft)' : 'var(--surface-2)',
      border: `1px solid ${isAchieved ? 'color-mix(in srgb, var(--success) 30%, transparent)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-md)',
    }}>
      {/* Row 1: description + status pill + remove */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <input
          className="wx-input"
          placeholder={descPlaceholder}
          value={item.text || ''}
          disabled={!canEditStructure}
          onChange={(e) => onChange(index, { text: e.target.value })}
          style={{ flex: 1 }}
        />
        <Pill kind={isAchieved ? 'success' : 'warning'}>
          {isAchieved ? '✓ On track' : `${pct}%`}
        </Pill>
        {canEditStructure && (
          <button type="button" onClick={() => onRemove(index)} title="Remove"
            style={{
              border: 0, background: 'transparent', color: 'var(--danger)',
              cursor: 'pointer', padding: 6, display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
            <XIcon width="14" height="14" />
          </button>
        )}
      </div>

      {/* Row 2: target + achieved + compensation */}
      <div className="incentive-item-row-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,180px)',
        gap: 10,
      }}>
        {/* Target with optional suffix */}
        <div>
          <label style={labelStyle}>
            Target <span style={hintStyle}>(suffix optional — e.g. %, $, pts)</span>
          </label>
          <div style={{ display: 'flex' }}>
            <input
              className="wx-input"
              type="number" min="0" placeholder="e.g. 250"
              value={item.targetValue || ''}
              disabled={!canEditStructure}
              onChange={(e) => onChange(index, { targetValue: Number(e.target.value) || 0 })}
              style={{ borderRadius: 'var(--radius-md) 0 0 var(--radius-md)', flex: 1, minWidth: 0 }}
            />
            <input
              className="wx-input"
              type="text" placeholder="—" maxLength={6}
              value={item.suffix || ''}
              disabled={!canEditStructure}
              onChange={(e) => onChange(index, { suffix: e.target.value })}
              title="Optional unit (e.g. %, $, pts)"
              style={{
                borderRadius: '0 var(--radius-md) var(--radius-md) 0',
                borderLeft: 0, width: 56, textAlign: 'center', fontWeight: 700,
              }}
            />
          </div>
        </div>

        {/* Achieved */}
        <div>
          <label style={labelStyle}>Achieved</label>
          <div style={{ display: 'flex' }}>
            <input
              className="wx-input"
              type="number" min="0" placeholder="0"
              value={item.achievedValue || ''}
              onChange={(e) => onChange(index, { achievedValue: Number(e.target.value) || 0 })}
              style={{ borderRadius: 'var(--radius-md) 0 0 var(--radius-md)', flex: 1, minWidth: 0 }}
            />
            {item.suffix && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', padding: '0 10px',
                background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
                borderLeft: 0, borderRadius: '0 var(--radius-md) var(--radius-md) 0',
                fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
              }}>{item.suffix}</span>
            )}
          </div>
        </div>

        {/* Compensation */}
        <div>
          <label style={labelStyle}>Compensation if achieved</label>
          <div style={{ display: 'flex' }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '0 10px',
              background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
              borderRight: 0, borderRadius: 'var(--radius-md) 0 0 var(--radius-md)',
              fontSize: 13, fontWeight: 800, color: accentColor,
            }}>+</span>
            <input
              className="wx-input"
              type="number" min="0" placeholder="Amount"
              value={item.amount || ''}
              disabled={!canEditStructure}
              onChange={(e) => onChange(index, { amount: Number(e.target.value) || 0 })}
              style={{ borderRadius: 0, flex: 1, minWidth: 0, borderLeft: 0, borderRight: 0 }}
            />
            <span style={{
              display: 'inline-flex', alignItems: 'center', padding: '0 12px',
              background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
              borderRadius: '0 var(--radius-md) var(--radius-md) 0',
              fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)',
            }}>PKR</span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {t > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ height: 4, background: 'var(--surface-1)', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${pct}%`,
              background: isAchieved ? 'var(--success)' : accentColor,
              transition: 'width 0.3s',
            }} />
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle = {
  display: 'block',
  fontSize: 11, fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: 4, letterSpacing: '0.01em',
};
const hintStyle = {
  fontWeight: 400, color: 'var(--text-muted)',
};

// ============================================================
// Reset & roll modal — Boss end-of-month workflow
// ============================================================
function ResetAndRollModal({ currentMonth: cm, onClose, onDone }) {
  const [sourceMonth, setSourceMonth] = useState(cm);
  const [targetMonth, setTargetMonth] = useState(() => nextMonth(cm));
  const [forceClear, setForceClear] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState('');
  const [result, setResult]         = useState(null);

  const { data: months = [] } = useQuery({
    queryKey: ['incentives', 'months'],
    queryFn: listAvailableMonths,
  });

  async function go() {
    setSaving(true); setErr(''); setResult(null);
    try {
      const res = await resetAndRoll({ sourceMonth, targetMonth, forceClear });
      setResult(res);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Clear payouts & roll month</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}
          {result && (
            <div className="wx-alert wx-alert-success" style={{ marginBottom: 10 }}>
              <CheckIcon width="14" height="14" />
              <span>Cleared {result.cleared}, carried over {result.created}, skipped {result.skipped}.</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label className="wx-label">Clear payouts for</label>
              <input type="month" className="wx-input" value={sourceMonth}
                onChange={(e) => setSourceMonth(e.target.value)} />
              {months.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                  Months on file: {months.slice(0, 4).join(', ')}{months.length > 4 ? '…' : ''}
                </div>
              )}
            </div>
            <div>
              <label className="wx-label">Roll into</label>
              <input type="month" className="wx-input" value={targetMonth}
                onChange={(e) => setTargetMonth(e.target.value)} />
            </div>
          </div>

          <label style={{
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            padding: '8px 10px', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)', marginTop: 4,
          }}>
            <input type="checkbox" checked={forceClear}
              onChange={(e) => setForceClear(e.target.checked)} />
            Clear even rows that aren't verified yet
          </label>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            Marks every <strong>{monthLabel(sourceMonth)}</strong> row as payout-cleared
            (if verified{forceClear ? ' — or unverified' : ''}) and creates matching{' '}
            <strong>{monthLabel(targetMonth)}</strong> rows with the same structure
            and zero progress.
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button className="wx-btn wx-btn-primary" onClick={go} disabled={saving}>
              {saving
                ? <><span className="wx-spinner" /> Rolling…</>
                : <><RefreshIcon width="13" height="13" /> Reset & roll</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
