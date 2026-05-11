import { supabase } from './supabase';

// --------------------------------------------------------------
// Data shape — matches v1
// --------------------------------------------------------------
// reports.data jsonb:
//   overallPerformance: { gmv, affiliateGmv, orders, samplesApproved, roi,
//                         shopPerformanceScore, videosPosted }
//   overallNotes:       { samplesApproved, videosPosted }
//   overallInsights:    string
//   topCreators:        [{ name, videosPosted, itemsSold, gmv, notes }]
//   topCreatorsInsights: string
//   topVideos:          [{ creatorName, itemsSold, gmv, views, productClicks, notes }]
//   topVideosInsights:  string
//   gmvMax:             [{ campaign, spend, roi, orders, cpo, gmv, notes }]
//   gmvMaxInsights:     string
//   productHighlights:  [{ productId, productName, unitsSold, gmv, newVideos, notes }]
//   productHighlightsInsights: string
//   offsitePerformance: { offsiteGmv, tiktokShopGmv, offsiteEffect }
//   offsiteInsights:    string
//   upcomingCampaigns:  string
//   operationalUpdates: string
//   recommendations:    string   (merged recommendations + actionItems section)
//   customFields:       { [fieldId]: { name, value } }

export const EMPTY_REPORT_DATA = () => ({
  // ISO-4217-ish code applied to every monetary field in this report.
  // 10 supported codes live in src/utils/currencies.js. Reports saved
  // before this feature have no `currency` and render as USD.
  currency: 'USD',
  overallPerformance: { gmv: '', affiliateGmv: '', orders: '', samplesApproved: '', roi: '', shopPerformanceScore: '', videosPosted: '' },
  overallNotes: { samplesApproved: '', videosPosted: '' },
  overallInsights: '',
  topCreators: [emptyCreator()],
  topCreatorsInsights: '',
  topVideos: [emptyVideo()],
  topVideosInsights: '',
  gmvMax: [emptyGmvMax()],
  gmvMaxInsights: '',
  productHighlights: [emptyProduct()],
  productHighlightsInsights: '',
  offsitePerformance: { offsiteGmv: '', tiktokShopGmv: '', offsiteEffect: '' },
  offsiteInsights: '',
  upcomingCampaigns: '',
  operationalUpdates: '',
  recommendations: '',
  // v1 keeps Action Items separate from Recommendations so APCs can list
  // concrete next steps below the narrative. Optional / free-form.
  actionItems: '',
  customFields: {},
});

export const emptyCreator = () => ({ name: '', videosPosted: '', itemsSold: '', gmv: '', notes: '' });
export const emptyVideo   = () => ({ creatorName: '', videoLink: '', itemsSold: '', gmv: '', views: '', productClicks: '', notes: '' });
export const emptyGmvMax  = () => ({ campaign: '', spend: '', roi: '', orders: '', cpo: '', gmv: '', notes: '' });
export const emptyProduct = () => ({ productId: '', productName: '', unitsSold: '', gmv: '', newVideos: '' , notes: '' });

// --------------------------------------------------------------
// Period computation
// --------------------------------------------------------------
const MS_PER_DAY = 86400000;

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}
function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function rangeLabel(start, end) {
  const s = `${MONTH_SHORT[start.getMonth()]} ${start.getDate()}`;
  const e = start.getMonth() === end.getMonth()
    ? `${end.getDate()}`
    : `${MONTH_SHORT[end.getMonth()]} ${end.getDate()}`;
  return `${s} - ${e}`;
}

// Weekly: given anchor (YYYY-MM-DD) compute week N (1-based) as 7-day block
export function makeWeekFromStart(startDate, weekNum = 1) {
  const start = startDate instanceof Date ? startDate : parseDate(startDate);
  const end = addDays(start, 6);
  return {
    week: weekNum,
    year: start.getFullYear(),
    month: start.getMonth(),
    startDate: fmtDate(start),
    endDate:   fmtDate(end),
    label: `Week ${weekNum} (${rangeLabel(start, end)})`,
  };
}

// Get all weeks whose startDate falls in the given year/month, anchored from anchorStr.
export function getWeeksForMonth(year, month, anchorStr) {
  if (!anchorStr) {
    // Fallback: calendar-based weeks (day 1–7, 8–14, 15–21, 22–28, 29–end)
    const weeks = [];
    for (let i = 0; i < 5; i++) {
      const startDay = 1 + i * 7;
      const start = new Date(year, month, startDay);
      if (start.getMonth() !== month) break;
      const end = addDays(start, 6);
      weeks.push({ week: i + 1, year, month, startDate: fmtDate(start), endDate: fmtDate(end), label: `Week ${i + 1} (${rangeLabel(start, end)})` });
    }
    return weeks;
  }
  const anchor = parseDate(anchorStr);
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  // Find the week number for first >= firstOfMonth
  const diffDays = Math.round((firstOfMonth - anchor) / MS_PER_DAY);
  const startWeekIdx = Math.max(0, Math.floor(diffDays / 7));
  const out = [];
  for (let i = startWeekIdx; i < startWeekIdx + 8; i++) {
    const start = addDays(anchor, i * 7);
    if (start > lastOfMonth) break;
    if (start < firstOfMonth && !out.length) continue;
    if (start.getMonth() !== month && start > firstOfMonth) break;
    out.push(makeWeekFromStart(start, i + 1));
  }
  return out;
}

export function detectNextWeek(existing, anchorStr) {
  // Caller may pass `anchorStr` (the brand's first-week start) to seed the
  // chain, OR omit it when prior reports already exist — we'll derive the
  // chain head from the latest report's start date in that case. Returns
  // null only when neither is available (truly first-time, no anchor set).
  //
  // `existing` items come back from getReportsForBrand() in the v1 shape
  // produced by _normReport(): {weekStart, weekEnd, week, ...} — NOT v2
  // column names. Read both `weekStart` (v1-shape, normalized) and
  // `period_start` (raw v2 row) to be safe across callers.
  let lastStart = anchorStr ? parseDate(anchorStr) : null;
  let lastNum = 0;
  let weeklyCount = 0;
  (existing || []).forEach((r) => {
    // Skip non-weekly only when the type field is present (v1 doc shape
    // doesn't carry `type`; v2 raw rows do).
    if (r.type && r.type !== 'weekly') return;
    const startStr = r.weekStart || r.period_start;
    const s = parseDate(startStr);
    if (!s) return;
    weeklyCount++;
    if (!lastStart || s >= lastStart) {
      lastStart = s;
      lastNum = Math.max(lastNum, r.week || r.period_number || 0);
    }
  });
  if (!lastStart) return null;
  const next = addDays(lastStart, weeklyCount > 0 ? 7 : 0);
  return makeWeekFromStart(next, (lastNum || 0) + 1);
}

// Bi-weekly: 14-day blocks from brand anchor
export function getBiWeeklyPeriodsFromAnchor(anchorStr, count = 30) {
  if (!anchorStr) return [];
  const anchor = parseDate(anchorStr);
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = addDays(anchor, i * 14);
    const end = addDays(start, 13);
    out.push({
      period: i + 1,
      year: start.getFullYear(),
      month: start.getMonth(),
      startDate: fmtDate(start),
      endDate: fmtDate(end),
      label: `Period ${i + 1} (${rangeLabel(start, end)})`,
    });
  }
  return out;
}

