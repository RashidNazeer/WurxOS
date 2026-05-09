/**
 * v1 verbatim-port shim for `reportHighlights`. v1 forms call:
 *   setReportHighlight('weeklyReports', reportId, fieldKey, html)
 *   getReportHighlight(report, fieldKey)
 *
 * v2 stores highlights inside `reports.data.highlights[fieldKey]` regardless
 * of report type — there's only one `reports` table. The first arg
 * (collection name) is ignored on v2; we keep it in the signature so
 * v1 markup compiles unmodified.
 *
 * `getReportHighlight` checks BOTH `report.highlights` (a v1-shape doc OR
 * a v2 row that's been through `_normReport` — which spreads data.* onto
 * the top level) AND `report.data.highlights` (a raw v2 row). This lets
 * the same helper work for ported v1 markup and any v2-native caller.
 */

import { setReportHighlight as setHl } from '../lib/reportHighlightsApi';

export async function setReportHighlight(_reportCollection, reportId, fieldKey, html) {
  void _reportCollection; // ignored — v2 has a single reports table
  return setHl(reportId, fieldKey, html);
}

export function getReportHighlight(report, fieldKey) {
  if (!report || !fieldKey) return null;
  const top = report.highlights;
  const inData = report.data?.highlights;
  const h = (top && typeof top === 'object') ? top
          : (inData && typeof inData === 'object') ? inData
          : null;
  if (!h) return null;
  const v = h[fieldKey];
  return (typeof v === 'string' && v.length > 0) ? v : null;
}
