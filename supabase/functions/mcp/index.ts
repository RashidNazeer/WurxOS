// ============================================================
// Edge Function: mcp — WurxOS as a Claude connector (MCP over HTTP, read-only).
//
// Claude connects to  https://wurxos.vercel.app/mcp  (Vercel proxies the paths below to this function) and
// signs the person in through THIS function's own OAuth endpoints (oauthRoutes.ts, tables in mig 436). The
// tokens it issues are opaque, work only here, and are NOT Supabase tokens: they cannot be used against the
// database API, Auth or any other function. Every call then runs as that person:
//   • Boss → the same data tools as Wurx Buddy on the service client (the Boss sees everything);
//   • OL   → a read-only database session as that person (role `authenticated` + their id), so table
//            RLS decides exactly as in the app, plus the app's page guards in tools/roles.ts. Others' pay is refused.
// Roles allowed in: boss and ol ONLY, read from the database on every request. Each tool call is logged
// (mcp_call_log, mig 435) and rate limited. app_config.mcp_enabled = 'false' switches the whole thing off.
//
// Deploy WITH --no-verify-jwt (the sign-in endpoints are public by design; every data call needs our token).
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { runDataTool, TOOL_DEFS } from '../_shared/ai/tools/index.ts';
import { handleBody, type McpDeps } from '../_shared/mcp/protocol.ts';
import { MCP_MAX_INFLIGHT_OL_TOTAL, MCP_MAX_INFLIGHT_PER_USER, callLimitFor, mcpAllowed, rateLimited, sourceLine, tooBusy } from '../_shared/mcp/access.ts';
import { bearer, looksLikeOurAccessToken, resourceUrl, sha256Hex, trimBase } from '../_shared/mcp/oauth.ts';
import * as O from './oauthRoutes.ts';
import { userPgClient } from './pgExec.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DB_URL = Deno.env.get('SUPABASE_DB_URL') ?? '';
// The origin Claude talks to. Configuration, never taken from the request.
const BASE = trimBase(Deno.env.get('MCP_PUBLIC_BASE') ?? 'https://wurxos.vercel.app');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...CORS, ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...extra } });
const unauthenticated = (invalid: boolean) => reply({ error: 'unauthenticated' }, 401, {
  'WWW-Authenticate': `Bearer${invalid ? ' error="invalid_token",' : ''} resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
});

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const at = url.pathname.indexOf('/mcp');
  const sub = at < 0 ? '' : url.pathname.slice(at + 4).replace(/\/+$/, '');        // '' | '/oauth/token' | '/.well-known/...'
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const cfg: O.Cfg = { admin, base: BASE };

  // ---- discovery and sign-in (public by design) ----
  if (req.method === 'GET' && sub.startsWith('/.well-known/oauth-protected-resource')) return O.protectedResourceDoc(cfg);
  if (req.method === 'GET' && sub === '/.well-known/oauth-authorization-server') return O.authorizationServerDoc(cfg);
  if (sub.startsWith('/oauth/') || sub.startsWith('/.well-known/')) {
    if (await switchedOff(admin)) return reply({ error: 'temporarily_unavailable' }, 503);
    if (req.method === 'POST' && sub === '/oauth/register') return O.register(req, cfg);
    if (req.method === 'GET' && sub === '/oauth/authorize') return O.authorize(req, cfg);
    if (req.method === 'POST' && sub === '/oauth/decision') return O.decision(req, cfg);
    if (req.method === 'POST' && sub === '/oauth/token') return O.token(req, cfg);
    if (req.method === 'POST' && sub === '/oauth/revoke') return O.revoke(req, cfg);
    return reply({ error: 'not found' }, 404);
  }
  if (sub !== '') return reply({ error: 'not found' }, 404);
  if (req.method !== 'POST') return reply({ error: 'method not allowed' }, 405, { Allow: 'POST' });

  // ---- the MCP endpoint: our token only ----
  if (await switchedOff(admin)) return reply({ error: 'temporarily_unavailable' }, 503);
  const tok = bearer(req.headers.get('Authorization'));
  if (!tok) return unauthenticated(false);
  if (!looksLikeOurAccessToken(tok)) return unauthenticated(true);
  const { data: t, error: te } = await admin.from('mcp_oauth_tokens').select('user_id, resource, access_expires_at, revoked_at, last_used_at').eq('access_hash', await sha256Hex(tok)).maybeSingle();
  if (te) return reply({ error: 'temporarily_unavailable' }, 503);             // a database hiccup must not look like a bad token
  if (!t || t.revoked_at || new Date(t.access_expires_at).getTime() <= Date.now() || t.resource !== resourceUrl(BASE)) return unauthenticated(true);
  if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > 300_000) {
    admin.from('mcp_oauth_tokens').update({ last_used_at: new Date().toISOString() }).eq('access_hash', await sha256Hex(tok)).then(() => {}, () => {});
  }
  const userId: string = t.user_id;

  // The role is read from the database on EVERY request (a demotion or deactivation takes effect at once)
  // and matched exactly; nothing the client sends can change it. Refusals are logged, a few a minute at most.
  const { data: p } = await admin.from('profiles').select('role, is_active, deleted_at').eq('id', userId).maybeSingle();
  if (!mcpAllowed(p)) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
    if ((count ?? 0) < 5) admin.from('mcp_call_log').insert({ user_id: userId, role: String(p?.role ?? 'unknown').slice(0, 40), tool: '(refused)', args: null, ok: false, ms: 0 }).then(() => {}, () => {});
    return reply({ error: 'not found' }, 404);   // to anyone else the connector does not exist
  }
  const role = p!.role as string;

  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 65_536) return reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }, 413);
    body = JSON.parse(raw);
  } catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  // An OL reads through a read-only database session as themselves. The Boss runs on the service client.
  let pg: ReturnType<typeof userPgClient> | null = null;
  if (role !== 'boss') {
    if (!DB_URL) return reply({ error: 'unavailable' }, 503);
    pg = userPgClient(DB_URL, userId);
  }
  const ctx = { userId, role, userClient: pg?.client };

  const deps: McpDeps = {
    serverName: 'wurxos',
    serverVersion: '1.0.0',
    tools: () => TOOL_DEFS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.parameters })),
    callTool: async (name, args) => {
      if (!mcpAllowed(p)) return { text: 'Not available for your account.', isError: true };   // second check, in front of every tool
      const limit = callLimitFor(role);
      const since = new Date(Date.now() - 60_000).toISOString();
      const busy = `Too many requests (limit ${limit} per minute, ${MCP_MAX_INFLIGHT_PER_USER} at a time). Wait a moment and ask again.`;
      // Cheap look first, so an over-limit caller does not grow the log; then reserve, then count again.
      const pre = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
      if (pre.error || rateLimited(pre.count, limit)) return { text: busy, isError: true };
      // Reserve first, then count: the call's own row is written BEFORE the tool runs, so parallel requests
      // cannot all see an empty log. If the log cannot be written or read, the call is refused (fail closed).
      const ins = await admin.from('mcp_call_log').insert({ user_id: userId, role, tool: name, args: JSON.stringify(args).slice(0, 1000), ok: true, ms: null }).select('id').single();
      if (ins.error || !ins.data) return { text: 'The connector is temporarily unavailable. Try again in a moment.', isError: true };
      const give = (reason: string) => { admin.from('mcp_call_log').update({ ok: false }).eq('id', ins.data.id).then(() => {}, () => {}); return { text: reason, isError: true }; };
      const { count, error: cErr } = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
      if (cErr || rateLimited(typeof count === 'number' ? count - 1 : null, limit)) return give(busy);
      // Calls still running (reserved, not finished) bound the database connections one person, and all OLs together, can hold.
      const live = new Date(Date.now() - 30_000).toISOString();
      const mine = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('ok', true).is('ms', null).gte('created_at', live);
      if (mine.error || tooBusy(typeof mine.count === 'number' ? mine.count - 1 : null, MCP_MAX_INFLIGHT_PER_USER)) return give(busy);
      if (role !== 'boss') {
        const all = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('role', 'ol').eq('ok', true).is('ms', null).gte('created_at', live);
        if (all.error || tooBusy(typeof all.count === 'number' ? all.count - 1 : null, MCP_MAX_INFLIGHT_OL_TOTAL)) return give(busy);
      }
      if (Math.random() < 0.01) admin.rpc('mcp_oauth_cleanup').then(() => {}, () => {});
      const t0 = Date.now();
      const r = await runDataTool(admin, ctx, name, args);
      const failed = /^Tool \S+ failed:/.test(r.text) || r.text.startsWith('Unknown tool');
      admin.from('mcp_call_log').update({ ok: !failed, ms: Date.now() - t0 }).eq('id', ins.data.id).then(() => {}, () => {});
      return { text: r.text + sourceLine(r.source), isError: failed };
    },
  };

  try {
    const out = await handleBody(body, deps);
    return out === null ? reply(null, 202) : reply(out);
  } finally {
    await pg?.close();
  }
});

// app_config.mcp_enabled = 'false' stops sign-in and every call. An unreadable setting also stops (fail closed).
async function switchedOff(admin: any): Promise<boolean> {
  const { data, error } = await admin.from('app_config').select('value').eq('key', 'mcp_enabled').maybeSingle();
  return !!error || data?.value === 'false';
}
