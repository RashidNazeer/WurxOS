// ============================================================
// ai-ingest — the Assistant v2 ingest worker (architecture.md §9.5).
//
//   POST {mode:'drain'}  (or no body) from ai_ingest_tick() (mig 375), every
//                        minute but only when the queue has claimable work.
//   POST {mode:'sweep'}  a manual trigger: ai_run_ingestion() (mig 379), then drain.
//
// Deploy with --no-verify-jwt: the caller proves itself with the shared
// x-webhook-secret header instead. All logic is in _shared/ai/ingest/run.ts
// and worker.ts, which scripts/ingest.mjs and the tests run under Node too.
//
// Secrets: AI_INGEST_SECRET (same value as app_config.ai_ingest_secret),
// OPEN_AI_API_KEY; SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are built in.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { supabaseRpc } from '../_shared/ai/ingest/db.ts';
import { parseMode, runIngest } from '../_shared/ai/ingest/run.ts';
import { openAiEmbedder } from '../_shared/ai/ingest/worker.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_SECRET = Deno.env.get('AI_INGEST_SECRET') ?? '';
const OPENAI_KEY = Deno.env.get('OPEN_AI_API_KEY') ?? '';
const OPENAI_KEY_FALLBACK = Deno.env.get('OPEN_AI_API_KEY_FALLBACK') ?? '';
// The second vector space (mig 406): the provider is a setting (mig 408,
// embed_alt_provider), so every key is handed over and the worker picks.
const ALT_KEYS = {
  nvidia: Deno.env.get('NVIDIA_API_KEY') ?? null,
  nvidia2: Deno.env.get('NVIDIA_API_KEY_2') ?? null,
  gemini: Deno.env.get('GEMINI_API_KEY') ?? null,
};

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
  if (!SUPABASE_URL || !SERVICE_KEY || !OPENAI_KEY) return json({ error: 'function secrets missing' }, 500);

  const text = await req.text();
  let body: unknown = null;
  try { body = text.trim() ? JSON.parse(text) : null; } catch { return json({ error: 'body is not JSON' }, 400); }
  const mode = parseMode(body);
  if (!mode) return json({ error: "mode must be 'drain' or 'sweep'" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    const result = await runIngest(mode, {
      rpc: supabaseRpc(admin),
      embed: openAiEmbedder([OPENAI_KEY, OPENAI_KEY_FALLBACK]),
      altKeys: ALT_KEYS,
    });
    return json({ ok: true, ...result });
  } catch (e) {
    console.error('ai-ingest:', String((e as Error)?.message ?? e).slice(0, 500));
    return json({ ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) }, 500);
  }
});
