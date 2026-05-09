import { supabase } from './supabase';

// ============================================================
// Resource Planner (Boss) — ported 1:1 from v1's
// resourcePlannerService.js. All calculations are client-side so
// Boss can what-if without writing to the DB. The only persistence
// is the singleton `resource_planner_config` row.
// ============================================================

export const ROLE_KEYS = ['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc'];

export const ROLE_LABELS = {
  boss: 'Boss',
  ol:   'Operation Lead',
  tl:   'Team Lead',
  pctl: 'Paid Collab TL',
  apc:  'APC',
  ipc:  'IPC',
};

// The v1 department map — deterministic from role, no DB column needed.
export const ROLE_DEPARTMENTS = {
  boss: 'Leadership',
  ol:   'Operations',
  tl:   'Team Leads',
  pctl: 'Paid Collab',
  apc:  'Account Management',
  ipc:  'Paid Collab',
};

export const DEPARTMENTS = [
  'Leadership',
  'Operations',
  'Team Leads',
  'Paid Collab',
  'Account Management',
];

// Oversight departments see ALL active brands as their load — they
// don't own specific brands, they oversee everything.
const OVERSIGHT_DEPTS = new Set(['Leadership', 'Operations']);

export const HORIZON_OPTIONS = [
  { months: 1,  label: '1 month'   },
  { months: 2,  label: '2 months'  },
  { months: 3,  label: '3 months'  },
  { months: 6,  label: '6 months'  },
  { months: 12, label: '12 months' },
];

export const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

// --------------------------------------------------------------
// Config loaders (singleton row)
// --------------------------------------------------------------
// Shape returned to UI uses camelCase so the tab components can stay
// close to v1's code. Conversion happens here.
export async function getPlannerConfig() {
  const { data, error } = await supabase.rpc('get_planner_config');
  if (error) throw new Error(error.message);
  return toClientConfig(data);
}

export async function savePlannerConfig(patch) {
  // Patch keys are camelCase — convert to the RPC's p_* params.
  const args = {
    p_planning_year:                patch.planningYear            ?? null,
    p_planning_quarter:             patch.planningQuarter         ?? null,
    p_target_new_brands_per_month:  patch.targetNewBrandsPerMonth ?? null,
    p_planning_horizon_months:      patch.planningHorizonMonths   ?? null,
    p_max_utilization_target:       patch.maxUtilizationTarget    ?? null,
    p_min_buffer_headcount:         patch.minBufferHeadcount      ?? null,
    p_churn_rate:                   patch.churnRate               ?? null,
    p_role_capacity_patch:          patch.roleCapacity ? patch.roleCapacity : null,
  };
  const { data, error } = await supabase.rpc('save_planner_config', args);
  if (error) throw new Error(error.message);
  return toClientConfig(data);
}

function toClientConfig(row) {
  if (!row) return null;
  return {
    planningYear:             row.planning_year,
    planningQuarter:          row.planning_quarter,
    targetNewBrandsPerMonth:  Number(row.target_new_brands_per_month ?? 0),
    planningHorizonMonths:    row.planning_horizon_months,
    maxUtilizationTarget:     row.max_utilization_target,
    minBufferHeadcount:       row.min_buffer_headcount,
    churnRate:                Number(row.churn_rate ?? 0),
    roleCapacity:             row.role_capacity || {},
    updatedAt:                row.updated_at,
    updatedBy:                row.updated_by,
  };
}

// --------------------------------------------------------------
// Live employee + brand loaders
// --------------------------------------------------------------
// v2's single source of truth is `profiles` (no split like v1's
// users/teamUsers). Boss RLS already lets a Boss read every profile.
export async function loadAllEmployees() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, display_name, role, is_active, employment_type, start_date, created_at')
    .in('role', ROLE_KEYS)   // exclude 'developer' from the planner (it's an ops-only role)
    .order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id:             p.id,
    name:           p.display_name || p.email || '—',
    email:          p.email,
    role:           p.role,
    department:     ROLE_DEPARTMENTS[p.role] || '—',
    employmentType: p.employment_type || '',
    startDate:      p.start_date || null,
    status:         p.is_active ? 'Active' : 'Inactive',
  }));
}

