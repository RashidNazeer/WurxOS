import { supabase } from './supabase';

export function currentMonth() { return new Date().toISOString().slice(0, 7); }

export function autoComplete(item) {
  const t = Number(item.targetValue), a = Number(item.achievedValue);
  if (!t || t <= 0) return !!item.completed;
  return (a / t) >= 0.9;
}

export async function getIncentives(userId, month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
    .eq('user_id', userId).eq('month', month).maybeSingle();
  if (error) throw new Error(error.message);
  // Note: _normRow attaches v1 aliases (basicSalary, userId, payoutCleared,
  // verifiedByName, etc.) so v1 markup reads it without translation.
  return data ? _normRow(data) : null;
}

export async function listIncentivesForMonth(month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, role)')
    .eq('month', month).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function upsertIncentives(userId, month, patch) {
  const { data: me } = await supabase.auth.getUser();
  const payload = {
    user_id: userId, month,
    ...patch,
    last_updated_by: me?.user?.id,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('incentives')
    .upsert(payload, { onConflict: 'user_id,month' })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export function recomputeCompletion(items) {
  return (items || []).map((it) => ({ ...it, completed: autoComplete(it) }));
}

export function earnedTotal(row) {
  if (!row) return 0;
  const inc = (row.incentives || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0);
  const bon = (row.bonuses    || []).filter((i) => i.completed).reduce((s, i) => s + Number(i.amount || 0), 0);
  return Number(row.basic_salary || 0) + inc + bon;
}

// Total potential (if all items hit) — shown alongside "earned" for context.
export function potentialTotal(row) {
  if (!row) return 0;
  const inc = (row.incentives || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const bon = (row.bonuses    || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  return Number(row.basic_salary || 0) + inc + bon;
}

// Summary for badges — count of items completed vs total.
export function completionCounts(row) {
  const inc = row?.incentives || [];
  const bon = row?.bonuses    || [];
  const totalItems     = inc.length + bon.length;
  const completedItems = inc.filter((i) => i.completed).length + bon.filter((i) => i.completed).length;
  return { completedItems, totalItems };
}

// --------------------------------------------------------------
// Verification + payout management (admin-only RPCs)
// --------------------------------------------------------------
export async function verifyIncentives(id, verified = true) {
  const { data, error } = await supabase.rpc('inc_verify', { p_id: id, p_verified: !!verified });
  if (error) throw new Error(error.message);
  return data;
}

export async function clearIncentivePayout(id, cleared = true) {
  const { data, error } = await supabase.rpc('inc_clear_payout', { p_id: id, p_cleared: !!cleared });
  if (error) throw new Error(error.message);
  return data;
}

export async function notifyIncentiveEmployee(id) {
  const { data, error } = await supabase.rpc('inc_notify_employee', { p_id: id });
  if (error) throw new Error(error.message);
  return data;
}

// Boss-only end-of-month reset-and-roll workflow.
export async function resetAndRoll({ sourceMonth, targetMonth, forceClear = false }) {
  const { data, error } = await supabase.rpc('inc_reset_and_roll', {
    p_source: sourceMonth,
    p_target: targetMonth,
    p_force_clear: !!forceClear,
  });
  if (error) throw new Error(error.message);
  return data;  // { cleared, created, skipped }
}

// --------------------------------------------------------------
// Richer queries for the Boss + OL pages
// --------------------------------------------------------------
// Month view scoped to a given role (APC / TL / OL) for the Boss tabs.
export async function listIncentivesForRole(role, month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to, is_active)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  return (data || []).filter((r) => r.user?.role === role);
}

// Month view scoped to a manager's direct-report team (for OL viewing APCs).
export async function listIncentivesForMyTeam(managerId, month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to, is_active)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  return (data || []).filter((r) => r.user?.reports_to === managerId);
}

// All months that have any incentive row — for the month picker.
export async function listAvailableMonths() {
  const { data, error } = await supabase
    .from('incentives')
    .select('month')
    .order('month', { ascending: false });
  if (error) throw new Error(error.message);
  const seen = new Set();
  const out = [];
  (data || []).forEach((r) => { if (!seen.has(r.month)) { seen.add(r.month); out.push(r.month); } });
  return out;
}

// ============================================================
// v1 PARITY LAYER
// ------------------------------------------------------------
// Helpers + normalisers + extra loaders the verbatim-ported v1
// pages need. Same pattern as the Performance port.
// ============================================================

export function getCurrentMonth() { return currentMonth(); }
export function getMonthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
export function getNextMonth(ym) {
  if (!ym) return ym;
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1); // m is 0-based when used as second arg → next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function pct(achieved, target) {
  if (!target || target <= 0) return 0;
  return Math.min(Math.round((Number(achieved) / Number(target)) * 100), 100);
}
export function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}
export function uid4() { return Math.random().toString(36).slice(2, 10); }

