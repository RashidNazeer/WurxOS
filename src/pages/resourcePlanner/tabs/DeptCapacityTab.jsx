import { CheckIcon, AlertIcon } from '../../../components/common/Icon';

// Department utilization summary. Bar viz + status badge.
export default function DeptCapacityTab({ deptSummary, config }) {
  const target = config.maxUtilizationTarget || 85;

  return (
    <>
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="wx-table" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>Headcount</th>
                <th style={{ textAlign: 'right' }}>Full-Time</th>
                <th style={{ textAlign: 'right' }}>Brand Load</th>
                <th style={{ minWidth: 220 }}>Avg Utilization</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {deptSummary.map((d) => (
                <tr key={d.department}>
                  <td style={{ fontWeight: 600 }}>{d.department}</td>
                  <td style={{ textAlign: 'right' }}>{d.headcount}</td>
                  <td style={{ textAlign: 'right', color: '#475569' }}>{d.fullTime}</td>
                  <td style={{ textAlign: 'right' }}>{d.totalBrands}</td>
                  <td>
                    <UtilBar value={d.avgUtilization} target={target} status={d.status} />
                  </td>
                  <td>
                    <StatusBadge status={d.status} label={d.statusLabel} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#64748b', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#10b981', borderRadius: 2, marginRight: 4 }} /> OK — below target</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#f59e0b', borderRadius: 2, marginRight: 4 }} /> Moderate — above {target}%</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: '#ef4444', borderRadius: 2, marginRight: 4 }} /> At Capacity — {'>'}100%</span>
      </div>
    </>
  );
}

function UtilBar({ value, target, status }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span style={{ color: '#94a3b8' }}>—</span>;
  }
  const clamped = Math.min(value, 150);
  const pct = (clamped / 150) * 100;
  let color = '#10b981';
  if (status === 'over') color = '#ef4444';
  else if (status === 'moderate') color = '#f59e0b';

  const targetPct = (target / 150) * 100;

  return (
    <div style={{ position: 'relative', background: '#f1f5f9', borderRadius: 4, height: 18, overflow: 'visible' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width .2s' }} />
      <div style={{ position: 'absolute', left: `${targetPct}%`, top: -2, bottom: -2, width: 2, background: '#475569' }} />
      <div style={{ position: 'absolute', right: 6, top: 0, height: 18, display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 700, color: '#0f172a' }}>
        {value}%
      </div>
    </div>
  );
}

function StatusBadge({ status, label }) {
  if (status === 'over') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 999, background: '#fef2f2', color: '#991b1b', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <AlertIcon width="12" height="12" /> {label}
      </span>
    );
  }
  if (status === 'moderate') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 999, background: '#fffbeb', color: '#92400e', fontSize: 12, fontWeight: 600 }}>
        {label}
      </span>
    );
  }
  if (status === 'na') {
    return <span style={{ color: '#94a3b8', fontSize: 12 }}>{label}</span>;
  }
  return (
    <span style={{ padding: '3px 10px', borderRadius: 999, background: '#f0fdf4', color: '#166534', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <CheckIcon width="12" height="12" /> {label}
    </span>
  );
}
