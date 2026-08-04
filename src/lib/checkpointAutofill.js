// ============================================================
// Weekly Checkpoint — auto-fill for sections 1–8 (phase 2; §07 creative angles
// is fully manual, §09–13 not yet wired).
//
// Sources, kept strictly separate (per the boss):
//   • WEEKLY REPORT for the same week (and the N-2 week) — the exact numbers.
//   • DERIVED LIVE on the form + deck (NOT here): "Videos now live" is manual,
//     and "Sample→video N-2" = videos now live ÷ approved(N-2). Neither is ever
//     taken from this-week's videosPosted (that is not the N-2 cohort).
//   • EUKA (only if the brand is on Euka) — funnel.targetInvites + funnel.optedIn.
//   • "last week" columns come from CARRY-FORWARD at create (checkpointCarry),
//     NOT here — the two mechanisms never overlap.
//
// NOT auto-filled here (stay manual — flagged to the boss): Sample requests /
// "Requests received" and Video CTOR are not in the WEEKLY report; Affiliate
// orders, Competitors, DM/Email, tier splits, MTD-by-tier, avg rating and all
// narrative fields are manual. Auto-fill only ever writes the fields below.
// ============================================================
import { supabase } from './supabase';
import { getReportsForBrand } from './reportsApi';
import { addWeeks } from './checkpointModel';

const asStr = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const asNum = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const sumBy = (arr, key) => (Array.isArray(arr) ? arr.reduce((a, r) => a + (asNum(r?.[key]) || 0), 0) : 0);
const round = (x, d) => { const p = 10 ** d; return Math.round(x * p) / p; };
const addDaysISO = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + days);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
};