// Mirror of v1's calcBreakdown — returns both potential and
// achieved totals. PKR amounts are summed as-is.
export function calcBreakdown(rec) {
  if (!rec) return { basic: 0, incTotal: 0, bonTotal: 0, incAchieved: 0, bonAchieved: 0, totalPotential: 0, totalAchieved: 0, total: 0 };
  const incs = rec.incentives || [];
  const bons = rec.bonuses    || [];
  const incTotal       = incs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal       = bons.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const incAchieved    = incs.filter((i) => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonAchieved    = bons.filter((b) => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const basic          = Number(rec.basicSalary ?? rec.basic_salary) || 0;
  const totalPotential = basic + incTotal + bonTotal;
  const totalAchieved  = basic + incAchieved + bonAchieved;
  return { basic, incTotal, bonTotal, incAchieved, bonAchieved, totalPotential, totalAchieved, total: totalAchieved };
}

// ── Row normaliser — v2 snake_case → v1 camelCase + alias fields ──
// v1 markup reads: id, userId, apcId, userRole, userName, basicSalary,
// month, incentives[], bonuses[], verified, payoutCleared, notified,
// verifiedByName, verifiedByRole, ownerId, brandNames[], ghosted,
// sourceMonth, carriedFrom.
function _normRow(r) {
  if (!r) return r;
  const u = r.user || {};
  const role = u.role || r.user_role || null;
  const isApc = role === 'apc' || role === 'ipc';
  return {
    ...r,
    id:               r.id,
    userId:           r.user_id,
    apcId:            isApc ? r.user_id : (r.apc_id || null),
    apcName:          isApc ? (u.display_name || r.user_name || '') : null,
    userRole:         role,
    userName:         u.display_name || r.user_name || '',
    userEmail:        u.email || '',
    ownerId:          u.reports_to || null,
    ownerName:        '',  // resolved on demand by callers; v1 read it from a separate join
    basicSalary:      Number(r.basic_salary) || 0,
    incentives:       Array.isArray(r.incentives) ? r.incentives : [],
    bonuses:          Array.isArray(r.bonuses) ? r.bonuses : [],
    verified:         !!r.verified,
    verifiedAt:       r.verified_at,
    verifiedBy:       r.verified_by,
    verifiedByName:   r.verifier?.display_name || null,
    verifiedByRole:   null, // v2 doesn't store; left null (UI handles)
    payoutCleared:    !!r.payout_cleared,
    payoutClearedAt:  r.payout_cleared_at,
    payoutClearedBy:  r.payout_cleared_by,
    notified:         !!r.notified,
    notifiedAt:       r.notified_at,
    brandNames:       r.brand_names || [],   // not stored in v2 schema; safe fallback
    ghosted:          !!r._ghost,
    sourceMonth:      r._source_month || null,
    carriedFrom:      r.carried_from || null,
  };
}

// Single-row normalise (exposed for callers that fetch via getIncentives).
export function normalizeRow(r) { return _normRow(r); }

// ── Bulk loaders the v1 pages need ─────────────────────────────
// Returns rows already normalised so v1 markup reads them as-is.
export async function listIncentivesMonth(month = currentMonth()) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to, is_active), verifier:verified_by(display_name)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  return (data || []).map(_normRow);
}

// Most recent prior plan for one user (used for ghost auto-carry-forward).
// Returns null if the user never had a plan before the picked month.
export async function getMostRecentPriorPlan(userId, beforeMonth) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*, user:user_id(id, display_name, email, role, reports_to)')
    .eq('user_id', userId)
    .lt('month', beforeMonth)
    .order('month', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return _normRow(data);
}

