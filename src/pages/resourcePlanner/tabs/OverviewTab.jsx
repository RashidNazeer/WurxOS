import { ChartIcon, AlertIcon, UsersIcon, BuildingIcon, TargetIcon, ArrowRightIcon } from '../../../components/common/Icon';

// KPI card grid + alert banners. v1 parity: 4 KPIs, two alert banners
// (urgent hiring, over-capacity), planning snapshot card.
export default function OverviewTab({ config, employees, brands, deptSummary, headcountPlanner, onNavigateTab }) {
  const active = employees.filter((e) => e.status === 'Active');
  const activeBrands = brands.filter((b) => b.status === 'Active');
  const pausedBrands = brands.filter((b) => b.status === 'Paused');

  const utilValues = active.map((e) => e.utilization).filter((v) => v !== null && !Number.isNaN(v));
  const avgUtil = utilValues.length
    ? Math.round((utilValues.reduce((a, b) => a + b, 0) / utilValues.length) * 10) / 10
    : null;

  const urgentDepts = headcountPlanner.filter((d) => d.priority === 'urgent');
  const soonDepts   = headcountPlanner.filter((d) => d.priority === 'soon');
  const overDepts   = deptSummary.filter((d) => d.status === 'over');

  return (
    <>
      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard icon={UsersIcon} tone="var(--info-text)" label="Total Team" value={active.length} sub={`${employees.length - active.length} inactive`} />
        <KpiCard icon={BuildingIcon} tone="var(--success-text)" label="Active Brands" value={activeBrands.length} sub={`${pausedBrands.length} paused`} />
        <KpiCard icon={TargetIcon} tone="var(--purple-text)" label="Avg Utilization" value={avgUtil !== null ? `${avgUtil}%` : '—'} sub={`Target ${config.maxUtilizationTarget}%`} />
        <KpiCard icon={ChartIcon} tone="var(--warning-text)" label="Depts Needing Hire" value={urgentDepts.length + soonDepts.length} sub={urgentDepts.length ? `${urgentDepts.length} URGENT` : 'All clear'} />
      </div>

      {/* Urgent hire alert */}
      {urgentDepts.length > 0 && (
        <div style={{ padding: 14, borderRadius: 10, background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <AlertIcon width="18" height="18" color="var(--danger-text)" />
            <strong style={{ color: 'var(--danger-text)' }}>Urgent hiring needed</strong>
            <button
              className="wx-btn wx-btn-ghost"
              onClick={() => onNavigateTab('planner')}
              style={{ marginLeft: 'auto', color: 'var(--danger-text)' }}
            >
              View Planner <ArrowRightIcon width="14" height="14" />
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {urgentDepts.map((d) => (
              <span key={d.department} style={{ padding: '4px 10px', background: 'var(--danger-soft)', color: 'var(--danger-text)', borderRadius: 999, fontSize: 13, fontWeight: 500 }}>
                {d.department}: need {d.hcNeeded} (have {d.hcAvailable})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Over-capacity alert */}
      {overDepts.length > 0 && (
        <div style={{ padding: 14, borderRadius: 10, background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <AlertIcon width="18" height="18" color="var(--warning-text)" />
            <strong style={{ color: 'var(--warning-text)' }}>Over capacity</strong>
            <button
              className="wx-btn wx-btn-ghost"
              onClick={() => onNavigateTab('depts')}
              style={{ marginLeft: 'auto', color: 'var(--warning-text)' }}
            >
              View Capacity <ArrowRightIcon width="14" height="14" />
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {overDepts.map((d) => (
              <span key={d.department} style={{ padding: '4px 10px', background: 'var(--warning-soft)', color: 'var(--warning-text)', borderRadius: 999, fontSize: 13, fontWeight: 500 }}>
                {d.department}: {d.avgUtilization}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Planning snapshot */}
      <div style={{ padding: 16, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong>Planning snapshot</strong>
          <button className="wx-btn wx-btn-ghost" onClick={() => onNavigateTab('inputs')} style={{ fontSize: 13 }}>
            Edit Inputs <ArrowRightIcon width="14" height="14" />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: 10, fontSize: 13 }}>
          <Snap label="Year"         value={config.planningYear} />
          <Snap label="Quarter"      value={config.planningQuarter} />
          <Snap label="Target/month" value={config.targetNewBrandsPerMonth} />
          <Snap label="Horizon"      value={`${config.planningHorizonMonths} mo`} />
          <Snap label="Max util"     value={`${config.maxUtilizationTarget}%`} />
          <Snap label="Buffer"       value={config.minBufferHeadcount} />
          <Snap label="Churn"        value={`${config.churnRate}%`} />
        </div>
      </div>
    </>
  );
}

function KpiCard({ icon: Icon, tone, label, value, sub }) {
  return (
    <div style={{ padding: 16, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: tone, marginBottom: 6 }}>
        <Icon width="18" height="18" /> <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Snap({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>{value}</div>
    </div>
  );
}
