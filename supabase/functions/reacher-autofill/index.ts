// ============================================================
// Edge Function: reacher-autofill
//
// "Auto Generate from Reacher" for brands that run on Reacher rather than Euka
// (Irwin Naturals). One function, two modes, so the credential, the access check
// and the error contract live in one place:
//
//   mode: 'report'      the weekly/monthly report's exact-match numbers
//   mode: 'checkpoint'  the Weekly Checkpoint's target invites + opted in
//
// What is filled, and -- just as important -- what is deliberately NOT, is
// documented in _shared/reacher.ts against the hand-entered reports it was
// validated on. The mapping is pure and unit-tested; this file is only plumbing.
//
// AuthZ is identical to euka-report-autofill: OL/Boss any brand; TL the brand
// they own; APC/IPC a brand assigned to them. A user only ever pulls their OWN
// brand's shop.
//
// Reacher's key sees several shops and is told which one with x-shop-id. That id
// comes from brands.reacher_shop_id (mig 427), never from the request body, so a
// caller cannot point their access to Irwin at another shop's data.
//
// Secret: REACHER_API_KEY
// Deploy: supabase functions deploy reacher-autofill
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { REACHER_BASE, buildReportData, buildCheckpoint } from '../_shared/reacher.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function errOut(stage: string, message: string, status = 500, detail?: unknown, elapsedMs?: number) {
  return json({ error: { stage, message, detail: detail ?? null, elapsedMs: elapsedMs ?? null } }, status);
}

// Supabase gives an edge function a 150s REQUEST IDLE TIMEOUT. Past it the gateway
// sends its own 504 and our message never arrives, so the total stays under it.
// Reacher's first call after idle took ~6s in testing; the cap is generous so a
// slow-but-working reply succeeds.
const ATTEMPT_TIMEOUT_MS = 40_000;
const TOTAL_BUDGET_MS = 110_000;
type Budget = { left: () => number };
const makeBudget = (ms: number): Budget => { const end = Date.now() + ms; return { left: () => end - Date.now() }; };

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

