// ============================================================
// Edge Function: assistant (Assistant v2, "Wurx Buddy")
//
// Replaces ai-chat at cutover (phase5-design.md §7: no engine switch). The
// agent core is in _shared/ai/agent; this file is only auth + transport.
//
// Request:  POST { message, conversationId?, stream?: true, surface?: 'quick'|'full',
//                  page_context?: { route, brand_id?, report_id?, kb_id? } }
// The reply row (ai_messages, status generating → done | error) is finished
// in the background via EdgeRuntime.waitUntil, even if the client disconnects.
//           Authorization: Bearer <user JWT>   (roles in ai_assistant_config.allowed_roles)
//           or x-internal-secret + { as_user_id }  (Slack relay; answers only as a boss)
// Response: stream:true  → SSE {started, conversationId, requestId, messageId} {status} {delta}
//                          {sources} {error} {done, conversationId, requestId, messageId, status}
//           otherwise    → JSON { conversationId, requestId, reply, sources }
//
// Allowed roles: boss and developer always, plus ai_assistant_config.allowed_roles.
// Env (function secrets): OPEN_AI_API_KEY, OPEN_AI_API_KEY_FALLBACK, GROQ_API_KEY, GEMINI_API_KEY, NVIDIA_API_KEY, NVIDIA_API_KEY_2 (optional), TAVILY_API_KEY + BRAVE_API_KEY (optional, web search), AI_INTERNAL_SECRET,
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (automatic).
// Deploy: NOT YET — only with the Owner's go (TEAM.md rule 0/3), --project-ref dev.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { CORS, json } from '../_shared/ai/agent/http.ts';
import { handleAsk, identify, type ServerEnv } from '../_shared/ai/agent/server.ts';

const env: ServerEnv = {
  url: Deno.env.get('SUPABASE_URL')!,
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  openAiKey: Deno.env.get('OPEN_AI_API_KEY') ?? Deno.env.get('OPENAI_API_KEY') ?? '',
  openAiKeyFallback: Deno.env.get('OPEN_AI_API_KEY_FALLBACK') ?? null,
  groqKey: Deno.env.get('GROQ_API_KEY') ?? null,
  geminiKey: Deno.env.get('GEMINI_API_KEY') ?? null,
  nvidiaKey: Deno.env.get('NVIDIA_API_KEY') ?? null,
  nvidia2Key: Deno.env.get('NVIDIA_API_KEY_2') ?? null,
  // Web search (migs 415, 416). TAVILY_API_KEY / BRAVE_API_KEY are the
  // canonical names; the Tavily_API and Brave_API spellings are read too
  // because that is what the Owner's .env.dev uses. A provider with no key is
  // simply skipped, so Brave stays dormant until its key is added.
  tavilyKey: Deno.env.get('TAVILY_API_KEY') ?? Deno.env.get('Tavily_API') ?? null,
  braveKey: Deno.env.get('BRAVE_API_KEY') ?? Deno.env.get('Brave_API') ?? Deno.env.get('BRAVE_SEARCH_API_KEY') ?? null,
  createClient,
};
const AI_INTERNAL_SECRET = Deno.env.get('AI_INTERNAL_SECRET') ?? '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!env.openAiKey) return json({ error: 'the assistant is not configured (no model key)' }, 500);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const caller = await identify(admin, {
    authorization: req.headers.get('Authorization'),
    internalSecret: req.headers.get('x-internal-secret'),
  }, body, AI_INTERNAL_SECRET);
  if (caller instanceof Response) return caller;
  try {
    const { response, done } = await handleAsk(env, admin, caller, body);
    // Finish the reply even if the browser goes away (ui-design §6).
    (globalThis as any).EdgeRuntime?.waitUntil?.(done);
    return response;
  } catch (e) {
    console.error('assistant error', e);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
