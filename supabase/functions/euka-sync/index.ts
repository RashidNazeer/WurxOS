// ============================================================
// Edge Function: euka-sync
//
// Pulls per-store TikTok Shop metrics from the Euka MCP server
// (query_store_data) and writes snapshots into euka_shop_metrics.
// Triggered every 3h by pg_cron, or on demand from the Shop
// Metrics dashboard ("Sync now").
//
// The comprehensive question makes Euka SAVE the metrics JSON to a
// sandbox file rather than return it inline; we resolve that path
// and fetch it with read_sandbox_file. The full metric set is
// stored in the `metrics` jsonb column ({ d7, d30, top }); the
// gmv_/units_/orders_ columns stay populated for easy querying.
//
// Self-rate-limited: a sync runs at most once per 10 minutes, so
// a duplicate trigger is a harmless no-op. Returns only counts —
// never the metric values — so the endpoint leaks nothing.
//
// Env (set via `supabase secrets set`):
//   EUKA_TOKEN                  Euka MCP bearer token
//   SUPABASE_URL                (auto)
//   SUPABASE_SERVICE_ROLE_KEY   (auto)
//
// Deploy: supabase functions deploy euka-sync --no-verify-jwt
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EUKA_TOKEN    = Deno.env.get('EUKA_TOKEN') ?? '';
const MCP_URL       = 'https://app.euka.ai/api/mcp';
const MIN_GAP_MS    = 10 * 60 * 1000;   // min spacing between syncs

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Minimal MCP (Streamable HTTP) client ─────────────────────────
let sessionId: string | null = null;
let idCounter = 0;

function parseBody(ct: string, text: string): any[] {
  if ((ct || '').includes('text/event-stream')) {
    const msgs: any[] = [];
    for (const l of text.split(/\r?\n/)) {
      if (l.startsWith('data:')) {
        try { msgs.push(JSON.parse(l.slice(5).trim())); } catch { /* ignore */ }
      }
    }
    return msgs;
  }
  try { return [JSON.parse(text)]; } catch { return []; }
}

