// ============================================================
// salariesApi.js — Salary Management data layer
//
// Wraps the migration-185 tables and RPCs:
//   • employee_compensation     (current salary per user)
//   • salary_history            (append-only audit trail)
//   • anniversary_celebrations  (tracks last anniversary banner shown)
//
// All writes go through SECURITY DEFINER RPCs (Boss-only enforced
// server-side). Reads are RLS-gated to: self, Boss, OL.
//
// Naming convention mirrors src/lib/incentivesApi.js — camelCase
// at the API boundary, snake_case in the DB.
// ============================================================

import { supabase } from './supabase';

// ── Reads ─────────────────────────────────────────────────────

// One user's current compensation row, or null if not yet seeded.
export async function getCompensationFor(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('employee_compensation')
    .select('user_id, basic_salary, effective_from, last_change_reason, last_changed_by, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normaliseComp(data) : null;
}

// Bulk fetch — used by the Boss "Active Salaries" tab.
// RLS scopes the result: Boss/OL see every row; everyone else sees
// only their own.
export async function listAllCompensation() {
  const { data, error } = await supabase
    .from('employee_compensation')
    .select(`
      user_id, basic_salary, effective_from, last_change_reason,
      last_changed_by, updated_at,
      user:user_id(id, display_name, email, role, start_date, is_active, deleted_at, avatar_url)
    `);
  if (error) throw new Error(error.message);
  return (data || []).map(normaliseComp);
}

// Salary-change history for one user — newest first.
export async function getHistoryFor(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('salary_history')
    .select(`
      id, user_id, effective_from, previous_amount, new_amount,
      increment_pct, change_reason, boss_notes, changed_by, created_at,
      changed_by_user:changed_by(display_name, role)
    `)
    .eq('user_id', userId)
    .order('effective_from', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(normaliseHistory);
}

// Cross-employee history feed — for the Salary History tab.
export async function listAllHistory({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('salary_history')
    .select(`
      id, user_id, effective_from, previous_amount, new_amount,
      increment_pct, change_reason, boss_notes, changed_by, created_at,
      user:user_id(display_name, role),
      changed_by_user:changed_by(display_name, role)
    `)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(normaliseHistory);
}

// Self-read: am I owed an anniversary banner? Returns the year to
// celebrate (1, 2, …) or null if there's nothing to show.
export async function pendingAnniversaryFor(userId, hireStartDate) {
  if (!userId || !hireStartDate) return null;
  const today = new Date();
  const hire  = new Date(hireStartDate + 'T00:00:00');
  if (Number.isNaN(hire.getTime())) return null;

  // years completed = full years where today >= anniversary of this year
  let years = today.getFullYear() - hire.getFullYear();
  const passedThisYear =
    today.getMonth() > hire.getMonth() ||
    (today.getMonth() === hire.getMonth() && today.getDate() >= hire.getDate());
  if (!passedThisYear) years -= 1;
  if (years < 1) return null;

  const { data, error } = await supabase
    .from('anniversary_celebrations')
    .select('last_year_shown')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const lastShown = data?.last_year_shown ?? 0;
  return years > lastShown ? years : null;
}

// ── Writes (Boss-only at the RPC layer) ───────────────────────

export async function setUserHireDate(userId, hireDate) {
  const { error } = await supabase.rpc('set_user_hire_date', {
    p_uid: userId,
    p_hire_date: hireDate,
  });
  if (error) throw new Error(error.message);
}

// changeReason: 'annual_increment' | 'promotion' | 'adjustment' | 'correction' | 'initial_seed'
export async function setUserSalary(userId, {
  newAmount,
  changeReason,
  incrementPct = null,
  bossNotes = null,
  effectiveFrom = null,
}) {
  const { data, error } = await supabase.rpc('set_user_salary', {
    p_uid: userId,
    p_new_amount: newAmount,
    p_change_reason: changeReason,
    p_increment_pct: incrementPct,
    p_boss_notes: bossNotes,
    p_effective_from: effectiveFrom,
  });
  if (error) throw new Error(error.message);
  return data;  // history row id
}

// Self-call: dismiss the anniversary banner.
export async function markAnniversarySeen(year) {
  const { error } = await supabase.rpc('mark_anniversary_seen', { p_year: year });
  if (error) throw new Error(error.message);
}

// ── Helpers ───────────────────────────────────────────────────

function normaliseComp(row) {
  if (!row) return row;
  const u = row.user || {};
  return {
    userId:        row.user_id,
    basicSalary:   Number(row.basic_salary ?? 0),
    effectiveFrom: row.effective_from,
    lastChangeReason: row.last_change_reason,
    lastChangedBy: row.last_changed_by,
    updatedAt:     row.updated_at,
    user: row.user_id ? {
      id:          u.id || row.user_id,
      displayName: u.display_name || u.email || '—',
      email:       u.email || '',
      role:        u.role || '',
      startDate:   u.start_date || null,
      isActive:    !!u.is_active,
      deletedAt:   u.deleted_at,
      avatarUrl:   u.avatar_url || null,
    } : null,
  };
}

function normaliseHistory(row) {
  return {
    id:              row.id,
    userId:          row.user_id,
    effectiveFrom:   row.effective_from,
    previousAmount:  row.previous_amount == null ? null : Number(row.previous_amount),
    newAmount:       Number(row.new_amount),
    incrementPct:    row.increment_pct == null ? null : Number(row.increment_pct),
    changeReason:    row.change_reason,
    bossNotes:       row.boss_notes,
    changedBy:       row.changed_by,
    createdAt:       row.created_at,
    user:            row.user ? {
      displayName: row.user.display_name || '—',
      role:        row.user.role || '',
    } : null,
    changedByUser:   row.changed_by_user ? {
      displayName: row.changed_by_user.display_name || '—',
      role:        row.changed_by_user.role || '',
    } : null,
  };
}

// Convenience: format a PKR amount the way the app does everywhere
// (no decimals, thousands separators, "PKR" prefix). Mirror this in
// any UI that displays salary so the format stays consistent.
export function formatPKR(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  return 'PKR ' + Number(amount).toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

// Years completed since a YYYY-MM-DD hire date, anchored to today.
// Returns 0 if hire is in the future or null.
export function yearsCompletedSince(hireStartDate, now = new Date()) {
  if (!hireStartDate) return 0;
  const hire = new Date(hireStartDate + 'T00:00:00');
  if (Number.isNaN(hire.getTime()) || hire > now) return 0;
  let years = now.getFullYear() - hire.getFullYear();
  const passed =
    now.getMonth() > hire.getMonth() ||
    (now.getMonth() === hire.getMonth() && now.getDate() >= hire.getDate());
  if (!passed) years -= 1;
  return Math.max(0, years);
}
