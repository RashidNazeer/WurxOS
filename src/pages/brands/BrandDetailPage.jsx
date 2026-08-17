import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { getBrand, setBrandLastSaleDate } from '../../lib/brandsApi';
import { listTasks } from '../../lib/tasksApi';
import { listReports, setReportSharedWithClient } from '../../lib/reportsApi';
import { listProducts } from '../../lib/productsApi';
import { useReportsRealtime } from '../../lib/useReportsRealtime';
import { currencySymbol } from '../../utils/currencies';

const REPORT_STATUS_TONE = {
  draft:     { fg: 'var(--text-muted)', label: 'Draft' },
  submitted: { fg: 'var(--accent)',     label: 'Submitted' },
  verified:  { fg: 'var(--info, #0ea5e9)', label: 'Verified' },
  approved:  { fg: 'var(--success)',    label: 'Approved' },
  rejected:  { fg: 'var(--danger)',     label: 'Rejected' },
};
import { supabase } from '../../lib/supabase';
import { paidCollabStatusLabel, gmvMaxStatusLabel } from '../../lib/roles';
import BrandAvatar from '../../components/brands/BrandAvatar';
import BrandForm from '../../components/brands/BrandForm';
import SwitchApcModal from '../../components/brands/SwitchApcModal';
import AssignBrandModal from '../../components/brands/AssignBrandModal';
import BrandResourcesPanel from '../../components/brands/BrandResourcesPanel';
import BrandReportLinksPanel from '../../components/brands/BrandReportLinksPanel';
import BrandReportSectionsPanel from '../../components/brands/BrandReportSectionsPanel';
import BrandActivityPanel from '../../components/brands/BrandActivityPanel';
import BrandCustomFieldsPanel from '../../components/brands/BrandCustomFieldsPanel';
import BrandProductsPanel from '../../components/brands/BrandProductsPanel';
import GmvMaxTab from '../../components/brands/tabs/GmvMaxTab';
import CampaignsTab from '../../components/brands/tabs/CampaignsTab';
import InactiveBrandBanner from '../../components/brands/InactiveBrandBanner';
import TaskRow from '../../components/tasks/TaskRow';
import TaskDetailModal from '../../components/tasks/TaskDetailModal';
import CreateTaskModal from '../../components/tasks/CreateTaskModal';
import {
  ChevronRightIcon, ChevronDownIcon, PencilIcon, AlertIcon,
  PlusIcon, StoreIcon, ChecklistIcon, ReportIcon, UsersIcon, BookmarkIcon,
  ShieldIcon, SettingsIcon, ClockIcon, BoxIcon, MegaphoneIcon, StarIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/brands.css';
import '../../styles/brandDetail.css';

const TAB_META = [
  { key: 'overview',  label: 'Overview',  Icon: StoreIcon },
  { key: 'products',  label: 'Products',  Icon: BoxIcon },
  { key: 'tasks',     label: 'Tasks',     Icon: ChecklistIcon },
  { key: 'reports',   label: 'Reports',   Icon: ReportIcon },
  { key: 'gmvMax',    label: 'GMV Max',   Icon: ReportIcon },
  { key: 'campaigns', label: 'Campaigns', Icon: MegaphoneIcon },
  { key: 'resources',   label: 'Resources',    Icon: BookmarkIcon },
  { key: 'reportLinks',    label: 'Report Links',    Icon: BookmarkIcon },
  { key: 'reportSections', label: 'Report Sections', Icon: BookmarkIcon },
  { key: 'activity',       label: 'Activity',        Icon: ClockIcon },
  { key: 'settings',  label: 'Settings',  Icon: SettingsIcon },
];

export default function BrandDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const role = profile?.role;
  const uid  = user?.id;

  const qc = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [showEdit, setShowEdit] = useState(false);
  const [showSwitchApc, setShowSwitchApc] = useState(false);
  const [showAssign, setShowAssign] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [viewTask, setViewTask] = useState(null);

  // --- Main brand fetch ---
  const { data: brand, isLoading, error, refetch: refetchBrand } = useQuery({
    queryKey: ['brand', id],
    queryFn: () => getBrand(id),
    enabled: !!id,
  });

  // --- Counts / aggregates ---
  const { data: tasks = [] } = useQuery({
    queryKey: ['brand-tasks', id],
    queryFn: () => listTasks({ brandId: id }),
    enabled: !!id && !!brand,
  });

  const { data: reports = [], refetch: refetchReports } = useQuery({
    queryKey: ['brand-reports', id],
    queryFn: () => listReports({ brandId: id }),
    enabled: !!id && !!brand,
  });
  // Live-sync: this brand's report list auto-updates when any report changes
  // (status flips, new/deleted) — no manual refresh.
  useReportsRealtime(refetchReports, { enabled: !!id && !!brand });

  const { data: resourceCount = 0 } = useQuery({
    queryKey: ['brand-resource-count', id],
    queryFn: async () => {
      const { count } = await supabase.from('resources')
        .select('id', { count: 'exact', head: true }).eq('brand_id', id);
      return count || 0;
    },
    enabled: !!id && !!brand,
  });

  const { data: products = [] } = useQuery({
    queryKey: ['brand-products', id],
    queryFn: () => listProducts(id),
    enabled: !!id && !!brand,
  });

  // --- Role-gated capabilities ---
  const isBossOrOL = ['boss', 'ol', 'developer'].includes(role);
  const isOwner    = brand && brand.owner_id === uid;
  const canEditBrand = isBossOrOL || isOwner;
  // Switching an APC automatically moves the brand to that APC's TL, so we
  // no longer expose a standalone "switch TL" action.
  const canSwitchApc = ['boss', 'ol', 'developer'].includes(role);

  // Activity + Settings limited to those who can actually manage.
  const showActivity = isBossOrOL || isOwner;
  const showSettings = canEditBrand;

  const openTaskCount = useMemo(
    () => tasks.filter((t) => t.status !== 'done').length, [tasks]);
  const openReportCount = useMemo(
    () => reports.filter((r) => ['draft','submitted','rejected'].includes(r.status)).length, [reports]);

  const taskStats = useMemo(() => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const endOfToday   = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
    let overdue = 0, dueToday = 0;
    for (const t of tasks) {
      if (t.status === 'done' || !t.due_date) continue;
      const d = new Date(t.due_date);
      if (d < startOfToday) overdue++;
      else if (d < endOfToday) dueToday++;
    }
    return { overdue, dueToday };
  }, [tasks]);

  const daysSinceOnboarded = useMemo(() => {
    if (!brand?.created_at) return null;
    const ms = Date.now() - new Date(brand.created_at).getTime();
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    return days >= 0 ? days : null;
  }, [brand?.created_at]);

  if (isLoading) {
    return <div className="wx-empty"><span className="wx-spinner" /> Loading brand…</div>;
  }
  if (error || !brand) {
    return (
      <div className="bd-empty">
        <div className="bd-empty-illu"><StoreIcon width="22" height="22" /></div>
        <div className="bd-empty-title">Brand not found</div>
        <div>{error?.message || 'You may not have access to this brand.'}</div>
        <div style={{ marginTop: 14 }}>
          <Link to="/brands" className="wx-btn wx-btn-ghost">Back to brands</Link>
        </div>
      </div>
    );
  }

  const owner = brand.owner;
  const assigned = brand.assignedUsers || [];

  return (
    <>
      {/* ---------- Top header card ---------- */}
      <div className="bd2-page">
        <button type="button" className="bd-back" onClick={() => navigate('/brands')}>
          <ChevronRightIcon width="14" height="14" style={{ transform: 'rotate(180deg)' }} />
          All brands
        </button>

        <div className="bd2-header">
          <div className="bd2-header-row">
            <div className="bd2-header-avatar">
              <BrandAvatar brand={brand} size={64} radius={14} />
            </div>
            <div className="bd2-header-main">
              <div className="bd2-header-title-row">
                <h1 className="bd2-header-title">{brand.brand_name}</h1>
                <span className={`bd-hero-status ${brand.status === 'active' ? 'bd-hero-status-active' : 'bd-hero-status-inactive'}`}>
                  {brand.status === 'active' ? 'Active' : 'Inactive'}
                </span>
                {brand.paid_collab_status && brand.paid_collab_status !== 'not_applicable' && (
                  <span className="bd-hero-status" style={{
                    background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
                    color: 'var(--accent)',
                  }}>
                    {paidCollabStatusLabel(brand.paid_collab_status)}
                  </span>
                )}
                {brand.tier && (
                  <span className="bd-hero-status" style={{
                    background: 'var(--surface-2)', color: 'var(--text-secondary)',
                  }}>
                    Tier · {brand.tier}
                  </span>
                )}
              </div>
              <div className="bd2-header-meta">
                {brand.client_name && (
                  <span className="bd2-header-meta-item">Client · <strong>{brand.client_name}</strong></span>
                )}
                {owner && (
                  <span className="bd2-header-meta-item">Owner · <strong>{owner.display_name}</strong></span>
                )}
                <span className="bd2-header-meta-item">
                  Onboarded {new Date(brand.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {daysSinceOnboarded != null && (
                    <span style={{ color: 'var(--text-muted)' }}> · {daysSinceOnboarded} {daysSinceOnboarded === 1 ? 'day' : 'days'} ago</span>
                  )}
                </span>
              </div>
            </div>
            <div className="bd2-header-actions">
              {brand.status === 'active' && (canEditBrand || assigned.some((a) => a.id === uid)) && (
                <button className="wx-btn wx-btn-ghost" onClick={() => setShowCreateTask(true)}>
                  <PlusIcon width="14" height="14" /> New task
                </button>
              )}
              {canEditBrand && (
                <button className="wx-btn wx-btn-primary" onClick={() => setShowEdit(true)}>
                  <PencilIcon width="14" height="14" /> Edit brand
                </button>
              )}
              {canEditBrand && brand.status === 'active' && (
                <button className="wx-btn wx-btn-ghost" onClick={() => setShowAssign(true)}
                  title="Assign this brand to an APC/IPC for temporary cover">
                  <UsersIcon width="14" height="14" /> Assign APC/IPC
                </button>
              )}
              {canSwitchApc && (
                <button className="wx-btn wx-btn-ghost" onClick={() => setShowSwitchApc(true)}
                  title="Move this brand to a different APC (the brand's TL follows the new APC)">
                  <UsersIcon width="14" height="14" /> Switch APC
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ---------- Horizontal tab strip ---------- */}
        <nav className="bd2-tabs" role="tablist">
          {TAB_META
            .filter((t) => {
              if (t.key === 'activity') return showActivity;
              if (t.key === 'settings') return showSettings;
              return true;
            })
            .map(({ key, label, Icon }) => {
              const count =
                key === 'tasks'     ? tasks.length
                : key === 'reports' ? reports.length
                : key === 'resources' ? resourceCount
                : key === 'products' ? products.length
                : null;
              return (
                <button key={key} type="button"
                  role="tab" aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`bd2-tab ${tab === key ? 'is-active' : ''}`}>
                  <Icon width="15" height="15" />
                  <span>{label}</span>
                  {count != null && count > 0 && (
                    <span className="bd2-tab-count">{count}</span>
                  )}
                </button>
              );
            })}
        </nav>

        <div className="bd-content">
          {tab === 'overview' && (
            <OverviewPanel
              brand={brand}
              canEdit={canEditBrand}
              canManageTier={canEditBrand || assigned.some((a) => a.id === uid)}
              onSaved={refetchBrand}
              owner={owner}
              assigned={assigned}
              gmv={brand.gmv}
              productsCount={products.length}
              openTaskCount={openTaskCount}
              overdueCount={taskStats.overdue}
              dueTodayCount={taskStats.dueToday}
              reportsCount={reports.length}
              openReportCount={openReportCount}
            />
          )}
          {tab === 'tasks' && (
            <TasksPanel
              tasks={tasks} brand={brand} user={user} role={role}
              canCreate={brand.status === 'active' && (canEditBrand || assigned.some((a) => a.id === uid))}
              isInactive={brand.status !== 'active'}
              onCreate={() => setShowCreateTask(true)}
              onEdit={setEditTask}
              onView={setViewTask}
              onChanged={() => qc.invalidateQueries({ queryKey: ['brand-tasks', id] })} />
          )}
          {tab === 'reports' && (
            <>
              {brand.status !== 'active' && <InactiveBrandBanner feature="reports" />}
              <ReportsPanel reports={reports} brand={brand} />
            </>
          )}
          {tab === 'gmvMax' && (
            <>
              {brand.status !== 'active' && <InactiveBrandBanner feature="GMV Max entries" />}
              <GmvMaxTab brand={brand} canCreate={brand.status === 'active'} />
            </>
          )}
          {tab === 'campaigns' && (
            <>
              {brand.status !== 'active' && <InactiveBrandBanner feature="campaigns" />}
              <CampaignsTab brand={brand} />
            </>
          )}
          {tab === 'products' && (
            <>
              {brand.status !== 'active' && <InactiveBrandBanner feature="products or product campaigns" />}
              <BrandProductsPanel
                brandId={brand.id}
                canEdit={brand.status === 'active' && (canEditBrand || ['apc','ipc'].includes(role))} />
            </>
          )}
          {tab === 'resources' && (
            <>
              {brand.status !== 'active' && <InactiveBrandBanner feature="resources" />}
              <BrandResourcesPanel
                brandId={brand.id}
                canEdit={brand.status === 'active' && (canEditBrand || ['apc','ipc'].includes(role))} />
            </>
          )}
          {tab === 'reportLinks' && (
            <BrandReportLinksPanel brandId={brand.id} brandName={brand.brand_name} />
          )}
          {tab === 'reportSections' && (
            <BrandReportSectionsPanel brandId={brand.id} brandName={brand.brand_name} />
          )}
          {tab === 'activity' && showActivity && (
            <BrandActivityPanel brandId={brand.id} />
          )}
          {tab === 'settings' && showSettings && (
            <SettingsPanel brand={brand} onEdit={() => setShowEdit(true)} />
          )}
        </div>
      </div>

      {/* ---------- Modals ---------- */}
      {showEdit && (
        <BrandForm brand={brand} onClose={() => setShowEdit(false)}
          onSaved={() => { setShowEdit(false); refetchBrand(); qc.invalidateQueries({ queryKey: ['brands'] }); }} />
      )}
      {showSwitchApc && (
        <SwitchApcModal brand={brand}
          onClose={() => setShowSwitchApc(false)}
          onDone={() => {
            setShowSwitchApc(false);
            refetchBrand();
            qc.invalidateQueries({ queryKey: ['brands'] });
            qc.invalidateQueries({ queryKey: ['brand-tasks', id] });
          }} />
      )}
      {showAssign && (
        <AssignBrandModal brand={brand}
          onClose={() => setShowAssign(false)}
          onDone={() => { refetchBrand(); qc.invalidateQueries({ queryKey: ['brands'] }); }} />
      )}
      {showCreateTask && (
        <CreateTaskModal task={null} defaultBrandId={brand.id}
          onClose={() => setShowCreateTask(false)}
          onSaved={() => { setShowCreateTask(false); qc.invalidateQueries({ queryKey: ['brand-tasks', id] }); }} />
      )}
      {editTask && (
        <CreateTaskModal task={editTask}
          onClose={() => setEditTask(null)}
          onSaved={() => { setEditTask(null); qc.invalidateQueries({ queryKey: ['brand-tasks', id] }); }} />
      )}
      {viewTask && (
        <TaskDetailModal
          task={viewTask}
          canEdit={
            !!user && (
              ['boss','ol','developer'].includes(role)
              || viewTask.created_by === user.id
              || (viewTask.brand && viewTask.brand.owner_id === user.id)
            )
          }
          onClose={() => setViewTask(null)}
          onEdit={() => { setEditTask(viewTask); setViewTask(null); }}
        />
      )}
    </>
  );
}

// ============================================================
// Tier sale tracker — a brand that isn't 'unlimited' must have a sale generated
// at least every 30 days to keep its creator-outreach tier unlocked. Record the
// last sale date here; the reminder fires 3/2/1 days before (date+30) then daily
// until it's updated (or the tier is set to unlimited). Boss/OL/owner-TL/assigned
// -APC can edit (server re-checks via brand_set_last_sale_date).
function karachiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()); // YYYY-MM-DD
}
function tierDeadlineInfo(dateStr) {
  if (!dateStr) return null;
  const deadline = new Date(dateStr + 'T00:00:00');
  deadline.setDate(deadline.getDate() + 30);
  const today = new Date(karachiToday() + 'T00:00:00');
  const daysLeft = Math.round((deadline - today) / 86400000);
  const deadlineLabel = deadline.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return { daysLeft, deadlineLabel };
}

