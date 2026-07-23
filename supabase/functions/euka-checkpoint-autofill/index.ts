// ============================================================
// Edge Function: euka-checkpoint-autofill
//
// Fills the two Euka-sourced fields of the Weekly Checkpoint funnel:
//   funnel.targetInvites  ← count of /data-export?type=target_collab_invites rows
//   funnel.optedIn        ← the "opted in / accepted" stage of
//                           /dashboard/creator-outreach-funnel
// for a brand's Euka store over a date window. The opt-in RATE is derived on the
// client (pct(optedIn, targetInvites)) — we only return the two counts.
//
// Runs server-side so the Euka key never reaches the browser, and (mirroring
// euka-report-autofill) is callable by APC/IPC (assigned) / TL (owner) / OL /
// Boss — a user only ever pulls their OWN brand's store. Brands not linked to a
// Euka store 400 (the client checks euka_store_id first and skips them).
//
// The opt-in stage label isn't fixed in our code, so we match it by regex and
// ALSO return the raw stage labels (optInStage / funnelStages) — if a brand's
// funnel uses a different label, optedIn comes back null (left manual) and the
// labels tell us what to match next.
//
// Deploy: supabase functions deploy euka-checkpoint-autofill
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EUKA_BASE = 'https://api.euka.ai/v0';

function eukaKeyForSlug(slug: string): string {
  if (slug === 'solidgold') return Deno.env.get('EUKA_API_KEY') || '';
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
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function errOut(stage: string, message: string, status = 500, detail?: unknown) {
  return json({ error: { stage, message, detail: detail ?? null } }, status);
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const intOrNull = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

// POST /dashboard/* with light retry.
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
      let data: any; try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) return data;
      lastErr = { status: r.status, body: typeof data === 'string' ? data.slice(0, 300) : data };
      if (r.status === 400 || r.status === 401 || r.status === 403) break;
    } catch (e) { lastErr = String(e); }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  throw { path, lastErr };
}

// GET (for /data-export, which is a GET and never cached) with light retry.
async function eukaGet(path: string, key: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(EUKA_BASE + path, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      const text = await r.text();
      let data: any; try { data = JSON.parse(text); } catch { data = text; }
      if (r.ok && !data?.error) return data;
      lastErr = data?.error || `HTTP ${r.status}`;
      if (r.status === 400) return data;
    } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  throw new Error(`Euka request failed: ${String(lastErr)}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    // ── AuthN ──────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return errOut('auth', 'Not signed in — please refresh and try again.', 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return errOut('auth', 'Your session expired — please sign in again.', 401);
    const uid = userData.user.id;
    const { data: profile } = await admin.from('profiles').select('role, is_active').eq('id', uid).maybeSingle();
    if (!profile || profile.is_active === false) return errOut('auth', 'Your account is not active.', 403);
    const role = String(profile.role || '').toLowerCase();

    // ── Input ──────────────────────────────────────────────────────
    const payload = await req.json().catch(() => ({}));
    const brandId: string = String(payload?.brandId || '').trim();
    const startDate: string = String(payload?.startDate || '').trim();
    const endDate: string = String(payload?.endDate || '').trim();
    if (!brandId) return errOut('input', 'No brand was provided.', 400);
    if (!isDate(startDate) || !isDate(endDate)) return errOut('input', 'The period is invalid (need YYYY-MM-DD dates).', 400);
    if (startDate > endDate) return errOut('input', 'The period start is after its end.', 400);

    // ── Resolve brand → store + slug + key ─────────────────────────
    const { data: brand } = await admin
      .from('brands').select('id, brand_name, owner_id, euka_store_id, euka_slug').eq('id', brandId).maybeSingle();
    if (!brand) return errOut('brand', 'Brand not found.', 404);
    if (!brand.euka_store_id || !brand.euka_slug) {
      return errOut('brand', `"${brand.brand_name}" is not linked to a Euka store.`, 400);
    }

    // ── AuthZ: OL/Boss any; TL owner; APC/IPC assigned ─────────────
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

    // ── Fetch both metrics in parallel (each failure = null, non-fatal) ──
    const qs = `type=target_collab_invites&store_id=${encodeURIComponent(storeId)}&start_date=${startDate}&end_date=${endDate}&export_type=json`;
    const [invitesResp, funnelResp] = await Promise.all([
      eukaGet(`/data-export?${qs}`, key).catch((e) => ({ __err: String(e) })),
      eukaPost('/dashboard/creator-outreach-funnel', { storeId, postedDateRange: { start: startDate, end: endDate } }, key).catch((e) => ({ __err: String(e) })),
    ]);

    const targetInvites = Array.isArray(invitesResp?.data) ? invitesResp.data.length : null;

    const stages = Array.isArray(funnelResp?.stages) ? funnelResp.stages : [];
    const funnelStages: string[] = stages.map((s: any) => s?.label).filter(Boolean);
    const hit = stages.find((s: any) => /opt.?in|accept|sign.?up/i.test(String(s?.label || '')));
    const optedIn = hit ? intOrNull(hit.value) : null;

    return json({
      targetInvites,
      optedIn,
      optInStage: hit ? hit.label : null,
      funnelStages,
      invitesError: invitesResp?.__err || null,
      funnelError: funnelResp?.__err || null,
    });
  } catch (e) {
    return errOut('unknown', 'Something went wrong pulling from Euka.', 500, String(e));
  }
});
