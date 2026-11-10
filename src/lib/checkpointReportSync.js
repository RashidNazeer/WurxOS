// ============================================================
// Weekly report -> weekly checkpoint: the fields the two have in common.
//
// Pure (no supabase, no DOM) so the mapping and the merge rule are unit-testable in plain node.
//
// WHAT FLOWS: only a VERIFIED (or approved) weekly report feeds the checkpoint. A draft or submitted
// report is the APC's own unreviewed number and must not appear in a document the team reviews; the
// checkpoint fills itself once the report is verified (checkpointAutofill.js runs this at the moment
// of verification, and again whenever the checkpoint is opened).
//
// WHAT NEVER FLOWS (not the same figure in both documents, or not in the report at all): Videos now
// live (the N-2 cohort), Video CTOR, Avg rating (Shop Performance Score is a different measure),
// impressions / clicks (the report only has per-video numbers for its top 5), affiliate orders,
// sample requests (Reacher supplies those), tier splits, effort log, outreach, every narrative box.
//
// THE MERGE RULE (mergeReportPatchInto): never overwrite what a person typed. A field is written only
// when it is blank, or still holds exactly the value the sync wrote last time (so a corrected report
// re-flows, but an APC's own edit stays). Everything the rule kept is counted so the page can say so.
// ============================================================
import { addWeeks } from './checkpointModel.js';

const asStr = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const asNum = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const sumBy = (arr, key) => (Array.isArray(arr) ? arr.reduce((a, r) => a + (asNum(r?.[key]) || 0), 0) : 0);
const round = (x, d) => { const p = 10 ** d; return Math.round(x * p) / p; };