function TierSaleCard({ brand, canManage, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  // Local copy so the picked date shows INSTANTLY while the RPC + refetch are in
  // flight — a purely prop-controlled input would flash back to the old value on
  // the setSaving re-render (painful on the slow ISPs this app codes for).
  const [localDate, setLocalDate] = useState(brand.last_sale_generated_date || '');
  useEffect(() => { setLocalDate(brand.last_sale_generated_date || ''); }, [brand.last_sale_generated_date]);
  const dateStr = localDate;
  const info = tierDeadlineInfo(dateStr);

  async function save(newDate) {
    setLocalDate(newDate || '');            // optimistic
    setSaving(true); setErr('');
    try {
      await setBrandLastSaleDate(brand.id, newDate || null);
      await onSaved?.();
    } catch (e) {
      setErr(e.message || 'Failed to save.');
      setLocalDate(brand.last_sale_generated_date || '');   // revert on failure
    }
    finally { setSaving(false); }
  }

  // Countdown badge tone/label.
  let badge = { text: 'No sale date set', bg: 'var(--warning-soft)', fg: 'var(--warning)' };
  if (info) {
    const d = info.daysLeft;
    if (d > 3)       badge = { text: `Next due in ${d} days`, bg: 'var(--success-soft)', fg: 'var(--success)' };
    else if (d > 0)  badge = { text: `Due in ${d} day${d === 1 ? '' : 's'}`, bg: 'var(--warning-soft)', fg: 'var(--warning)' };
    else if (d === 0) badge = { text: 'Due today', bg: 'var(--danger-soft)', fg: 'var(--danger)' };
    else             badge = { text: `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}`, bg: 'var(--danger-soft)', fg: 'var(--danger)' };
  }

  return (
    <div className="bd-card">
      <div className="bd-card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StarIcon width="15" height="15" style={{ color: 'var(--accent)' }} />
        Tier sale tracker
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
        Tier <strong>{brand.tier}</strong> stays unlocked only if a sale is generated every 30 days.
        Record the last sale date — reminders fire 3 days before it's due, then daily until you update it
        (or set the tier to <strong>unlimited</strong>).
      </p>

      <div className="d-flex align-items-center flex-wrap gap-2 mb-2">
        <span style={{
          fontSize: 11.5, fontWeight: 800, padding: '4px 11px', borderRadius: 999,
          background: badge.bg, color: badge.fg,
        }}>{badge.text}</span>
        {info && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Deadline · {info.deadlineLabel}</span>
        )}
      </div>

      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 8, fontSize: 12 }}><span>{err}</span></div>}

      {canManage ? (
        <div className="d-flex align-items-end flex-wrap gap-2">
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4 }}>
              Last sale generated
            </div>
            <input type="date" className="wx-input" style={{ width: 170 }}
              value={dateStr} max={karachiToday()} disabled={saving}
              onChange={(e) => save(e.target.value)} />
          </div>
          <button className="wx-btn wx-btn-primary" disabled={saving}
            onClick={() => save(karachiToday())}>
            {saving ? <span className="wx-spinner" /> : <><i className="bi bi-check2-circle me-1" />Mark generated today</>}
          </button>
          {dateStr && (
            <button className="wx-btn wx-btn-ghost" disabled={saving} onClick={() => save(null)} title="Clear the date (stops reminders)">
              Clear
            </button>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13 }}>
          Last sale generated: <strong>{dateStr ? new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</strong>
        </div>
      )}
    </div>
  );
}