// immutable nested set by dot-path (indices allowed, e.g. samples.products)
function setIn(obj, path, value) {
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
function getIn(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Call the Euka edge function for the two funnel counts. Returns
// { targetInvites, optedIn, optInStage, funnelStages } or throws.
export async function fetchEukaCheckpoint(brandId, startDate, endDate) {
  const { data, error } = await supabase.functions.invoke('euka-checkpoint-autofill', {
    body: { brandId, startDate, endDate },
  });
  if (error) throw new Error(error.message || 'Euka request failed.');
  if (data?.error) throw new Error(data.error.message || 'Euka request failed.');
  return data || {};
}

/**
 * Build the auto-fill patch for one checkpoint week.
 * @param onStage optional ({label, pct}) progress callback for the create overlay.
 * @returns { scalars:{path:string}, arrays:{path:any[]}, meta }
 */
export async function runCheckpointAutofill({ brandId, weekStart, brand, onStage }) {
  const stage = (label, pct) => { try { onStage?.({ label, pct }); } catch { /* ignore */ } };
  const scalars = {};
  const arrays = {};
  const meta = { reportFound: false, reportN2Found: false, eukaTried: false, eukaOk: false, eukaError: null, eukaStages: null, filled: 0 };
  const set = (path, v) => { const val = asStr(v); if (val !== null) { scalars[path] = val; meta.filled++; } };

  // ── weekly reports (this week + N-2) ───────────────────────────────
  stage('Reading weekly report…', 40);
  let reports = [];
  try { reports = await getReportsForBrand(brandId); } catch { reports = []; }
  const byStart = (ps) => reports.find((r) => r.weekStart === ps) || null;
  const wk = byStart(weekStart);
  const n2 = byStart(addWeeks(weekStart, -2));
  meta.reportFound = !!wk;
  meta.reportN2Found = !!n2;

  if (wk) {
    const op = wk.overallPerformance || {};
    const on = wk.overallNotes || {};
    const hasGmvMax = Array.isArray(wk.gmvMax) && wk.gmvMax.length > 0;
    const gmvMaxSpend = sumBy(wk.gmvMax, 'spend');
    const gmvMaxGmv = sumBy(wk.gmvMax, 'gmv');
    const gmvMaxOrders = sumBy(wk.gmvMax, 'orders');

    // §01 Affiliate funnel — recruit + produce
    set('funnel.approved', op.samplesApproved);
    // "Videos now live" is MANUAL — it's the videos posted by the creators we
    // approved in Wk N-2 (the cohort), which is NOT the weekly report's
    // this-week videosPosted. So we don't auto-fill it; the APC enters it
    // (the form shows a hint referencing the Wk N-2 approved count).

    // §04 Performance snapshot — THIS-WEEK values (last-week from carry-forward).
    // Cost/order comes from the report: GMV Max spend ÷ GMV Max orders (the same
    // basis the report's per-campaign cost-per-order uses).
    set('snapshot.kpis.gmv.cur', op.gmv);
    if (hasGmvMax) set('snapshot.kpis.gmvMaxSpend.cur', round(gmvMaxSpend, 2));
    set('snapshot.kpis.roi.cur', op.roi);
    set('snapshot.kpis.orders.cur', op.orders);
    if (hasGmvMax && gmvMaxOrders) set('snapshot.kpis.costPerOrder.cur', round(gmvMaxSpend / gmvMaxOrders, 2));
    set('snapshot.kpis.videosLive.cur', op.videosPosted);
    // ctor + avg rating stay manual — not in the weekly report

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

    // §06 Content & traffic — SKU orders + top videos this week (impressions/
    // clicks stay manual; last-week from carry-forward). Top-video ANGLE isn't
    // in the report, so it's left blank for the APC.
    set('traffic.orders', op.orders);
    const topVideos = (wk.topVideos || [])
      .filter((v) => (v.creatorName || '').trim() || asNum(v.gmv) != null)
      .map((v) => ({ creator: v.creatorName || '', angle: '', gmv: (v.gmv === '' || v.gmv == null) ? '' : String(v.gmv) }));
    if (topVideos.length) { arrays['traffic.topVideos'] = topVideos; meta.filled++; }

    // §08 GMV Max & paid — spend + gross revenue + GMV Max orders straight from
    // the weekly GMV Max table, so the deck's ROI (=grossRev÷spend) and
    // cost/order (=spend÷orders) reproduce the report's own values. (targetRoi /
    // ROI-protection / mode carried forward; decision + screenshot manual.)
    if (hasGmvMax) {
      set('paid.spend', round(gmvMaxSpend, 2));
      set('paid.grossRevenue', round(gmvMaxGmv, 2));
      set('paid.skuOrders', gmvMaxOrders);
    }
  }

  // §1 Produce — Approved · Wk N-2 (from the N-2 weekly report). "Sample→video
  // N-2" is NOT auto-filled: it equals Videos now live ÷ Approved · Wk N-2, and
  // the form + deck derive it live from those two fields (never from this-week's
  // videosPosted, which is not the N-2 cohort).
  if (n2) set('funnel.approvedN2', n2.overallPerformance?.samplesApproved);

  // ── Euka (only when the brand is on Euka) — target invites + opted in ──
  if (brand?.euka_store_id) {
    meta.eukaTried = true;
    stage('Fetching Euka data…', 70);
    try {
      const euka = await fetchEukaCheckpoint(brandId, weekStart, addDaysISO(weekStart, 6));
      if (euka.targetInvites != null) set('funnel.targetInvites', euka.targetInvites);
      if (euka.optedIn != null) set('funnel.optedIn', euka.optedIn);
      meta.eukaOk = true;
      meta.eukaStages = euka.funnelStages || null;
    } catch (e) { meta.eukaError = e?.message || String(e); }
  }

  stage('Finishing up…', 90);
  return { scalars, arrays, meta };
}

// Fields that are the SAME number in more than one section, so the APC only ever
// types it once (verified same-type — the autofill fills every member of a group
// from the identical report value; boss-confirmed for sample requests). Each
// group's members mirror each other (two-way in the form; and here after a patch
// so an autofill/Euka value that lands on one member propagates to the rest).
// Look-alikes that are NOT the same (e.g. "Videos now live" N-2 cohort vs §04
// "Videos Live" this week; §08 GMV-Max "SKU orders" vs the weekly total; MTD vs
// weekly; this-week vs last-week) are deliberately NOT grouped.
export const MIRROR_GROUPS = [
  ['funnel.targetInvites', 'outreach.reachInvites', 'effort.invitesSent'],   // target invites
  ['funnel.approved', 'samples.approvedThisWeek'],                            // samples approved this week
  ['funnel.sampleRequests', 'samples.requestsReceived', 'effort.sampleRequested'], // sample requests
  ['snapshot.kpis.orders.cur', 'traffic.orders'],                            // weekly SKU orders (total)
  ['snapshot.kpis.gmvMaxSpend.cur', 'paid.spend'],                           // GMV Max spend
];

// Propagate each group's value onto all its members. Uses the first non-empty
// member as the source (autofill writes the first-listed member), never mirrors
// a blank. Idempotent — the members are already equal after autofill/typing.
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

// Apply a patch onto checkpoint data (returns a new object).
export function applyAutofillPatch(data, patch) {
  let d = data;
  for (const [path, v] of Object.entries(patch.scalars || {})) d = setIn(d, path, v);
  for (const [path, v] of Object.entries(patch.arrays || {})) d = setIn(d, path, v);
  return d;
}
