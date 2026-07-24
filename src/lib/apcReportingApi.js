// ============================================================
// APC reporting-metric split (mig 274).
//
// The APC "reporting" metric = OL slider (0–90) + weekly-report return chunk
// (0–5) + checkpoint return chunk (0–5). The chunks fall as the TL docks the
// APC's returned reports/checkpoints. See [[weekly-apc-performance]].
// ============================================================
import { supabase } from './supabase';

// The two return chunks for an APC as reviewed in a meeting.
export async function apcReturnChunks(apcId, meetingId) {
  if (!apcId || !meetingId) return { report_score: 5, report_deducted: 0, checkpoint_score: 5, checkpoint_deducted: 0 };
  const { data, error } = await supabase.rpc('apc_return_chunks', { p_apc: apcId, p_meeting: meetingId });
  if (error) throw new Error(error.message);
  const r = data?.[0];
  return {
    report_score: r ? Number(r.report_score) : 5,
    report_deducted: r ? Number(r.report_deducted) : 0,
    checkpoint_score: r ? Number(r.checkpoint_score) : 5,
    checkpoint_deducted: r ? Number(r.checkpoint_deducted) : 0,
  };
}

export async function apcReportDeduct(kind, sourceId, amount, note = null) {
  const { error } = await supabase.rpc('apc_report_deduct', { p_kind: kind, p_source_id: sourceId, p_amount: amount });
  if (error) throw new Error(error.message);
}

// Prompt shown to the TL right after they send an APC's report/checkpoint back:
// how many reporting marks to dock (default 1, 0/cancel = none).
async function _deductPrompt(kind, sourceId) {
  // eslint-disable-next-line no-alert
  const raw = window.prompt('Deduct reporting marks from the APC for this return? (default 1; 0 = none):', '1');
  if (raw === null) return;
  const amt = Number(raw);
  if (!Number.isFinite(amt) || amt <= 0) return;
  await apcReportDeduct(kind, sourceId, amt);
}
export const deductPromptApcReport = (reportId) => _deductPrompt('report', reportId);
export const deductPromptApcCheckpoint = (checkpointId) => _deductPrompt('checkpoint', checkpointId);
