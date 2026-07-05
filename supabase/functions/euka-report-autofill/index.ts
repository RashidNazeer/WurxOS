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
//   topCreators[]:      name (@handle), videosPosted (videoCount),
//                       gmv (totalGmv)   [itemsSold left blank]
//   productHighlights[]: productId, productName (title),
//                       unitsSold (per-product totalOrders — the report uses
//                       orders as "units"), gmv (per-product totalAffiliateGMV)
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
// A structured error the client can show verbatim + copy to Discord. `stage`
// says WHERE it failed so a developer can triage fast.
function errOut(stage: string, message: string, status = 500, detail?: unknown) {
  return json({ error: { stage, message, detail: detail ?? null } }, status);
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
// Counts (orders, videos, units) → integer. Money (GMV) → 2-decimal exact, to
// avoid float noise like 4812.860000000001 showing in the report fields.
const num = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? '' : Math.round(Number(v)));
const money = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? '' : Number(Number(v).toFixed(2)));

// POST a /dashboard/* endpoint with light retry (Pakistani ISPs + Euka throttling).
async function eukaPost(path: string, body: unknown, key: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(EUKA_BASE + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) return data;
      lastErr = { status: r.status, body: typeof data === 'string' ? data.slice(0, 300) : data };
      if (r.status === 400 || r.status === 401 || r.status === 403) break; // won't fix on retry
    } catch (e) { lastErr = String(e); }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  throw { path, lastErr };
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

  try {
    // ── AuthN ────────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return errOut('auth', 'Not signed in — please refresh and try again.', 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return errOut('auth', 'Your session expired — please sign in again.', 401);
    const uid = userData.user.id;
    const { data: profile } = await admin
      .from('profiles').select('role, is_active').eq('id', uid).maybeSingle();
    if (!profile || profile.is_active === false) return errOut('auth', 'Your account is not active.', 403);
    const role = String(profile.role || '').toLowerCase();

    // ── Input ────────────────────────────────────────────────────────
    const payload = await req.json().catch(() => ({}));
    const brandId: string = String(payload?.brandId || '').trim();
    const startDate: string = String(payload?.startDate || '').trim();
    const endDate: string = String(payload?.endDate || '').trim();
    if (!brandId) return errOut('input', 'No brand was provided.', 400);
    if (!isDate(startDate) || !isDate(endDate)) return errOut('input', 'The stats period is invalid (need YYYY-MM-DD dates).', 400);
    if (startDate > endDate) return errOut('input', 'The stats period start is after its end.', 400);

    // ── Resolve brand → store + slug + key ───────────────────────────
    const { data: brand } = await admin
      .from('brands').select('id, brand_name, owner_id, euka_store_id, euka_slug').eq('id', brandId).maybeSingle();
    if (!brand) return errOut('brand', 'Brand not found.', 404);
    if (!brand.euka_store_id || !brand.euka_slug) {
      return errOut('brand', `"${brand.brand_name}" is not linked to a Euka store, so it can't be auto-filled.`, 400);
    }

    // ── AuthZ: OL/Boss any; TL owner; APC/IPC assigned ───────────────
    let allowed = role === 'boss' || role === 'ol' || brand.owner_id === uid;
    if (!allowed) {
      const { data: assign } = await admin
        .from('brand_assignments').select('brand_id').eq('brand_id', brandId).eq('user_id', uid).maybeSingle();
      allowed = !!assign;
    }
    if (!allowed) return errOut('auth', 'You do not have access to this brand.', 403);

    const storeId = String(brand.euka_store_id);
    const key = eukaKeyForSlug(String(brand.euka_slug));
    if (!key) return errOut('config', `Euka key not configured for "${brand.brand_name}" — tell the developer.`, 500);

    // ── Fetch the exact-match stats (mirrors buildEukaAutofillData) ──
    let overview: any, creatorsResp: any, prodResp: any;
    try {
      [overview, creatorsResp, prodResp] = await Promise.all([
        eukaPost('/dashboard/performance-overview', { storeId, startDate, endDate }, key),
        eukaPost('/dashboard/top-creators-by-gmv', { storeId, postedDateRange: { start: startDate, end: endDate }, limit: 10 }, key).catch(() => null),
        eukaPost('/dashboard/top-products-by-video-revenue', { storeId, postedDateRange: { start: startDate, end: endDate }, limit: 10 }, key).catch(() => null),
      ]);
    } catch (e) {
      return errOut('euka-fetch', 'Euka did not return performance data for this period. It may be too recent (data not synced yet) or Euka may be temporarily unavailable. Try a slightly older week.', 502, e);
    }
    if (!overview || overview.totalShopGMV == null) {
      return errOut('euka-empty', 'Euka returned no performance numbers for this period. Pick a week whose data has settled and try again.', 502, { overview });
    }

    // Top creators — exact fields only (units sold left blank).
    const topCreators = (creatorsResp?.affiliates || []).map((c: any) => ({
      name: c.handle ? `@${c.handle}` : '',
      videosPosted: num(c.videoCount),
      itemsSold: '',
      gmv: money(c.totalGmv),
      notes: '',
    })).filter((c: any) => c.name);

    // Per-product AFFILIATE GMV + orders (the report's product columns).
    const baseProducts = prodResp?.products || [];
    let productHighlights: any[] = [];
    try {
      const withGmv = await Promise.all(baseProducts.map((p: any) =>
        eukaPost('/dashboard/performance-overview', { storeId, startDate, endDate, productIds: [p.productId] }, key)
          .then((o: any) => ({ ...p, affiliateGmv: o?.totalAffiliateGMV ?? null, orders: o?.totalOrders ?? null }))
          .catch(() => ({ ...p, affiliateGmv: null, orders: null })),
      ));
      productHighlights = withGmv
        .filter((p: any) => Number(p.affiliateGmv) > 0)
        .sort((a: any, b: any) => Number(b.affiliateGmv) - Number(a.affiliateGmv))
        .slice(0, 8)
        .map((p: any) => ({
          productId: p.productId || '',
          productName: p.title || '',
          unitsSold: num(p.orders),   // report uses ORDERS as "units"
          gmv: money(p.affiliateGmv),
          newVideos: '', videosMtd: '', samplesApprovedWeek: '', samplesApprovedMtd: '', notes: '',
        }));
    } catch { productHighlights = []; }

    const data = {
      overallPerformance: {
        gmv: money(overview.totalShopGMV),
        affiliateGmv: money(overview.totalAffiliateGMV),
        orders: num(overview.totalOrders),
        samplesApproved: '', roi: '', shopPerformanceScore: '', videosPosted: '',
      },
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
        creatorCount: topCreators.length,
        productCount: productHighlights.length,
      },
    });
  } catch (err) {
    console.error('euka-report-autofill failed:', err);
    return errOut('unexpected', 'Something went wrong while auto-filling from Euka.', 500, String(err));
  }
});