async function reacherPost(
  path: string, body: unknown, key: string, shopId: number, budget: Budget, timings: Record<string, number>,
  label?: string,
): Promise<any> {
  const startedAt = Date.now();
  const record = () => { timings[label ?? path] = Date.now() - startedAt; };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget.left();
    if (left <= 0) { record(); throw { path, lastErr: lastErr ?? 'ran out of time before this call', timedOut: true }; }
    try {
      const r = await fetch(REACHER_BASE + path, {
        method: 'POST',
        headers: {
          'x-api-key': key, 'x-shop-id': String(shopId),
          'Content-Type': 'application/json', Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, left)),
      });
      const text = await r.text();
      let data: any; try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) { record(); return data; }
      lastErr = { status: r.status, body: typeof data === 'string' ? data.slice(0, 300) : data };
      // 4xx other than 429 is the request being wrong; retrying cannot fix it.
      if (r.status >= 400 && r.status < 500 && r.status !== 429) break;
    } catch (e) {
      lastErr = String(e);
      if (budget.left() <= 0) { record(); throw { path, lastErr, timedOut: true }; }
    }
    if (attempt === 1) break;
    if (budget.left() <= 600) break;
    await new Promise((res) => setTimeout(res, 600));
  }
  record();
  throw { path, lastErr, timedOut: budget.left() <= 0 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const t0 = Date.now();
  const budget = makeBudget(TOTAL_BUDGET_MS);
  const timings: Record<string, number> = {};
  const fail = (stage: string, message: string, status = 500, detail?: unknown) =>
    errOut(stage, message, status, detail, Date.now() - t0);

  try {
    // ── AuthN ──────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return fail('auth', 'Not signed in — please refresh and try again.', 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return fail('auth', 'Your session expired — please sign in again.', 401);
    const uid = userData.user.id;
    const { data: profile } = await admin.from('profiles').select('role, is_active').eq('id', uid).maybeSingle();
    if (!profile || profile.is_active === false) return fail('auth', 'Your account is not active.', 403);
    const role = String(profile.role || '').toLowerCase();

    // ── Input ──────────────────────────────────────────────────────
    const payload = await req.json().catch(() => ({}));
    const mode = String(payload?.mode || 'report');
    const brandId = String(payload?.brandId || '').trim();
    const startDate = String(payload?.startDate || '').trim();
    const endDate = String(payload?.endDate || '').trim();
    if (mode !== 'report' && mode !== 'checkpoint') return fail('input', `Unknown mode "${mode}".`, 400);
    if (!brandId) return fail('input', 'No brand was provided.', 400);
    if (!isDate(startDate) || !isDate(endDate)) return fail('input', 'The stats period is invalid (need YYYY-MM-DD dates).', 400);
    if (startDate > endDate) return fail('input', 'The stats period start is after its end.', 400);

    // ── Resolve brand -> Reacher shop ──────────────────────────────
    const { data: brand } = await admin
      .from('brands').select('id, brand_name, owner_id, reacher_shop_id').eq('id', brandId).maybeSingle();
    if (!brand) return fail('brand', 'Brand not found.', 404);
    if (!brand.reacher_shop_id) {
      return fail('brand', `"${brand.brand_name}" is not linked to a Reacher shop, so it can't be auto-filled from Reacher.`, 400);
    }

    // ── AuthZ: OL/Boss any; TL owner; APC/IPC assigned ─────────────
    let allowed = role === 'boss' || role === 'ol' || brand.owner_id === uid;
    if (!allowed) {
      const { data: assign } = await admin
        .from('brand_assignments').select('brand_id').eq('brand_id', brandId).eq('user_id', uid).maybeSingle();
      allowed = !!assign;
    }
    if (!allowed) return fail('auth', 'You do not have access to this brand.', 403);

    const key = Deno.env.get('REACHER_API_KEY') || '';
    if (!key) return fail('config', 'Reacher key is not configured — tell the developer.', 500);
    const shopId = Number(brand.reacher_shop_id);
    const win = { start_date: startDate, end_date: endDate };
    const call = (path: string, body: unknown, label?: string) => reacherPost(path, body, key, shopId, budget, timings, label);

    // ═════════════════════════ CHECKPOINT ═════════════════════════
    if (mode === 'checkpoint') {
      const [summary, tier] = await Promise.all([
        call('/metrics/summary', win).catch((e) => ({ __err: e })),
        call('/creators/tier-performance', win).catch((e) => ({ __err: e })),
      ]);
      const out = buildCheckpoint(summary?.__err ? null : summary, tier?.__err ? null : tier?.weeks, startDate);
      const describe = (r: any) => (r?.__err ? `Reacher said ${JSON.stringify(r.__err.lastErr ?? r.__err).slice(0, 200)}` : null);
      return json({
        ...out,
        source: 'reacher',
        invitesError: describe(tier) || (out.targetInvites == null ? 'Reacher returned no outreach funnel for this week.' : null),
        funnelError: describe(summary) || (out.optedIn == null ? 'Reacher returned no sample-request count for this week.' : null),
        timings,
      });
    }

    // ═══════════════════════════ REPORT ═══════════════════════════
    // The week's headline numbers are the one fatal call. Everything else is
    // best-effort, but a best-effort failure is NAMED in meta.skipped instead of
    // vanishing into a catch -- twice already a swallowed Euka error blanked the
    // creator and product tables with nothing to say why.
    const skipped: string[] = [];
    const mtdStart = endDate.slice(0, 7) + '-01';
    const needMtd = mtdStart !== startDate;
    const soft = (name: string, p: Promise<any>) => p.catch(() => { skipped.push(name); return null; });

    let summary: any;
    let mtd: any, creatorsSummary: any, creatorsResp: any, productsResp: any, healthResp: any;
    try {
      [summary, mtd, creatorsSummary, creatorsResp, productsResp, healthResp] = await Promise.all([
        call('/metrics/summary', win),
        needMtd ? soft('monthToDate', call('/metrics/summary', { start_date: mtdStart, end_date: endDate }, 'metrics/summary (MTD)')) : Promise.resolve(null),
        soft('videosPosted', call('/creators/summary', win)),
        soft('topCreators', call('/creators/performance', win)),
        soft('productHighlights', call('/products/list', { ...win, page_size: 50 })),
        soft('shopPerformanceScore', call('/shop-health/timeseries', win)),
      ]);
    } catch (e) {
      if ((e as any)?.timedOut) {
        return fail('reacher-timeout',
          'Reacher did not answer in time, so the auto-fill was stopped before the server cut it off. Try again in a few minutes, or fill this week in manually.',
          504, { ...(e as object), timings });
      }
      const status = (e as { lastErr?: { status?: number } })?.lastErr?.status;
      const message = status === 401 || status === 403
        ? 'Reacher refused the key for this shop (' + status + '). That is a configuration problem, not missing data — tell the developer.'
        : status === 422 || status === 400
          ? 'Reacher rejected the request (' + status + '). That is a configuration problem, not missing data — a different week will not help. Tell the developer.'
          : 'Reacher did not return performance data for this period. It may be too recent (data not synced yet) or Reacher may be temporarily unavailable. Try a slightly older week.';
      return fail('reacher-fetch', message, 502, { ...(e as object), timings });
    }
    if (!summary || summary.total_gmv == null) {
      return fail('reacher-empty', 'Reacher returned no performance numbers for this period. Pick a week whose data has settled and try again.', 502, { summary, timings });
    }

    const built = buildReportData({
      summary,
      mtd: needMtd ? mtd : null,
      creatorsSummary,
      creators: creatorsResp?.data ?? null,
      products: productsResp?.data ?? null,
      health: healthResp?.series ?? null,
      endDate,
    });

    return json({
      brandLabel: brand.brand_name,
      period: { startDate, endDate },
      data: built.data,
      meta: {
        source: 'reacher',
        filledOverall: true,
        mtdGmv: built.mtdGmv !== '' ? built.mtdGmv : null,
        mtdPeriod: { startDate: mtdStart, endDate },
        creatorCount: built.creatorCount,
        productCount: built.productCount,
        skipped,
        elapsedMs: Date.now() - t0,
        timings,
      },
    });
  } catch (err) {
    console.error('reacher-autofill failed:', { err: String(err), elapsedMs: Date.now() - t0, timings });
    return fail('unexpected', 'Something went wrong while auto-filling from Reacher.', 500, { err: String(err), timings });
  }
});
