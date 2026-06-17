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
const EUKA_API_KEY = Deno.env.get('EUKA_API_KEY') ?? '';
const EUKA_BASE = 'https://api.euka.ai/v0';
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — caps billed Euka calls

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
    if (!EUKA_API_KEY) return json({ error: 'EUKA_API_KEY not configured' }, 500);

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
    if (!path || !pathAllowed(path)) return json({ error: `path not allowed: ${path}` }, 400);

    const method: string = payload?.method
      || (path.startsWith('/dashboard/') ? 'POST' : 'GET');
    const body = payload?.body ?? null;
    const query = payload?.query ?? null;
    const fresh = payload?.fresh === true;

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
    const cacheKey = `${method}:${path}:${JSON.stringify(query || {})}:${JSON.stringify(body || {})}`;
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
        Authorization: `Bearer ${EUKA_API_KEY}`,
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
