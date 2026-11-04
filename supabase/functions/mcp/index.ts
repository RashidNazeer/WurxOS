// ============================================================
// Edge Function: mcp — WurxOS as a Claude connector (MCP over HTTP, read-only).
//
// Claude (claude.ai → Settings → Connectors → custom connector) points at
//   https://<project>.supabase.co/functions/v1/mcp
// and signs the person in through Supabase Auth's OAuth server (this function only advertises it, see
// /.well-known/oauth-protected-resource). Every call then runs as that person:
//   • Boss  → the same data tools as Wurx Buddy on the service client (the Boss sees everything);
//   • OL → the person's OWN JWT client, so table RLS decides exactly as in the app, plus the
//     app's page guards in tools/roles.ts. Others' pay is refused, never hinted at.
// Roles allowed in: boss and ol ONLY. Each tool call is logged (mcp_call_log, mig 435) and rate limited.
//
// Deploy WITH --no-verify-jwt: the unauthenticated 401 + discovery document must be reachable, and the
// token is verified here with auth.getUser(). Deploy: `supabase functions deploy mcp --no-verify-jwt`.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { runDataTool, TOOL_DEFS } from '../_shared/ai/tools/index.ts';
import { handleBody, type McpDeps } from '../_shared/mcp/protocol.ts';
import { MCP_CALLS_PER_MINUTE, mcpAllowed, rateLimited, sourceLine } from '../_shared/mcp/access.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};
const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...CORS, ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...extra } });

const resourceUrl = () => `${URL_}/functions/v1/mcp`;
const metadataUrl = () => `${resourceUrl()}/.well-known/oauth-protected-resource`;
const unauthenticated = () => reply({ error: 'unauthenticated' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl()}"` });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const path = new URL(req.url).pathname;

  // RFC 9728: tells Claude which authorization server issues tokens for this resource.
  if (req.method === 'GET' && path.includes('/.well-known/oauth-protected-resource')) {
    return reply({ resource: resourceUrl(), authorization_servers: [`${URL_}/auth/v1`], bearer_methods_supported: ['header'], resource_name: 'WurxOS' });
  }
  if (req.method === 'GET') return reply({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  if (req.method !== 'POST') return reply({ error: 'method not allowed' }, 405, { Allow: 'POST' });

  const token = String(req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return unauthenticated();
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return unauthenticated();
  // The role is read from the database on EVERY request (a demotion or deactivation takes effect at once)
  // and matched exactly; nothing the client sends can change it. Refusals are logged, a few a minute at most.
  const { data: p } = await admin.from('profiles').select('role, is_active, deleted_at').eq('id', u.user.id).maybeSingle();
  if (!mcpAllowed(p)) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count } = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('user_id', u.user.id).gte('created_at', since);
    if ((count ?? 0) < 5) admin.from('mcp_call_log').insert({ user_id: u.user.id, role: String(p?.role ?? 'unknown').slice(0, 40), tool: '(refused)', args: null, ok: false, ms: 0 }).then(() => {}, () => {});
    return reply({ error: 'not found' }, 404);   // to anyone else the connector does not exist
  }
  const role = p!.role as string;

  let body: unknown;
  try { body = await req.json(); } catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  const userClient = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  const ctx = { userId: u.user.id, role, userClient };

  const deps: McpDeps = {
    serverName: 'wurxos',
    serverVersion: '1.0.0',
    tools: () => TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
    callTool: async (name, args) => {
      if (!mcpAllowed(p)) return { text: 'Not available for your account.', isError: true };   // second check, in front of every tool
      const since = new Date(Date.now() - 60_000).toISOString();
      const { count } = await admin.from('mcp_call_log').select('id', { count: 'exact', head: true }).eq('user_id', ctx.userId).gte('created_at', since);
      if (rateLimited(count)) return { text: `Too many requests (limit ${MCP_CALLS_PER_MINUTE} per minute). Wait a moment and ask again.`, isError: true };
      const t0 = Date.now();
      const r = await runDataTool(admin, ctx, name, args);
      const failed = /^Tool \S+ failed:/.test(r.text) || r.text.startsWith('Unknown tool');
      // Best effort: the audit row must never turn a good answer into an error.
      admin.from('mcp_call_log').insert({ user_id: ctx.userId, role, tool: name, args: JSON.stringify(args).slice(0, 1000), ok: !failed, ms: Date.now() - t0 }).then(() => {}, () => {});
      return { text: r.text + sourceLine(r.source), isError: failed };
    },
  };

  const out = await handleBody(body, deps);
  return out === null ? reply(null, 202) : reply(out);
});
