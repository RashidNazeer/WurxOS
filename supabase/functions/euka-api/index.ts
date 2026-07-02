// ============================================================
// Edge Function: euka-api
//
// Secure, Boss-only proxy to the Euka REST API (https://api.euka.ai/v0).
//
// Why a proxy: the Euka OpenAPI key is a full-read secret for the whole
// brand's sales/creator/store data. It must NEVER reach the browser. This
// function holds the key as a secret, verifies the caller is an active Boss
// (via their Supabase JWT), forwards the allow-listed request to Euka, and
// CACHES the response for a short TTL so we don't burn Euka API calls /
// billing on repeated dashboard views.
//
// Request body (JSON):
//   { path: "/dashboard/performance-overview", method?: "GET"|"POST",
//     body?: {...}, query?: {...}, fresh?: boolean }
//   - path must be one of the allow-listed Euka paths.
//   - method defaults to POST for /dashboard/*, GET otherwise.
//   - fresh=true bypasses the cache (the "Refresh" button).
//
// Env (supabase secrets set):
//   EUKA_API_KEY                Euka OpenAPI key (euka_openapi_...)
//   SUPABASE_URL / SERVICE_ROLE_KEY (auto)
//
// Deploy: supabase functions deploy euka-api
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EUKA_BASE = 'https://api.euka.ai/v0';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — caps billed Euka calls

// ── Brands are DATA-DRIVEN by env secrets — no code edit to add one ──
// Each Euka brand is a SEPARATE OpenAPI account/key. Brands are discovered
// from env vars by convention so a NEW brand needs only a secret (and one
// optional label), never a redeploy of this routing code:
//   EUKA_API_KEY              → brand slug "solidgold" (the original)
//   EUKA_API_KEY_INNOSUPPS    → brand slug "innosupps"
//   EUKA_API_KEY_<SLUG>       → brand slug "<slug>" (lowercased)
// Optional human labels live in EUKA_BRAND_LABELS (JSON, e.g.
//   {"solidgold":"Solid Gold Pets","innosupps":"InnoSupps"}); a missing
// label falls back to a title-cased slug. The frontend reads the brand
// list from the virtual `/__brands` endpoint below, so adding a brand is
// purely a secrets change.
const DEFAULT_BRAND = 'solidgold';

