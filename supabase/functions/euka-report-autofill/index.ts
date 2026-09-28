// ============================================================
// Edge Function: euka-report-autofill
//
// "Auto Generate from Euka" for weekly reports. Given a brand + a 7-day stats
// window, fetches ONLY the stats Euka matches EXACTLY (per the feasibility
// review) and returns a PARTIAL weekly-report `data` object; the frontend
// merges it over the blank template so everything else stays blank for manual
// entry. Runs server-side so the Euka key never reaches the browser and so
// APC/TL/OL (not just Boss, who owns the euka-api proxy) can use it.
//
// Exact-match fields filled (everything else left ''):
//   overallPerformance: gmv (totalShopGMV), affiliateGmv (totalAffiliateGMV),
//                       orders (totalOrders)
//   overallNotes:       gmv (Month-to-Date totalShopGMV — 1st of the week's
//                       end-month through endDate)
//   topCreators[]:      TOP 3 by GMV — name (@handle), videosPosted (videoCount,
//                       0 when Euka reports none), gmv (totalGmv) [itemsSold blank]
//   productHighlights[]: TOP 5 by affiliate GMV — productId, productName (title),
//                       unitsSold (per-product orders — the report's "Orders"
//                       column), gmv (per-product affiliateGmv), all straight
//                       from /dashboard/products-performance
//   overallInsights:    a short auto-generated summary
//
// AuthZ: OL/Boss any brand; TL the brand they own; APC/IPC a brand assigned to
// them — so a user only ever pulls their OWN brand's store.
//
// The stats window (startDate/endDate) is INDEPENDENT of the report's week —
// the caller decides which 7 days to pull; the report keeps its own period.
//
// Deploy: supabase functions deploy euka-report-autofill
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EUKA_BASE = 'https://api.euka.ai/v0';

// Euka key routing by brand slug (mirrors euka-api / video-review-targets).
function eukaKeyForSlug(slug: string): string {
  if (slug === 'solidgold') return Deno.env.get('EUKA_API_KEY') || '';
  // Dedicated-key brands by convention: EUKA_API_KEY_<SLUG> (e.g. INNOSUPPS,
  // BENTGO). Mirrors euka-api's discovery, so a new own-key brand needs only the
  // secret + a euka_stores row — no edit here. Falls back to the shared account.
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
// A structured error the client can show verbatim + copy to Discord. `stage`
// says WHERE it failed so a developer can triage fast. `elapsedMs` says how
// long we had been going — without it a report cannot distinguish a request
// that died instantly from one that ran for two minutes.
function errOut(stage: string, message: string, status = 500, detail?: unknown, elapsedMs?: number) {
  return json({ error: { stage, message, detail: detail ?? null, elapsedMs: elapsedMs ?? null } }, status);
}

// ── Time budget ──────────────────────────────────────────────────────
// Euka calls used to have NO timeout and no overall budget: three calls with
// three attempts each, then the MTD call with three more, every one of them
// able to hang indefinitely. A slow Euka therefore ran this worker until the
// PLATFORM killed it — and a killed worker sends no response at all, which the
// browser reports as "TypeError: Failed to fetch". The user was then told to
// check their internet for a failure that happened server-side.
//
// So: every attempt is bounded, the whole request is bounded well inside the
// edge wall clock, and running out of time is now a real error with a real
// message instead of a dropped connection.
//
// WHY THESE NUMBERS, AND WHY THE TOTAL CANNOT SIMPLY BE RAISED
// ------------------------------------------------------------
// Supabase gives an edge function a 150s REQUEST IDLE TIMEOUT: if no response
// has been sent by then the gateway returns its own 504 and our error never
// reaches the browser. That 150s is a hard ceiling on every plan — the 400s
// wall clock on paid plans does not move it. So the total budget must leave
// room to build and send the response inside 150s, which is what 120s buys.
//
// The per-attempt cap is the part worth being generous with: Euka answering
// slowly but correctly should SUCCEED, not be cut off. 45s is long enough for
// a genuinely slow-but-working reply and still lets a dead connection fail
// twice inside the budget.
//
// Needing more than this is a sign to ask Euka for less, not to wait longer —
// which is why the MTD call now runs in parallel rather than after the others.
const ATTEMPT_TIMEOUT_MS = 45_000;
const TOTAL_BUDGET_MS = 120_000;

function makeBudget(ms: number) {
  const endsAt = Date.now() + ms;
  return { left: () => endsAt - Date.now() };
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
// Counts (orders, videos, units) → integer. Money (GMV) → 2-decimal exact, to
// avoid float noise like 4812.860000000001 showing in the report fields.
const num = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? '' : Math.round(Number(v)));
const money = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? '' : Number(Number(v).toFixed(2)));

