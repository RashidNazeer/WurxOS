// Client for the euka-report-autofill edge function ("Auto Generate from Euka"
// on the weekly report form). Called via a direct fetch (like the AI assistant
// and video reviews) because the per-product fan-out can take a while.
import { supabase } from './supabase';

// Runs the exact-match autofill for a brand + a 7-day stats window. Returns
// { brandLabel, period:{startDate,endDate}, data (partial report), meta }.
// Throws an Error whose `.detail` carries the structured error for the
// copy-to-Discord message.
export async function runEukaReportAutofill({ brandId, startDate, endDate }) {
  const base = import.meta.env.VITE_SUPABASE_URL;
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  if (!accessToken) throw new Error('Not signed in.');

  let res, body;
  try {
    res = await fetch(`${base}/functions/v1/euka-report-autofill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId, startDate, endDate }),
    });
  } catch (netErr) {
    // Network-level failure (offline / DNS / CORS). Give a copyable shape.
    const e = new Error('Could not reach the server. Check your internet and try again.');
    e.detail = { stage: 'network', message: String(netErr) };
    throw e;
  }
  try { body = await res.json(); } catch { body = null; }

  if (!res.ok || body?.error) {
    const err = body?.error || { stage: 'http', message: `Request failed (${res.status}).` };
    const e = new Error(typeof err === 'string' ? err : (err.message || 'Auto-fill failed.'));
    e.detail = { httpStatus: res.status, ...(typeof err === 'object' ? err : {}) };
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
  if (partial.overallPerformance) {
    next.overallPerformance = { ...current.overallPerformance, ...partial.overallPerformance };
  }
  // MTD GMV lives in overallNotes — deep-merge so manual MTD fields survive.
  if (partial.overallNotes) {
    next.overallNotes = { ...current.overallNotes, ...partial.overallNotes };
  }
  // Arrays: only replace when the autofill supplied rows (else keep manual).
  if (partial.topCreators && partial.topCreators.length) next.topCreators = partial.topCreators;
  else next.topCreators = current.topCreators;
  if (partial.productHighlights && partial.productHighlights.length) next.productHighlights = partial.productHighlights;
  else next.productHighlights = current.productHighlights;
  return next;
}