// immutable nested set by dot-path (indices allowed, e.g. samples.products)
export function setIn(obj, path, value) {
  const keys = path.split('.');
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return clone;
}
export function getIn(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Fields that are the SAME number in more than one section, so the APC only ever types it once.
// Look-alikes that are NOT the same (N-2 "Videos now live" vs this week's "Videos Live", GMV-Max "SKU
// orders" vs the weekly total, MTD vs weekly, this week vs last week) are deliberately not grouped.
export const MIRROR_GROUPS = [
  ['funnel.targetInvites', 'outreach.reachInvites', 'effort.invitesSent'],         // target invites
  ['funnel.approved', 'samples.approvedThisWeek'],                                  // samples approved this week
  ['funnel.sampleRequests', 'samples.requestsReceived', 'effort.sampleRequested'], // sample requests
  ['snapshot.kpis.orders.cur', 'traffic.orders'],                                  // weekly SKU orders (total)
  ['snapshot.kpis.gmvMaxSpend.cur', 'paid.spend'],                                 // GMV Max spend
];

// Propagate each group's value onto all its members. Uses the first non-empty member as the source,
// never mirrors a blank. Idempotent.
export function mirrorDuplicates(data) {
  let d = data;
  for (const group of MIRROR_GROUPS) {
    let v = null;
    for (const p of group) { const cur = getIn(d, p); if (cur !== '' && cur != null) { v = String(cur); break; } }
    if (v == null) continue;
    for (const p of group) d = setIn(d, p, v);
  }
  return d;
}

// Apply a patch onto checkpoint data (returns a new object). Overwrites: used when a checkpoint is created.
export function applyAutofillPatch(data, patch) {
  let d = data;
  for (const [path, v] of Object.entries(patch.scalars || {})) d = setIn(d, path, v);
  for (const [path, v] of Object.entries(patch.arrays || {})) d = setIn(d, path, v);
  return d;
}

export const isVerifiedReport = (r) => !!r && (r.status === 'verified' || r.status === 'approved');

const stampOf = (r) => {
  const v = r?.verifiedAt;
  try { return v?.toDate ? v.toDate().toISOString() : (v ? new Date(v).toISOString() : ''); } catch { return ''; }
};

/**
 * The patch a brand's VERIFIED weekly report (and the verified N-2 report) gives one checkpoint week.
 * @param reports    every weekly report of the brand (normalised, as getReportsForBrand returns)
 * @param weekStart  the checkpoint week's start date (YYYY-MM-DD) = the report's weekStart
 * @returns { scalars:{path:string}, arrays:{path:any[]}, meta }
 */
export function buildReportPatch(reports, weekStart) {
  const scalars = {};
  const arrays = {};
  const meta = { reportFound: false, reportPending: false, reportN2Found: false, reportId: null, reportVerifiedAt: '', filled: 0 };
  const set = (path, v) => { const val = asStr(v); if (val !== null) { scalars[path] = val; meta.filled++; } };

  const byStart = (ps) => (reports || []).find((r) => r.weekStart === ps) || null;
  const wkAny = byStart(weekStart);
  const n2Any = byStart(addWeeks(weekStart, -2));
  const wk = isVerifiedReport(wkAny) ? wkAny : null;
  const n2 = isVerifiedReport(n2Any) ? n2Any : null;
  meta.reportFound = !!wk;
  meta.reportPending = !!wkAny && !wk;     // written but not verified yet: nothing flows until it is
  meta.reportN2Found = !!n2;
  meta.reportId = wk?.id || null;
  meta.reportVerifiedAt = stampOf(wk);

  if (wk) {
    const op = wk.overallPerformance || {};
    const on = wk.overallNotes || {};
    const hasGmvMax = Array.isArray(wk.gmvMax) && wk.gmvMax.length > 0;
    const gmvMaxSpend = sumBy(wk.gmvMax, 'spend');
    const gmvMaxGmv = sumBy(wk.gmvMax, 'gmv');
    const gmvMaxOrders = sumBy(wk.gmvMax, 'orders');

    // §01 Affiliate funnel
    set('funnel.approved', op.samplesApproved);

    // §04 Performance snapshot (this-week values; last week comes from carry-forward)
    set('snapshot.kpis.gmv.cur', op.gmv);
    if (hasGmvMax) set('snapshot.kpis.gmvMaxSpend.cur', round(gmvMaxSpend, 2));
    set('snapshot.kpis.roi.cur', op.roi);
    set('snapshot.kpis.orders.cur', op.orders);
    if (hasGmvMax && gmvMaxOrders) set('snapshot.kpis.costPerOrder.cur', round(gmvMaxSpend / gmvMaxOrders, 2));
    set('snapshot.kpis.videosLive.cur', op.videosPosted);

    // §05 Samples
    set('samples.approvedThisWeek', op.samplesApproved);
    set('samples.mtdApproved', on.samplesApproved);
    const products = (wk.productHighlights || [])
      .filter((p) => (p.productName || '').trim() || asNum(p.samplesApprovedWeek) != null)
      .map((p) => ({
        name: p.productName || '',
        count: (p.samplesApprovedWeek === '' || p.samplesApprovedWeek == null) ? '' : String(p.samplesApprovedWeek),
      }));
    if (products.length) { arrays['samples.products'] = products; meta.filled++; }

    // §06 Content & traffic: SKU orders + top videos (the angle is not in the report)
    set('traffic.orders', op.orders);
    const topVideos = (wk.topVideos || [])
      .filter((v) => (v.creatorName || '').trim() || asNum(v.gmv) != null)
      .map((v) => ({ creator: v.creatorName || '', angle: '', gmv: (v.gmv === '' || v.gmv == null) ? '' : String(v.gmv) }));
    if (topVideos.length) { arrays['traffic.topVideos'] = topVideos; meta.filled++; }

    // §08 GMV Max & paid: from the weekly GMV Max table so ROI and cost/order reproduce the report's own
    if (hasGmvMax) {
      set('paid.spend', round(gmvMaxSpend, 2));
      set('paid.grossRevenue', round(gmvMaxGmv, 2));
      set('paid.skuOrders', gmvMaxOrders);
    }
  }

  // §01 Produce: Approved . Wk N-2 (from the verified N-2 report)
  if (n2) set('funnel.approvedN2', n2.overallPerformance?.samplesApproved);

  return { scalars, arrays, meta };
}

const blankRow = (row) => !row || Object.values(row).every((v) => v === '' || v == null);
const blankArray = (arr) => !Array.isArray(arr) || arr.length === 0 || arr.every(blankRow);

// What the sync wrote last time, parsed from the checkpoint's stamp.
function lastWritten(data) {
  try { const v = JSON.parse(data?._autofill?.values || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * Merge a report patch into an EXISTING checkpoint without overwriting a person's own entries.
 * @returns { data, filled, kept, changed } `filled` = fields written or refreshed, `kept` = fields left
 *          because someone typed their own value there.
 */
export function mergeReportPatchInto(data, patch) {
  const written = lastWritten(data);
  const next = { ...written };
  let d = data;
  let filled = 0;
  let kept = 0;

  const str = (p) => { const c = getIn(d, p); return c === null || c === undefined ? '' : String(c); };

  // A mirror group is ONE number typed once, so it is decided as a unit: if nobody typed their own
  // value in any member, every member takes the report's; if someone did, that value stands and the
  // blank members follow it (the members must never end up disagreeing).
  const done = new Set();
  for (const [path, v] of Object.entries(patch.scalars || {})) {
    if (done.has(path)) continue;
    const members = MIRROR_GROUPS.find((g) => g.includes(path)) || [path];
    members.forEach((m) => done.add(m));
    const typed = members.filter((m) => { const c = str(m); return c !== '' && c !== v && c !== written[m]; });
    if (typed.length === 0) {
      for (const m of members) {
        if (str(m) !== v) { d = setIn(d, m, v); filled++; }
        next[m] = v;
      }
    } else {
      const own = str(typed[0]);
      kept++;
      for (const m of members) if (str(m) === '') { d = setIn(d, m, own); filled++; }
    }
  }
  for (const [path, arr] of Object.entries(patch.arrays || {})) {
    const cur = getIn(d, path);
    const json = JSON.stringify(arr);
    if (JSON.stringify(cur) === json) { next[path] = json; continue; }
    if (blankArray(cur) || JSON.stringify(cur) === written[path]) { d = setIn(d, path, arr); next[path] = json; filled++; }
    else kept++;
  }

  const stamp = { reportId: patch.meta?.reportId || '', verifiedAt: patch.meta?.reportVerifiedAt || '', values: JSON.stringify(next) };
  const stampChanged = JSON.stringify(d._autofill || null) !== JSON.stringify(stamp);
  if (stampChanged) d = { ...d, _autofill: stamp };
  return { data: d, filled, kept, changed: filled > 0 || stampChanged };
}