// Brands: we pull owner_id + assigned user ids, and normalize
// v2's 'active'/'inactive' status to v1's 'Active'/'Paused' labels
// so the rest of the planner logic is unchanged.
export async function loadAllBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, status, owner_id, brand_assignments(user_id)')
    .order('brand_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((b) => ({
    id:             b.id,
    name:           b.brand_name,
    ownerId:        b.owner_id || null,
    assignedUserIds: (b.brand_assignments || []).map((a) => a.user_id),
    status:         b.status === 'active' ? 'Active' : 'Paused',
  }));
}

// --------------------------------------------------------------
// Computations (pure, client-side)
// --------------------------------------------------------------
export function computeBrandIdsForEmployee(employee, brands) {
  const activeBrands = brands.filter((b) => b.status === 'Active');

  if (employee.role === 'boss' || employee.role === 'ol') {
    // Oversight roles — every active brand counts against them
    return activeBrands.map((b) => b.id);
  }

  if (employee.role === 'tl' || employee.role === 'pctl') {
    return activeBrands
      .filter((b) => b.ownerId === employee.id)
      .map((b) => b.id);
  }

  if (employee.role === 'apc' || employee.role === 'ipc') {
    return activeBrands
      .filter((b) => (b.assignedUserIds || []).includes(employee.id))
      .map((b) => b.id);
  }

  return [];
}

export function computeUtilizationPct(employee, brandCount, config) {
  const cap = config?.roleCapacity?.[employee.role];
  const max = Number(cap?.maxBrands);
  if (!max || max <= 0) return null;
  return Math.round((brandCount / max) * 1000) / 10;
}

export function decorateEmployees(employees, brands, config) {
  return employees.map((e) => {
    const brandIds = computeBrandIdsForEmployee(e, brands);
    const brandCount = brandIds.length;
    const utilization = computeUtilizationPct(e, brandCount, config);
    return { ...e, brandIds, brandCount, utilization };
  });
}

export function computeDepartmentSummary(decoratedEmployees, brands, config) {
  const activeBrandCount = brands.filter((b) => b.status === 'Active').length;
  const maxTarget = Number(config?.maxUtilizationTarget) || 85;

  return DEPARTMENTS.map((dept) => {
    const inDept = decoratedEmployees.filter((e) => e.department === dept && e.status === 'Active');
    const headcount = inDept.length;
    const fullTime = inDept.filter((e) => (e.employmentType || '').toLowerCase().startsWith('full')).length;

    const isOversight = OVERSIGHT_DEPTS.has(dept);
    const totalBrands = isOversight
      ? activeBrandCount
      : inDept.reduce((sum, e) => sum + e.brandCount, 0);

    const utilValues = inDept.map((e) => e.utilization).filter((v) => v !== null && !Number.isNaN(v));
    const avgUtilization = utilValues.length
      ? Math.round((utilValues.reduce((a, b) => a + b, 0) / utilValues.length) * 10) / 10
      : null;

    let status = 'ok';
    let statusLabel = 'OK';
    if (avgUtilization === null) {
      status = 'na'; statusLabel = 'N/A';
    } else if (avgUtilization > 100) {
      status = 'over'; statusLabel = 'At Capacity';
    } else if (avgUtilization > maxTarget) {
      status = 'moderate'; statusLabel = 'Moderate';
    }

    return { department: dept, headcount, fullTime, totalBrands, avgUtilization, status, statusLabel };
  });
}

