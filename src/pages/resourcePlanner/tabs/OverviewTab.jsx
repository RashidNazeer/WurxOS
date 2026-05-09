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
        <KpiCard icon={UsersIcon} tone="#2563eb" label="Total Team" value={active.length} sub={`${employees.length - active.length} inactive`} />
        <KpiCard icon={BuildingIcon} tone="#16a34a" label="Active Brands" value={activeBrands.length} sub={`${pausedBrands.length} paused`} />
        <KpiCard icon={TargetIcon} tone="#7c3aed" label="Avg Utilization" value={avgUtil !== null ? `${avgUtil}%` : '—'} sub={`Target ${config.maxUtilizationTarget}%`} />
        <KpiCard icon={ChartIcon} tone="#ea580c" label="Depts Needing Hire" value={urgentDepts.length + soonDepts.length} sub={urgentDepts.length ? `${urgentDepts.length} URGENT` : 'All clear'} />
      </div>

      {/* Urgent hire alert */}
      {urgentDepts.length > 0 && (
        <div style={{ padding: 14, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <AlertIcon width="18" height="18" color="#dc2626" />
            <strong style={{ color: '#991b1b' }}>Urgent hiring needed</strong>
            <button
              className="wx-btn wx-btn-ghost"
              onClick={() => onNavigateTab('planner')}
              style={{ marginLeft: 'auto', color: '#991b1b' }}
            >
              View Planner <ArrowRightIcon width="14" height="14" />
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {urgentDepts.map((d) => (
              <span key={d.department} style={{ padding: '4px 10px', background: '#fee2e2', color: '#991b1b', borderRadius: 999, fontSize: 13, fontWeight: 500 }}>
                {d.department}: need {d.hcNeeded} (have {d.hcAvailable})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Over-capacity alert */}
      {overDepts.length > 0 && (
        <div style={{ padding: 14, borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <AlertIcon width="18" height="18" color="#d97706" />
            <strong style={{ color: '#92400e' }}>Over capacity</strong>
            <button
              className="wx-btn wx-btn-ghost"
              onClick={() => onNavigateTab('depts')}
              style={{ marginLeft: 'auto', color: '#92400e' }}
            >
              View Capacity <ArrowRightIcon width="14" height="14" />
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {overDepts.map((d) => (
              <span key={d.department} style={{ padding: '4px 10px', background: '#fef3c7', color: '#92400e', borderRadius: 999, fontSize: 13, fontWeight: 500 }}>
                {d.department}: {d.avgUtilization}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Planning snapshot */}
      <div style={{ padding: 16, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff' }}>
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
    <div style={{ padding: 16, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: tone, marginBottom: 6 }}>
        <Icon width="18" height="18" /> <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#0f172a' }}>{value}</div>
      <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function Snap({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}
