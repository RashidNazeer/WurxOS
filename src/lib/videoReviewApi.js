// Client for the video-review-targets edge function.
//
// The function makes many upstream Euka calls (a full-history pull per
// candidate) so a run takes 1–3 minutes — longer than supabase.functions
// .invoke comfortably allows. So we hit the function URL directly with the
// caller's session token (same pattern as the AI assistant's streaming call).
import { supabase } from './supabase';

// Returns { brandLabel, targetDate, missedDates, group1[], group2[], group3[],
//           needsManual[], meta{ candidates, candidateWindow, dayBoundary } }.
export async function runVideoReviewTargets({ targetDate, missedDates = [] }) {
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
    body: JSON.stringify({ targetDate, missedDates }),
  });

  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `Request failed (${res.status}).`);
  }
  return data;
}

// Build a one-column CSV ("Usernames" header) from a list of handles, and
// trigger a browser download. Handles are written WITHOUT the leading '@'
// (they're pasted straight into TikTok/Euka which don't want the '@').
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
