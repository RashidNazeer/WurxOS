// ============================================================
// Edge Function: video-review-targets
//
// Computes, for a given TARGET DATE, which creators are due to receive
// their 1st / 2nd / 3rd video-review message today — the exact algorithm
// the APCs run by hand today (and previously via the Euka Copilot prompt).
//
// It runs entirely server-side so the Euka API key never reaches the
// browser, and so the many upstream calls (one full-history pull per
// candidate) happen close to Euka. Returns three handle lists:
//   { group1: string[], group2: string[], group3: string[],
//     needsManual: {handle,note}[], meta: {...} }
// The browser turns those into CSV files.
//
// Algorithm (verified against live data for 2026-07-01):
//   Candidate window = 2 days before earliest-processing .. target (incl).
//   Earliest-processing = min(target, ...missedDates).
//   Run dates = every date EXCEPT missed dates.
//   Step 1  Candidates = creators who posted >=1 video in the window
//           (creator_videos export — NOT GMV-capped).
//   Step 2  For each candidate, pull FULL video history (creator_video_level,
//           chunked 70 days back — the export caps a call at 70 days) to find
//           their 1st/2nd/3rd video EVER (as of the target date).
//   Step 3  3-message cap: only videos 1..3 matter; 4+ ignored, never block.
//   Step 4  Send dates: msg1 = first run-date >= D1; msg2 = first run-date >=
//           max(D2, day after msg1); msg3 = first run-date >= max(D3, day
//           after msg2). Missed dates roll forward.
//   Step 5  Group N = that message's send date == target (one group per creator).
//   Step 6  Return the handle lists + needs-manual.
//
// Day boundaries: midnight-to-midnight in UTC (Euka posted_date is UTC, and
// the Euka Copilot uses UTC too — confirmed).
//
// Brand-aware: the caller passes a `brandId`; the fn resolves it to that
// brand's euka_store_id + euka_slug (mig 229 backfill) and picks the right
// Euka key from the slug. AuthZ: APC-ONLY — the caller must be an APC assigned
// to the brand (Boss / OL / TL do not get this feature). So an APC generates
// files for THEIR OWN store.
// Deploy: supabase functions deploy video-review-targets
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EUKA_BASE = 'https://api.euka.ai/v0';

