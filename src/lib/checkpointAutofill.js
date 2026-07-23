// ============================================================
// Weekly Checkpoint — auto-fill for sections 1–8 (phase 2; §07 creative angles
// is fully manual, §09–13 not yet wired).
//
// Sources, kept strictly separate (per the boss):
//   • WEEKLY REPORT for the same week (and the N-2 week) — the exact numbers.
//   • COMPUTED — sample→video N-2 = videos live ÷ approved(N-2).
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
 * @returns { scalars:{path:string}, arrays:{path:any[]}, meta }
 */
export async function runCheckpointAutofill({ brandId, weekStart, brand }) {
  const scalars = {};
  const arrays = {};
  const meta = { reportFound: false, reportN2Found: false, eukaTried: false, eukaOk: false, eukaError: null, eukaStages: null, filled: 0 };
  const set = (path, v) => { const val = asStr(v); if (val !== null) { scalars[path] = val; meta.filled++; } };

  // ── weekly reports (this week + N-2) ───────────────────────────────
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
    set('funnel.videosLive', op.videosPosted);

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

  // §1 Produce — Approved · Wk N-2, and §05 sample→video N-2 (needs both weeks)
  if (n2) set('funnel.approvedN2', n2.overallPerformance?.samplesApproved);
  const vLive = asNum(wk?.overallPerformance?.videosPosted);
  const app2 = asNum(n2?.overallPerformance?.samplesApproved);
  if (vLive != null && app2) set('samples.sampleToVideoN2', round((vLive / app2) * 100, 1));

  // ── Euka (only when the brand is on Euka) — target invites + opted in ──
  if (brand?.euka_store_id) {
    meta.eukaTried = true;
    try {
      const euka = await fetchEukaCheckpoint(brandId, weekStart, addDaysISO(weekStart, 6));
      if (euka.targetInvites != null) set('funnel.targetInvites', euka.targetInvites);
      if (euka.optedIn != null) set('funnel.optedIn', euka.optedIn);
      meta.eukaOk = true;
      meta.eukaStages = euka.funnelStages || null;
    } catch (e) { meta.eukaError = e?.message || String(e); }
  }

  // Outreach "Target invites" = the same number as the funnel's target invites.
  if (scalars['funnel.targetInvites'] != null) set('outreach.reachInvites', scalars['funnel.targetInvites']);

  return { scalars, arrays, meta };
}

// Apply a patch onto checkpoint data (returns a new object).
export function applyAutofillPatch(data, patch) {
  let d = data;
  for (const [path, v] of Object.entries(patch.scalars || {})) d = setIn(d, path, v);
  for (const [path, v] of Object.entries(patch.arrays || {})) d = setIn(d, path, v);
  return d;
}
