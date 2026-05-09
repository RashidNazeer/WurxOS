import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getPlannerConfig, savePlannerConfig, loadAllEmployees, loadAllBrands,
  decorateEmployees, computeDepartmentSummary, computeHeadcountPlanner,
} from '../../lib/resourcePlannerApi';
import {
  RefreshIcon, AlertIcon, CheckIcon, DiagramIcon, SlidersIcon, UsersIcon,
  GridIcon, ChartIcon, TargetIcon, BuildingIcon,
} from '../../components/common/Icon';
import OverviewTab       from './tabs/OverviewTab';
import InputsTab         from './tabs/InputsTab';
import RoleCapacityTab   from './tabs/RoleCapacityTab';
import CurrentTeamTab    from './tabs/CurrentTeamTab';
import BrandAllocationTab from './tabs/BrandAllocationTab';
import DeptCapacityTab   from './tabs/DeptCapacityTab';
import HeadcountPlannerTab from './tabs/HeadcountPlannerTab';
import '../../styles/table.css';

const TABS = [
  { key: 'overview',  label: 'Overview',           Icon: DiagramIcon },
  { key: 'inputs',    label: 'Inputs',             Icon: SlidersIcon },
  { key: 'roles',     label: 'Role Capacity',      Icon: TargetIcon },
  { key: 'team',      label: 'Current Team',       Icon: UsersIcon },
  { key: 'alloc',     label: 'Brand Allocation',   Icon: GridIcon },
  { key: 'depts',     label: 'Dept Capacity',      Icon: BuildingIcon },
  { key: 'planner',   label: 'Headcount Planner',  Icon: ChartIcon },
];

export default function ResourcePlannerPage() {
  const qc = useQueryClient();
  const [activeKey, setActiveKey] = useState('overview');
  const [saving, setSaving]   = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [saveErr, setSaveErr] = useState('');

  const configQ    = useQuery({ queryKey: ['rp', 'config'],    queryFn: getPlannerConfig });
  const employeesQ = useQuery({ queryKey: ['rp', 'employees'], queryFn: loadAllEmployees });
  const brandsQ    = useQuery({ queryKey: ['rp', 'brands'],    queryFn: loadAllBrands });

  const config    = configQ.data || null;
  const employees = employeesQ.data || [];
  const brands    = brandsQ.data || [];
  const loading   = configQ.isPending || employeesQ.isPending || brandsQ.isPending;
  const loadErr   = configQ.error?.message || employeesQ.error?.message || brandsQ.error?.message || '';

  const decoratedEmployees = useMemo(
    () => (config ? decorateEmployees(employees, brands, config) : []),
    [employees, brands, config],
  );
  const deptSummary = useMemo(
    () => (config ? computeDepartmentSummary(decoratedEmployees, brands, config) : []),
    [decoratedEmployees, brands, config],
  );
  const headcountPlanner = useMemo(
    () => (config ? computeHeadcountPlanner(decoratedEmployees, brands, config) : []),
    [decoratedEmployees, brands, config],
  );

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['rp'] });
  };

  const onConfigChange = async (patch) => {
    setSaving(true);
    setSaveErr('');
    try {
      const next = await savePlannerConfig(patch);
      qc.setQueryData(['rp', 'config'], next);
      setSavedAt(Date.now());
    } catch (e) {
      setSaveErr(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const showSavedPulse = savedAt && (Date.now() - savedAt < 1800);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Resource Planner</h1>
          <p className="page-subtitle">Plan headcount and brand capacity across the company.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {saving && (
            <span style={{ fontSize: 12, color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span className="wx-spinner" style={{ width: 12, height: 12 }} /> Saving…
            </span>
          )}
          {!saving && showSavedPulse && (
            <span style={{ fontSize: 12, color: '#16a34a', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CheckIcon width="14" height="14" /> Saved
            </span>
          )}
          <button className="wx-btn wx-btn-ghost" onClick={refreshAll} title="Refresh">
            <RefreshIcon width="15" height="15" /> Refresh
          </button>
        </div>
      </div>

      {(loadErr || saveErr) && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{loadErr || saveErr}</span>
        </div>
      )}

      <div className="rp-tabs-strip" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--wx-border, #e5e7eb)', paddingBottom: 8 }}>
        {TABS.map((t) => {
          const active = t.key === activeKey;
          const Icon = t.Icon;
          return (
            <button
              key={t.key}
              onClick={() => setActiveKey(t.key)}
              className="wx-btn"
              style={{
                background: active ? 'var(--wx-primary, #2563eb)' : 'transparent',
                color: active ? '#fff' : 'var(--wx-muted, #475569)',
                border: active ? 'none' : '1px solid transparent',
                fontWeight: active ? 600 : 500,
              }}
            >
              <Icon width="14" height="14" /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && (
        <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>
          <span className="wx-spinner" /> Loading planner…
        </div>
      )}

      {!loading && config && (
        <>
          {activeKey === 'overview' && (
            <OverviewTab
              config={config} employees={decoratedEmployees} brands={brands}
              deptSummary={deptSummary} headcountPlanner={headcountPlanner}
              onNavigateTab={setActiveKey}
            />
          )}
          {activeKey === 'inputs' && (
            <InputsTab config={config} onConfigChange={onConfigChange} />
          )}
          {activeKey === 'roles' && (
            <RoleCapacityTab config={config} onConfigChange={onConfigChange} />
          )}
          {activeKey === 'team' && (
            <CurrentTeamTab employees={decoratedEmployees} config={config} />
          )}
          {activeKey === 'alloc' && (
            <BrandAllocationTab employees={decoratedEmployees} brands={brands} />
          )}
          {activeKey === 'depts' && (
            <DeptCapacityTab deptSummary={deptSummary} config={config} />
          )}
          {activeKey === 'planner' && (
            <HeadcountPlannerTab
              config={config}
              employees={decoratedEmployees}
              brands={brands}
              headcountPlanner={headcountPlanner}
              onConfigChange={onConfigChange}
            />
          )}
        </>
      )}
    </>
  );
}
