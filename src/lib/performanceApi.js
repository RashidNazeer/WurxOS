import { supabase } from './supabase';

export const METRICS = [
  { key: 'dailyTasksQuality', label: 'Daily task quality' },
  { key: 'reporting',         label: 'Reporting' },
  { key: 'punctuality',       label: 'Punctuality' },
  { key: 'overallWorkflow',   label: 'Overall workflow' },
  { key: 'responseTime',      label: 'Response time' },
  { key: 'tasksProcessing',   label: 'Tasks processing' },
];

export const LEVEL_META = {
  promotion:   { label: 'Promotion',   color: 'var(--success)' },
  good:        { label: 'Good',        color: 'var(--info, #0d6efd)' },
  warning:     { label: 'Warning',     color: 'var(--warning, #fd7e14)' },
  termination: { label: 'Termination', color: 'var(--danger)' },
  not_rated:   { label: 'Not rated',   color: 'var(--text-muted)' },
};

export const PILLARS = [
  { key: 'performance_score', label: 'Performance',    weightKey: 'weight_performance' },
  { key: 'incentives_score',  label: 'Bonus & Incentives', weightKey: 'weight_incentives' },
  { key: 'attendance_score',  label: 'Attendance',     weightKey: 'weight_attendance' },
  { key: 'flags_score',       label: 'Monthly Flags',  weightKey: 'weight_flags' },
];