// POST a /dashboard/* endpoint with light retry (Pakistani ISPs + Euka
// throttling), bounded per attempt and by the request's remaining budget.
// Every call's wall time lands in `timings` so a slow report says WHICH Euka
// endpoint was slow rather than just "it failed".
type Budget = { left: () => number };

async function eukaPost(
  path: string, body: unknown, key: string, budget: Budget, timings: Record<string, number>,
  label?: string,
): Promise<any> {
  let lastErr: unknown;
  const startedAt = Date.now();
  // `label` keeps the two performance-overview calls (the week and the MTD
  // window) apart — they share a path but are very different in size.
  const record = () => { timings[label ?? path] = Date.now() - startedAt; };

  for (let attempt = 0; attempt < 3; attempt++) {
    const left = budget.left();
    if (left <= 0) {
      record();
      throw { path, lastErr: lastErr ?? 'ran out of time before this call', timedOut: true };
    }
    try {
      const r = await fetch(EUKA_BASE + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, left)),
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) { record(); return data; }
      lastErr = { status: r.status, body: typeof data === 'string' ? data.slice(0, 300) : data };
      if (r.status === 400 || r.status === 401 || r.status === 403) break; // won't fix on retry
    } catch (e) {
      lastErr = String(e);
      // An abort here is either this attempt's 20s cap or the whole budget.
      // Out of budget means give up now — retrying cannot make time appear.
      if (budget.left() <= 0) { record(); throw { path, lastErr, timedOut: true }; }
    }
    // Don't back off after the final attempt, and don't spend the remaining
    // budget sleeping when there would be no time left to use afterwards.
    if (attempt === 2) break;
    const backoff = 500 * (attempt + 1);
    if (budget.left() <= backoff) break;
    await new Promise((res) => setTimeout(res, backoff));
  }
  record();
  throw { path, lastErr, timedOut: budget.left() <= 0 };
}