async function mcp(method: string, params?: unknown, isNotification = false): Promise<any> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!isNotification) body.id = ++idCounter;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${EUKA_TOKEN}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (isNotification) return null;

  const msgs = parseBody(res.headers.get('content-type') || '', text);
  const reply = msgs.find((m) => m.id === body.id) || msgs[0];
  if (!reply) throw new Error(`MCP ${method}: no parseable reply`);
  if (reply.error) throw new Error(`MCP ${method} error: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

// The metrics question. query_store_data is an LLM and answers
// non-deterministically, so we ONLY ask for the metrics that came
// back bit-identical across repeated pulls and matched the Euka
// Performance Overview dashboard: Affiliate GMV, Videos Posted,
// Samples Shipped (all sourced straight from the affiliate table).
//
// Deliberately NOT asked for, because query_store_data returns them
// inconsistently (a different value each run):
//   • Total GMV / Orders / AOV — no all-channels data source at all
//   • Value Driven by Euka / EMV — computed attribution, flips run
//     to run (e.g. EMV 1383 vs 162)
//   • video_views / conversion rate — miscounted ~8x
//
// One window per query_store_data call: asking for two date ranges
// at once degrades accuracy further.
function buildWindowQuestion(start: string, end: string, withTop: boolean): string {
  return 'You are reading this store\'s TikTok Shop Performance Overview dashboard for the date '
    + 'range ' + start + ' to ' + end + ' inclusive. Report the headline tile values EXACTLY as '
    + 'that dashboard shows them for that range — do NOT recompute from raw data or estimate, '
    + 'use the dashboard\'s own aggregated numbers. DO NOT save anything to a file; put the JSON '
    + 'directly in your reply. Return ONLY a compact minified JSON object, no prose, no markdown '
    + 'fences, with these numeric keys (plain numbers — no currency symbols, no commas, no '
    + 'K-suffixes; null if unavailable): affiliate_gmv, videos_posted, samples_shipped'
    + (withTop ? ', top. ' : '. ')
    + 'affiliate_gmv = the Affiliate GMV tile; videos_posted = the Videos Posted tile; '
    + 'samples_shipped = the Samples Shipped tile.'
    + (withTop
      ? ' "top" is an object {"creator_name":string,"creator_gmv":number,"product_name":string,'
        + '"product_gmv":number} — the single best creator and best product by affiliate GMV '
        + 'over this range.'
      : '');
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Extract a JSON object from arbitrary text. Returns null unless the
// parsed object carries at least one expected metric key — this
// guards against storing a stray {...} (e.g. an error blob).
function tryParseObj(text: string): any | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o && typeof o === 'object'
      && ('affiliate_gmv' in o || 'videos_posted' in o || 'samples_shipped' in o)) return o;
  } catch { /* not JSON */ }
  return null;
}

// Resolve the sandbox path the query_store_data result points to.
function resolveSandboxPath(result: any): string | null {
  const sc = result?.structuredContent || {};
  if (Array.isArray(sc.artifacts) && sc.artifacts.length) {
    const a = sc.artifacts[0];
    const p = typeof a === 'string' ? a : (a?.path || a?.file || a?.name || null);
    if (p) return p;
  }
  const summary: string = sc.summary
    ?? (result?.content || []).map((c: any) => c.text || '').join('\n');
  const m = summary && summary.match(/(exports\/[\w./-]+\.json)/);
  return m ? m[1] : null;
}

// Run one query_store_data call and parse its window object. Inline
// reply first; if Euka still saved a file, fall back to the sandbox.
async function queryWindow(storeId: string, question: string): Promise<any> {
  const r = await mcp('tools/call', {
    name: 'query_store_data',
    arguments: { storeId, question },
  });

  const sc = r?.structuredContent || {};
  const summary: string = sc.summary
    ?? (r?.content || []).map((c: any) => c.text || '').join('\n');

  // 1. Inline JSON in the reply (the expected path).
  let obj = tryParseObj(summary);

  // 2. Fallback — Euka saved it to a sandbox file anyway.
  if (!obj) {
    const path = resolveSandboxPath(r);
    if (path) {
      const f = await mcp('tools/call', { name: 'read_sandbox_file', arguments: { path } });
      const fsc = f?.structuredContent || {};
      if (fsc.success !== false) {
        const fileText = typeof fsc.content === 'string'
          ? fsc.content
          : (f?.content || []).map((c: any) => c.text || '').join('\n');
        obj = tryParseObj(fileText);
      }
    }
  }

  if (!obj) throw new Error('no metrics JSON in Euka response');
  return { obj, summary };
}

// Pull the full metric set for one store — one query_store_data call
// per window (accuracy degrades badly if both are asked at once).
async function fetchStoreMetrics(
  storeId: string,
  win7: { start: string; end: string },
  win30: { start: string; end: string },
): Promise<any> {
  const r7  = await queryWindow(storeId, buildWindowQuestion(win7.start, win7.end, false));
  const r30 = await queryWindow(storeId, buildWindowQuestion(win30.start, win30.end, true));

  const top = r30.obj.top && typeof r30.obj.top === 'object' ? r30.obj.top : null;
  const d30 = { ...r30.obj };
  delete d30.top;

  const metrics = { d7: r7.obj, d30, top };
  return { metrics, summary: `7d: ${r7.summary}\n\n30d: ${r30.summary}` };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    if (!EUKA_TOKEN) throw new Error('EUKA_TOKEN not configured');

    // ── Rate limit — at most one sync per 10 minutes ─────────────
    const { data: last } = await admin
      .from('euka_shop_metrics')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.synced_at).getTime() < MIN_GAP_MS) {
      return new Response(JSON.stringify({ skipped: true, reason: 'synced recently' }),
        { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Fresh MCP session per run.
    sessionId = null; idCounter = 0;
    await mcp('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'wurxos-euka-sync', version: '2.0.0' },
    });
    await mcp('notifications/initialized', undefined, true);

    // ── Date windows — pinned so Euka reads the same dashboard
    //    presets our UI labels (7 / 30 calendar days ending today).
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const today = new Date();
    const back = (n: number) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - n); return d; };
    const win7  = { start: iso(back(6)),  end: iso(today) };
    const win30 = { start: iso(back(29)), end: iso(today) };

    // ── Stores ───────────────────────────────────────────────────
    const storesRes = await mcp('tools/call', { name: 'list_accessible_stores', arguments: {} });
    const stores: any[] = storesRes?.structuredContent?.result
      ?? (() => {
        try { return JSON.parse((storesRes?.content || [])[0]?.text || '[]'); }
        catch { return []; }
      })();

    let synced = 0;
    const names: string[] = [];

    for (const s of stores) {
      const storeId = s.storeId;
      if (!storeId) continue;
      const storeName = s.storeName || s.parentBrand?.brandName || 'Store';

      try {
        const { metrics, summary } = await fetchStoreMetrics(storeId, win7, win30);
        const d7  = metrics?.d7  || {};
        const d30 = metrics?.d30 || {};

        // Resolve the WurxOS brand: explicit mapping first, then name.
        let brandId: string | null = null;
        const { data: byStore } = await admin
          .from('brands').select('id').eq('euka_store_id', storeId).maybeSingle();
        if (byStore) {
          brandId = byStore.id;
        } else {
          const { data: byName } = await admin
            .from('brands').select('id').ilike('brand_name', storeName).limit(1).maybeSingle();
          if (byName) {
            brandId = byName.id;
            // Auto-link so future syncs use the explicit mapping.
            await admin.from('brands').update({ euka_store_id: storeId }).eq('id', brandId);
          }
        }

        // Legacy gmv_ columns now hold Affiliate GMV (the only GMV
        // Euka reports accurately); units/orders are left null since
        // Euka's API has no reliable all-channels figure for them.
        await admin.from('euka_shop_metrics').insert({
          euka_store_id: storeId,
          store_name: storeName,
          region: s.region || null,
          brand_id: brandId,
          gmv_7d: num(d7.affiliate_gmv),   units_7d: null, orders_7d: null,
          gmv_30d: num(d30.affiliate_gmv), units_30d: null, orders_30d: null,
          metrics,
          raw: { parsed: metrics, summary },
        });
        synced += 1;
        names.push(storeName);
      } catch (err) {
        console.error(`euka-sync: store ${storeName} failed —`, err);
      }
    }

    return new Response(JSON.stringify({ synced, stores: names }),
      { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('euka-sync failed:', err);
    return new Response(JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
