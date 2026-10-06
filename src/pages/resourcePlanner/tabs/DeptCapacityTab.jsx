import { CheckIcon, AlertIcon } from '../../../components/common/Icon';

// Department utilization summary. Bar viz + status badge.
export default function DeptCapacityTab({ deptSummary, config }) {
  const target = config.maxUtilizationTarget || 85;

  return (
    <>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface-1)' }}>
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
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{d.fullTime}</td>
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

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--success)', borderRadius: 'var(--radius-xs)', marginRight: 4 }} /> OK — below target</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--warning)', borderRadius: 'var(--radius-xs)', marginRight: 4 }} /> Moderate — above {target}%</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--danger)', borderRadius: 'var(--radius-xs)', marginRight: 4 }} /> At Capacity — {'>'}100%</span>
      </div>
    </>
  );
}

function UtilBar({ value, target, status }) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  }
  const clamped = Math.min(value, 150);
  const pct = (clamped / 150) * 100;
  let color = 'var(--success-text)';
  if (status === 'over') color = 'var(--danger-text)';
  else if (status === 'moderate') color = 'var(--warning-text)';

  const targetPct = (target / 150) * 100;

  return (
    <div style={{ position: 'relative', background: 'var(--surface-2)', borderRadius: 'var(--radius-xs)', height: 18, overflow: 'visible' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 'var(--radius-xs)', transition: 'width var(--dur-base) var(--ease-out)' }} />
      <div style={{ position: 'absolute', left: `${targetPct}%`, top: -2, bottom: -2, width: 2, background: 'var(--text-secondary)' }} />
      <div style={{ position: 'absolute', right: 6, top: 0, height: 18, display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
        {value}%
      </div>
    </div>
  );
}

function StatusBadge({ status, label }) {
  if (status === 'over') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-pill)', background: 'var(--danger-soft)', color: 'var(--danger-text)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <AlertIcon width="12" height="12" /> {label}
      </span>
    );
  }
  if (status === 'moderate') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-pill)', background: 'var(--warning-soft)', color: 'var(--warning-text)', fontSize: 12, fontWeight: 600 }}>
        {label}
      </span>
    );
  }
  if (status === 'na') {
    return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{label}</span>;
  }
  return (
    <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-pill)', background: 'var(--success-soft)', color: 'var(--success-text)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <CheckIcon width="12" height="12" /> {label}
    </span>
  );
}