// What-if extra brands is an ad-hoc slider on the planner tab — NOT
// persisted. Passed as `extraBrands` so we don't pollute the config.
export function computeHeadcountPlanner(decoratedEmployees, brands, config, extraBrands = 0) {
  const activeBrandCount = brands.filter((b) => b.status === 'Active').length;
  const perMonth = Number(config?.targetNewBrandsPerMonth) || 0;
  const horizonMonths = Math.max(1, Number(config?.planningHorizonMonths) || 1);
  const projectedNewBrands = Math.round(perMonth * horizonMonths * 10) / 10;
  const projected = activeBrandCount + projectedNewBrands + (Number(extraBrands) || 0);
  const buffer = Number(config?.minBufferHeadcount) || 0;

  return DEPARTMENTS.map((dept) => {
    const inDept = decoratedEmployees.filter((e) => e.department === dept && e.status === 'Active');
    const hcAvailable = inDept.length;

    const rolesInDept = ROLE_KEYS.filter((r) => ROLE_DEPARTMENTS[r] === dept);
    const maxBrandsList = rolesInDept
      .map((r) => Number(config?.roleCapacity?.[r]?.maxBrands))
      .filter((v) => Number.isFinite(v) && v > 0);
    const avgBrandsPerRole = maxBrandsList.length
      ? Math.round((maxBrandsList.reduce((a, b) => a + b, 0) / maxBrandsList.length) * 10) / 10
      : null;

    let hcNeeded = null;
    let gap = null;
    let priority = 'na';
    let priorityLabel = 'N/A';

    if (avgBrandsPerRole) {
      hcNeeded = Math.ceil(projected / avgBrandsPerRole) + buffer;
      gap = hcAvailable - hcNeeded;
      if (gap <= -2)       { priority = 'urgent'; priorityLabel = 'URGENT'; }
      else if (gap === -1) { priority = 'soon';   priorityLabel = 'Hire Soon'; }
      else                 { priority = 'ok';     priorityLabel = 'Sufficient'; }
    }

    return {
      department: dept,
      currentTeam: hcAvailable,
      currentBrands: activeBrandCount,
      projectedBrands: projected,
      avgBrandsPerRole,
      hcNeeded,
      hcAvailable,
      gap,
      priority,
      priorityLabel,
    };
  });
}

export function computeMonthlyOutlook(decoratedEmployees, brands, config, monthsAhead = 12) {
  const activeBrandCount = brands.filter((b) => b.status === 'Active').length;
  const perMonth = Number(config?.targetNewBrandsPerMonth) || 0;
  const buffer = Number(config?.minBufferHeadcount) || 0;
  const hcAvailableTotal = decoratedEmployees.filter((e) => e.status === 'Active').length;

  const deptInfo = DEPARTMENTS.map((dept) => {
    const inDept = decoratedEmployees.filter((e) => e.department === dept && e.status === 'Active');
    const rolesInDept = ROLE_KEYS.filter((r) => ROLE_DEPARTMENTS[r] === dept);
    const maxBrandsList = rolesInDept
      .map((r) => Number(config?.roleCapacity?.[r]?.maxBrands))
      .filter((v) => Number.isFinite(v) && v > 0);
    const avgBrandsPerRole = maxBrandsList.length
      ? maxBrandsList.reduce((a, b) => a + b, 0) / maxBrandsList.length
      : null;
    return { dept, hcAvailable: inDept.length, avgBrandsPerRole };
  });

  const rows = [];
  for (let m = 1; m <= monthsAhead; m++) {
    const newBrandsSoFar = Math.round(perMonth * m * 10) / 10;
    const projectedBrands = activeBrandCount + newBrandsSoFar;

    let totalNeeded = 0;
    for (const d of deptInfo) {
      if (!d.avgBrandsPerRole) continue;
      totalNeeded += Math.ceil(projectedBrands / d.avgBrandsPerRole) + buffer;
    }
    const gap = hcAvailableTotal - totalNeeded;

    let priority = 'ok';
    let priorityLabel = 'Sufficient';
    if (gap <= -2) { priority = 'urgent'; priorityLabel = 'URGENT'; }
    else if (gap === -1) { priority = 'soon'; priorityLabel = 'Hire Soon'; }

    const d = new Date();
    d.setMonth(d.getMonth() + m);
    const monthLabel = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    rows.push({
      monthOffset: m,
      monthLabel,
      newBrandsThisMonth: perMonth,
      newBrandsCumulative: newBrandsSoFar,
      projectedBrands,
      hcNeeded: totalNeeded,
      hcAvailable: hcAvailableTotal,
      gap,
      priority,
      priorityLabel,
    });
  }
  return rows;
}