// ============================================================
function OverviewPanel({
  brand, canEdit, canManageTier, onSaved, owner, assigned,
  gmv, productsCount, openTaskCount, overdueCount, dueTodayCount,
}) {
  // A brand is "under tier" (needs periodic sale generation to stay unlocked)
  // when it has a concrete tier that isn't 'unlimited'.
  const underTier = brand.tier && brand.tier.trim() && brand.tier.trim().toLowerCase() !== 'unlimited';
  // Build the KPI tile list, skipping tiles we don't have data for.
  const tiles = [];
  if (gmv != null) {
    tiles.push({
      key: 'gmv', label: 'GMV · 30 day', value: formatMoney(gmv, brand.currency),
      icon: 'bi-cash-stack', accent: '#0ea5e9',
      foot: gmv === 0 ? 'No attributed sales yet' : null,
    });
  }
  if (productsCount > 0) {
    tiles.push({
      key: 'products', label: 'Products live', value: productsCount,
      icon: 'bi-box-seam', accent: '#10b981',
    });
  }
  if (openTaskCount > 0 || overdueCount > 0 || dueTodayCount > 0) {
    const foot = [];
    if (overdueCount > 0)  foot.push(`${overdueCount} overdue`);
    if (dueTodayCount > 0) foot.push(`${dueTodayCount} due today`);
    tiles.push({
      key: 'tasks', label: 'Open tasks', value: openTaskCount,
      icon: 'bi-check2-square', accent: '#f59e0b',
      foot: foot.join(' · ') || null,
      footTone: overdueCount > 0 ? 'danger' : null,
    });
  }

  const teamCount = assigned.length + (owner ? 1 : 0);

  return (
    <div className="bd2-overview">
      {tiles.length > 0 && (
        <div className="bd2-kpis">
          {tiles.map((t) => (
            <div key={t.key} className="bd2-kpi">
              <div className="bd2-kpi-head">
                <span className="bd2-kpi-icon" style={{
                  background: `color-mix(in srgb, ${t.accent} 16%, transparent)`,
                  color: t.accent,
                }}>
                  <i className={`bi ${t.icon}`} />
                </span>
                <span className="bd2-kpi-label">{t.label}</span>
              </div>
              <div className="bd2-kpi-value">{t.value}</div>
              {t.foot && (
                <div className={`bd2-kpi-foot ${t.footTone === 'danger' ? 'is-danger' : ''}`}>
                  {t.foot}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bd-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="bd-card">
            <div className="bd-card-title">About</div>
            <dl className="bd-kv">
              <dt>Client</dt><dd>{brand.client_name || '—'}</dd>
              <dt>Tier</dt><dd>{brand.tier || '—'}</dd>
              <dt>GMV · 30 day</dt><dd>{brand.gmv != null ? formatMoney(brand.gmv, brand.currency) : '—'}</dd>
              <dt>Paid Collab</dt><dd>{paidCollabStatusLabel(brand.paid_collab_status)}</dd>
              <dt>GMV Max</dt><dd>{gmvMaxStatusLabel(brand.gmv_max_status)}</dd>
              <dt>Status</dt><dd style={{ textTransform: 'capitalize' }}>{brand.status}</dd>
              <dt>Created</dt><dd>{new Date(brand.created_at).toLocaleDateString()}</dd>
            </dl>
          </div>

          {underTier && brand.status === 'active' && (
            <TierSaleCard brand={brand} canManage={canManageTier} onSaved={onSaved} />
          )}

          <BrandCustomFieldsPanel brandId={brand.id} canEdit={canEdit} />
        </div>

        <div className="bd-card">
          <div className="bd-card-title">Team · {teamCount}</div>
          <div className="bd-team">
            {owner && (
              <div className="bd-team-row">
                <Avatar user={owner} />
                <div>
                  <div className="bd-team-name">{owner.display_name}</div>
                  <div className="bd-team-sub">Team Lead · Owner</div>
                </div>
                <span style={{
                  fontSize: 10.5, fontWeight: 800, padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--accent-soft)', color: 'var(--accent)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>TL</span>
              </div>
            )}
            {assigned.length === 0 && !owner && (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No team members assigned.
              </div>
            )}
            {assigned.map((u) => (
              <div key={u.id} className="bd-team-row">
                <Avatar user={u} />
                <div>
                  <div className="bd-team-name">{u.display_name}</div>
                  <div className="bd-team-sub">{u.role || 'member'}</div>
                </div>
                <span style={{
                  fontSize: 10.5, fontWeight: 700, padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--surface-2)', color: 'var(--text-muted)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>{u.role || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
function TasksPanel({ tasks, user, role, canCreate, isInactive, onCreate, onEdit, onView, onChanged }) {
  const [statusFilter, setStatus] = useState('all');
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return tasks;
    return tasks.filter((t) => t.status === statusFilter);
  }, [tasks, statusFilter]);

  const canEditRow = (r) => {
    if (!user) return false;
    if (['boss', 'ol', 'developer'].includes(role)) return true;
    if (r.created_by === user.id) return true;
    if (r.brand && r.brand.owner_id === user.id) return true;
    return false;
  };

  return (
    <>
      {isInactive && <InactiveBrandBanner feature="tasks" />}
      <div className="wx-toolbar" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['all','todo','in_progress','done'].map((s) => (
            <button key={s} type="button"
              onClick={() => setStatus(s)}
              className={`wx-role-chip ${statusFilter === s ? 'wx-role-chip-active' : ''}`}
              style={{ textTransform: 'capitalize' }}>
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          {canCreate && (
            <button className="wx-btn wx-btn-primary" onClick={onCreate}>
              <PlusIcon width="14" height="14" /> New task
            </button>
          )}
        </div>
      </div>
      <div className="wx-list">
        {filtered.length === 0 ? (
          <div className="bd-empty">
            <div className="bd-empty-illu"><ChecklistIcon width="22" height="22" /></div>
            <div className="bd-empty-title">{tasks.length === 0 ? 'No tasks yet' : 'No tasks match this filter'}</div>
            <div>{tasks.length === 0 && canCreate ? 'Click "New task" to add one.' : ''}</div>
          </div>
        ) : filtered.map((t) => (
          <TaskRow key={t.id}
            task={t}
            canEdit={canEditRow(t)}
            currentUserId={user?.id}
            onEdit={() => onEdit(t)}
            onView={onView}
            onChanged={onChanged} />
        ))}
      </div>
    </>
  );
}

// ============================================================
// One row's "Share with client" tick. Split out so its own pending/error state
// cannot re-render the whole table on every keystroke of a save.
//
// Two things it must get right:
//   * it lives inside a <Link>, so the click must be stopped or ticking a box
//     navigates away from the page you are working on.
//   * an unapproved report cannot be shared. The box is disabled rather than
//     allowed-then-rejected, because a control that fails when you use it is
//     worse than one that visibly cannot be used yet. The database refuses it
//     regardless (mig 322/323) — this is the courtesy, not the guard.
function ShareWithClientCell({ report, canShare }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const approved = report.status === 'approved';
  const disabled = !canShare || !approved || saving;

  async function toggle(e) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setSaving(true); setErr('');
    try {
      await setReportSharedWithClient(report.id, !report.shared_with_client);
      qc.invalidateQueries({ queryKey: ['reports'] });
    } catch (ex) {
      setErr(ex.message || 'Could not change sharing.');
    } finally { setSaving(false); }
  }

  return (
    <div
      onClick={toggle}
      title={
        !canShare ? 'Only an Operations Lead or the Boss can share reports with clients'
        : !approved ? 'This report must be approved before it can be shared with the client'
        : report.shared_with_client ? 'Visible to the client. Click to withhold it.'
        : 'Not visible to the client. Click to share it.'
      }
      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer' }}
    >
      <input
        type="checkbox"
        readOnly
        checked={!!report.shared_with_client}
        disabled={disabled}
        style={{ width: 15, height: 15, accentColor: 'var(--primary)', cursor: disabled ? 'default' : 'pointer' }}
      />
      {saving && <span className="wx-spinner" style={{ width: 12, height: 12 }} />}
      {err && <span style={{ fontSize: 10.5, color: 'var(--danger)' }} title={err}>failed</span>}
    </div>
  );
}

function ReportsPanel({ reports, brand }) {
  const { profile } = useAuth();
  const canShare = ['boss', 'ol', 'developer'].includes(profile?.role);
  if (reports.length === 0) {
    return (
      <div className="bd-empty">
        <div className="bd-empty-illu"><ReportIcon width="22" height="22" /></div>
        <div className="bd-empty-title">No reports for this brand</div>
        <div>Reports authored against <strong>{brand.brand_name}</strong> will appear here.</div>
      </div>
    );
  }
  const grouped = groupReportsByPeriod(reports);
  return (
    <div className="wx-list">
      <div className="wx-list-row wx-list-header" style={{ gridTemplateColumns: '1.2fr 1fr 1fr 120px 100px 130px' }}>
        <div>Period</div><div>Type</div><div>Author</div><div>Updated</div><div>Status</div>
        <div title="Only approved reports that are ticked here are visible in the client portal">Share with client</div>
      </div>
      {grouped.map((r) => (
        <Link key={r.id} to={`/reports?open=${r.id}`}
          className="wx-list-row"
          style={{ gridTemplateColumns: '1.2fr 1fr 1fr 120px 100px 130px', textDecoration: 'none', color: 'inherit' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{r.period_label || '—'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {new Date(r.period_start).toLocaleDateString()}
              {r.period_end ? ` – ${new Date(r.period_end).toLocaleDateString()}` : ''}
            </div>
          </div>
          <div style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{r.type}</div>
          <div style={{ fontSize: 12.5 }}>{r.author?.display_name || '—'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            {r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '—'}
          </div>
          <div>
            {(() => {
              const tone = REPORT_STATUS_TONE[r.status] || { fg: 'var(--text-muted)', label: r.status };
              return (
                <span style={{
                  fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
                  padding: '3px 10px', borderRadius: 'var(--radius-pill)',
                  background: `color-mix(in srgb, ${tone.fg} 18%, transparent)`,
                  color: tone.fg,
                }}>{tone.label}</span>
              );
            })()}
          </div>
          <ShareWithClientCell report={r} canShare={canShare} />
        </Link>
      ))}
    </div>
  );
}
function groupReportsByPeriod(reports) {
  // Already sorted desc by period_start from the API. Just return as-is.
  return reports;
}

// ============================================================
function SettingsPanel({ brand, onEdit }) {
  return (
    <div className="bd-grid">
      <div className="bd-card">
        <div className="bd-card-title">Brand details</div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
          Update this brand's name, client, logo, tier, GMV, paid-collab status
          and assigned APCs/IPCs.
        </p>
        <button className="wx-btn wx-btn-primary" onClick={onEdit}>
          <PencilIcon width="14" height="14" /> Edit brand
        </button>
      </div>
      <div className="bd-card">
        <div className="bd-card-title">Ownership</div>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
          Current Team Lead: <strong>{brand.owner?.display_name || '—'}</strong>.
          The TL moves automatically when a Boss or OL switches the brand's APC
          — use <strong>Switch APC</strong> above to reassign the brand.
        </p>
      </div>
    </div>
  );
}

// ============================================================
function Avatar({ user }) {
  if (user?.avatar_url) {
    return <div className="bd-avatar"><img src={user.avatar_url} alt="" /></div>;
  }
  return <div className="bd-avatar">{initialsOf(user?.display_name)}</div>;
}
function initialsOf(name) {
  if (!name) return '?';
  return String(name).split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
}
function formatMoney(n, currency = 'USD') {
  if (n == null) return '—';
  const sym = currencySymbol(currency);
  const num = Number(n);
  if (num >= 1_000_000) return `${sym}${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000)     return `${sym}${(num / 1_000).toFixed(1)}K`;
  return `${sym}${num.toFixed(0)}`;
}
