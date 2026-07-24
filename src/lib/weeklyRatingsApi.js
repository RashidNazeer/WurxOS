// ============================================================
// Weekly APC performance ratings (mig 269).
//
// The OL rates an APC's 5 performance metrics each week, right after the APC
// presents in the agenda meeting. One row per (apc, meeting). The month's
// performance pillar = the AVERAGE of that month's weekly rows, rolled up in SQL
// into the existing monthly performance_ratings row (so the composite formula is
// untouched). See [[weekly-apc-performance]].
// ============================================================
import { supabase } from './supabase';

// The 5 scored metrics — MUST match performanceApi METRICS + the generated
// overall_score columns on performance_ratings AND weekly_performance_ratings.
export const WEEKLY_METRIC_KEYS = [
  'dailyTasksQuality', 'reporting', 'overallWorkflow', 'responseTime', 'tasksProcessing',
];

const SELECT =
  'id, apc_id, meeting_id, week_start, month, metrics, overall_score, rated_by, updated_at,' +
  ' rater:rated_by(id, display_name)';

// Average of a metrics object over the 5 keys (0 for missing) → rounded int,
// identical to the composite's calcMetricsAvg so the preview matches the score.
// Sum in integer hundredths (metrics are ≤2dp) to mirror SQL's exact-decimal
// round(sum/5) — plain FP Math.round(sum/5) can drift 1 point at a .5 boundary.
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
// DB trigger from the meeting, so callers pass only the scores.
export async function saveWeeklyRating(apcId, meetingId, metrics) {
  const { data: auth } = await supabase.auth.getUser();
  const clean = {};
  for (const k of WEEKLY_METRIC_KEYS) clean[k] = Number(metrics?.[k]) || 0;
  // reportingOl = the OL's 0–90 slider for the split reporting metric (mig 274).
  // The DB trigger folds metrics.reporting = reportingOl + the two return chunks;
  // we keep the slider so the panel can reload it.
  if (metrics?.reportingOl != null) {
    clean.reportingOl = Math.min(90, Math.max(0, Number(metrics.reportingOl) || 0));
  }
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
