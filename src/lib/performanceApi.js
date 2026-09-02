import { supabase } from './supabase';
import { applyAttendanceAutofill, applyCommissionAutofill, applyGmvMaxAutofill } from './incentivesApi';

// 5 metrics. Punctuality was dropped (mig 243) — attendance is already its own
// auto-fetched pillar and the incentive items cover it, so rating it here was a
// third count of the same thing. `overall_score` is a generated column averaging
// exactly these keys; keep the two in sync.
export const METRICS = [
  { key: 'dailyTasksQuality', label: 'Daily task quality' },
  { key: 'reporting',         label: 'Reporting' },
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

export const ROLE_LABEL = { apc: 'APC', ipc: 'IPC', tl: 'Team Lead', pctl: 'Paid Collab TL', ol: 'Operation Lead', ads_manager: 'Ads Manager', boss: 'Boss', developer: 'Developer' };

// ── Pure helpers — IDENTICAL to v1's math ──────────────────────
export function getLevel(score) {
  if (score >= 90) return { label: 'Promotion',   color: '#198754', bg: '#e6f4ea', icon: 'bi-trophy-fill' };
  if (score >= 70) return { label: 'Good',         color: '#0d6efd', bg: '#e8f0fe', icon: 'bi-hand-thumbs-up-fill' };
  if (score >= 50) return { label: 'Warning',      color: '#fd7e14', bg: '#fff3e0', icon: 'bi-exclamation-triangle' };
  return              { label: 'Termination',   color: '#dc3545', bg: '#fce4ec', icon: 'bi-x-octagon-fill' };
}

// Same bands as getLevel but with theme-aware CSS tokens, so pills in the modals
// adapt to dark mode. getLevel keeps its v1 literal hex for callers that need it.
export function getLevelTokens(score) {
  if (score >= 90) return { label: 'Promotion',   color: 'var(--success)', bg: 'var(--success-soft)', icon: 'bi-trophy-fill' };
  if (score >= 70) return { label: 'Good',         color: 'var(--info, #0d6efd)', bg: 'color-mix(in srgb, var(--info, #0d6efd) 16%, transparent)', icon: 'bi-hand-thumbs-up-fill' };
  if (score >= 50) return { label: 'Warning',      color: 'var(--warning)', bg: 'var(--warning-soft)', icon: 'bi-exclamation-triangle' };
  return              { label: 'Termination',   color: 'var(--danger)', bg: 'var(--danger-soft)', icon: 'bi-x-octagon-fill' };
}

export function calcMetricsAvg(metrics) {
  if (!metrics) return 0;
  // Sum in integer hundredths (metric values are ≤2dp once weekly rollups exist)
  // to mirror SQL's exact-decimal round(sum/5); plain Math.round(sum/5) can drift
  // 1 point at a .5 boundary and break composite parity vs the AI assistant.
  const sum = V1_METRICS.reduce((a, m) => a + Math.round((Number(metrics[m.key]) || 0) * 100), 0);
  return Math.round(sum / (V1_METRICS.length * 100));
}

// ── APC performance blend (mig 304) — the parity mirror of the SQL APC branch ──
// The OL's weekly slider set dropped 'reporting' (now the per-report TL star), so
// the APC "checkpoint" factor averages these 4 keys. Distinct from V1_METRICS (5),
// which the OLD method + monthly hand-rating still use.
export const CHECKPOINT_METRIC_KEYS = ['dailyTasksQuality', 'overallWorkflow', 'responseTime', 'tasksProcessing'];

// checkpoint factor = integer avg of the 4 keys, mirroring SQL apc_checkpoint_score
// = round(sum/4). Integer-hundredths to avoid the .5-boundary FP drift.
export function calcCheckpointAvg(metrics) {
  if (!metrics) return 0;
  const sum = CHECKPOINT_METRIC_KEYS.reduce((a, k) => a + Math.round((Number(metrics[k]) || 0) * 100), 0);
  return Math.round(sum / (CHECKPOINT_METRIC_KEYS.length * 100));
}

// APC performance pillar = 0.6×checkpoint + 0.4×external-report score, with the
// same null-collapse + clamp as the SQL APC branch of get_performance_composite.
// `checkpoint` is the 4-key avg (0–100 or null); `report` is apc_report_score
// (0–100 or null, i.e. 0.6×stars + 0.4×accountability). Returns null when neither
// factor exists (⇒ "Not Rated").
export function apcPerfPillar(checkpoint, report) {
  const c = checkpoint == null ? null : Number(checkpoint);
  const r = report == null ? null : Number(report);
  let v;
  if (c != null && r != null) v = Math.round(0.6 * c + 0.4 * r);
  else if (c != null) v = Math.round(c);
  else if (r != null) v = Math.round(r);
  else return null;
  return Math.max(0, Math.min(100, v));
}

export function calcIncentiveScore(incRecord) {
  if (!incRecord) return null;
  const items = [...(incRecord.incentives || []), ...(incRecord.bonuses || [])];
  if (items.length === 0) return null;
  const completed = items.filter((i) => i.completed).length;
  return Math.round((completed / items.length) * 100);
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
  // The Boss evaluates everyone. can_eval_perf (mig 213) has always allowed it
  // server-side; this list only ever named 'ol', so the Rate button was hidden
  // on every other role and the Boss appeared to have LESS access than an OL.
  if (viewer === 'boss') return true;
  // An OL evaluates the whole operation, PCTLs and IPCs included. Same story:
  // can_eval_perf grants any active OL evaluation rights over any target, so
  // this was a UI-only gap, not a permissions decision. It was never a
  // regression either — git history shows 'ol' has covered only tl/apc since
  // the v2 baseline commit, so this is a v1 behaviour that was never ported.
  if (viewer === 'ol' && ['tl', 'apc', 'pctl', 'ipc'].includes(target)) return true;
  if (viewer === 'tl' && target === 'apc') return true;
  // PCTL is the IPCs' direct manager (profiles.reports_to), so they
  // rate / flag IPCs the same way a TL rates / flags APCs. A PCTL can also
  // pick up APC direct reports — RLS/can_eval_perf backs pctl->apc for any
  // target whose reports_to = the PCTL, so allow the Rate button too.
  if (viewer === 'pctl' && (target === 'ipc' || target === 'apc')) return true;
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

// ─── Flag removal request flow ─────────────────────────────────────
// OL who created a flag submits a removal request → Boss approves /
// rejects. Boss can also delete flags directly (no request needed).
// Server enforces all permissions via security-definer RPCs.

function _normFlagRemoval(r) {
  if (!r) return r;
  return {
    id:            r.id,
    flagId:        r.flag_id,
    userId:        r.user_id,
    requestedBy:   r.requested_by,
    reason:        r.reason || '',
    status:        r.status || 'pending',
    decidedBy:     r.decided_by,
    decidedAt:     r.decided_at,
    decisionNote:  r.decision_note,
    createdAt:     r.created_at,
    requester:     r.requester || null,
    user:          r.user || null,
    flag:          r.flag || null,
  };
}

export async function requestFlagRemoval(flagId, reason) {
  const { data, error } = await supabase.rpc('flag_removal_request', {
    p_flag_id: flagId,
    p_reason:  reason,
  });
  if (error) throw new Error(error.message);
  return _normFlagRemoval(data);
}

export async function decideFlagRemoval(requestId, action, note = null) {
  const { data, error } = await supabase.rpc('flag_removal_decide', {
    p_request_id: requestId,
    p_action:     action,        // 'approve' | 'reject'
    p_note:       note,
  });
  if (error) throw new Error(error.message);
  return _normFlagRemoval(data);
}

// Boss-only direct removal (skips the request flow).
export async function removeFlagDirect(flagId) {
  const { error } = await supabase.rpc('flag_remove_direct', { p_flag_id: flagId });
  if (error) throw new Error(error.message);
}

// Pending removal requests for any flags the current user is involved
// in (as flag owner, requester, or Boss). RLS filters automatically.
export async function listFlagRemovalRequests({ status = null } = {}) {
  let q = supabase
    .from('flag_removal_requests')
    .select(`
      *,
      requester:requested_by(id, display_name, role),
      user:user_id(id, display_name, role),
      flag:flag_id(id, type, severity, reason, created_at)
    `)
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(_normFlagRemoval);
}

// Just the pending requests for THIS flag (used to show 'pending Boss
// approval' state in the flag list).
export async function getPendingRemovalForFlag(flagId) {
  const { data, error } = await supabase
    .from('flag_removal_requests')
    .select('*, requester:requested_by(id, display_name)')
    .eq('flag_id', flagId)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return _normFlagRemoval(data);
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
//
// The attendance auto-fill (mig 235) is a READ-TIME overlay: an item flagged
// { source: 'attendance' } keeps achievedValue 0 / completed false in the DB by
// design, and gets its real value computed on every read. The Incentives page
// applies it (via getIncentives / listIncentivesMonth); this function did not —
// so the Performance page's Bonus & Incentives pillar counted an auto-filled
// item as INCOMPLETE and scored people below what Incentives showed (and paid
// out on) for the same month. Apply the same overlay here so the two pages can
// never disagree. No-op and no extra network call when no item uses the toggle.
export async function listAllIncentivesForMonth(month) {
  const { data, error } = await supabase
    .from('incentives')
    .select('*')
    .eq('month', month);
  if (error) throw new Error(error.message);
  const rows = (data || []).map((r) => ({
    ...r,
    userId:     r.user_id,
    apcId:      r.user_id, // v1 used apcId for APC rows; same source
    incentives: r.incentives || [],
    bonuses:    r.bonuses || [],
  }));
  // Commission lines need the same treatment for the same reason: their
  // `completed` is derived and therefore false at rest, so without the overlay
  // this pillar would count an earned commission as an unmet item.
  //
  // gmv_max MUST be overlaid since mig 339. Until then it derived no `completed`
  // at all, so skipping it here genuinely made no difference — that is what the
  // comment this replaces said, and it was true when it was written. Mig 339 made
  // SQL perf_incentives_score derive gmv_max completion; leaving this side alone
  // made the JS composite on the Performance page read LOWER than the SQL score
  // for the same person — exactly the contract-C3 disagreement the old comment
  // was guarding against.
  //
  // ol_brands is still NOT overlaid: it has the same latent defect, but SQL
  // perf_incentives_score also still reads its stored value, so the two agree.
  // Fixing that one moves live OL scores and belongs in its own change.
  return applyCommissionAutofill(
    await applyGmvMaxAutofill(await applyAttendanceAutofill(rows, month), month),
    month,
  );
}

// ── Attendance ────────────────────────────────────────────────
// Re-exported here for the Performance page — saves a separate import
// path. The coverage %/breakdown is computed in SQL (mig 252), not JS;
// fetchRosterMonth / getAdjustmentsForMonth remain for the raw rows the
// Roster needs (hours, calendar, adjustment Remove buttons).
export {
  fetchRosterMonth,
  getAdjustmentsForMonth,
  fetchAttendanceBreakdown,
  fetchAttendanceBreakdownBulk,
  ATTENDANCE_BREAKDOWN_ZERO,
} from './attendanceApi';