export function detectNextBiWeeklyPeriod(existing, anchorStr) {
  // Mirror of the weekly fix (c1dac39 / 66542d1). Callers may pass
  // `anchorStr` (the brand's first-period start) to seed the chain,
  // OR omit it when prior reports already exist — we'll derive the
  // chain head from the latest report's start date in that case.
  //
  // `existing` items come back from getBiWeeklyReportsForBrand() in
  // the v1 shape produced by _normReport(): {periodStart, periodEnd,
  // period, ...} — NOT v2 column names. Read both `periodStart` (v1-
  // shape, normalized) and `period_start` (raw v2 row) to be safe.
  //
  // Returns null only when neither an anchor nor any prior report is
  // available (truly first-time, no anchor set, no reports yet).
  const reports = (existing || []).filter((r) => !r.type || r.type === 'biweekly');
  const lastStart = reports
    .map((r) => r.periodStart || r.period_start)
    .filter(Boolean)
    .sort()
    .pop();

  // Derive the anchor: prefer the explicit one, otherwise back-compute
  // from the latest report so the period chain stays aligned to the
  // brand's existing 14-day grid.
  const effectiveAnchor = anchorStr || lastStart;
  if (!effectiveAnchor) return null;

  const all = getBiWeeklyPeriodsFromAnchor(effectiveAnchor, 60);
  if (!lastStart) return all[0];
  const idx = all.findIndex((p) => p.startDate === lastStart);
  return idx >= 0 ? all[idx + 1] || null : all[0];
}

// --------------------------------------------------------------
// Status helpers
// --------------------------------------------------------------
export const STATUS_LABEL = {
  draft: 'Draft', submitted: 'Submitted', verified: 'Verified', approved: 'Approved',
};
export const STATUS_COLOR = {
  draft:     { bg: 'var(--surface-3)',   fg: 'var(--text-muted)' },
  submitted: { bg: 'var(--info-soft)',   fg: 'var(--info)' },
  verified:  { bg: 'var(--warning-soft)',fg: 'var(--warning)' },
  approved:  { bg: 'var(--success-soft)',fg: 'var(--success)' },
};

// Default to 'draft' when there's no row yet — the caller is creating
// a new report and should be able to edit it. The earlier default of
// 'approved' silently locked the form as read-only before the first save.
export function getReportStatus(r) { return r?.status || 'draft'; }

// What the current user can do on this report given their role.
export function reportPermissions({ report, role, uid, brandOwnerId }) {
  const status = getReportStatus(report);
  // For a brand-new report (no row yet) the current user is by definition the
  // author — they're about to create it. Without this, non-admin authors
  // (APC/TL) see the form locked as read-only until the first save.
  const isAuthor       = !report || report.author_id === uid;
  const isBrandOwner   = brandOwnerId === uid || report?.brand?.owner_id === uid;
  const isOL           = role === 'ol' || role === 'developer';
  const isBoss         = role === 'boss';
  const isAdmin        = isBoss || isOL;

  // Reject (return-to-author) splits by reviewer:
  //   * TL (the brand owner) can only return-to-APC while the report
  //     is at the TL stage (status: submitted). Once they've verified
  //     it, ownership has moved on to OL — TL no longer owns it. To
  //     send a verified report back to APC, OL must first return-to-TL
  //     (verified → submitted), then TL can return-to-APC.
  //   * OL / Boss / Developer can reject at both 'submitted' and
  //     'verified' — they have authority over the whole chain.
  const canTlReject    = isBrandOwner && !isAdmin && status === 'submitted';
  const canAdminReject = isAdmin && (status === 'submitted' || status === 'verified');

  return {
    canEditContent: (status === 'draft' && (isAuthor || isAdmin)),
    canSubmit:      (status === 'draft' && (isAuthor || isAdmin)),
    canVerify:      (status === 'submitted' && (isBrandOwner || isAdmin)),
    canApprove:     (status === 'verified' && isAdmin),
    canReject:      canTlReject || canAdminReject,
    canReopen:      status === 'approved' && isAdmin,
    // Boss/OL can change a report's period dates without going through
    // the approval flow. Useful for fixing legacy/mislabeled reports.
    canEditDates:   isAdmin,
  };
}

