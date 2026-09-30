// What the Deno function and the local Node server share: who is calling, and
// the clients a turn runs with. The supabase-js createClient is passed in
// (esm.sh in Deno, npm in Node).

import { supabaseRpc } from '../ingest/db.ts';
import { cachedEmbedder, openAiQueryEmbedder, openAiReranker } from '../retrieval/rerank.ts';
import { RETRIEVAL_DEFAULTS } from '../retrieval/config.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import { UsageMeter } from '../prices.ts';
import { cleanPageContext, cleanSurface, requestCancel, type CoreDeps } from './core.ts';
import { json, turnResponse, type TurnHttp } from './http.ts';

// Who may use the assistant: ai_assistant_config.allowed_roles (mig 385),
// Boss-only by default. Widening it is a config change, made by the Lead only
// after the role safeguards (ui-design §8) pass QA. No row / no column → boss.
export const DEFAULT_ALLOWED_ROLES = ['boss'];

export async function allowedRoles(admin: any): Promise<string[]> {
  try {
    const { data, error } = await admin.from('ai_assistant_config').select('allowed_roles').eq('id', 1).maybeSingle();
    if (error || !Array.isArray(data?.allowed_roles)) return DEFAULT_ALLOWED_ROLES;
    return data.allowed_roles.map((r: unknown) => String(r).toLowerCase());
  } catch { return DEFAULT_ALLOWED_ROLES; }
}

type CreateClient = (url: string, key: string, opts?: any) => any;

export type Caller = { userId: string; role: string; displayName: string | null; token: string | null; internal: boolean };

// Constant-time string comparison (QA m7): the time taken does not depend on
// where the first difference is.
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Two ways in (as v1 ai-chat):
//   • a user JWT (Authorization: Bearer …), verified with the auth server;
//   • the Slack relay: x-internal-secret + as_user_id, which may only answer as an active boss.
export async function identify(admin: any, h: { authorization?: string | null; internalSecret?: string | null },
  body: any, secret: string): Promise<Caller | Response> {
  const internal = !!secret && !!h.internalSecret && safeEqual(h.internalSecret, secret);
  let userId: string;
  let token: string | null = null;
  if (internal) {
    userId = String(body?.as_user_id || '');
    if (!userId) return json({ error: 'as_user_id required for an internal call' }, 400);
  } else {
    token = String(h.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthenticated' }, 401);
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'unauthenticated' }, 401);
    userId = u.user.id;
  }
  return checkProfile(admin, userId, token, internal);
}

export async function checkProfile(admin: any, userId: string, token: string | null, internal: boolean): Promise<Caller | Response> {
  const { data: p } = await admin.from('profiles').select('display_name, role, is_active, deleted_at').eq('id', userId).maybeSingle();
  if (!p || p.is_active === false || p.deleted_at) return json({ error: 'forbidden' }, 403);
  const role = String(p.role || '').toLowerCase();
  if (internal && role !== 'boss') return json({ error: 'internal calls may only answer as a boss' }, 403);
  if (!internal && !(await allowedRoles(admin)).includes(role)) return json({ error: 'The assistant is currently in limited testing and not available for your role yet.' }, 403);
  return { userId, role, displayName: p.display_name ?? null, token, internal };
}

export type ServerEnv = { url: string; serviceKey: string; anonKey: string; openAiKey: string; createClient: CreateClient; fetchImpl?: typeof fetch; modelOverride?: string };

// Search runs with the caller's JWT so the database ACL applies; without one
// (Slack relay, local --as-user) it runs as the service role with p_as_user.
export function makeDeps(env: ServerEnv, admin: any, caller: Caller): CoreDeps {
  const userClient = caller.token
    ? env.createClient(env.url, env.anonKey, { global: { headers: { Authorization: `Bearer ${caller.token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  const meter = new UsageMeter();
  return {
    admin,
    searchRpc: supabaseRpc(userClient ?? admin),
    asUser: userClient ? null : caller.userId,
    // Data tools read people & pay data with this client, so the database RLS
    // decides for non-Boss callers. Without a JWT (Slack relay: Boss-only;
    // local --as-user) there is none, and non-Boss people tools refuse.
    ...(userClient ? { userClient } : {}),
    apiKey: env.openAiKey,
    ...(env.modelOverride ? { model: env.modelOverride } : {}),
    embed: cachedEmbedder(openAiQueryEmbedder(env.openAiKey, env.fetchImpl, meter.onEmbed(DEFAULT_CONFIG.EMBED_MODEL)), DEFAULT_CONFIG.QUERY_EMBED_CACHE_TTL_MS),
    rerank: openAiReranker({ apiKey: env.openAiKey, model: RETRIEVAL_DEFAULTS.RERANK_MODEL, fetchImpl: env.fetchImpl, onUsage: meter.onRerank(RETRIEVAL_DEFAULTS.RERANK_MODEL) }),
    meter,
  };
}

// The whole POST handler, given a verified caller. `done` settles when the
// reply row is finished, whatever happened to the connection.
export async function handleAsk(env: ServerEnv, admin: any, caller: Caller, body: any): Promise<TurnHttp> {
  // Stop: POST {cancel: messageId} → the running turn stops at its next check.
  if (body?.cancel !== undefined) {
    const r = await requestCancel(admin, caller.userId, String(body.cancel));
    return { response: json(r.body, r.status), done: Promise.resolve() };
  }
  const deps = makeDeps(env, admin, caller);
  const conversationId = typeof body?.conversationId === 'string' && UUID.test(body.conversationId) ? body.conversationId : null;
  if (body?.conversationId && !conversationId) return { response: json({ error: 'conversation not found' }, 404), done: Promise.resolve() };
  return turnResponse({
    userId: caller.userId, role: caller.role, displayName: caller.displayName, message: String(body?.message ?? ''), conversationId,
    surface: caller.internal ? 'slack' : cleanSurface(body?.surface), pageContext: cleanPageContext(body?.page_context),
    // Regenerate: {regenerate: <assistant messageId>}; its question is reused, `message` is ignored.
    ...(body?.regenerate !== undefined ? { regenerate: String(body.regenerate) } : {}),
  }, deps, body?.stream === true);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
