// ============================================================
// Weekly APC performance ratings (mig 269; restructured mig 304).
//
// The OL rates an APC's CHECKPOINT metrics each week, right after the APC
// presents in the agenda meeting. One row per (apc, meeting). The month's
// average of these rows = the APC's "checkpoint" factor = 0.6 of the APC
// performance pillar (the other 0.4 is the per-report external-report score;
// see mig 304). The "reporting" slider + the ±5 return chunks (mig 274) were
// RETIRED — external reporting is now the TL's per-report star. See
// [[weekly-apc-performance]] / [[tl-performance-method]].
// ============================================================
import { supabase } from './supabase';

// The 4 CHECKPOINT metrics the OL rates weekly. 'reporting' was dropped (mig 304);
// external reporting is scored per-report via the TL star. The monthly rollup +
// apc_checkpoint_score average exactly these 4 keys.
export const WEEKLY_METRIC_KEYS = [
  'dailyTasksQuality', 'overallWorkflow', 'responseTime', 'tasksProcessing',
];

const SELECT =
  'id, apc_id, meeting_id, week_start, month, metrics, overall_score, rated_by, updated_at,' +
  ' rater:rated_by(id, display_name)';

// Average of a metrics object over the 4 checkpoint keys (0 for missing) →
// rounded int, identical to SQL apc_checkpoint_score so the preview matches the
// score. Sum in integer hundredths (metrics are ≤2dp) to mirror SQL's exact
// round(sum/4) — plain FP Math.round(sum/4) can drift 1 point at a .5 boundary.
export function weeklyOverall(metrics) {
  if (!metrics) return 0;
  const sum = WEEKLY_METRIC_KEYS.reduce((a, k) => a + Math.round((Number(metrics[k]) || 0) * 100), 0);
  return Math.round(sum / (WEEKLY_METRIC_KEYS.length * 100));
}

// Per-metric average across a set of weekly rows → the monthly metrics object
// (mirrors the SQL rollup, so the client preview equals what "go live" writes).
export function averageWeeklyMetrics(rows) {
  if (!rows || !rows.length) return null;
  const out = {};
  for (const k of WEEKLY_METRIC_KEYS) {
    const sum = rows.reduce((a, r) => a + (Number(r.metrics?.[k]) || 0), 0);
    out[k] = Math.round((sum / rows.length) * 100) / 100; // 2dp, like the SQL rollup
  }
  return out;
}

// All weekly ratings for one meeting (the OL panel shows who's already rated).
export async function listWeeklyRatingsForMeeting(meetingId) {
  if (!meetingId) return [];
  const { data, error } = await supabase
    .from('weekly_performance_ratings').select(SELECT).eq('meeting_id', meetingId);
  if (error) throw new Error(error.message);
  return data || [];
}