// User loaders the management pages need — same shape v1 used.
//   { id, displayName, userName, userType, role, email, ownerId, ownerName,
//     assignedBrands? (UI uses .map(b => b.name)) }
export async function listUsersByRoles(roles) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to, is_active, deleted_at')
    .in('role', roles)
    .is('deleted_at', null)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  // Build owner-name lookup so APC cards can show "Under {TL}".
  const ownerIds = new Set();
  (data || []).forEach((p) => { if (p.reports_to) ownerIds.add(p.reports_to); });
  let ownerById = new Map();
  if (ownerIds.size) {
    const { data: owners, error: e2 } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', Array.from(ownerIds));
    if (e2) throw new Error(e2.message);
    ownerById = new Map((owners || []).map((o) => [o.id, o.display_name]));
  }

  // Brand assignments — single batched query keyed by user_id, joined to
  // brands so the incentive UI can show what brands each team member is
  // running (with tier so the OL can design tier-aware incentives).
  const userIds = (data || []).map((p) => p.id);
  let brandsByUser = new Map();
  if (userIds.length) {
    const { data: links, error: e3 } = await supabase
      .from('brand_assignments')
      .select('user_id, brand:brand_id(id, name, tier, status, notes)')
      .in('user_id', userIds);
    if (e3) throw new Error(e3.message);
    (links || []).forEach((row) => {
      if (!row.brand) return;
      const list = brandsByUser.get(row.user_id) || [];
      list.push({
        id:     row.brand.id,
        name:   row.brand.name,
        tier:   row.brand.tier   || null,
        status: row.brand.status || null,
        notes:  row.brand.notes  || null,
      });
      brandsByUser.set(row.user_id, list);
    });
  }

  return (data || []).map((p) => ({
    id:              p.id,
    displayName:     p.display_name || p.email || '—',
    userName:        p.display_name || p.email || '—',
    userType:        p.role,
    role:            p.role,
    email:           p.email,
    ownerId:         p.reports_to || null,
    ownerName:       p.reports_to ? (ownerById.get(p.reports_to) || '') : '',
    assignedBrands:  brandsByUser.get(p.id) || [],
  }));
}

// Resolve a single user for IncentiveForm's "Edit plan for X" header.
export async function getUserForEditor(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to')
    .eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  let ownerName = '';
  if (data.reports_to) {
    const { data: o } = await supabase
      .from('profiles').select('display_name').eq('id', data.reports_to).maybeSingle();
    ownerName = o?.display_name || '';
  }
  return {
    id:              data.id,
    displayName:     data.display_name || data.email || '—',
    userName:        data.display_name || data.email || '—',
    userType:        data.role,
    role:            data.role,
    email:           data.email,
    ownerId:         data.reports_to || null,
    ownerName,
    assignedBrands:  [],
  };
}

// ── Mutation: write an items-only progress patch (APC / TL / OL editing
// their own progress, or APC EditModal). Server-side guard already
// blocks non-admins from changing verified / payout_cleared / basic_salary.
export async function updateIncentivesProgress({
  rowId, incentives, bonuses,
  /* eslint-disable-next-line no-unused-vars */
  notifyManagerMessage = null, // optional: also fire inc_notify_manager
}) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('incentives')
    .update({
      incentives,
      bonuses,
      last_updated_by: me?.user?.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rowId)
    .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normRow(data);
}

// ── Mutation: full plan upsert (Boss / OL editing the structure).
// Accepts v1 payload shape (basicSalary, incentives, bonuses) and
// converts to snake_case. If `id` is given, updates; otherwise upserts
// on (user_id, month).
export async function savePlan({
  id, userId, month, basicSalary,
  incentives: inc, bonuses: bon,
}) {
  const { data: me } = await supabase.auth.getUser();
  if (id) {
    const { data, error } = await supabase
      .from('incentives')
      .update({
        basic_salary: Number(basicSalary) || 0,
        incentives: inc || [],
        bonuses:    bon || [],
        last_updated_by: me?.user?.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
      .single();
    if (error) throw new Error(error.message);
    return _normRow(data);
  }
  const { data, error } = await supabase
    .from('incentives')
    .upsert({
      user_id: userId,
      month,
      basic_salary: Number(basicSalary) || 0,
      incentives: inc || [],
      bonuses:    bon || [],
      last_updated_by: me?.user?.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,month' })
    .select('*, user:user_id(id, display_name, email, role, reports_to), verifier:verified_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normRow(data);
}

// ── Default plan template (Save / Load Default in IncentiveForm) ─
// v1 stored at templates/incentivesTemplate. v2 uses app_config row
// keyed 'incentives_default_template'. Same shape: { basicSalary,
// incentives[], bonuses[], savedByName, savedAt }.
export async function getIncentivesTemplate() {
  const { data, error } = await supabase
    .from('app_config')
    .select('value, updated_at')
    .eq('key', 'incentives_default_template')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.value) return null;
  return data.value;
}

export async function setIncentivesTemplate({ basicSalary, incentives: inc, bonuses: bon, savedByName }) {
  const value = {
    basicSalary: Number(basicSalary) || 0,
    incentives:  (inc || []).map((i) => ({
      id: i.id, text: i.text, amount: Number(i.amount) || 0,
      targetValue: Number(i.targetValue) || 0,
      suffix: itemSuffix(i),
    })),
    bonuses:     (bon || []).map((b) => ({
      id: b.id, text: b.text, amount: Number(b.amount) || 0,
      targetValue: Number(b.targetValue) || 0,
      suffix: itemSuffix(b),
    })),
    savedByName: savedByName || '',
    savedAt:     new Date().toISOString(),
  };
  const { error } = await supabase
    .from('app_config')
    .upsert({ key: 'incentives_default_template', value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return value;
}