// --------------------------------------------------------------
// Reads
// --------------------------------------------------------------
export async function listReports({ type, brandId, year, month, status } = {}) {
  let q = supabase
    .from('reports')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url, owner_id),
      author:author_id(id, display_name, email)
    `)
    .order('period_start', { ascending: false });
  if (type)    q = q.eq('type', type);
  if (brandId) q = q.eq('brand_id', brandId);
  if (status)  q = q.eq('status', status);
  if (year != null)  q = q.eq('period_year', year);
  if (month != null) q = q.eq('period_month', month);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Duplicate guard — find an existing non-draft report for the same
// brand + type + week. Used by the form to surface a clear error
// banner before save/submit instead of silently overwriting via the
// upsert (`brand_id,type,period_start` conflict target).
// --------------------------------------------------------------
// --------------------------------------------------------------
// Boss / Developer maintenance — recompute every weekly report's
// period_number + period_label using each brand's earliest report
// as the anchor. Fixes anchor drift / duplicate labels.
// --------------------------------------------------------------
export async function repairWeekLabels({ brandId = null } = {}) {
  const { data, error } = await supabase.rpc('repair_week_labels', {
    p_brand_id: brandId,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return row || { brands_processed: 0, reports_relabelled: 0 };
}

export async function findDuplicateReport({ brandId, type, periodStart, excludeId = null }) {
  if (!brandId || !type || !periodStart) return null;
  let q = supabase
    .from('reports')
    .select(`id, status, period_label, period_start, author:author_id(display_name)`)
    .eq('brand_id', brandId)
    .eq('type', type)
    .eq('period_start', periodStart)
    .neq('status', 'draft')
    .limit(1);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export async function getReport(id) {
  const { data, error } = await supabase
    .from('reports')
    .select(`*, brand:brand_id(id, brand_name, logo_url, owner_id), author:author_id(id, display_name, email)`)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Fetch a brand's recent reports for trend charts + previous-week deltas.
// Limit the window so the chart stays readable (last N reports, ascending).
export async function listReportsForBrandTrend(brandId, type, { limit = 8 } = {}) {
  // Order by period_start (the canonical date for the reporting window),
  // tie-break with created_at. Previously this ordered by created_at
  // alone, which broke the moment OL/Boss edited a report's dates: a
  // report whose period_start was rewritten to an older week kept its
  // original (newer) created_at and surfaced as the "previous" report
  // even when an actual older report sat in between. period_start is
  // what the chart axis and the "compared to last week" hint use to
  // line reports up; ordering by it keeps the previous-period pick
  // consistent with what the user sees.
  const { data, error } = await supabase
    .from('reports')
    .select('id, period_label, period_start, period_end, data, status, type, created_at')
    .eq('brand_id', brandId)
    .eq('type', type)
    .in('status', ['approved', 'verified', 'submitted'])
    .order('period_start', { ascending: false })
    .order('created_at',   { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).reverse(); // oldest → newest for charts
}

// --------------------------------------------------------------
// Writes — create / save draft / submit / verify / approve / reject / reopen
// --------------------------------------------------------------
export async function upsertDraft({ id, brandId, authorId, type, period, data }) {
  // Build the row WITHOUT an id key when creating. Postgres's
  // `default gen_random_uuid()` only fires when the column is absent
  // or unspecified — sending `id: null` trips the NOT NULL constraint.
  const row = {
    brand_id: brandId,
    author_id: authorId,
    type,
    period_number: period.week || period.period,
    period_start:  period.startDate,
    period_end:    period.endDate,
    period_year:   period.year,
    period_month:  period.month,
    period_label:  period.label,
    status: 'draft',
    data,
  };
  if (id) row.id = id;
  if (id) {
    const { data: saved, error } = await supabase.from('reports').update({
      data,
      period_number: row.period_number,
      period_start:  row.period_start,
      period_end:    row.period_end,
      period_year:   row.period_year,
      period_month:  row.period_month,
      period_label:  row.period_label,
    }).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return saved;
  } else {
    // No id: try insert; if conflict (same brand/type/period_start), update that row to draft with new data
    const { data: saved, error } = await supabase
      .from('reports')
      .upsert(row, { onConflict: 'brand_id,type,period_start' })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return saved;
  }
}

export async function submitReport(id, data) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  // Only write `data` when the caller passed a value. The OL acting-as-APC
  // flow calls submitReport(id, null) to mean "leave the current data
  // untouched, just flip the status" — and `data` is NOT NULL on the
  // reports table, so writing null would 23502 the row out.
  const patch = {
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    submitted_by: me,
    rejection_note: null,  // clear previous rejection note on resubmit
  };
  if (data != null) patch.data = data;

  const { data: saved, error } = await supabase
    .from('reports')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return saved;
}

export async function verifyReport(id) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data: saved, error } = await supabase
    .from('reports')
    .update({
      status: 'verified',
      verified_at: new Date().toISOString(),
      verified_by: me,
    })
    .eq('id', id)
    .select().single();
  if (error) throw new Error(error.message);
  return saved;
}

export async function approveReport(id) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data: saved, error } = await supabase
    .from('reports')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: me,
    })
    .eq('id', id)
    .select().single();
  if (error) throw new Error(error.message);
  return saved;
}

// Reject drops the status back one stage (verified → submitted, submitted → draft)
// OR to an explicit target for reopen flows.
export async function rejectReport(id, { note, toStatus }) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data: current, error: cErr } = await supabase.from('reports').select('status').eq('id', id).maybeSingle();
  if (cErr) throw new Error(cErr.message);
  const next = toStatus || (current?.status === 'verified' ? 'submitted' : 'draft');
  const { data: saved, error } = await supabase
    .from('reports')
    .update({
      status: next,
      rejection_note: note || null,
      rejected_at: new Date().toISOString(),
      rejected_by: me,
    })
    .eq('id', id)
    .select().single();
  if (error) throw new Error(error.message);
  return saved;
}

// Reopen (OL on approved): target = 'draft' | 'submitted' | 'verified'
// - 'draft'     → back to APC with note
// - 'submitted' → back to TL with note
// - 'verified'  → keep at verified (OL self-edit), no note required
export async function reopenReport(id, { target = 'verified', note }) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const patch = {
    status: target,
    reopened_at: new Date().toISOString(),
    reopened_by: me,
    rejection_note: target === 'verified' ? null : (note || null),
  };
  const { data: saved, error } = await supabase
    .from('reports').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return saved;
}

// --------------------------------------------------------------
// OL/Boss edit-the-dates — change a report's period without touching
// any sibling reports. Just an UPDATE in v2 (Postgres uses the row's
// uuid id; no document-rewrite cascade needed like Firestore).
//
// Recomputes period_year, period_month, and period_label from the new
// start date so the existing list/sort logic keeps working.
// --------------------------------------------------------------
export async function editReportDates(id, { startDate, endDate }) {
  if (!startDate || !endDate) throw new Error('Pick both a start and end date.');
  if (endDate < startDate)    throw new Error('End date must be on or after start date.');
  const d = new Date(startDate);
  const periodLabel = `${new Date(startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const { data: saved, error } = await supabase
    .from('reports')
    .update({
      period_start: startDate,
      period_end:   endDate,
      period_year:  d.getFullYear(),
      period_month: d.getMonth(),
      period_label: periodLabel,
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return saved;
}

// Find sibling reports for the same brand + type (excluding the
// caller's own report id) — used by the date-edit modal to flag
// overlapping ranges as a non-blocking warning.
export async function listSiblingReports({ brandId, type, excludeId }) {
  if (!brandId || !type) return [];
  let q = supabase
    .from('reports')
    .select('id, period_start, period_end, period_label, author_id, author:author_id(display_name)')
    .eq('brand_id', brandId)
    .eq('type', type);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Bi-weekly anchors
// --------------------------------------------------------------
export async function getBiWeeklyAnchor(brandId) {
  const { data, error } = await supabase
    .from('bi_weekly_anchors')
    .select('*')
    .eq('brand_id', brandId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function setBiWeeklyAnchor(brandId, anchorStart) {
  const { data: auth } = await supabase.auth.getUser();
  const me = auth?.user?.id;
  const { data, error } = await supabase
    .from('bi_weekly_anchors')
    .upsert({ brand_id: brandId, anchor_start: anchorStart, set_by: me, set_at: new Date().toISOString() })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Custom fields templates (per user)
// --------------------------------------------------------------
export async function listUserCustomFields(userId) {
  const { data, error } = await supabase
    .from('user_report_custom_fields')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addCustomField(userId, fieldName) {
  // Compute next sort_order
  const existing = await listUserCustomFields(userId);
  const nextOrder = existing.length ? Math.max(...existing.map((f) => f.sort_order)) + 1 : 0;
  const { data, error } = await supabase
    .from('user_report_custom_fields')
    .insert({ user_id: userId, field_name: fieldName.trim(), sort_order: nextOrder })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function renameCustomField(id, fieldName) {
  const { data, error } = await supabase
    .from('user_report_custom_fields')
    .update({ field_name: fieldName.trim() })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteCustomField(id) {
  const { error } = await supabase.from('user_report_custom_fields').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Brand pickers
// --------------------------------------------------------------
// =====================================================================
// v1-compat layer — mirror v1's three reporting services
// (reportingService, biWeeklyReportingService, monthlyReportingService)
// so the verbatim-ported v1 components can call this API without touching
// the JSX. All additions are strictly additive; v2-native callers above
// continue to work unchanged.
//
// v1 Firestore docs vs. v2 Postgres rows:
//
//   weeklyReports/{brandId_YYYY-MM-DD}
//   biWeeklyReports/{brandId_bw_YYYY-MM-DD}
//   monthlyReports/{brandId_m_YYYY-MM}
//   ────────────────────────────────────  (all merged into v2's reports table
//   reports.type='weekly'|'biweekly'|'monthly' (mig 012 + mig 129)
//
// v1 doc fields → v2 columns:
//   brandId            → brand_id
//   weekStart/periodStart  → period_start
//   weekEnd/periodEnd      → period_end
//   weekLabel/periodLabel  → period_label
//   week/period            → period_number
//   year                   → period_year
//   month (0-11)           → period_month
//   monthKey ('YYYY-MM')   → derived from period_year/period_month
//   sectionsEnabled (monthly) → sections_enabled (mig 129)
//   {whole content blob}   → data (jsonb)
//   status                 → status
//   createdBy/Name         → author_id (+ joined profile.display_name)
//   submittedBy/Name etc.  → submitted_by (+ joined profile.display_name)
//   lastEditedBy/Name      → last_edited_by (+ joined display_name) (mig 121)
//
// =====================================================================

// ---------------------------------------------------------------------
// Firestore Timestamp shim — v1 components call .toDate() / .seconds
// on createdAt fields all over the place.
// ---------------------------------------------------------------------
function _fsTsReport(value) {
  if (!value) return null;
  if (typeof value === 'object' && (value.toDate || typeof value.seconds === 'number')) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return {
    toDate: () => d,
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    valueOf: () => d.getTime(),
  };
}

// ---------------------------------------------------------------------
// _normRow — Postgres reports row → v1 doc shape
//
// Caller may pass joined profiles for `author:author_id(...)`,
// `submitter:submitted_by(...)`, `verifier:verified_by(...)`, etc.;
// any missing join falls back to the plain UID with empty display name.
// ---------------------------------------------------------------------
const _MONTH_NAMES_LONG = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

function _monthKeyFrom(y, m) {
  if (y == null || m == null) return null;
  return `${y}-${String((m | 0) + 1).padStart(2, '0')}`;
}

export function _normReport(row) {
  if (!row) return row;
  const data = row.data || {};
  const isMonthly = row.type === 'monthly';
  const isBiWeekly = row.type === 'biweekly';
  const periodNum = row.period_number || (isMonthly ? null : 1);

  const base = {
    id: row.id,
    type: row.type,
    brandId: row.brand_id,
    brandName: row.brand?.brand_name || data.brandName || '',
    status: row.status || 'approved',
    sectionsEnabled: row.sections_enabled || data.sectionsEnabled || null,

    // Audit (v1-style camelCase)
    createdBy:        row.author_id || null,
    createdByName:    row.author?.display_name || data.createdByName || '',
    createdAt:        _fsTsReport(row.created_at),
    updatedAt:        _fsTsReport(row.updated_at),

    submittedBy:      row.submitted_by || null,
    submittedByName:  row.submitter?.display_name || data.submittedByName || '',
    submittedAt:      _fsTsReport(row.submitted_at),

    verifiedBy:       row.verified_by || null,
    verifiedByName:   row.verifier?.display_name || data.verifiedByName || '',
    verifiedAt:       _fsTsReport(row.verified_at),

    approvedBy:       row.approved_by || null,
    approvedByName:   row.approver?.display_name || data.approvedByName || '',
    approvedAt:       _fsTsReport(row.approved_at),

    rejectedBy:       row.rejected_by || null,
    rejectedByName:   row.rejecter?.display_name || data.rejectedByName || '',
    rejectedAt:       _fsTsReport(row.rejected_at),
    rejectionNote:    row.rejection_note || data.rejectionNote || '',

    reopenedBy:       row.reopened_by || null,
    reopenedByName:   row.reopener?.display_name || data.reopenedByName || '',
    reopenedAt:       _fsTsReport(row.reopened_at),

    lastEditedBy:     row.last_edited_by || row.author_id || null,
    lastEditedByName: row.last_editor?.display_name || data.lastEditedByName || '',

    // Spread all v1 content fields back onto the doc so v1 markup like
    // `report.overallPerformance.gmv` works without unwrapping `.data`.
    ...data,
  };

  if (isMonthly) {
    return {
      ...base,
      year:     row.period_year,
      month:    row.period_month,
      monthKey: _monthKeyFrom(row.period_year, row.period_month),
      label:    row.period_label || (row.period_year != null && row.period_month != null
                  ? `${_MONTH_NAMES_LONG[row.period_month]} ${row.period_year}`
                  : ''),
    };
  }

  if (isBiWeekly) {
    return {
      ...base,
      period:      periodNum,
      year:        row.period_year,
      month:       row.period_month,
      periodStart: row.period_start,
      periodEnd:   row.period_end,
      periodLabel: row.period_label || '',
    };
  }

  // Weekly (default)
  return {
    ...base,
    week:      periodNum,
    year:      row.period_year,
    month:     row.period_month,
    weekStart: row.period_start,
    weekEnd:   row.period_end,
    weekLabel: row.period_label || '',
  };
}

// ---------------------------------------------------------------------
// First-time-reporter helpers (v1 hardcoded a 20-week menu starting
// 2026-03-29 so brand-new APCs have something to pick from).
// ---------------------------------------------------------------------
export function getFirstTimeWeekOptions() {
  const ANCHOR = new Date(2026, 2, 29); // 2 = March (0-indexed)
  const out = [];
  for (let i = 0; i < 20; i++) {
    const ws = new Date(ANCHOR);
    ws.setDate(ws.getDate() + i * 7);
    out.push(makeWeekFromStart(ws, i + 1));
  }
  return out;
}

export function getAnchorDate(reports) {
  if (!reports || !reports.length) return null;
  const sorted = [...reports].sort((a, b) =>
    (a.weekStart || a.period_start || '').localeCompare(b.weekStart || b.period_start || ''));
  return sorted[0].weekStart || sorted[0].period_start || null;
}

// ---------------------------------------------------------------------
// Weekly: buildWeekInfoFromRange — v1's date-edit modal needs to build
// a weekInfo from arbitrary start+end (not necessarily a 7-day block).
// ---------------------------------------------------------------------
export function buildWeekInfoFromRange(startStr, endStr, weekNum = 1) {
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  return {
    week:      weekNum,
    year:      start.getFullYear(),
    month:     start.getMonth(),
    startDate: startStr,
    endDate:   endStr,
    label:     `Week ${weekNum} (${rangeLabel(start, end)})`,
  };
}

// ---------------------------------------------------------------------
// BiWeekly helper: buildPeriodInfoFromRange (mirrors weekly version)
// ---------------------------------------------------------------------
export function buildPeriodInfoFromRange(startStr, endStr, periodNum = 1) {
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  return {
    period:    periodNum,
    year:      start.getFullYear(),
    month:     start.getMonth(),
    startDate: startStr,
    endDate:   endStr,
    label:     `Period ${periodNum} (${rangeLabel(start, end)})`,
  };
}

// ---------------------------------------------------------------------
// Monthly: makeMonthInfo, detectNextMonth, getFirstTimeMonthOptions
// ---------------------------------------------------------------------
function _monthLastDay(y, m) {
  return new Date(y, m + 1, 0).getDate();
}
export function makeMonthInfo(year, monthIndex) {
  return {
    year,
    month: monthIndex,
    monthKey: _monthKeyFrom(year, monthIndex),
    label: `${_MONTH_NAMES_LONG[monthIndex]} ${year}`,
    startDate: `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`,
    endDate:   `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(_monthLastDay(year, monthIndex)).padStart(2, '0')}`,
  };
}

export function buildMonthInfo(year, monthIndex) { return makeMonthInfo(year, monthIndex); }

export function detectNextMonth(reports) {
  if (!reports || !reports.length) return null;
  const sorted = [...reports].sort((a, b) => (a.monthKey || '').localeCompare(b.monthKey || ''));
  const last = sorted[sorted.length - 1];
  let nextYear = last.year;
  let nextMonth = (last.month ?? 0) + 1;
  if (nextMonth > 11) { nextYear += 1; nextMonth = 0; }
  return makeMonthInfo(nextYear, nextMonth);
}

export function getFirstTimeMonthOptions() {
  const now = new Date();
  const opts = [];
  for (let offset = -12; offset <= 2; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    opts.push(makeMonthInfo(d.getFullYear(), d.getMonth()));
  }
  return opts.reverse(); // newest first
}

// ---------------------------------------------------------------------
// MONTHLY_SECTIONS + sections-enabled helpers (mirrors v1 exactly)
// ---------------------------------------------------------------------
export const MONTHLY_SECTIONS = [
  { key: 'totalSales',          title: 'Total Sales' },
  { key: 'keyMetrics',          title: 'Key Metrics' },
  { key: 'kpis',                title: "KPI's" },
  { key: 'gmvBreakdown',        title: 'GMV Breakdown' },
  { key: 'topCreators',         title: 'Top Creators' },
  { key: 'topVideos',           title: 'Top Videos' },
  { key: 'videoPerformance',    title: 'Video Performance' },
  { key: 'creatorsPerformance', title: "Creators' Performance" },
  { key: 'productAnalytics',    title: 'Product Analytics' },
  { key: 'gmvMax',              title: 'GMV Max Performance' },
  { key: 'customers',           title: 'Customers' },
  { key: 'keyWinsInsights',     title: 'Key Wins / Insights' },
  { key: 'campaignsText',       title: 'Campaigns' },
  { key: 'recommendations',     title: 'Recommendations & Action Items' },
  { key: 'customFields',        title: 'My Custom Fields' },
];
const _DEFAULT_SECTIONS_ENABLED = Object.fromEntries(MONTHLY_SECTIONS.map((s) => [s.key, true]));
export function resolveSectionsEnabled(raw) {
  return { ..._DEFAULT_SECTIONS_ENABLED, ...(raw || {}) };
}

// ---------------------------------------------------------------------
// WEEKLY_SECTIONS + helper (mirrors monthly but for weekly/biweekly forms).
// Same shape and column (sections_enabled jsonb on reports), different
// section list. Keys match the camelCase fields in EMPTY_REPORT_DATA so
// the form/view can drive visibility off them directly.
// ---------------------------------------------------------------------
export const WEEKLY_SECTIONS = [
  { key: 'overallPerformance',  title: 'Overall Performance',           required: true  },
  { key: 'topCreators',         title: 'Top Creators',                  required: true  },
  { key: 'topVideos',           title: 'Top Videos',                    required: true  },
  { key: 'gmvMax',              title: 'GMV Max Performance',           required: true  },
  { key: 'productHighlights',   title: 'Product Highlights',            required: true  },
  { key: 'offsitePerformance',  title: 'Offsite Performance',           required: false },
  { key: 'upcomingCampaigns',   title: 'Current & Upcoming Campaigns',  required: true  },
  { key: 'operationalUpdates',  title: 'Operational Updates',           required: true  },
  { key: 'recommendations',     title: 'Recommendations & Action Items', required: false },
];
const _DEFAULT_WEEKLY_SECTIONS_ENABLED = Object.fromEntries(WEEKLY_SECTIONS.map((s) => [s.key, true]));
export function resolveWeeklySectionsEnabled(raw) {
  return { ..._DEFAULT_WEEKLY_SECTIONS_ENABLED, ...(raw || {}) };
}

// ---------------------------------------------------------------------
// Empty-report templates (v1's emptyReport / emptyBiWeeklyReport / emptyMonthlyReport)
// ---------------------------------------------------------------------
export function emptyReport() { return EMPTY_REPORT_DATA(); }

export function emptyBiWeeklyReport() {
  // BiWeekly shape mirrors weekly except topVideos lacks `videoLink` in v1.
  // We keep videoLink optional so v2's view code that reads it still works.
  return {
    ...EMPTY_REPORT_DATA(),
    topVideos: [{ creatorName: '', itemsSold: '', gmv: '', views: '', productClicks: '', notes: '' }],
  };
}

export function emptyMonthlyReport() {
  return {
    currency: 'USD',
    sectionsEnabled: { ..._DEFAULT_SECTIONS_ENABLED },
    totalSales: { monthGmv: '', allTimeGmv: '' },
    keyMetrics: { gmv: '', orders: '', customers: '', itemsSold: '' },
    kpis: {
      completedCollabs: '', contentPending: '', totalOrders: '', freeSamplesApproved: '',
    },
    gmvBreakdown: {
      affiliateGmv: '', organicGmv: '', liveGmv: '', videoGmv: '', productCardGmv: '',
    },
    topCreators: [{ username: '', gmv: '' }],
    topVideos:   [{ videoLink: '', gmv: '' }],
    videoPerformance: {
      productImpressions: '', productClicks: '', videoViews: '',
      ctr: '', ctor: '', skuOrders: '', gmv: '',
      videos1MViews: '', videos100kViews: '', videos10kViews: '',
      videos1000Gmv: '', videos100Gmv: '',
      newVideosPosted: '',
    },
    creatorsPerformance: {
      creators1Plus: '', creators3Plus: '', creators10Plus: '',
      creators1kGmv: '', creators100Gmv: '',
    },
    productAnalytics: [
      { productId: '', productName: '', unitsSold: '', gmv: '', samplesApproved: '' },
    ],
    gmvMax: [
      { campaign: '', spend: '', roi: '', orders: '', cpo: '', gmv: '' },
    ],
    customers: {
      awareCustomers: '', newCustomers: '', potentialNewCustomers: '',
      crmMessagesSent: '', convertedCustomers: '',
    },
    keyWinsInsights: '',
    campaignsText:   '',
    recommendations: '',
    customFields:    {},
  };
}

// ---------------------------------------------------------------------
// REPORT_STATUSES — v1's color/icon palette for badges.
// ---------------------------------------------------------------------
export const REPORT_STATUSES = {
  draft:     { label: 'Draft',     color: '#64748b', bg: '#f1f5f9', icon: 'bi-file-earmark-text' },
  submitted: { label: 'Submitted', color: '#2563eb', bg: '#dbeafe', icon: 'bi-send-fill' },
  verified:  { label: 'Verified',  color: '#7c3aed', bg: '#ede9fe', icon: 'bi-patch-check-fill' },
  approved:  { label: 'Approved',  color: '#16a34a', bg: '#dcfce7', icon: 'bi-shield-check-fill' },
};

// ---------------------------------------------------------------------
// v1-shaped CRUD: saveReport / saveBiWeeklyReport / saveMonthlyReport
//
// These wrap the existing v2 upsertDraft + writeback so v1 forms can
// call them with their original payload shape:
//
//   saveReport({ brandId, brandName, weekInfo, data, uid, userName, status })
//   → returns the v2 row id
//
// status ∈ 'draft' | 'submitted' (v1 also accepts 'verified'/'approved'
// as the form's status param when TL/OL re-saves).
// ---------------------------------------------------------------------
async function _findExistingReportId(brandId, type, periodStart) {
  const { data, error } = await supabase
    .from('reports')
    .select('id')
    .eq('brand_id', brandId)
    .eq('type', type)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') throw new Error(error.message);
  return data?.id || null;
}

async function _saveReportV1({ type, brandId, weekInfo, data, uid, status = 'draft', extraFields = {} }) {
  if (!uid) throw new Error('not authenticated');
  if (!brandId) throw new Error('brandId required');
  const periodStart = weekInfo.startDate;
  const existingId  = await _findExistingReportId(brandId, type, periodStart);

  // Strip v1 doc-id wrapper / brandId (already a column) / non-data fields
  // we manage explicitly. v1 loads `data` via `{...d.data()}` so it can
  // include ANY v1 top-level field — keep them in jsonb.data so old views
  // keep rendering them.
  const {
    id: _ignore,
    brandId: _b,
    brandName: _bn,
    week: _w, weekStart: _ws, weekEnd: _we, weekLabel: _wl,
    period: _pn, periodStart: _ps, periodEnd: _pe, periodLabel: _pl,
    monthKey: _mk, year: _yr, month: _mo,
    sectionsEnabled,
    status: _stIgnore,
    createdAt: _ca, createdBy: _cb, createdByName: _cbn,
    updatedAt: _ua, lastEditedBy: _leb, lastEditedByName: _lebn,
    submittedAt: _sa, submittedBy: _sb, submittedByName: _sbn,
    verifiedAt: _va, verifiedBy: _vb, verifiedByName: _vbn,
    approvedAt: _aa, approvedBy: _ab, approvedByName: _abn,
    rejectedAt: _ra, rejectedBy: _rb, rejectionNote: _rn,
    reopenedAt: _roa, reopenedBy: _rob,
    ...cleanData
  } = data || {};

  const payload = {
    brand_id:      brandId,
    author_id:     existingId ? undefined : uid,
    type,
    period_number: weekInfo.week ?? weekInfo.period ?? null,
    period_start:  weekInfo.startDate,
    period_end:    weekInfo.endDate,
    period_year:   weekInfo.year ?? null,
    period_month:  weekInfo.month ?? null,
    period_label:  weekInfo.label ?? '',
    status,
    data: { ...cleanData, ...(extraFields || {}) },
    last_edited_by: uid,
    updated_at:     new Date().toISOString(),
  };
  // Persist sectionsEnabled into its own column for all report types
  // (also keep a copy in data so old code reading from data.sectionsEnabled
  // still works). Monthly uses its own default section list; weekly and
  // biweekly share the weekly default.
  if (type === 'monthly') {
    payload.sections_enabled = sectionsEnabled || _DEFAULT_SECTIONS_ENABLED;
    payload.data.sectionsEnabled = payload.sections_enabled;
  } else if (type === 'weekly' || type === 'biweekly') {
    payload.sections_enabled = sectionsEnabled || _DEFAULT_WEEKLY_SECTIONS_ENABLED;
    payload.data.sectionsEnabled = payload.sections_enabled;
  }
  if (existingId) {
    const { data: updated, error } = await supabase
      .from('reports')
      .update(payload)
      .eq('id', existingId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return updated.id;
  }
  payload.author_id = uid;
  const { data: inserted, error } = await supabase
    .from('reports')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return inserted.id;
}

export async function saveReport({ brandId, brandName, weekInfo, data, uid, userName, status = 'draft', extraFields = {} }) {
  void brandName; void userName; // v2 derives from joins
  return _saveReportV1({ type: 'weekly', brandId, weekInfo, data, uid, status, extraFields });
}
export async function saveBiWeeklyReport({ brandId, brandName, periodInfo, data, uid, userName, status = 'draft', extraFields = {} }) {
  void brandName; void userName;
  return _saveReportV1({ type: 'biweekly', brandId, weekInfo: periodInfo, data, uid, status, extraFields });
}
export async function saveMonthlyReport({ brandId, brandName, monthInfo, data, uid, userName, status = 'draft', extraFields = {} }) {
  void brandName; void userName;
  // monthInfo has { year, month, monthKey, label, startDate, endDate }
  return _saveReportV1({ type: 'monthly', brandId, weekInfo: monthInfo, data, uid, status, extraFields });
}

// v1-shaped delete
export async function deleteReportV1(id) {
  const { error } = await supabase.from('reports').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
export const deleteReport = deleteReportV1;
export const deleteBiWeeklyReport = deleteReportV1;
export const deleteMonthlyReport  = deleteReportV1;

// v1's "change a report's week/period/month" — under v1 this re-keyed
// the doc; under v2 the row id is stable and we just update period_*.
// Caller passes the existing v2 row id and the new period info.
export async function changeReportWeek(oldReportId, newWeekInfo, reportData) {
  void reportData;
  const patch = {
    period_number: newWeekInfo.week ?? newWeekInfo.period ?? null,
    period_start:  newWeekInfo.startDate,
    period_end:    newWeekInfo.endDate,
    period_year:   newWeekInfo.year ?? null,
    period_month:  newWeekInfo.month ?? null,
    period_label:  newWeekInfo.label ?? '',
  };
  const { error } = await supabase.from('reports').update(patch).eq('id', oldReportId);
  if (error) throw new Error(error.message);
  return oldReportId;
}
export const changeBiWeeklyReportPeriod = changeReportWeek;
export const changeMonthlyReportMonth   = changeReportWeek;

// v1 uses these names; the date editor calls editReportDates(id, start, end, data)
// while v2's existing editReportDates(id, {startDate, endDate}) takes an object.
// Provide the v1 signature under a different name to avoid collision.
export async function editReportDatesV1(oldReportId, newStartDate, newEndDate, reportData) {
  const newWeekInfo = buildWeekInfoFromRange(newStartDate, newEndDate, reportData?.week || 1);
  return changeReportWeek(oldReportId, newWeekInfo, reportData);
}
export async function editBiWeeklyReportDates(oldReportId, newStartDate, newEndDate, reportData) {
  const newPeriodInfo = buildPeriodInfoFromRange(newStartDate, newEndDate, reportData?.period || 1);
  return changeReportWeek(oldReportId, newPeriodInfo, reportData);
}
export async function editMonthlyReportMonth(oldReportId, newYear, newMonthIndex /*, reportData */) {
  const m = makeMonthInfo(newYear, newMonthIndex);
  return changeReportWeek(oldReportId, m, null);
}

// v1's status flipper — used by the listing pages' inline Verify/Approve
// buttons. v2 has separate RPCs but they only read ids; this wrapper
// dispatches to the right one and writes audit fields server-side.
export async function updateReportStatus(reportId, nextStatus, auditData = null) {
  // v2 RPCs: submitReport, verifyReport, approveReport, rejectReport, reopenReport
  let result;
  if (nextStatus === 'submitted') {
    // submitReport expects (id, data) — pass null so it preserves what's there
    result = await submitReport(reportId, null);
  } else if (nextStatus === 'verified') {
    result = await verifyReport(reportId);
  } else if (nextStatus === 'approved') {
    result = await approveReport(reportId);
  } else {
    // Unknown — fall back to a direct status update (boss/dev RLS allows this).
    const { error } = await supabase
      .from('reports')
      .update({ status: nextStatus })
      .eq('id', reportId);
    if (error) throw new Error(error.message);
  }

  // Apply any extra audit fields the caller passed (e.g. v1's
  // submittedActingAs / verifiedActingAs flags for OL acting-as flows).
  // Skip fields we already wrote via the RPC; map camelCase → snake_case
  // for the few names that v1 used.
  if (auditData && typeof auditData === 'object') {
    const KEY_MAP = {
      submittedActingAs: 'submitted_acting_as',
      verifiedActingAs:  'verified_acting_as',
      approvedActingAs:  'approved_acting_as',
      rejectedActingAs:  'rejected_acting_as',
      submittedAt: 'submitted_at',
      verifiedAt:  'verified_at',
      approvedAt:  'approved_at',
      rejectedAt:  'rejected_at',
      submittedBy: 'submitted_by',
      verifiedBy:  'verified_by',
      approvedBy:  'approved_by',
      rejectedBy:  'rejected_by',
      submittedByName: 'submitted_by_name',
      verifiedByName:  'verified_by_name',
      approvedByName:  'approved_by_name',
      rejectedByName:  'rejected_by_name',
      rejectionNote: 'rejection_note',
    };
    const SKIP = new Set([
      // RPCs already write these — don't clobber
      'submitted_at', 'submitted_by',
      'verified_at',  'verified_by',
      'approved_at',  'approved_by',
    ]);
    const patch = {};
    for (const [k, v] of Object.entries(auditData)) {
      const col = KEY_MAP[k] || (k.includes('_') ? k : null);
      if (!col || SKIP.has(col)) continue;
      patch[col] = v;
    }
    if (Object.keys(patch).length > 0) {
      try {
        await supabase.from('reports').update(patch).eq('id', reportId);
      } catch { /* non-fatal — RPC already moved status */ }
    }
  }
  return result;
}

// ---------------------------------------------------------------------
// v1-shaped reads
// ---------------------------------------------------------------------
const _SELECT_WITH_JOINS =
  '*, brand:brand_id(id, brand_name, logo_url, owner_id),' +
  'author:author_id(id, display_name, role, avatar_url),' +
  'submitter:submitted_by(id, display_name),' +
  'verifier:verified_by(id, display_name),' +
  'approver:approved_by(id, display_name),' +
  'rejecter:rejected_by(id, display_name),' +
  'reopener:reopened_by(id, display_name),' +
  'last_editor:last_edited_by(id, display_name)';

async function _listByType(type, { brandId = null, brandIds = null, limit = null } = {}) {
  let q = supabase.from('reports').select(_SELECT_WITH_JOINS).eq('type', type);
  if (brandId) q = q.eq('brand_id', brandId);
  if (brandIds && brandIds.length) q = q.in('brand_id', brandIds);
  q = q.order('period_start', { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(_normReport);
}

// Single read by id, normalized.
export async function getReportV1(id) {
  const { data, error } = await supabase
    .from('reports')
    .select(_SELECT_WITH_JOINS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? _normReport(data) : null;
}
export const getBiWeeklyReport = getReportV1;
export const getMonthlyReport  = getReportV1;

export async function getReportsForBrand(brandId)        { return _listByType('weekly',  { brandId, limit: 52 }); }
export async function getBiWeeklyReportsForBrand(brandId){ return _listByType('biweekly',{ brandId, limit: 52 }); }
export async function getMonthlyReportsForBrand(brandId) { return _listByType('monthly', { brandId, limit: 24 }); }

export async function getAllReports()             { return _listByType('weekly',   { limit: 200 }); }
export async function getAllBiWeeklyReports()     { return _listByType('biweekly', { limit: 200 }); }
export async function getAllMonthlyReports()      { return _listByType('monthly',  { limit: 200 }); }

export async function getReportsForTL(brandIds)         { return _listByType('weekly',   { brandIds }); }
export async function getBiWeeklyReportsForTL(brandIds) { return _listByType('biweekly', { brandIds }); }
export async function getMonthlyReportsForTL(brandIds)  { return _listByType('monthly',  { brandIds }); }

// ---------------------------------------------------------------------
// Realtime subscriptions — Supabase channels behind v1's onSnapshot pattern.
// Returns an unsubscribe function. Each subscription fetches an initial
// snapshot, then refetches on any change to the reports table for that
// type (filtered by brandId / brandIds when applicable).
// ---------------------------------------------------------------------
function _subscribeByType(type, fetcher, channelKey) {
  let stopped = false;
  (async () => {
    try { const rows = await fetcher(); if (!stopped) channelKey._cb(rows); }
    catch { /* ignore initial */ }
  })();
  const ch = supabase
    .channel(channelKey._name)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reports', filter: `type=eq.${type}` },
      async () => { try { const rows = await fetcher(); if (!stopped) channelKey._cb(rows); } catch { /* ignore */ } })
    .subscribe();
  return () => { stopped = true; supabase.removeChannel(ch); };
}

export function subscribeAllWeeklyReports(onChange) {
  return _subscribeByType('weekly', getAllReports, { _name: 'reports-weekly-all', _cb: onChange });
}
export function subscribeAllBiWeeklyReports(onChange) {
  return _subscribeByType('biweekly', getAllBiWeeklyReports, { _name: 'reports-biweekly-all', _cb: onChange });
}
export function subscribeAllMonthlyReports(onChange) {
  return _subscribeByType('monthly', getAllMonthlyReports, { _name: 'reports-monthly-all', _cb: onChange });
}

export function subscribeReportsForBrand(brandId, onChange) {
  return _subscribeByType('weekly', () => getReportsForBrand(brandId),
    { _name: `reports-weekly-brand-${brandId}`, _cb: onChange });
}
export function subscribeBiWeeklyReportsForBrand(brandId, onChange) {
  return _subscribeByType('biweekly', () => getBiWeeklyReportsForBrand(brandId),
    { _name: `reports-biweekly-brand-${brandId}`, _cb: onChange });
}
export function subscribeMonthlyReportsForBrand(brandId, onChange) {
  return _subscribeByType('monthly', () => getMonthlyReportsForBrand(brandId),
    { _name: `reports-monthly-brand-${brandId}`, _cb: onChange });
}

export function subscribeReportsForTL(brandIds, onChange) {
  return _subscribeByType('weekly', () => getReportsForTL(brandIds),
    { _name: `reports-weekly-tl-${(brandIds || []).join('_').slice(0, 60)}`, _cb: onChange });
}
export function subscribeBiWeeklyReportsForTL(brandIds, onChange) {
  return _subscribeByType('biweekly', () => getBiWeeklyReportsForTL(brandIds),
    { _name: `reports-biweekly-tl-${(brandIds || []).join('_').slice(0, 60)}`, _cb: onChange });
}
export function subscribeMonthlyReportsForTL(brandIds, onChange) {
  return _subscribeByType('monthly', () => getMonthlyReportsForTL(brandIds),
    { _name: `reports-monthly-tl-${(brandIds || []).join('_').slice(0, 60)}`, _cb: onChange });
}

// ---------------------------------------------------------------------
// findPreviousReport — same-brand report whose period ended before the
// current one started. Drives prior-period delta math in v1 forms/views.
// We compare by `weekStart` (or `periodStart` / `monthKey`) string,
// NOT createdAt — intentional so OL date-edits don't reshuffle history.
// ---------------------------------------------------------------------
export function findPreviousReport(reports, currentReport) {
  const cur = currentReport.weekStart || currentReport.periodStart || '';
  if (!cur) return null;
  const sorted = [...reports]
    .filter((r) => r.brandId === currentReport.brandId && r.id !== currentReport.id
                && (r.weekStart || r.periodStart || '') < cur)
    .sort((a, b) => (b.weekStart || b.periodStart || '').localeCompare(a.weekStart || a.periodStart || ''));
  return sorted[0] || null;
}

export function findPreviousMonthlyReport(reports, currentReport) {
  const cur = currentReport.monthKey || '';
  if (!cur) return null;
  const sorted = [...reports]
    .filter((r) => r.brandId === currentReport.brandId && r.id !== currentReport.id
                && (r.monthKey || '') < cur)
    .sort((a, b) => (b.monthKey || '').localeCompare(a.monthKey || ''));
  return sorted[0] || null;
}

// Numeric helpers (v1's `num`, `pctChange`, `cleanNumericInput`)
//
// `num()` is a tolerant numeric parser. Accepts: "1234", "1,234",
// "$3,456.9", "8.20M", "23.84k", "3.17%", numbers, null/undefined/empty.
// Returns 0 on garbage. Why: PDF-import payloads and form pastes
// routinely include formatting, and the view layer compares values via
// num() — a strict parseFloat lost data silently for any string with a
// leading "$" or a thousands separator (e.g. parseFloat("$350,975.69")
// → NaN → 0, so every YoY/MoM delta vs a formatted prev value
// reported a +100% jump). Ported from v1 commit bcb429e + 4190751.
export function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const cleaned = String(v).trim().replace(/[$£€¥₹\s,%]/g, '');
  if (!cleaned) return 0;
  const m = cleaned.match(/^(-?\d*\.?\d+)([kKmMbB])$/);
  if (m) {
    const base = parseFloat(m[1]);
    const mult = m[2].toLowerCase() === 'k' ? 1e3
               : m[2].toLowerCase() === 'm' ? 1e6
               : 1e9;
    return isFinite(base) ? base * mult : 0;
  }
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

export function pctChange(current, previous) {
  const c = num(current);
  const p = num(previous);
  if (p === 0) return c > 0 ? 100 : 0;
  return ((c - p) / p) * 100;
}

// Strip currency symbols, commas, percent, and whitespace from a
// user-entered numeric string. Keeps digits / dot / minus / suffix
// characters intact so typing stays fluid. Used by Form `Field`
// components (numeric type) so a user pasting "$3,456.9" or "5.1%"
// gets it normalised to "3456.9" / "5.1" automatically.
export function cleanNumericInput(s) {
  if (s == null) return '';
  return String(s).replace(/[$£€¥₹%\s,]/g, '');
}

// ---------------------------------------------------------------------
// User custom fields — v1 shape (single-doc array of {id, name})
// ---------------------------------------------------------------------
export async function getUserCustomFields(uid) {
  const rows = await listUserCustomFields(uid);
  return (rows || []).map((r) => ({ id: r.id, name: r.field_name, sort_order: r.sort_order }));
}

// v1's saveUserCustomFields(uid, fields) was a wholesale-replace of the
// list. Translate to v2's per-row CRUD: diff incoming names against
// stored, add missing, rename changed, delete removed.
export async function saveUserCustomFields(uid, fields) {
  const incoming = Array.isArray(fields) ? fields : [];
  const existing = await listUserCustomFields(uid);
  const existingById = new Map((existing || []).map((r) => [r.id, r]));

  const incomingIds = new Set(incoming.map((f) => f.id).filter(Boolean));

  // Deletes: existing rows not present in incoming
  for (const row of existing || []) {
    if (!incomingIds.has(row.id)) {
      try { await deleteCustomField(row.id); } catch { /* ignore */ }
    }
  }
  // Adds + renames
  for (const f of incoming) {
    if (f.id && existingById.has(f.id)) {
      const stored = existingById.get(f.id);
      if (stored.field_name !== f.name) {
        try { await renameCustomField(f.id, f.name); } catch { /* ignore */ }
      }
    } else {
      try { await addCustomField(uid, f.name); } catch { /* ignore */ }
    }
  }
  return getUserCustomFields(uid);
}

// ---------------------------------------------------------------------
// repairWeeklyLabels — v1's Boss-only utility wraps repairWeekLabels()
// already in this file. v1 returned {updated, skipped, errors, total};
// v2's RPC returns row count. Adapt.
// ---------------------------------------------------------------------
export async function repairWeeklyLabels() {
  const updated = await repairWeekLabels();
  return { updated: Number(updated || 0), skipped: 0, errors: 0, total: 0 };
}

// ---------------------------------------------------------------------
// Brands this user can author reports on (APC sees assigned; TL sees owned;
// Boss/OL/dev see all active).
export async function listBrandsForReporting({ role, uid }) {
  if (['boss','ol','developer'].includes(role)) {
    const { data, error } = await supabase
      .from('brands')
      .select('id, brand_name, logo_url, owner_id')
      .eq('status', 'active')
      .order('brand_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  if (role === 'tl') {
    const { data, error } = await supabase
      .from('brands')
      .select('id, brand_name, logo_url, owner_id')
      .eq('status', 'active')
      .eq('owner_id', uid)
      .order('brand_name');
    if (error) throw new Error(error.message);
    return data || [];
  }
  // APC/IPC — use brand_assignments
  const { data, error } = await supabase
    .from('brand_assignments')
    .select('brand:brand_id(id, brand_name, logo_url, owner_id, status)')
    .eq('user_id', uid);
  if (error) throw new Error(error.message);
  return (data || [])
    .map((r) => r.brand)
    .filter((b) => b && b.status === 'active');
}
