// ============================================================
// tts-crawl — the weekly TikTok Shop Academy re-crawl (mig 380 / 381).
//
//   POST {mode:'continue'} (or no body) from ai_crawl_tick() every minute while
//                          a crawl runs: one resumable batch (~100 s).
//   POST {mode:'start'}    a manual start: ai_crawl_start() (a running crawl is
//                          left alone), then a first batch.
//
// Deploy with --no-verify-jwt: the caller proves itself with the
// x-webhook-secret header (the same AI_INGEST_SECRET as ai-ingest). Writes only
// tts_articles (new / changed / retired rows); the ingest sweep embeds them.
// All logic is in _shared/ai/crawl/, which the Node tests run too.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { supabaseRpc } from '../_shared/ai/ingest/db.ts';
import { httpFetcher, runCrawl } from '../_shared/ai/crawl/runner.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_SECRET = Deno.env.get('AI_INGEST_SECRET') ?? '';

// Constant-time, so response timing does not leak how much of a guess matched.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!INGEST_SECRET || !sameSecret(req.headers.get('x-webhook-secret') ?? '', INGEST_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'function secrets missing' }, 500);

  const text = await req.text();
  let body: { mode?: unknown } | null = null;
  try { body = text.trim() ? JSON.parse(text) : null; } catch { return json({ error: 'body is not JSON' }, 400); }
  const mode = body?.mode ?? 'continue';
  if (mode !== 'continue' && mode !== 'start') return json({ error: "mode must be 'continue' or 'start'" }, 400);

  const rpc = supabaseRpc(createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }));
  try {
    const started = mode === 'start' ? await rpc('ai_crawl_start') : undefined;
    const result = await runCrawl({ rpc, fetch: httpFetcher(), workerId: `tts-crawl-${crypto.randomUUID()}` });
    return json({ ok: true, started, ...result });
  } catch (e) {
    console.error('tts-crawl:', String((e as Error)?.message ?? e).slice(0, 500));
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) }, 500);
  }
});
