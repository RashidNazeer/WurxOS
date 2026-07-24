// ============================================================
// Team-Lead performance method (migs 271/272).
//
// A TL's performance pillar = 0.6 × team score (avg of his APCs' composites)
// + 0.4 × reporting score ((reports verified − deductions) ÷ reports × 100).
// Computed on-read in SQL (get_performance_composite) when the Boss switch is
// ON; the page mirrors the blend in JS. See [[tl-performance-method]].
// ============================================================
import { supabase } from './supabase';

// The Boss trial switch (+ launch floor).
export async function getTlPerfEnabled() {
  const { data, error } = await supabase
    .from('performance_config').select('tl_perf_method_enabled, tl_perf_since').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return { enabled: !!data?.tl_perf_method_enabled, since: data?.tl_perf_since || null };
}
export async function setTlPerfEnabled(enabled) {
  const { data, error } = await supabase.rpc('set_tl_perf_method_enabled', { p_enabled: !!enabled });
  if (error) throw new Error(error.message);
  return !!data;
}

// Bulk reporting scores for every TL (boss/ol) → { tlId: {reports_n, deductions, reporting_score} }.
export async function listTlReporting(month) {
  const { data, error } = await supabase.rpc('list_tl_reporting', { p_month: month });
  if (error) throw new Error(error.message);
  const map = {};
  for (const r of data || []) {
    map[r.tl_id] = {
      reports_n: r.reports_n,
      deductions: Number(r.deductions),
      reporting_score: r.reporting_score == null ? null : Number(r.reporting_score),
    };
  }
  return map;
}

// The blend components for one TL (breakdown modal + self-view preview).
export async function tlPerfPreview(tlId, month) {
  const { data, error } = await supabase.rpc('tl_perf_preview', { p_tl: tlId, p_month: month });
  if (error) throw new Error(error.message);
  const r = data?.[0];
  if (!r) return null;
  return {
    team: r.team_score == null ? null : Number(r.team_score),
    reporting: r.reporting_score == null ? null : Number(r.reporting_score),
    n: r.reports_n,
    deductions: Number(r.deductions),
    blended: r.blended == null ? null : Number(r.blended),
  };
}

// The deduction rows behind a TL's reporting score, with report context.
export async function listTlDeductions(tlId, month) {
  const { data, error } = await supabase
    .from('tl_reporting_deductions')
    .select('id, report_id, amount, note, created_at, decider:decided_by(display_name), report:report_id(period_label, type, brand:brand_id(brand_name))')
    .eq('tl_id', tlId).eq('month', month)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function tlReportDeduct(reportId, amount, note = null) {
  const { error } = await supabase.rpc('tl_report_deduct', { p_report_id: reportId, p_amount: amount, p_note: note });
  if (error) throw new Error(error.message);
}
export async function tlReportDeductRemove(id) {
  const { error } = await supabase.rpc('tl_report_deduct_remove', { p_id: id });
  if (error) throw new Error(error.message);
}

// Called right after an OL returns a report to the TL: asks how many reporting
// marks to dock (default 1, 0/cancel = none) and records it against the TL.
export async function deductPrompt(reportId) {
  // eslint-disable-next-line no-alert
  const raw = window.prompt('Reporting deduction for the Team Lead (marks to dock; 0 = none):', '1');
  if (raw === null) return;                 // cancelled → no deduction
  const amt = Number(raw);
  if (!Number.isFinite(amt) || amt <= 0) return;
  await tlReportDeduct(reportId, amt);
}
