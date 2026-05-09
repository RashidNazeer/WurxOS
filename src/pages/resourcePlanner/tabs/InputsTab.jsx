import { useEffect, useState } from 'react';
import { QUARTERS, HORIZON_OPTIONS } from '../../../lib/resourcePlannerApi';

// Planning parameters. Text/number inputs commit on blur; selects
// commit on change. Mirrors v1's InputsTab behavior exactly.
export default function InputsTab({ config, onConfigChange }) {
  const [local, setLocal] = useState(config);

  // Re-sync when parent-driven updates come in (refresh, other tabs
  // patched the config, etc).
  useEffect(() => { setLocal(config); }, [config]);

  const commit = (patch) => onConfigChange(patch);

  const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 14 }}>
      <Card title="Planning Year" help="Fiscal year this plan covers.">
        <input
          type="number" min="2020" max="2099" className="wx-input"
          value={local.planningYear}
          onChange={(e) => setLocal({ ...local, planningYear: e.target.value })}
          onBlur={() => {
            const v = num(local.planningYear);
            if (v !== config.planningYear) commit({ planningYear: v });
          }}
        />
      </Card>

      <Card title="Planning Quarter" help="Current quarter — saves instantly.">
        <select
          className="wx-input"
          value={local.planningQuarter}
          onChange={(e) => {
            setLocal({ ...local, planningQuarter: e.target.value });
            commit({ planningQuarter: e.target.value });
          }}
        >
          {QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
      </Card>

      <Card title="Target New Brands / Month" help="Used for headcount projections.">
        <input
          type="number" min="0" max="50" step="0.5" className="wx-input"
          value={local.targetNewBrandsPerMonth}
          onChange={(e) => setLocal({ ...local, targetNewBrandsPerMonth: e.target.value })}
          onBlur={() => {
            const v = num(local.targetNewBrandsPerMonth);
            if (v !== config.targetNewBrandsPerMonth) commit({ targetNewBrandsPerMonth: v });
          }}
        />
      </Card>

      <Card title="Planning Horizon" help="How far ahead projections run.">
        <select
          className="wx-input"
          value={local.planningHorizonMonths}
          onChange={(e) => {
            const v = Number(e.target.value);
            setLocal({ ...local, planningHorizonMonths: v });
            commit({ planningHorizonMonths: v });
          }}
        >
          {HORIZON_OPTIONS.map((h) => (
            <option key={h.months} value={h.months}>{h.label}</option>
          ))}
        </select>
      </Card>

      <Card title="Max Utilization Target (%)" help="Threshold for the 'Moderate' capacity alert.">
        <input
          type="number" min="0" max="100" className="wx-input"
          value={local.maxUtilizationTarget}
          onChange={(e) => setLocal({ ...local, maxUtilizationTarget: e.target.value })}
          onBlur={() => {
            const v = num(local.maxUtilizationTarget);
            if (v !== config.maxUtilizationTarget) commit({ maxUtilizationTarget: v });
          }}
        />
      </Card>

      <Card title="Minimum Buffer Headcount" help="Extra HC per department (safety stock).">
        <input
          type="number" min="0" max="20" className="wx-input"
          value={local.minBufferHeadcount}
          onChange={(e) => setLocal({ ...local, minBufferHeadcount: e.target.value })}
          onBlur={() => {
            const v = num(local.minBufferHeadcount);
            if (v !== config.minBufferHeadcount) commit({ minBufferHeadcount: v });
          }}
        />
      </Card>

      <Card title="Churn Rate Assumption (%)" help="Annual turnover used for long-term planning.">
        <input
          type="number" min="0" max="100" step="0.5" className="wx-input"
          value={local.churnRate}
          onChange={(e) => setLocal({ ...local, churnRate: e.target.value })}
          onBlur={() => {
            const v = num(local.churnRate);
            if (v !== config.churnRate) commit({ churnRate: v });
          }}
        />
      </Card>
    </div>
  );
}

function Card({ title, help, children }) {
  return (
    <div style={{ padding: 16, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>{title}</div>
      {children}
      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>{help}</div>
    </div>
  );
}
