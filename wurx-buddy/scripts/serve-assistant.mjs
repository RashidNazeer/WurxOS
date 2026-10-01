// ============================================================
// Local Assistant v2 server for dev testing and the eval. DEV only.
//
//   node --experimental-strip-types scripts/serve-assistant.mjs [--port 8787] [--as-user <uuid>] [--model <model>] [--key-slot primary|fallback|groq|gemini] [--no-rate-limit]
//   --model overrides ai_assistant_config.model for this server only (e.g. to compare models);
//   without --key-slot it must be a built-in OpenAI model, with it any model that key serves.
//   Keys: OPEN_AI_API_KEY, OPEN_AI_API_KEY_FALLBACK, GROQ_Fallback (or GROQ_API_KEY), Gemini_Fallback (or GEMINI_API_KEY), OPEN_AI_NVA (or NVIDIA_API_KEY), NEM_API (or NVIDIA_API_KEY_2).
//
//   POST http://127.0.0.1:<port>/assistant   (the same contract as the edge
//   function supabase/functions/assistant; run-eval --engine v2 --base-url
//   http://localhost:<port> works against it)
//
// Auth: a dev Supabase user JWT (Authorization: Bearer …), verified against the
// dev auth server, Boss-only as in production. With --as-user the server
// answers as that profile without a token (local testing only; search then
// runs as the service role with p_as_user, the Slack relay's path). No JWT is
// minted, so the data tools get no caller client: for a non-Boss --as-user the
// people & pay tools refuse (fail closed). Test non-Boss roles with a real JWT.
//
// Listens on 127.0.0.1 only. Reads ../.env.dev and refuses anything that is
// not the dev project. Every question costs real (small) OpenAI money.
// ============================================================
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { devDbUrl, readEnv } from './dev-env.mjs';
import { json } from '../supabase/functions/_shared/ai/agent/http.ts';
import { checkProfile, handleAsk, identify } from '../supabase/functions/_shared/ai/agent/server.ts';
import { ALLOWED_MODELS } from '../supabase/functions/_shared/ai/llm/openai.ts';
import { KEY_SLOTS } from '../supabase/functions/_shared/ai/agent/models.ts';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt('--port') ?? 8787);
const asUser = opt('--as-user') ?? null;
const modelOverride = opt('--model');
const keySlot = opt('--key-slot');
if (keySlot && (!modelOverride || !KEY_SLOTS.includes(keySlot))) { console.error(`--key-slot needs --model and one of: ${KEY_SLOTS.join(', ')}`); process.exit(1); }
if (modelOverride && !keySlot && !ALLOWED_MODELS.includes(modelOverride)) { console.error(`--model must be one of: ${ALLOWED_MODELS.join(', ')} (or pass --key-slot)`); process.exit(1); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (asUser && !UUID.test(asUser)) { console.error('--as-user must be a profile uuid'); process.exit(1); }

devDbUrl();   // exits unless ../.env.dev points at the dev project
const env = readEnv();
const devRef = env.WURXOS_DEV_PROJECT_REF;
const url = env.VITE_SUPABASE_URL || '';
if (new URL(url).hostname !== `${devRef}.supabase.co`) { console.error('Refusing: VITE_SUPABASE_URL is not the dev project.'); process.exit(1); }
for (const k of ['WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_ANON_KEY', 'OPEN_AI_API_KEY']) {
  if (!env[k]) { console.error(`${k} missing in ../.env.dev`); process.exit(1); }
}
const serverEnv = { url, serviceKey: env.WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY, anonKey: env.VITE_SUPABASE_ANON_KEY, openAiKey: env.OPEN_AI_API_KEY, openAiKeyFallback: env.OPEN_AI_API_KEY_FALLBACK || null, groqKey: env.GROQ_API_KEY || env.GROQ_Fallback || null, geminiKey: env.GEMINI_API_KEY || env.Gemini_Fallback || null, nvidiaKey: env.NVIDIA_API_KEY || env.OPEN_AI_NVA || null, nvidia2Key: env.NVIDIA_API_KEY_2 || env.NEM_API || null, noRateLimit: argv.includes('--no-rate-limit'), createClient, ...(modelOverride ? { modelOverride, ...(keySlot ? { modelKeySlot: keySlot } : {}) } : {}) };
const admin = createClient(url, serverEnv.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// GET /__log/<requestId>: the request-log row in the shape run-eval reads
// (its --mock-auth path fetches this instead of querying the DB). Local only.
async function requestLog(id) {
  if (!UUID.test(id)) return json({ error: 'bad id' }, 400);
  const { data: l } = await admin.from('ai_request_log').select('est_cost_usd, tokens_in, tokens_out, tools, retrieved').eq('id', id).maybeSingle();
  if (!l) return json({ error: 'not found' }, 404);
  const ids = (l.retrieved ?? []).map((r) => r.chunk_id).filter(Boolean);
  const { data: chunks } = ids.length
    ? await admin.from('ai_chunks').select('id, content, ai_documents(source_type, source_id, title)').in('id', ids)
    : { data: [] };
  const byId = new Map((chunks ?? []).map((c) => [c.id, c]));
  return json({
    est_cost_usd: Number(l.est_cost_usd), tokens_in: l.tokens_in, tokens_out: l.tokens_out, tools: l.tools,
    retrieved: (l.retrieved ?? []).map((r, i) => {
      const c = byId.get(r.chunk_id);
      return { rank: i + 1, chunk_id: r.chunk_id, cited: !!r.cited, source_type: c?.ai_documents?.source_type ?? null,
        source_id: c?.ai_documents?.source_id ?? null, title: c?.ai_documents?.title ?? null, content: String(c?.content ?? '').slice(0, 1500) };
    }),
  });
}

// A client that disconnects only stops the copying: the turn keeps running
// in this process and finishes its reply row (the edge function does the
// same with EdgeRuntime.waitUntil).
async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  res.on('close', () => { if (!res.writableFinished) reader.cancel().catch(() => {}); });
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    if (!res.destroyed) res.write(value);
  }
  if (!res.destroyed) res.end();
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.method === 'OPTIONS') return send(res, new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } }));
    const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
    if (asUser && req.method === 'GET' && path.startsWith('/__log/')) return send(res, await requestLog(decodeURIComponent(path.slice(7))));
    if (req.method !== 'POST' || !['/assistant', '/functions/v1/assistant'].includes(path)) return send(res, json({ error: 'not found' }, 404));
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 100_000) return send(res, json({ error: 'body too large' }, 413)); }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, json({ error: 'invalid JSON' }, 400)); }
    const caller = asUser
      ? await checkProfile(admin, asUser, null, false)
      : await identify(admin, { authorization: req.headers.authorization, internalSecret: null }, body, '');
    if (caller instanceof Response) return send(res, caller);
    const { response, done } = await handleAsk(serverEnv, admin, caller, body);
    await send(res, response);
    await done;
    console.log(`${new Date().toISOString()} ${caller.role} ${String(body?.message ?? '').slice(0, 60).replace(/\s+/g, ' ')} · ${Date.now() - t0} ms${res.destroyed && !res.writableFinished ? ' (client left early; reply finished)' : ''}`);
  } catch (e) {
    console.error('serve-assistant error', e);
    if (!res.headersSent) send(res, json({ error: 'server error' }, 500)); else res.end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Assistant v2 on http://127.0.0.1:${port}/assistant (dev ${devRef})${asUser ? `, answering as ${asUser}` : ''}${modelOverride ? `, model ${keySlot ? `${keySlot}:` : ''}${modelOverride}` : ''}`));