function brandLabels(): Record<string, string> {
  try { return JSON.parse(Deno.env.get('EUKA_BRAND_LABELS') || '{}'); }
  catch { return {}; }
}
function titleCase(slug: string): string {
  return slug.replace(/(^|[-_ ])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
}

// A brand resolves to a Euka key AND (for shared-key brands) a specific
// storeId to scope requests. Two sources, unioned:
//   1. Per-key brands (original): EUKA_API_KEY (=DEFAULT_BRAND) and
//      EUKA_API_KEY_<SLUG>. Each key owns exactly one store, so no storeId is
//      needed — the frontend reads it from /stores.
//   2. Shared-key brands (new): ONE key (EUKA_SHARED_API_KEY) covers many
//      brands. Which store each brand maps to lives in EUKA_SHARED_BRANDS, a
//      JSON map { "<slug>": "<storeId>", ... }. Adding a brand on the shared
//      account = add one line to that JSON secret. Because the shared key sees
//      ALL stores, the server MUST inject the right storeId per brand (the
//      frontend can't tell them apart from /stores).
type BrandEntry = { key: string; storeId?: string };

function discoverBrands(): Record<string, BrandEntry> {
  const env = Deno.env.toObject();
  const out: Record<string, BrandEntry> = {};
  // (1) per-key brands
  for (const [name, val] of Object.entries(env)) {
    if (!val) continue;
    if (name === 'EUKA_API_KEY') out[DEFAULT_BRAND] = { key: val };
    else if (name.startsWith('EUKA_API_KEY_')) {
      const slug = name.slice('EUKA_API_KEY_'.length).toLowerCase();
      if (slug) out[slug] = { key: val };
    }
  }
  // (2) shared-key brands
  const sharedKey = env['EUKA_SHARED_API_KEY'] || '';
  if (sharedKey) {
    let map: Record<string, string> = {};
    try { map = JSON.parse(env['EUKA_SHARED_BRANDS'] || '{}'); } catch { map = {}; }
    for (const [slug, storeId] of Object.entries(map)) {
      const s = slug.toLowerCase();
      if (s && storeId) out[s] = { key: sharedKey, storeId: String(storeId) };
    }
  }
  return out;
}

// Public brand list for the frontend dropdown — slugs + labels, NO keys.
function brandList(): Array<{ slug: string; label: string }> {
  const labels = brandLabels();
  const brands = discoverBrands();
  return Object.keys(brands)
    .sort((a, b) => (a === DEFAULT_BRAND ? -1 : b === DEFAULT_BRAND ? 1 : a.localeCompare(b)))
    .map((slug) => ({ slug, label: labels[slug] || titleCase(slug) }));
}

function keyForBrand(brand: string | null): { slug: string; key: string; storeId?: string } {
  const brands = discoverBrands();
  const slug = brand && brands[brand] ? brand : DEFAULT_BRAND;
  const entry = brands[slug] || { key: '' };
  return { slug, key: entry.key || '', storeId: entry.storeId };
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Allow-list: exact GET paths + the POST /dashboard/* family + data-export.
const GET_PATHS = new Set(['/ping', '/me', '/brands', '/stores']);
function pathAllowed(path: string): boolean {
  if (GET_PATHS.has(path)) return true;
  if (path === '/data-export') return true;
  if (path.startsWith('/dashboard/')) return true;
  return false;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // ── AuthN/AuthZ: caller must be an active Boss ──────────────────
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthenticated' }, 401);

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'unauthenticated' }, 401);

    const { data: profile } = await admin
      .from('profiles')
      .select('role, is_active')
      .eq('id', userData.user.id)
      .maybeSingle();
    if (!profile || profile.is_active === false || profile.role !== 'boss') {
      return json({ error: 'forbidden — Boss only' }, 403);
    }

    // ── Parse + validate the request ────────────────────────────────
    const payload = await req.json().catch(() => ({}));
    const path: string = payload?.path || '';

    // Virtual endpoint: the frontend asks which brands exist (slugs + labels,
    // never keys) so its dropdown auto-discovers brands from env secrets.
    if (path === '/__brands') return json({ data: brandList() });

    if (!path || !pathAllowed(path)) return json({ error: `path not allowed: ${path}` }, 400);

    const method: string = payload?.method
      || (path.startsWith('/dashboard/') ? 'POST' : 'GET');
    let body = payload?.body ?? null;
    const query = payload?.query ?? null;
    const fresh = payload?.fresh === true;

    // Pick the Euka key (+ store, for shared-key brands) for the requested brand.
    const { slug: brandSlug, key: brandKey, storeId: brandStoreId } = keyForBrand(payload?.brand ?? null);
    if (!brandKey) return json({ error: `Euka key not configured for brand "${brandSlug}"` }, 500);

    // Shared-key brands: the key sees ALL stores, so the frontend can't tell
    // them apart. Force the request to THIS brand's store so it can never read
    // a sibling brand's data. (Dashboard endpoints take storeId in the body.)
    if (brandStoreId) {
      if (path.startsWith('/dashboard/') || path === '/data-export') {
        body = { ...(body && typeof body === 'object' ? body : {}), storeId: brandStoreId };
      }
    }

    // Build the upstream URL (+ query string for GET endpoints).
    let url = EUKA_BASE + path;
    if (query && typeof query === 'object') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    // ── Cache (skip CSV exports — they can be large/streamed) ───────
    const isExport = path === '/data-export';
    const cacheKey = `${brandSlug}:${method}:${path}:${JSON.stringify(query || {})}:${JSON.stringify(body || {})}`;
    if (!fresh && !isExport) {
      const { data: hit } = await admin
        .from('euka_api_cache')
        .select('payload, fetched_at')
        .eq('cache_key', cacheKey)
        .maybeSingle();
      if (hit && (Date.now() - new Date(hit.fetched_at).getTime() < CACHE_TTL_MS)) {
        return json({ data: hit.payload, cached: true, fetchedAt: hit.fetched_at });
      }
    }

    // ── Forward to Euka ─────────────────────────────────────────────
    const upstream = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${brandKey}`,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' && body ? { body: JSON.stringify(body) } : {}),
    });

    const ct = upstream.headers.get('content-type') || '';
    if (isExport && ct.includes('text/csv')) {
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'text/csv' },
      });
    }

    const text = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!upstream.ok) {
      return json({ error: `Euka ${upstream.status}`, detail: data }, upstream.status === 401 ? 502 : upstream.status);
    }

    // Shared-key brands: the key lists ALL stores/brands on the account. Narrow
    // /stores (and /brands) to JUST the selected brand so the frontend — which
    // takes stores[0] — never picks a sibling brand's store.
    if (brandStoreId && Array.isArray(data)) {
      if (path === '/stores') data = (data as any[]).filter((s) => s?.id === brandStoreId);
    }

    // Store in cache (best-effort; never block the response on a cache write).
    if (!isExport) {
      admin.from('euka_api_cache')
        .upsert({ cache_key: cacheKey, payload: data, fetched_at: new Date().toISOString() })
        .then(() => {}, () => {});
    }

    return json({ data, cached: false, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('euka-api failed:', err);
    return json({ error: String(err) }, 500);
  }
});
