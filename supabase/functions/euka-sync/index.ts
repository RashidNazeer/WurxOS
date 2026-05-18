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

// The comprehensive question — Euka saves the result to a sandbox
// file as pure JSON; the summary is just a pointer to that file.
const METRICS_QUESTION =
  'Compute a metrics object and SAVE IT to a sandbox file as pure JSON. Exact shape: '
  + '{"d7":{...},"d30":{...},"top":{"creator_name":string,"creator_gmv":number,'
  + '"product_name":string,"product_gmv":number}}. d7 = last 7 days, d30 = last 30 days; each '
  + 'has numeric keys (plain numbers, no symbols/commas, null if unavailable): gmv, video_gmv, '
  + 'units, orders, aov, active_creators, videos_posted, video_views, ad_spend, roas, '
  + 'sample_requests, outreach_messages, collab_invites. The saved file must contain ONLY the '
  + 'JSON object, nothing else.';

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

// Pull the metrics JSON for one store via the sandbox-file flow.
async function fetchStoreMetrics(storeId: string): Promise<any> {
  const r = await mcp('tools/call', {
    name: 'query_store_data',
    arguments: { storeId, question: METRICS_QUESTION },
  });

  // The result may be inline JSON (small answers) or a saved file.
  const sc = r?.structuredContent || {};
  const summary: string = sc.summary
    ?? (r?.content || []).map((c: any) => c.text || '').join('\n');

  const path = resolveSandboxPath(r);
  let jsonText = '';
  if (path) {
    const f = await mcp('tools/call', { name: 'read_sandbox_file', arguments: { path } });
    const fsc = f?.structuredContent || {};
    jsonText = typeof fsc.content === 'string'
      ? fsc.content
      : (f?.content || []).map((c: any) => c.text || '').join('\n');
  } else {
    jsonText = summary || '';
  }

  const jm = jsonText.match(/\{[\s\S]*\}/);
  if (!jm) throw new Error('no JSON in Euka response');
  return { metrics: JSON.parse(jm[0]), summary };
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
        const { metrics, summary } = await fetchStoreMetrics(storeId);
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

        await admin.from('euka_shop_metrics').insert({
          euka_store_id: storeId,
          store_name: storeName,
          region: s.region || null,
          brand_id: brandId,
          gmv_7d: num(d7.gmv),   units_7d: num(d7.units),   orders_7d: num(d7.orders),
          gmv_30d: num(d30.gmv), units_30d: num(d30.units), orders_30d: num(d30.orders),
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