function insightsHtml(ov: any, creators: any[]): string {
  const money = (v: any) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  const n = (v: any) => (v == null ? '—' : Number(v).toLocaleString());
  const top = (creators || []).slice(0, 3)
    .map((c) => `${c.name} (${money(typeof c.gmv === 'number' ? c.gmv : null)})`)
    .filter((s) => !s.startsWith(' '))
    .join(', ');
  return '<ul>'
    + `<li>Total Shop GMV <b>${money(ov.totalShopGMV)}</b>, Affiliate GMV <b>${money(ov.totalAffiliateGMV)}</b>, with <b>${n(ov.totalOrders)}</b> orders this week.</li>`
    + (top ? `<li>Top creators by GMV: <b>${top}</b>.</li>` : '')
    + '</ul>';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const t0 = Date.now();
  const budget = makeBudget(TOTAL_BUDGET_MS);
  const timings: Record<string, number> = {};
  // Every error carries how long we had been running. That single number is
  // what tells a developer whether a failure was instant or a slow death.
  const fail = (stage: string, message: string, status = 500, detail?: unknown) =>
    errOut(stage, message, status, detail, Date.now() - t0);

  try {
    // ── AuthN ────────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return fail('auth', 'Not signed in — please refresh and try again.', 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return fail('auth', 'Your session expired — please sign in again.', 401);
    const uid = userData.user.id;
    const { data: profile } = await admin
      .from('profiles').select('role, is_active').eq('id', uid).maybeSingle();
    if (!profile || profile.is_active === false) return fail('auth', 'Your account is not active.', 403);
    const role = String(profile.role || '').toLowerCase();

    // ── Input ────────────────────────────────────────────────────────
    const payload = await req.json().catch(() => ({}));
    const brandId: string = String(payload?.brandId || '').trim();
    const startDate: string = String(payload?.startDate || '').trim();
    const endDate: string = String(payload?.endDate || '').trim();
    if (!brandId) return fail('input', 'No brand was provided.', 400);
    if (!isDate(startDate) || !isDate(endDate)) return fail('input', 'The stats period is invalid (need YYYY-MM-DD dates).', 400);
    if (startDate > endDate) return fail('input', 'The stats period start is after its end.', 400);

    // ── Resolve brand → store + slug + key ───────────────────────────
    const { data: brand } = await admin
      .from('brands').select('id, brand_name, owner_id, euka_store_id, euka_slug').eq('id', brandId).maybeSingle();
    if (!brand) return fail('brand', 'Brand not found.', 404);
    if (!brand.euka_store_id || !brand.euka_slug) {
      return fail('brand', `"${brand.brand_name}" is not linked to a Euka store, so it can't be auto-filled.`, 400);
    }

    // ── AuthZ: OL/Boss any; TL owner; APC/IPC assigned ───────────────
    let allowed = role === 'boss' || role === 'ol' || brand.owner_id === uid;
    if (!allowed) {
      const { data: assign } = await admin
        .from('brand_assignments').select('brand_id').eq('brand_id', brandId).eq('user_id', uid).maybeSingle();
      allowed = !!assign;
    }
    if (!allowed) return fail('auth', 'You do not have access to this brand.', 403);

    const storeId = String(brand.euka_store_id);
    const key = eukaKeyForSlug(String(brand.euka_slug));
    if (!key) return fail('config', `Euka key not configured for "${brand.brand_name}" — tell the developer.`, 500);

    // ── Month-to-Date window ──────────────────────────────────────────
    // The MTD month is decided by the WEEK'S END DATE: a week ending
    // 2026-07-04 is July MTD (2026-07-01..04), even though it began in June.
    // If the week already starts on the 1st, the weekly overview IS the MTD.
    //
    // This is the WIDEST window the function asks for — a week ending the 26th
    // means 26 days, not 7 — so it is the likeliest slow call. It used to run
    // sequentially AFTER the other three, which put the slowest request on the
    // critical path behind everything else. It depends on nothing but the input
    // dates, so it now goes in the same parallel batch: the whole function
    // takes as long as its slowest call instead of the sum of two rounds.
    const mtdStart = endDate.slice(0, 7) + '-01';
    const needMtd = mtdStart !== startDate;

    // ── Fetch the exact-match stats (mirrors buildEukaAutofillData) ──
    let overview: any, creatorsResp: any, prodResp: any, mtdResp: any;
    try {
      [overview, creatorsResp, prodResp, mtdResp] = await Promise.all([
        eukaPost('/dashboard/performance-overview', { storeId, startDate, endDate }, key, budget, timings),
        eukaPost('/dashboard/top-creators-by-gmv', { storeId, postedDateRange: { start: startDate, end: endDate }, limit: 5 }, key, budget, timings).catch(() => null),
        // products-performance carries per-product affiliateGmv + orders itself.
        // (It replaced top-products-by-video-revenue, which Euka removed in Aug
        // 2026 — that 404 was swallowed here, so product rows silently stopped
        // filling. Ranked by total GMV; we re-rank by AFFILIATE GMV below, so
        // ask for more rows than the 5 we keep.)
        eukaPost('/dashboard/products-performance', { storeId, postedDateRange: { start: startDate, end: endDate }, pageSize: 25, sortField: 'gmv', sortOrder: 'DESC' }, key, budget, timings).catch(() => null),
        // Best-effort: no MTD figure is a blank field, not a failed report.
        needMtd
          ? eukaPost('/dashboard/performance-overview', { storeId, startDate: mtdStart, endDate }, key,
              budget, timings, 'performance-overview (MTD)').catch(() => null)
          : Promise.resolve(null),
      ]);
    } catch (e) {
      // Out of time is its own failure and gets its own message: "Euka is slow
      // right now" is actionable, "Euka returned nothing" would be a lie.
      if ((e as any)?.timedOut) {
        return errOut('euka-timeout',
          'Euka did not answer within two minutes, so the auto-fill was stopped before the server cut it off. Euka is slow right now, not broken — try again in a few minutes, or fill this week in manually.',
          504, { ...(e as object), timings }, Date.now() - t0);
      }
      return errOut('euka-fetch', 'Euka did not return performance data for this period. It may be too recent (data not synced yet) or Euka may be temporarily unavailable. Try a slightly older week.', 502, { ...(e as object), timings }, Date.now() - t0);
    }
    if (!overview || overview.totalShopGMV == null) {
      return fail('euka-empty', 'Euka returned no performance numbers for this period. Pick a week whose data has settled and try again.', 502, { overview, timings });
    }

    // A week starting on the 1st IS its own MTD, so no second call was made.
    const mtdOverview: any = needMtd ? mtdResp : overview;
    const mtdGmv = money(mtdOverview?.totalShopGMV);

    // Top creators — TOP 3 by GMV; exact fields only (units sold left blank).
    // videosPosted falls back to 0 (not blank) so "no videos" reads explicitly.
    const topCreators = (creatorsResp?.affiliates || [])
      .map((c: any) => {
        const v = num(c.videoCount);
        return {
          name: c.handle ? `@${c.handle}` : '',
          videosPosted: v === '' ? 0 : v,
          itemsSold: '',
          gmv: money(c.totalGmv),
          notes: '',
        };
      })
      .filter((c: any) => c.name)
      .slice(0, 3);

    // Per-product AFFILIATE GMV + orders (the report's product columns) — one
    // response, no per-product fan-out. Products with no affiliate GMV are
    // dropped: the report's product table is an affiliate-performance table.
    const productHighlights = (prodResp?.products || [])
      .filter((p: any) => Number(p.affiliateGmv) > 0)
      .sort((a: any, b: any) => Number(b.affiliateGmv) - Number(a.affiliateGmv))
      .slice(0, 5)
      .map((p: any) => ({
        productId: p.productId || '',
        productName: p.title || '',
        unitsSold: num(p.orders),   // report uses ORDERS as "units"
        gmv: money(p.affiliateGmv),
        newVideos: '', videosMtd: '', samplesApprovedWeek: '', samplesApprovedMtd: '', notes: '',
      }));

    const data = {
      overallPerformance: {
        gmv: money(overview.totalShopGMV),
        affiliateGmv: money(overview.totalAffiliateGMV),
        orders: num(overview.totalOrders),
        samplesApproved: '', roi: '', shopPerformanceScore: '', videosPosted: '',
      },
      // Only the MTD GMV key — deep-merged so any manual MTD fields are kept.
      ...(mtdGmv !== '' ? { overallNotes: { gmv: mtdGmv } } : {}),
      overallInsights: insightsHtml(overview, topCreators),
      topCreators: topCreators.length ? topCreators : undefined,
      productHighlights: productHighlights.length ? productHighlights : undefined,
    };

    return json({
      brandLabel: brand.brand_name,
      period: { startDate, endDate },
      data,
      meta: {
        filledOverall: true,
        mtdGmv: mtdGmv !== '' ? mtdGmv : null,
        mtdPeriod: { startDate: mtdStart, endDate },
        creatorCount: topCreators.length,
        productCount: productHighlights.length,
        // Returned even on success: a run that took 70 of its 90 seconds is
        // one slow week away from failing, and this is the only place that
        // would show it before it does.
        elapsedMs: Date.now() - t0,
        timings,
      },
    });
  } catch (err) {
    console.error('euka-report-autofill failed:', { err: String(err), elapsedMs: Date.now() - t0, timings });
    return fail('unexpected', 'Something went wrong while auto-filling from Euka.', 500, { err: String(err), timings });
  }
});