// Euka key routing by brand slug (mirrors the euka-api edge fn): a couple of
// brands have their own dedicated key; everyone else is on the shared account
// key (and is scoped by store_id, which the shared key can see across stores).
function eukaKeyForSlug(slug: string): string {
  if (slug === 'solidgold') return Deno.env.get('EUKA_API_KEY') || '';
  if (slug === 'innosupps') return Deno.env.get('EUKA_API_KEY_INNOSUPPS') || '';
  return Deno.env.get('EUKA_SHARED_API_KEY') || '';
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── Date helpers (all UTC, YYYY-MM-DD) ──────────────────────────────
const dayOf = (iso: string) => iso.slice(0, 10);
function addDays(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const maxDate = (...ds: (string | null | undefined)[]) =>
  ds.filter(Boolean).sort(cmp).slice(-1)[0] as string;
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// ── Euka fetch with light retry (Pakistani ISPs + Euka throttling) ──
async function eukaGet(path: string, key: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(EUKA_BASE + path, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) return data;
      lastErr = data?.error || `HTTP ${r.status}`;
      // 400s (bad params) won't fix on retry
      if (r.status === 400) return data;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  throw new Error(`Euka request failed: ${String(lastErr)}`);
}

// Full video history for one creator, as of the target date. Chunks 70 days
// back until we hit the beginning (two empty chunks in a row). Dedups by
// video_id. Returns posting DAYS oldest-first, filtered to <= target.
async function fullHistory(handle: string, target: string, storeId: string, key: string): Promise<string[]> {
  const vids = new Map<string, string>(); // video_id -> posted_date iso
  let end = target;
  let emptyStreak = 0;
  for (let i = 0; i < 13; i++) { // 13*70 ≈ 2.5 years — ample to find first 3
    const start = addDays(end, -69);
    let rows: any[] = [];
    try {
      const r = await eukaGet(
        `/data-export?type=creator_video_level&store_id=${storeId}` +
        `&start_date=${start}&end_date=${end}&export_type=json&creator_handle=${encodeURIComponent(handle)}`,
        key,
      );
      rows = Array.isArray(r?.data) ? r.data : [];
    } catch { rows = []; }
    for (const v of rows) if (v?.video_id && v?.posted_date) vids.set(v.video_id, v.posted_date);
    if (rows.length === 0) { emptyStreak++; if (emptyStreak >= 2) break; } else emptyStreak = 0;
    end = addDays(start, -1);
  }
  return [...vids.values()]
    .map(dayOf)
    .filter((d) => d <= target)
    .sort(cmp);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // ── AuthN ────────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthenticated' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'unauthenticated' }, 401);
    const uid = userData.user.id;
    const { data: profile } = await admin
      .from('profiles').select('role, is_active, display_name').eq('id', uid).maybeSingle();
    if (!profile || profile.is_active === false) return json({ error: 'forbidden' }, 403);
    const role = String(profile.role || '').toLowerCase();

    // ── Parse + validate input ───────────────────────────────────────
    const payload = await req.json().catch(() => ({}));
    const brandId: string = String(payload?.brandId || '').trim();
    if (!brandId) return json({ error: 'brandId is required' }, 400);
    const target: string = String(payload?.targetDate || '').trim();
    const missedRaw: unknown = payload?.missedDates;
    if (!isValidDate(target)) return json({ error: 'targetDate must be YYYY-MM-DD' }, 400);
    let missed: string[] = Array.isArray(missedRaw)
      ? [...new Set(missedRaw.map((d) => String(d).trim()).filter(isValidDate))]
      : [];
    if (missed.length > 2) return json({ error: 'At most 2 missed dates.' }, 400);
    // A missed date must be on/before the target (can't miss a future run).
    missed = missed.filter((d) => d <= target);

    // ── AuthZ: Video Reviews is an APC-ONLY feature ──────────────────
    // Boss / OL / TL do not get it. The caller must be an APC assigned to the
    // brand, so an APC only ever runs their OWN store.
    if (role !== 'apc') return json({ error: 'forbidden — Video Reviews is for APCs' }, 403);

    // ── Resolve the brand → Euka store + slug + key ──────────────────
    const { data: brand } = await admin
      .from('brands').select('id, brand_name, euka_store_id, euka_slug').eq('id', brandId).maybeSingle();
    if (!brand) return json({ error: 'brand not found' }, 404);
    if (!brand.euka_store_id || !brand.euka_slug) {
      return json({ error: `"${brand.brand_name}" is not linked to a Euka store.` }, 400);
    }
    const storeId = String(brand.euka_store_id);
    const key = eukaKeyForSlug(String(brand.euka_slug));
    if (!key) return json({ error: `Euka key not configured for "${brand.brand_name}".` }, 500);

    const { data: assign } = await admin
      .from('brand_assignments').select('brand_id').eq('brand_id', brandId).eq('user_id', uid).maybeSingle();
    if (!assign) return json({ error: 'forbidden — this brand is not assigned to you' }, 403);

    // ── Window ───────────────────────────────────────────────────────
    const earliestProcessing = [target, ...missed].sort(cmp)[0];
    const candStart = addDays(earliestProcessing, -2);
    const candEnd = target;

    const isMissed = (d: string) => missed.includes(d);
    const firstRunDateOnOrAfter = (d: string) => { let x = d; while (isMissed(x)) x = addDays(x, 1); return x; };

    // ── Step 1: candidates (all posters in window; not GMV-capped) ───
    const cv = await eukaGet(
      `/data-export?type=creator_videos&store_id=${storeId}` +
      `&start_date=${candStart}&end_date=${candEnd}&export_type=json`,
      key,
    );
    const windowVideos: any[] = Array.isArray(cv?.data) ? cv.data : [];
    const candidateHandles = [...new Set(
      windowVideos
        .filter((v) => { const d = dayOf(v?.posted_date || ''); return d >= candStart && d <= candEnd; })
        .map((v) => v?.creator_handle)
        .filter(Boolean),
    )] as string[];

    // ── Steps 2–5: per-candidate history → send dates → grouping ─────
    const group1: string[] = [];
    const group2: string[] = [];
    const group3: string[] = [];
    const needsManual: { handle: string; note: string }[] = [];

    // Bounded concurrency so we don't hammer Euka (or hit its throttle).
    const CONCURRENCY = 4;
    let idx = 0;
    async function worker() {
      while (idx < candidateHandles.length) {
        const handle = candidateHandles[idx++];
        let hist: string[] = [];
        try { hist = await fullHistory(handle, target, storeId, key); }
        catch { needsManual.push({ handle, note: 'history lookup failed — check manually' }); continue; }
        if (hist.length === 0) {
          needsManual.push({ handle, note: 'posted in window per creator_videos but per-creator history returned nothing' });
          continue;
        }
        const D1 = hist[0], D2 = hist[1], D3 = hist[2];
        const s1 = D1 ? firstRunDateOnOrAfter(D1) : null;
        const s2 = D2 ? firstRunDateOnOrAfter(maxDate(D2, addDays(s1!, 1))) : null;
        const s3 = D3 ? firstRunDateOnOrAfter(maxDate(D3, addDays(s2!, 1))) : null;
        if (s1 === target) group1.push(handle);
        else if (s2 === target) group2.push(handle);
        else if (s3 === target) group3.push(handle);
        // else: nothing due today
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // Stable, friendly ordering (alphabetical within a group).
    group1.sort(); group2.sort(); group3.sort();

    // ── Log the run (best-effort; never block the response) ──────────
    admin.from('video_review_runs').insert({
      brand_slug: brand.euka_slug,
      brand_label: brand.brand_name,
      target_date: target,
      missed_dates: missed,
      group1_count: group1.length,
      group2_count: group2.length,
      group3_count: group3.length,
      candidates: candidateHandles.length,
      needs_manual: needsManual.length,
      run_by: uid,
      run_by_name: profile.display_name || null,
    }).then(() => {}, () => {});

    return json({
      brandLabel: brand.brand_name,
      targetDate: target,
      missedDates: missed,
      group1, group2, group3,
      needsManual,
      meta: {
        candidates: candidateHandles.length,
        candidateWindow: { start: candStart, end: candEnd },
        dayBoundary: 'UTC',
      },
    });
  } catch (err) {
    console.error('video-review-targets failed:', err);
    return json({ error: String(err) }, 500);
  }
});
