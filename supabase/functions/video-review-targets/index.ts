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
//   Step 2  For each candidate, pull video history (creator_video_level, chunked
//           70 days back — the export caps a call at 70 days) to find their
//           1st/2nd/3rd video EVER (as of the target date). RULE-OUT: a creator
//           with 3+ videos older than the candidate window already had all three
//           messages fall due, so they stop after one chunk (see fullHistory).
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
  // Dedicated-key brands by convention: EUKA_API_KEY_<SLUG> (e.g. INNOSUPPS,
  // BENTGO). A new own-key brand needs only the secret + a euka_stores row.
  const own = Deno.env.get(`EUKA_API_KEY_${slug.toUpperCase()}`);
  if (own) return own;
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

// NOTE — there is deliberately NO "stop after N empty chunks" heuristic here.
//
// The old code stopped after 2 consecutive empty 70-day chunks, treating that as
// "we've reached the start of their history". 2 chunks = 140 days, so ANY creator
// who posted, went quiet for ~5 months, then came back had their old videos never
// seen: their comeback video looked like their FIRST EVER, and they were flagged
// for a 1st review they had already received — or bumped a group (a 3rd read as a
// 2nd). Silent, and wrong in the client's favour never.
//
// Property-tested over 55,051 random creator histories: the 2-chunk stop got
// 2,855 wrong; widening it to 4 chunks still got 1,355 wrong. ANY finite guess is
// unsound, because a gap can always be one chunk longer than the guess. So we
// simply walk the full 13 chunks (~2.5 years) for every creator who is not ruled
// out below. Same test, with no early break: ZERO mismatches.
//
// We can afford this precisely BECAUSE of the rule-out: on live Cutler data 82 of
// 116 creators exit after one chunk, so only 34 pay for the full walk — 535 calls,
// 59s, versus a ~150s ceiling. The rule-out buys the correctness.
//
// Residual limit: a creator whose FIRST video is older than 13*70 = 910 days AND
// who has fewer than 3 videos before the window would still be truncated. To hit
// that you'd need someone with <=2 videos in their entire life, the first >2.5
// years ago, posting again now. Anyone with a real back-catalogue is ruled out.

// Video history for one creator, as of the target date, walked in 70-day chunks
// (the export rejects a wider range).
//
// EARLY RULE-OUT — the big win. We only ever care about a creator's FIRST THREE
// videos. If 3+ of their videos are already older than the candidate window,
// then videos #1/#2/#3 are all in the past, so all three messages fell due long
// ago and the creator CANNOT be due today. We can stop immediately without
// learning their exact history.
//
// Safety: candStart is always earliestProcessing - 2. With D1,D2,D3 <= candStart-1,
// the send chain advances at most one day per message (msg2 >= msg1+1,
// msg3 >= msg2+1) and firstRunDateOnOrAfter only skips missed dates, which are
// all >= earliestProcessing. Worst case msg3 lands on target-1 — never on target.
// That 2-day lookback in the candidate window is exactly the margin the
// three-message chain needs.
//
// This is what makes big brands affordable: a prolific creator (g6iffinlifts has
// 379 videos) used to cost 10 chunks to prove they weren't due. Now it costs 1.
// Verified against live Euka data — identical groups, ~4x fewer calls.
//
// Returns { skip: true } for a ruled-out creator; otherwise their posting DAYS
// oldest-first (one entry PER VIDEO — same-day videos count separately, which is
// what D1/D2/D3 mean), filtered to <= target.
async function fullHistory(
  handle: string, target: string, candStart: string, storeId: string, key: string,
): Promise<{ skip: boolean; days: string[] }> {
  const vids = new Map<string, string>(); // video_id -> posted_date iso
  let end = target;
  for (let i = 0; i < 13; i++) { // 13*70 ≈ 2.5 years — back to the start of history
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

    // Count VIDEOS (not days) strictly before the window — D1/D2/D3 are the
    // 1st/2nd/3rd VIDEO, so three same-day videos still consume all three.
    let before = 0;
    for (const d of vids.values()) if (dayOf(d) < candStart) before++;
    if (before >= 3) return { skip: true, days: [] };

    end = addDays(start, -1);
  }
  return {
    skip: false,
    days: [...vids.values()].map(dayOf).filter((d) => d <= target).sort(cmp),
  };
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
    //
    // Was 4, which timed out (504) and then got resource-killed (546) on
    // Cutler Nutritions. The cost is candidates x up-to-13 sequential Euka calls,
    // so wall clock is set by how SLOW a store's Euka responses are, not by how
    // many creators it has: Cutler had only 24 candidates (vs Bentgo's 69) but
    // ~1.8s per chunk on the throttled shared key. Measured against the real
    // Euka API with Cutler's own key: 4 -> ~144s (at the ~150s ceiling),
    // 10 -> 25.1s across 136 calls. Euka accepted 10-way with no throttling.
    const CONCURRENCY = 12;

    // Wall-clock budget. Even with headroom, a pathologically slow store must
    // DEGRADE rather than 504: past the budget we stop starting new candidates
    // and hand the rest back as "check manually", so the APC still gets the
    // CSVs we did compute instead of a bare gateway error.
    const startedAt = Date.now();
    const BUDGET_MS = 110_000;
    const outOfTime = () => Date.now() - startedAt > BUDGET_MS;

    let idx = 0;
    async function worker() {
      while (idx < candidateHandles.length) {
        const handle = candidateHandles[idx++];
        if (outOfTime()) {
          needsManual.push({ handle, note: 'timed out before this creator could be checked — run again or check manually' });
          continue;
        }
        let res: { skip: boolean; days: string[] };
        try { res = await fullHistory(handle, target, candStart, storeId, key); }
        catch { needsManual.push({ handle, note: 'history lookup failed — check manually' }); continue; }
        // Ruled out: 3+ videos predate the window, so all three messages already
        // went out. Nothing due — NOT a manual case.
        if (res.skip) continue;
        const hist = res.days;
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
