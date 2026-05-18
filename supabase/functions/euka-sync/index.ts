// ============================================================
// Edge Function: euka-sync
//
// Pulls per-store TikTok Shop metrics from the Euka MCP server
// (query_store_data) and writes snapshots into euka_shop_metrics.
// Triggered every 3h by pg_cron, or on demand from the Shop
// Metrics dashboard ("Sync now").
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

const METRICS_QUESTION =
  'Return ONLY a compact minified JSON object and nothing else — no prose, no explanation, '
  + 'no markdown code fences. Use exactly these keys with plain numeric values (no currency '
  + 'symbols, no commas, no quotes around numbers): gmv_7d, units_7d, orders_7d, gmv_30d, '
  + 'units_30d, orders_30d. gmv = total GMV in USD across all channels; units = total units '
  + 'sold; orders = total orders. The _7d keys cover the last 7 days; the _30d keys cover the '
  + 'last 30 days.';

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
      clientInfo: { name: 'wurxos-euka-sync', version: '1.0.0' },
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
        const r = await mcp('tools/call', {
          name: 'query_store_data',
          arguments: { storeId, question: METRICS_QUESTION },
        });
        const summary: string = r?.structuredContent?.summary
          ?? (r?.content || []).map((c: any) => c.text || '').join('\n');
        const jm = summary && summary.match(/\{[\s\S]*\}/);
        const m = jm ? JSON.parse(jm[0]) : {};

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
          gmv_7d: num(m.gmv_7d), units_7d: num(m.units_7d), orders_7d: num(m.orders_7d),
          gmv_30d: num(m.gmv_30d), units_30d: num(m.units_30d), orders_30d: num(m.orders_30d),
          raw: { parsed: m, summary },
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
