import { useMemo, useState } from 'react';
import {
  HORIZON_OPTIONS, computeHeadcountPlanner, computeMonthlyOutlook,
} from '../../../lib/resourcePlannerApi';
import { AlertIcon, CheckIcon } from '../../../components/common/Icon';

// Three parts: planning horizon control card, required HC by dept,
// monthly outlook table. What-if slider is ad-hoc (not persisted).
export default function HeadcountPlannerTab({ config, employees, brands, onConfigChange }) {
  const [whatIf, setWhatIf] = useState(0);

  // Recompute with the what-if delta so Boss can preview without
  // changing the persisted target.
  const plannerRows = useMemo(
    () => computeHeadcountPlanner(employees, brands, config, whatIf),
    [employees, brands, config, whatIf],
  );
  const outlookRows = useMemo(
    () => computeMonthlyOutlook(employees, brands, config, 12),
    [employees, brands, config],
  );

  const activeBrands = brands.filter((b) => b.status === 'Active').length;
  const projectedNew = Math.round((config.targetNewBrandsPerMonth || 0) * config.planningHorizonMonths * 10) / 10;
  const totalProjected = activeBrands + projectedNew + whatIf;

  const totalHcNeeded = plannerRows.reduce((s, r) => s + (r.hcNeeded || 0), 0);
  const totalHcAvailable = plannerRows.reduce((s, r) => s + r.hcAvailable, 0);
  const totalGap = totalHcAvailable - totalHcNeeded;

  const horizonLabel = HORIZON_OPTIONS.find((h) => h.months === config.planningHorizonMonths)?.label || `${config.planningHorizonMonths} months`;

  return (
    <>
      {/* Part A: Planning horizon control */}
      <div style={{ padding: 16, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', marginBottom: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Planning horizon</div>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 12 }}>
          You're planning for the next <strong>{horizonLabel}</strong>. Expected pipeline:{' '}
          <strong>{config.targetNewBrandsPerMonth}/month × {config.planningHorizonMonths} = {projectedNew} new brands</strong>.
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          {HORIZON_OPTIONS.map((h) => {
            const active = config.planningHorizonMonths === h.months;
            return (
              <button
                key={h.months}
                className="wx-btn"
                onClick={() => onConfigChange({ planningHorizonMonths: h.months })}
                style={{
                  background: active ? '#2563eb' : 'transparent',
                  color: active ? '#fff' : '#475569',
                  border: active ? 'none' : '1px solid #e5e7eb',
                }}
              >
                {h.label}
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: '#475569' }}>What-if extra brands in horizon:</label>
          <input
            type="range" min="0" max="30" step="1"
            value={whatIf}
            onChange={(e) => setWhatIf(Number(e.target.value))}
            style={{ flex: '1 1 200px', maxWidth: 280 }}
          />
          <strong style={{ minWidth: 36 }}>+{whatIf}</strong>
          {whatIf > 0 && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setWhatIf(0)}>Reset</button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))', gap: 10, marginTop: 14 }}>
          <Pill label="Current brands"         value={activeBrands} />
          <Pill label={`End of ${horizonLabel}`} value={totalProjected} />
          <Pill label="HC needed"              value={totalHcNeeded} />
          <Pill label="HC available"           value={totalHcAvailable} />
          <Pill
            label="Total gap"
            value={totalGap > 0 ? `+${totalGap}` : totalGap}
            tone={totalGap < 0 ? '#dc2626' : '#16a34a'}
          />
        </div>
      </div>

      {/* Part B: Required headcount by dept */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff', marginBottom: 14 }}>
        <div style={{ padding: 14, borderBottom: '1px solid #e5e7eb' }}>
          <strong>Required headcount by department</strong>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
            HC Needed = ceil(Projected Brands ÷ Avg Brands/Role) + Buffer ({config.minBufferHeadcount}).
            Gap = HC Available − HC Needed. Negative = need to hire; positive = spare capacity.
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="wx-table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Department</th>
                <th style={{ textAlign: 'right' }}>Current team</th>
                <th style={{ textAlign: 'right' }}>Current brands</th>
                <th style={{ textAlign: 'right' }}>Projected</th>
                <th style={{ textAlign: 'right' }}>Avg brands/role</th>
                <th style={{ textAlign: 'right' }}>HC needed</th>
                <th style={{ textAlign: 'right' }}>Gap</th>
                <th>Hire priority</th>
              </tr>
            </thead>
            <tbody>
              {plannerRows.map((r) => (
                <tr key={r.department}>
                  <td style={{ fontWeight: 600 }}>{r.department}</td>
                  <td style={{ textAlign: 'right' }}>{r.currentTeam}</td>
                  <td style={{ textAlign: 'right' }}>{r.currentBrands}</td>
                  <td style={{ textAlign: 'right' }}>{r.projectedBrands}</td>
                  <td style={{ textAlign: 'right', color: '#475569' }}>{r.avgBrandsPerRole ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{r.hcNeeded ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {r.gap === null
                      ? <span style={{ color: '#94a3b8' }}>—</span>
                      : <span style={{ color: r.gap < 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
                          {r.gap > 0 ? `+${r.gap}` : r.gap}
                        </span>}
                  </td>
                  <td><PriorityBadge priority={r.priority} label={r.priorityLabel} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Part C: Monthly outlook */}
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
        <div style={{ padding: 14, borderBottom: '1px solid #e5e7eb' }}>
          <strong>Monthly outlook — next 12 months</strong>
        </div>
        {config.targetNewBrandsPerMonth === 0 && (
          <div style={{ padding: 14, background: '#eff6ff', color: '#1e40af', fontSize: 13 }}>
            Set a monthly target in Inputs to see a real forecast.
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table className="wx-table" style={{ minWidth: 780 }}>
            <thead>
              <tr>
                <th>Month</th>
                <th style={{ textAlign: 'right' }}>Cumulative new</th>
                <th style={{ textAlign: 'right' }}>Projected total</th>
                <th style={{ textAlign: 'right' }}>HC needed</th>
                <th style={{ textAlign: 'right' }}>HC available</th>
                <th style={{ textAlign: 'right' }}>Gap</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {outlookRows.map((r) => {
                const isHorizon = r.monthOffset === config.planningHorizonMonths;
                return (
                  <tr key={r.monthOffset} style={{ background: isHorizon ? '#eff6ff' : undefined }}>
                    <td>
                      <span style={{ fontWeight: 600 }}>M+{r.monthOffset}</span>{' '}
                      <span style={{ color: '#64748b', fontSize: 12 }}>· {r.monthLabel}</span>
                      {isHorizon && <span style={{ marginLeft: 8, padding: '1px 8px', background: '#dbeafe', color: '#1e40af', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>Horizon</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.newBrandsCumulative}</td>
                    <td style={{ textAlign: 'right' }}>{r.projectedBrands}</td>
                    <td style={{ textAlign: 'right' }}>{r.hcNeeded}</td>
                    <td style={{ textAlign: 'right' }}>{r.hcAvailable}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: r.gap < 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
                        {r.gap > 0 ? `+${r.gap}` : r.gap}
                      </span>
                    </td>
                    <td><PriorityBadge priority={r.priority} label={r.priorityLabel} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Pill({ label, value, tone }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 8, background: '#f8fafc', border: '1px solid #e5e7eb' }}>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone || '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function PriorityBadge({ priority, label }) {
  if (priority === 'urgent') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 999, background: '#fef2f2', color: '#991b1b', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <AlertIcon width="12" height="12" /> {label}
      </span>
    );
  }
  if (priority === 'soon') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 999, background: '#fffbeb', color: '#92400e', fontSize: 12, fontWeight: 600 }}>
        {label}
      </span>
    );
  }
  if (priority === 'ok') {
    return (
      <span style={{ padding: '3px 10px', borderRadius: 999, background: '#f0fdf4', color: '#166534', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <CheckIcon width="12" height="12" /> {label}
      </span>
    );
  }
  return <span style={{ color: '#94a3b8', fontSize: 12 }}>{label}</span>;
}