// One APC's rating for one meeting, or null.
export async function getWeeklyRating(apcId, meetingId) {
  if (!apcId || !meetingId) return null;
  const { data, error } = await supabase
    .from('weekly_performance_ratings').select(SELECT)
    .eq('apc_id', apcId).eq('meeting_id', meetingId).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

// Upsert an APC's weekly rating for a meeting. week_start/month are filled by a
// DB trigger from the meeting, so callers pass only the 4 checkpoint scores.
export async function saveWeeklyRating(apcId, meetingId, metrics) {
  const { data: auth } = await supabase.auth.getUser();
  const clean = {};
  for (const k of WEEKLY_METRIC_KEYS) clean[k] = Number(metrics?.[k]) || 0;
  const { data, error } = await supabase
    .from('weekly_performance_ratings')
    .upsert(
      { apc_id: apcId, meeting_id: meetingId, metrics: clean, rated_by: auth?.user?.id || null, updated_at: new Date().toISOString() },
      { onConflict: 'apc_id,meeting_id' },
    )
    .select(SELECT).single();
  if (error) throw new Error(error.message);
  return data;
}

// The weekly rows that make up one APC's month (for the breakdown + preview).
export async function listWeeklyRatingsForApcMonth(apcId, month) {
  if (!apcId || !month) return [];
  const { data, error } = await supabase
    .from('weekly_performance_ratings').select(SELECT)
    .eq('apc_id', apcId).eq('month', month)
    .order('week_start', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// All weekly rows for a month (RLS-scoped to what the viewer may see) — the team
// tab groups these by apc_id.
export async function listWeeklyRatingsForMonth(month) {
  if (!month) return [];
  const { data, error } = await supabase
    .from('weekly_performance_ratings').select(SELECT)
    .eq('month', month)
    .order('week_start', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// The meetings an APC actually PARTICIPATED in (has an agenda_presentations row
// — presented, or marked present at finish) held in a given month. Keyed off
// participation (not the current reports_to) so a transferred-in APC is never
// shown / nagged for their new team's pre-transfer meetings. Oldest first.
export async function listApcMeetingsForMonth(apcId, month) {
  if (!apcId || !month) return [];
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)); // first of next month
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const { data, error } = await supabase
    .from('agenda_presentations')
    .select('meeting:meeting_id(id, week_start, meeting_date, status)')
    .eq('apc_id', apcId);
  if (error) throw new Error(error.message);
  return (data || [])
    .map((r) => r.meeting)
    .filter((mt) => mt && mt.meeting_date >= start && mt.meeting_date < end)
    .sort((a, b) => (a.meeting_date < b.meeting_date ? -1 : 1));
}

// OL/boss: APC+meeting pairs from meetings ≥2 days old with no rating yet.
export async function listPendingApcRatings(month = null) {
  const { data, error } = await supabase.rpc('list_pending_apc_ratings', { p_month: month });
  if (error) throw new Error(error.message);
  return data || [];
}

// Bulk external-report reporting for every APC the caller manages (mig 304) →
// { apcId: {reports_n, deductions, star_score, accountability, report_score} }.
// The page combines report_score with a JS checkpoint avg into the APC blend.
export async function listApcReporting(month) {
  const { data, error } = await supabase.rpc('list_apc_reporting', { p_month: month });
  if (error) throw new Error(error.message);
  const map = {};
  for (const r of data || []) {
    map[r.apc_id] = {
      reports_n: r.reports_n,
      deductions: Number(r.deductions),
      star_score: r.star_score == null ? null : Number(r.star_score),
      accountability: r.accountability == null ? null : Number(r.accountability),
      report_score: r.report_score == null ? null : Number(r.report_score),
    };
  }
  return map;
}

// The APC blend components for one APC (breakdown modal + self-view preview).
export async function apcPerfPreview(apcId, month) {
  const { data, error } = await supabase.rpc('apc_perf_preview', { p_apc: apcId, p_month: month });
  if (error) throw new Error(error.message);
  const r = data?.[0];
  if (!r) return null;
  return {
    checkpoint: r.checkpoint_score == null ? null : Number(r.checkpoint_score),
    report: r.report_score == null ? null : Number(r.report_score),
    n: r.reports_n,
    deductions: Number(r.deductions),
    blended: r.blended == null ? null : Number(r.blended),
    starAvg: r.star_avg == null ? null : Number(r.star_avg),
    starScore: r.star_score == null ? null : Number(r.star_score),
    accountability: r.accountability == null ? null : Number(r.accountability),
  };
}

// The trial switch (read).
export async function getWeeklyRatingsEnabled() {
  const { data, error } = await supabase
    .from('performance_config').select('weekly_apc_ratings_enabled, weekly_apc_ratings_since').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return {
    enabled: !!data?.weekly_apc_ratings_enabled,
    since: data?.weekly_apc_ratings_since || null,
  };
}

// Boss-only: flip trial ⇄ live (turning ON backfills existing weekly rows).
export async function setWeeklyRatingsEnabled(enabled) {
  const { data, error } = await supabase.rpc('set_weekly_apc_ratings_enabled', { p_enabled: !!enabled });
  if (error) throw new Error(error.message);
  return !!data;
}
