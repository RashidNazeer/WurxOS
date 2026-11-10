// ============================================================
// Weekly Checkpoint — auto-fill for sections 1–8 (phase 2; §07 creative angles
// is fully manual, §09–13 not yet wired).
//
// Sources, kept strictly separate (per the boss):
//   • WEEKLY REPORT for the same week (and the N-2 week) — the exact numbers, from VERIFIED reports only.
//     The mapping lives in checkpointReportSync.js; syncCheckpointFromVerifiedReport (below) fills an
//     existing checkpoint the moment its report is verified, without overwriting what the APC typed.
//   • DERIVED LIVE on the form + deck (NOT here): "Videos now live" is manual,
//     and "Sample→video N-2" = videos now live ÷ approved(N-2). Neither is ever
//     taken from this-week's videosPosted (that is not the N-2 cohort).
//   • EUKA or REACHER (whichever the brand is on) — funnel.targetInvites + funnel.optedIn
//     (Reacher also supplies funnel.sampleRequests).
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
import { getCheckpoint, saveCheckpoint } from './checkpointsApi';
import { hydrate } from './checkpointDraft';
import { buildReportPatch, mergeReportPatchInto, isVerifiedReport } from './checkpointReportSync';

// The pure mapping + merge live in checkpointReportSync.js; re-exported so existing imports keep working.
export { MIRROR_GROUPS, mirrorDuplicates, applyAutofillPatch } from './checkpointReportSync';

const asStr = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const addDaysISO = (iso, days) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + days);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
};

// Call the Euka edge function for the two funnel counts. Returns
// { targetInvites, optedIn, optInStage, funnelStages } or throws.
export function fetchEukaCheckpoint(brandId, startDate, endDate) {
  return invokeCheckpoint('euka-checkpoint-autofill', { brandId, startDate, endDate });
}

// Same two counts (plus sample requests) from Reacher, for brands on Reacher.
// targetInvites comes back flagged approximate: it tracks the APC's own figure
// to within ~1% but is not exact.
export function fetchReacherCheckpoint(brandId, startDate, endDate) {
  return invokeCheckpoint('reacher-autofill', { mode: 'checkpoint', brandId, startDate, endDate });
}