export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export async function getMyRating(uid, month = currentMonth()) {
  const { data, error } = await supabase
    .from('performance_ratings').select('*, evaluator:evaluated_by(display_name)')
    .eq('user_id', uid).eq('month', month).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function listRatingsForMonth(month = currentMonth()) {
  const { data, error } = await supabase
    .from('performance_ratings')
    .select('*, user:user_id(id, display_name, role), evaluator:evaluated_by(display_name)')
    .eq('month', month).order('overall_score', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function upsertRating(userId, month, metrics) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('performance_ratings').upsert({
    user_id: userId, month, metrics, evaluated_by: me?.user?.id, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,month' }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listFlags(userId, { month } = {}) {
  let q = supabase
    .from('performance_flags').select('*, creator:created_by(display_name)')
    .eq('user_id', userId).order('created_at', { ascending: false });
  if (month) {
    const start = `${month}-01`;
    const next = new Date(`${month}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    q = q.gte('created_at', start).lt('created_at', next.toISOString().slice(0, 10));
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addFlag(userId, { type, severity, reason }) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase.from('performance_flags').insert({
    user_id: userId, type, severity, reason, created_by: me?.user?.id,
  });
  if (error) throw new Error(error.message);
}

export async function deleteFlag(id) {
  const { error } = await supabase.from('performance_flags').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function listWarnings(userId) {
  const { data, error } = await supabase
    .from('performance_warnings').select('*, creator:created_by(display_name)')
    .eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addWarning(userId, { reason, severity }) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase.from('performance_warnings').insert({
    user_id: userId, reason, severity, created_by: me?.user?.id,
  });
  if (error) throw new Error(error.message);
}

// --- Composite & config ---
export async function getCompositeFor(userId, month = currentMonth()) {
  const { data, error } = await supabase.rpc('get_performance_composite', {
    p_user: userId, p_month: month,
  });
  if (error) throw new Error(error.message);
  return (data && data[0]) || null;
}

export async function getOverview(month = currentMonth()) {
  const { data, error } = await supabase.rpc('get_performance_overview', { p_month: month });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getConfig() {
  const { data, error } = await supabase
    .from('performance_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateConfig(cfg) {
  const { data, error } = await supabase.rpc('update_performance_config', {
    p_weight_performance:  Number(cfg.weight_performance),
    p_weight_incentives:   Number(cfg.weight_incentives),
    p_weight_attendance:   Number(cfg.weight_attendance),
    p_weight_flags:        Number(cfg.weight_flags),
    p_min_attendance_days: Number(cfg.min_attendance_days),
    p_threshold_promotion: Number(cfg.threshold_promotion),
    p_threshold_good:      Number(cfg.threshold_good),
    p_threshold_warning:   Number(cfg.threshold_warning),
    p_flag_pts_low:        Number(cfg.flag_pts_low),
    p_flag_pts_medium:     Number(cfg.flag_pts_medium),
    p_flag_pts_high:       Number(cfg.flag_pts_high),
    p_flag_pts_critical:   Number(cfg.flag_pts_critical),
  });
  if (error) throw new Error(error.message);
  return data;
}

// ============================================================
// v1 PARITY LAYER
// ------------------------------------------------------------
// The exports below mirror v1's PerformancePage.js contract so
// the verbatim-ported page can read/write without translation.
// All math is client-side (matches v1) — the server-side
// get_performance_composite RPC is NOT called from the page.
// ============================================================

// v1 metric / pillar / level / weightage definitions (verbatim).
export const V1_METRICS = [
  { key: 'dailyTasksQuality', label: 'Daily Tasks Quality',  icon: 'bi-check2-all' },
  { key: 'reporting',         label: 'Reporting',             icon: 'bi-file-earmark-text' },
  { key: 'punctuality',       label: 'Punctuality',           icon: 'bi-clock' },
  { key: 'overallWorkflow',   label: 'Overall Workflow',      icon: 'bi-diagram-3' },
  { key: 'responseTime',      label: 'Response Time',         icon: 'bi-chat-dots' },
  { key: 'tasksProcessing',   label: 'Tasks Processing',      icon: 'bi-list-task' },
];

export const V1_PILLARS = [
  { key: 'performance', label: 'Performance Tracking', icon: 'bi-bar-chart-fill', color: '#0d6efd' },
  { key: 'incentives',  label: 'Bonus & Incentives',   icon: 'bi-award-fill',     color: '#198754' },
  { key: 'attendance',  label: 'Attendance',            icon: 'bi-calendar-check', color: '#fd7e14' },
  { key: 'flags',       label: 'Monthly Flags',         icon: 'bi-flag-fill',      color: '#7b1fa2' },
];

export const V1_DEFAULT_WEIGHTS = { performance: 40, incentives: 25, attendance: 20, flags: 15 };

export const V1_WEIGHTAGES = [
  { key: 'low',      label: 'Low',      color: '#6c757d', bg: '#f3f4f6', pts: 3 },
  { key: 'medium',   label: 'Medium',   color: '#fd7e14', bg: '#fff3e0', pts: 5 },
  { key: 'high',     label: 'High',     color: '#dc3545', bg: '#fce4ec', pts: 8 },
  { key: 'critical', label: 'Critical', color: '#7b1fa2', bg: '#f3e5f5', pts: 12 },
];

export const ROLE_LABEL = { apc: 'APC', ipc: 'IPC', tl: 'Team Lead', pctl: 'Paid Collab TL', ol: 'Operation Lead', boss: 'Boss', developer: 'Developer' };

// ── Pure helpers — IDENTICAL to v1's math ──────────────────────
export function getLevel(score) {
  if (score >= 90) return { label: 'Promotion',   color: '#198754', bg: '#e6f4ea', icon: 'bi-trophy-fill' };
  if (score >= 70) return { label: 'Good',         color: '#0d6efd', bg: '#e8f0fe', icon: 'bi-hand-thumbs-up-fill' };
  if (score >= 50) return { label: 'Warning',      color: '#fd7e14', bg: '#fff3e0', icon: 'bi-exclamation-triangle' };
  return              { label: 'Termination',   color: '#dc3545', bg: '#fce4ec', icon: 'bi-x-octagon-fill' };
}

export function calcMetricsAvg(metrics) {
  if (!metrics) return 0;
  const vals = V1_METRICS.map((m) => Number(metrics[m.key]) || 0);
  return Math.round(vals.reduce((a, b) => a + b, 0) / V1_METRICS.length);
}

export function calcIncentiveScore(incRecord) {
  if (!incRecord) return null;
  const items = [...(incRecord.incentives || []), ...(incRecord.bonuses || [])];
  if (items.length === 0) return null;
  const completed = items.filter((i) => i.completed).length;
  return Math.round((completed / items.length) * 100);
}

export function calcAttendanceScore(coveredDays, workingDays) {
  if (!workingDays || workingDays <= 0) return 100;
  return Math.min(100, Math.round((coveredDays / workingDays) * 100));
}

export function workingDaysInMonth(monthStr) {
  if (!monthStr) return 0;
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  let n = 0;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

// Flag scoring (verbatim from v1): base 80 · +10 per green · −20 per red.
// Severity (low/medium/high/critical) is a label only and does NOT affect
// the score — it's there for at-a-glance triage.
const FLAG_BASE_SCORE  = 80;
const FLAG_GREEN_DELTA = 10;
const FLAG_RED_DELTA   = -20;

export function calcFlagsScore(flags, month) {
  const monthFlags = (flags || []).filter((f) => {
    const created = f.createdAt ?? f.created_at;
    if (!created) return false;
    const d = created.toDate ? created.toDate() : new Date(created);
    const fm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return fm === month;
  });
  let score = FLAG_BASE_SCORE;
  monthFlags.forEach((f) => {
    score += f.type === 'green' ? FLAG_GREEN_DELTA : FLAG_RED_DELTA;
  });
  return Math.max(0, Math.min(100, score));
}

export function calcComposite(pillarScores, weights) {
  let totalWeight = 0, weightedSum = 0;
  V1_PILLARS.forEach((p) => {
    const s = pillarScores[p.key];
    const w = weights[p.key] || 0;
    if (s !== null && s !== undefined) { weightedSum += s * w; totalWeight += w; }
  });
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

export function canRate(viewer, target) {
  if (viewer === 'boss' && target === 'ol') return true;
  if (viewer === 'ol' && (target === 'tl' || target === 'apc')) return true;
  if (viewer === 'tl' && target === 'apc') return true;
  return false;
}

// ── Row normalisers — bring snake_case Postgres rows into v1 shape ───
// v1 markup reads: id, userId, userName, userRole, type, weightage,
// description, addedBy, addedByName, createdAt (with .toDate()).
function _normFlag(r) {
  if (!r) return r;
  return {
    ...r,
    id:          r.id,
    userId:      r.user_id,
    userName:    r.user?.display_name || r.user_name || '',
    userRole:    r.user?.role || r.user_role || '',
    type:        r.type,
    weightage:   r.severity || r.weightage || 'low',
    description: r.reason ?? r.description ?? '',
    addedBy:     r.created_by,
    addedByName: r.creator?.display_name || r.added_by_name || '',
    createdAt:   r.created_at,
  };
}

function _normWarning(r) {
  if (!r) return r;
  return {
    ...r,
    id:           r.id,
    userId:       r.user_id,
    userName:     r.user?.display_name || r.user_name || '',
    userRole:     r.user?.role || r.user_role || '',
    reason:       r.reason || '',
    issuedBy:     r.created_by,
    issuedByName: r.creator?.display_name || r.issued_by_name || '',
    createdAt:    r.created_at,
  };
}

function _normRating(r) {
  if (!r) return r;
  return {
    ...r,
    id:               r.id,
    userId:           r.user_id,
    userName:         r.user?.display_name || r.user_name || '',
    userRole:         r.user?.role || r.user_role || '',
    month:            r.month,
    metrics:          r.metrics || {},
    overallScore:    r.overall_score,
    evaluatedBy:      r.evaluated_by,
    evaluatedByName:  r.evaluator?.display_name || r.evaluated_by_name || '',
    updatedAt:        r.updated_at,
    createdAt:        r.created_at,
  };
}

// ── Bulk loaders the v1 Team tab uses ──────────────────────────
// Returns rows already normalised so the page reads them as v1.
export async function listAllRatingsForMonth(month) {
  const { data, error } = await supabase
    .from('performance_ratings')
    .select('*, user:user_id(display_name, role), evaluator:evaluated_by(display_name)')
    .eq('month', month);
  if (error) throw new Error(error.message);
  return (data || []).map(_normRating);
}

export async function listAllFlags() {
  const { data, error } = await supabase
    .from('performance_flags')
    .select('*, user:user_id(display_name, role), creator:created_by(display_name)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normFlag);
}

export async function listAllWarnings() {
  const { data, error } = await supabase
    .from('performance_warnings')
    .select('*, user:user_id(display_name, role), creator:created_by(display_name)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normWarning);
}

// Per-user flag list (still normalised).
export async function listFlagsForUser(userId) {
  const { data, error } = await supabase
    .from('performance_flags')
    .select('*, user:user_id(display_name, role), creator:created_by(display_name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normFlag);
}

// Per-user warnings count (used by My tab).
export async function countWarningsForUser(userId) {
  const { count, error } = await supabase
    .from('performance_warnings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return count || 0;
}

// One rating row for (user, month).
export async function getRatingFor(userId, month) {
  const { data, error } = await supabase
    .from('performance_ratings')
    .select('*, user:user_id(display_name, role), evaluator:evaluated_by(display_name)')
    .eq('user_id', userId).eq('month', month).maybeSingle();
  if (error) throw new Error(error.message);
  return _normRating(data);
}

// Save a rating in v1 shape.
export async function saveRating({ userId, userName, userRole, month, metrics }) {
  const { data: me } = await supabase.auth.getUser();
  // overall_score is a generated column, so we don't write it.
  const payload = {
    user_id:      userId,
    month,
    metrics,
    evaluated_by: me?.user?.id,
    updated_at:   new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('performance_ratings')
    .upsert(payload, { onConflict: 'user_id,month' })
    .select('*, user:user_id(display_name, role), evaluator:evaluated_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normRating(data);
}

// Add a flag (v1 shape: type/weightage/description).
export async function saveFlag({ userId, type, weightage, description }) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('performance_flags')
    .insert({
      user_id:    userId,
      type,                          // 'green' | 'red'
      severity:   weightage || 'low', // schema column name
      reason:     description || '',
      created_by: me?.user?.id,
    })
    .select('*, user:user_id(display_name, role), creator:created_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normFlag(data);
}

// Add a warning (v1 schema: reason only).
export async function saveWarning({ userId, reason }) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('performance_warnings')
    .insert({
      user_id:    userId,
      reason:     reason || '',
      severity:   'medium',
      created_by: me?.user?.id,
    })
    .select('*, user:user_id(display_name, role), creator:created_by(display_name)')
    .single();
  if (error) throw new Error(error.message);
  return _normWarning(data);
}

// Boss config: pillar weights. v2 stores per-pillar columns; v1's
// UI uses a {performance, incentives, attendance, flags} object.
// Converts both ways.
export async function getV1Weights() {
  const { data, error } = await supabase
    .from('performance_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ...V1_DEFAULT_WEIGHTS };
  return {
    performance: Number(data.weight_performance) || V1_DEFAULT_WEIGHTS.performance,
    incentives:  Number(data.weight_incentives)  || V1_DEFAULT_WEIGHTS.incentives,
    attendance:  Number(data.weight_attendance)  || V1_DEFAULT_WEIGHTS.attendance,
    flags:       Number(data.weight_flags)       || V1_DEFAULT_WEIGHTS.flags,
  };
}

export async function saveV1Weights(weights) {
  // Need the rest of the config row's required fields to call the RPC.
  const { data: cur, error: e1 } = await supabase
    .from('performance_config').select('*').eq('id', 1).maybeSingle();
  if (e1) throw new Error(e1.message);
  const cfg = cur || {};
  const { error } = await supabase.rpc('update_performance_config', {
    p_weight_performance:  Number(weights.performance) || 0,
    p_weight_incentives:   Number(weights.incentives)  || 0,
    p_weight_attendance:   Number(weights.attendance)  || 0,
    p_weight_flags:        Number(weights.flags)       || 0,
    p_min_attendance_days: Number(cfg.min_attendance_days || 22),
    p_threshold_promotion: Number(cfg.threshold_promotion || 90),
    p_threshold_good:      Number(cfg.threshold_good      || 70),
    p_threshold_warning:   Number(cfg.threshold_warning   || 50),
    p_flag_pts_low:        Number(cfg.flag_pts_low      || 3),
    p_flag_pts_medium:     Number(cfg.flag_pts_medium   || 5),
    p_flag_pts_high:       Number(cfg.flag_pts_high     || 8),
    p_flag_pts_critical:   Number(cfg.flag_pts_critical || 12),
  });
  if (error) throw new Error(error.message);
  return weights;
}

// ── User loaders the Team tab needs ───────────────────────────
// Boss → all OLs + all TLs/PCTLs + all APCs/IPCs
// OL   → all TLs/PCTLs + all APCs/IPCs
// TL   → APCs reporting to me
// PCTL → IPCs reporting to me (treated identically by the page)
// Returns rows shaped as v1 expects (with `_tab` flag for the
// active sub-tab and v1 fields displayName/userName/userType).
export async function listEvaluableUsers({ uid, viewerRole }) {
  let q = supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to')
    .is('deleted_at', null)
    .eq('is_active', true);
  if (viewerRole === 'boss' || viewerRole === 'developer') {
    q = q.in('role', ['ol', 'tl', 'pctl', 'apc', 'ipc']);
  } else if (viewerRole === 'ol') {
    q = q.in('role', ['tl', 'pctl', 'apc', 'ipc']);
  } else if (viewerRole === 'tl' || viewerRole === 'pctl') {
    q = q.in('role', ['apc', 'ipc']).eq('reports_to', uid);
  } else {
    return [];
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id:           p.id,
    displayName:  p.display_name || p.email || '—',
    userName:     p.display_name || p.email || '—',
    userType:     p.role,
    role:         p.role,
    email:        p.email,
    reportsTo:    p.reports_to,
    _tab:         (p.role === 'ol') ? 'ols'
                 : (p.role === 'tl' || p.role === 'pctl') ? 'tls'
                 : 'apcs',
  }));
}

// Bulk fetch: incentives rows for a month — v2 has a single
// `incentives` table; we hand v1's UI the same shape it expects
// (record.incentives[], record.bonuses[]).
export async function listAllIncentivesForMonth(month) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*')
    .eq('month', month);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({
    ...r,
    userId:     r.user_id,
    apcId:      r.user_id, // v1 used apcId for APC rows; same source
    incentives: r.incentives || [],
    bonuses:    r.bonuses || [],
  }));
}

// ── Attendance bulk fetch (already used by RosterTab) ─────────
// Re-exported here for the Performance Team tab — saves a separate
// import path. The attendance API already filters WFH from leaves
// and exposes computeMonthlyDays().
export {
  fetchRosterMonth,
  computeMonthlyDays,
  getAdjustmentsForMonth,
} from './attendanceApi';

