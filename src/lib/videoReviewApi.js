// Client for the video-review-targets edge function.
//
// The function makes many upstream Euka calls (a full-history pull per
// candidate) so a run takes 1–3 minutes — longer than supabase.functions
// .invoke comfortably allows. So we hit the function URL directly with the
// caller's session token (same pattern as the AI assistant's streaming call).
import { supabase } from './supabase';

// Video Reviews is an APC-only feature: the Euka-linked brands the current APC
// is ASSIGNED to. Returns [{ id, brand_name, euka_slug }] sorted by name.
// Empty ⇒ the APC has no Euka brand (so the menu item / page is hidden).
export async function listMyEukaBrands() {
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess?.session?.user?.id;
  if (!uid) return [];

  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, euka_slug, euka_store_id, assignments:brand_assignments(user_id)')
    .not('euka_store_id', 'is', null)
    .order('brand_name');
  if (error) throw new Error(error.message);
  const rows = (data || []).filter((b) => (b.assignments || []).some((a) => a.user_id === uid));
  return rows.map((b) => ({ id: b.id, brand_name: b.brand_name, euka_slug: b.euka_slug }));
}

// Returns { brandLabel, targetDate, missedDates, group1[], group2[], group3[],
//           needsManual[], meta{ candidates, candidateWindow, dayBoundary } }.
export async function runVideoReviewTargets({ brandId, targetDate, missedDates = [] }) {
  const base = import.meta.env.VITE_SUPABASE_URL;
  const { data: sess } = await supabase.auth.getSession();
  const accessToken = sess?.session?.access_token;
  if (!accessToken) throw new Error('Not signed in.');

  const res = await fetch(`${base}/functions/v1/video-review-targets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ brandId, targetDate, missedDates }),
  });

  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `Request failed (${res.status}).`);
  }
  return data;
}

// Record a group's messages as SENT.
//
// Downloading the CSV is the commitment point — the file goes straight up to
// Euka, so the messages go out. Recording it here is what stops the same creator
// being messaged again tomorrow, and what lets the run fire OVERDUE messages
// without spamming: the ledger knows who has already had which message.
//
// Idempotent server-side (greatest() on msgs_sent), so downloading the same CSV
// twice can never advance a creator to their next message.
export async function markGroupSent({ brandId, handles, messageNo, sentOn }) {
  if (!brandId || !messageNo || !(handles || []).length) return 0;
  const { data, error } = await supabase.rpc('video_review_mark_sent', {
    p_brand: brandId,
    p_handles: handles,
    p_msg_no: messageNo,
    p_sent_on: sentOn,
  });
  if (error) throw new Error(error.message);
  return data || 0;
}

// Build a one-column CSV ("Usernames" header) from a list of handles, and
// trigger a browser download. Handles are written WITHOUT the leading '@'
// (they're pasted straight into TikTok/Euka which don't want the '@').
// ONE COLUMN ONLY — Euka's uploader rejects anything else, so never add
// columns here; extra context belongs in the UI panel.
export function downloadHandlesCsv(handles, filename) {
  const header = 'Usernames';
  const body = (handles || []).map((h) => String(h).replace(/^@/, '')).join('\r\n');
  const csv = `${header}\r\n${body}${body ? '\r\n' : ''}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