async function invokeCheckpoint(fn, body) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    // A non-2xx from an Edge Function arrives as a generic "non-2xx status
    // code"; the real body is on error.context. Without this unwrap every
    // message the function writes -- "You do not have access to this brand.",
    // the Euka timeout text, the missing-key text -- was discarded, which is
    // why a failed pull looked identical to an empty one. Same idiom as
    // adminApi.js; euka-report-autofill sidesteps it with a raw fetch.
    let msg = error.message;
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) msg = ctx.error.message || ctx.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg || 'Euka request failed.');
  }
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
  const meta = { reportFound: false, reportPending: false, reportN2Found: false, reportId: null, reportVerifiedAt: '', providerName: null, providerLinked: false, providerTried: false, providerOk: false, providerError: null, providerNote: null, eukaStages: null, filled: 0 };
  const set = (path, v) => { const val = asStr(v); if (val !== null) { scalars[path] = val; meta.filled++; } };

  // ── weekly reports (this week + N-2): VERIFIED ones only (see checkpointReportSync.js) ──
  stage('Reading weekly report…', 40);
  let reports = [];
  try { reports = await getReportsForBrand(brandId); } catch { reports = []; }
  const rp = buildReportPatch(reports, weekStart);
  Object.assign(scalars, rp.scalars);
  Object.assign(arrays, rp.arrays);
  meta.filled += rp.meta.filled;
  Object.assign(meta, {
    reportFound: rp.meta.reportFound, reportPending: rp.meta.reportPending, reportN2Found: rp.meta.reportN2Found,
    reportId: rp.meta.reportId, reportVerifiedAt: rp.meta.reportVerifiedAt,
  });

  // ── Euka OR Reacher (whichever the brand is on) — target invites + opted in ──
  // A brand on neither is skipped silently here, which read to APCs on unlinked
  // brands as "auto-fill is broken". Record the fact so the banner can say so.
  const provider = brand?.euka_store_id ? 'euka' : brand?.reacher_shop_id ? 'reacher' : null;
  meta.providerName = provider === 'euka' ? 'Euka' : provider === 'reacher' ? 'Reacher' : null;
  meta.providerLinked = provider !== null;
  if (provider) {
    meta.providerTried = true;
    stage('Fetching ' + meta.providerName + ' data…', 70);
    try {
      const euka = provider === 'euka'
        ? await fetchEukaCheckpoint(brandId, weekStart, addDaysISO(weekStart, 6))
        : await fetchReacherCheckpoint(brandId, weekStart, addDaysISO(weekStart, 6));
      if (euka.targetInvites != null) set('funnel.targetInvites', euka.targetInvites);
      if (euka.optedIn != null) set('funnel.optedIn', euka.optedIn);
      // Only Reacher supplies this; for Euka brands it stays a manual field.
      if (euka.sampleRequests != null) set('funnel.sampleRequests', euka.sampleRequests);
      if (euka.approximate?.includes('targetInvites') && euka.targetInvites != null) {
        meta.providerNote = "target invites is an estimate (within about 1% of Reacher's own figure) - check it";
      }
      // The function answers 200 with per-call reasons (invitesError /
      // funnelError) when Euka rejects one of the two pulls, so "nothing threw"
      // is NOT "it worked". Reporting eukaOk unconditionally printed a Euka
      // tick beside two empty fields and left nobody anything to act on.
      meta.providerOk = euka.targetInvites != null || euka.optedIn != null;
      meta.providerError = [euka.invitesError, euka.funnelError].filter(Boolean).join(' - ') || null;
      meta.eukaStages = euka.funnelStages || null;
    } catch (e) { meta.providerError = e?.message || String(e); }
  }

  stage('Finishing up…', 90);
  return { scalars, arrays, meta };
}

// The verified weekly report for one brand + week, or null. Only a verified (or approved) report counts.
export async function getVerifiedReportForWeek(brandId, weekStart) {
  let reports = [];
  try { reports = await getReportsForBrand(brandId); } catch { reports = []; }
  const r = reports.find((x) => x.weekStart === weekStart) || null;
  return isVerifiedReport(r) ? r : null;
}

/**
 * Fill an EXISTING checkpoint from the brand's verified weekly report for that week.
 * Called the moment a weekly report is verified (reportsApi.updateReportStatus). Never overwrites a
 * person's own entries (mergeReportPatchInto), never touches the checkpoint's status, and does nothing
 * when there is no checkpoint yet (it fills itself from the verified report when it is created).
 * Best effort: callers must not let a failure here undo the verification.
 */
export async function syncCheckpointFromVerifiedReport({ brandId, weekStart }) {
  if (!brandId || !weekStart) return { synced: false, reason: 'missing brand or week' };
  let reports = [];
  try { reports = await getReportsForBrand(brandId); } catch { reports = []; }
  const patch = buildReportPatch(reports, weekStart);
  if (!patch.meta.reportFound) return { synced: false, reason: 'the weekly report is not verified' };
  const cp = await getCheckpoint(brandId, weekStart);
  if (!cp) return { synced: false, reason: 'no checkpoint for this week yet' };
  const { data, filled, kept, changed } = mergeReportPatchInto(hydrate(cp.data), patch);
  if (!changed) return { synced: true, filled: 0, kept };
  await saveCheckpoint({ brandId, weekStart, weekLabel: cp.week_label, data });
  return { synced: true, filled, kept };
}

// The report patch for one brand + week (verified reports only), for the checkpoint page to merge on open.
export async function getReportPatchForWeek(brandId, weekStart) {
  let reports = [];
  try { reports = await getReportsForBrand(brandId); } catch { reports = []; }
  return buildReportPatch(reports, weekStart);
}
