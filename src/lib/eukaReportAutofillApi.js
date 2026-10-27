// Client for the euka-report-autofill edge function ("Auto Generate from Euka"
// on the weekly report form). Called via a direct fetch (like the AI assistant
// and video reviews) because the per-product fan-out can take a while.
import { supabase } from './supabase';
import { assertAllowedInDemo } from './demoMode';

// Runs the exact-match autofill for a brand + a 7-day stats window. Returns
// { brandLabel, period:{startDate,endDate}, data (partial report), meta }.
// Throws an Error whose `.detail` carries the structured error for the
// copy-to-Discord message.
export function runEukaReportAutofill({ brandId, startDate, endDate }) {
  return runReportAutofill('euka-report-autofill', 'Euka', { brandId, startDate, endDate });
}

// Same contract, for brands that run on Reacher rather than Euka (brands.reacher_shop_id).
export function runReacherReportAutofill({ brandId, startDate, endDate }) {
  return runReportAutofill('reacher-autofill', 'Reacher', { mode: 'report', brandId, startDate, endDate });
}

// Which provider auto-fills this brand, if any: 'euka' | 'reacher' | null.
// A brand has at most one (brands_one_data_provider, mig 427).
export function reportProviderOf(brand) {
  if (brand?.euka_store_id) return 'euka';
  if (brand?.reacher_shop_id) return 'reacher';
  return null;
}
export const PROVIDER_LABEL = { euka: 'Euka', reacher: 'Reacher' };

async function runReportAutofill(fnName, providerLabel, reqBody) {
  // Raw fetch, so the invoke wrapper in supabase.js does not cover this one.
  assertAllowedInDemo(fnName);
  const base = import.meta.env.VITE_SUPABASE_URL;
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  if (!accessToken) throw new Error('Not signed in.');

  // Above the function's own 120s budget AND above Supabase's 150s request
  // idle timeout, so a real server-side answer — ours or the gateway's 504 —
  // always wins the race. We only abort when nothing at all came back.
  const CLIENT_TIMEOUT_MS = 165_000;

  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);

  let res, body;
  try {
    res = await fetch(`${base}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      signal: ctl.signal,
    });
  } catch (netErr) {
    // No response at all. This used to say "check your internet", which was a
    // guess: a dropped connection and an edge function killed mid-run raise the
    // identical TypeError. So report what is actually known, and record how long
    // it took — that is the number that separates the two causes. Fast means the
    // request never left; slow means the server was working and got cut off.
    const elapsedMs = Date.now() - t0;
    const aborted = ctl.signal.aborted;
    const e = new Error(aborted
      ? `The server stopped responding altogether. ${providerLabel} is most likely very slow right now — try again shortly, or fill this week in manually.`
      : elapsedMs < 5000
        ? 'Could not reach the server. Check your internet and try again.'
        : `No response from the server after ${Math.round(elapsedMs / 1000)}s. The request was cut off rather than refused — this is usually ${providerLabel} being slow, not your connection.`);
    e.detail = { stage: aborted ? 'client-timeout' : 'network', elapsedMs, message: String(netErr) };
    throw e;
  } finally {
    clearTimeout(timer);
  }
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok || body?.error) {
    const err = body?.error || { stage: 'http', message: `Request failed (${res.status}).` };
    const e = new Error(typeof err === 'string' ? err : (err.message || 'Auto-fill failed.'));
    e.detail = { httpStatus: res.status, elapsedMs: Date.now() - t0, ...(typeof err === 'object' ? err : {}) };
    throw e;
  }
  return body;
}

// The Euka-linked brands the current user may auto-fill reports for:
//   OL / Boss → every brand on Euka.
//   TL        → brands they OWN that are on Euka.
//   APC / IPC → brands ASSIGNED to them that are on Euka.
// Returns [{ id, brand_name, euka_slug, euka_store_id }] by name. Empty ⇒ the
// user has no Euka brand (so no "Auto Generate from Euka" button).
export async function listMyEukaReportBrands() {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess?.session?.user?.id;
  if (!uid) return [];
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', uid).maybeSingle();
  const role = String(profile?.role || '').toLowerCase();

  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, euka_slug, euka_store_id, owner_id, assignments:brand_assignments(user_id)')
    .not('euka_store_id', 'is', null)
    .order('brand_name');
  if (error) throw new Error(error.message);
  let rows = data || [];
  if (role === 'boss' || role === 'ol') {
    // all Euka brands
  } else if (role === 'tl') {
    rows = rows.filter((b) => b.owner_id === uid);
  } else {
    rows = rows.filter((b) => (b.assignments || []).some((a) => a.user_id === uid));
  }
  return rows.map((b) => ({ id: b.id, brand_name: b.brand_name, euka_slug: b.euka_slug, euka_store_id: b.euka_store_id }));
}

// Deep-merge a partial autofill `data` over the current form data — only
// overwrites the keys the autofill actually filled; everything else is kept.
// Mirrors the toFullReport idiom used by the Euka preview.
export function mergeAutofill(current, partial) {
  if (!partial) return current;
  const next = { ...current, ...partial };
  // The autofill sends '' for fields it deliberately leaves to the APC (samples,
  // ROI...). A plain spread lets those blanks overwrite a number the APC had
  // already typed, so only values the provider actually supplied are applied.
  const filled = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== '' && v != null));
  if (partial.overallPerformance) {
    next.overallPerformance = { ...current.overallPerformance, ...filled(partial.overallPerformance) };
  }
  // MTD GMV lives in overallNotes — deep-merge so manual MTD fields survive.
  if (partial.overallNotes) {
    next.overallNotes = { ...current.overallNotes, ...filled(partial.overallNotes) };
  }
  // Arrays: only replace when the autofill supplied rows (else keep manual).
  if (partial.topCreators && partial.topCreators.length) next.topCreators = partial.topCreators;
  else next.topCreators = current.topCreators;
  if (partial.productHighlights && partial.productHighlights.length) next.productHighlights = partial.productHighlights;
  else next.productHighlights = current.productHighlights;
  return next;
}
