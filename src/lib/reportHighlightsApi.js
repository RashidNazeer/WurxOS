/**
 * Per-report user-highlights persistence.
 *
 * Highlights are stored on the report row inside data.highlights[fieldKey]
 * (jsonb). Different from v1's top-level `highlights` field — in v2 we
 * tuck them into the existing data jsonb so no schema migration is needed.
 *
 * Unlike v1 (which used Firestore dot-path updates), Postgres jsonb edits
 * need a read-modify-write. We do the merge client-side and save the
 * whole `data` blob; the report rows are small (a few KB at most).
 */

import { supabase } from './supabase';

export async function setReportHighlight(reportId, fieldKey, html) {
  if (!reportId || !fieldKey) return;
  // Read current data
  const { data: cur, error: rdErr } = await supabase
    .from('reports').select('data').eq('id', reportId).maybeSingle();
  if (rdErr) throw new Error(rdErr.message);
  const data = cur?.data || {};
  const highlights = data.highlights || {};
  highlights[fieldKey] = html == null ? '' : String(html);
  const newData = { ...data, highlights };
  const { error: wrErr } = await supabase
    .from('reports').update({ data: newData }).eq('id', reportId);
  if (wrErr) throw new Error(wrErr.message);
}

export function getReportHighlight(report, fieldKey) {
  if (!report || !fieldKey) return null;
  const h = report?.data?.highlights;
  if (!h || typeof h !== 'object') return null;
  const v = h[fieldKey];
  return (typeof v === 'string' && v.length > 0) ? v : null;
}
