// The connector's sign-in endpoints (register, authorize, decision, token, revoke) and discovery documents.
// The rules live in _shared/mcp/oauth.ts and are tested there; this file only does the HTTP and the database.
// Every table is service-role only (mig 436), so all access here is through the admin client.
// deno-lint-ignore-file no-explicit-any

import {
  ACCESS_TTL_S, CODE_TTL_S, REFRESH_TTL_S, REQUEST_TTL_S, authorizationServerMetadata, looksLikeOurRefreshToken, parseAuthorize,
  parseRegistration, pkceOk, protectedResourceMetadata, randomId, randomToken, redirectWith, resourceUrl, safeEqual, sha256Hex,
  tokenError, tokenResponse, trimBase, type TokenError,
} from '../_shared/mcp/oauth.ts';
import { mcpAllowed } from '../_shared/mcp/access.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
const text = (msg: string, status = 400) => new Response(msg, { status, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, ...NO_STORE } });

export type Cfg = { admin: any; base: string };

async function readBody(req: Request, max = 8192): Promise<string | null> {
  const raw = await req.text();
  return raw.length > max ? null : raw;
}

// ---- discovery --------------------------------------------------------------------------------
export const protectedResourceDoc = (c: Cfg) => json(protectedResourceMetadata(c.base));
export const authorizationServerDoc = (c: Cfg) => json(authorizationServerMetadata(c.base));

// ---- dynamic client registration (RFC 7591) ---------------------------------------------------
export async function register(req: Request, { admin }: Cfg): Promise<Response> {
  const raw = await readBody(req, 4096);
  if (raw === null) return json({ error: 'invalid_client_metadata', error_description: 'too large' }, 400);
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_client_metadata', error_description: 'JSON expected' }, 400); }
  const reg = parseRegistration(body);
  if (!reg.ok) return json({ error: reg.error, error_description: reg.description }, 400);
  // Unauthenticated endpoint: a global ceiling keeps it from being used to fill the table.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count, error: ce } = await admin.from('mcp_oauth_clients').select('client_id', { count: 'exact', head: true }).gte('created_at', since);
  if (ce || (count ?? 0) >= 30) return json({ error: 'temporarily_unavailable', error_description: 'too many registrations, try later' }, 429, { 'Retry-After': '600' });
  const clientId = `wxc_${randomId()}`;
  const { error } = await admin.from('mcp_oauth_clients').insert({ client_id: clientId, client_name: reg.name, redirect_uris: reg.redirectUris });
  if (error) return json({ error: 'server_error', error_description: 'could not register' }, 500);
  return json({
    client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: reg.name, redirect_uris: reg.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }, 201, NO_STORE);
}

// ---- authorize: validates, stores the request, sends the browser to the app's consent page ------
export async function authorize(req: Request, { admin, base }: Cfg): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const clientId = q.get('client_id') ?? '';
  const { data: client } = clientId.length <= 80 ? await admin.from('mcp_oauth_clients').select('client_id, redirect_uris').eq('client_id', clientId).maybeSingle() : { data: null };
  const r = parseAuthorize(q, client ?? null, base);
  if (!r.ok) {
    // Never redirect to an address that was not validated against the registration.
    if (r.to === 'page') return text(`Cannot connect: ${r.description}.`);
    return redirect(redirectWith(r.redirectUri!, { error: r.error, error_description: r.description, state: r.state ?? undefined }));
  }
  const id = randomToken('rq', 24);
  const { error } = await admin.from('mcp_oauth_requests').insert({
    id_hash: await sha256Hex(id), client_id: r.clientId, redirect_uri: r.redirectUri, state: r.state, code_challenge: r.challenge,
    resource: r.resource, expires_at: new Date(Date.now() + REQUEST_TTL_S * 1000).toISOString(),
  });
  if (error) return text('Cannot connect right now. Try again.', 503);
  return redirect(`${trimBase(base)}/oauth/consent?request=${encodeURIComponent(id)}`);
}

// ---- decision: called by the app's consent page with the person's Supabase login --------------
// To anyone who is not an active Boss or OL this endpoint answers 404, like the rest of the connector.
export async function decision(req: Request, { admin }: Cfg): Promise<Response> {
  const supaToken = String(req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!supaToken) return json({ error: 'unauthenticated' }, 401);
  const { data: u } = await admin.auth.getUser(supaToken);
  if (!u?.user) return json({ error: 'unauthenticated' }, 401);
  const { data: p } = await admin.from('profiles').select('role, is_active, deleted_at').eq('id', u.user.id).maybeSingle();
  if (!mcpAllowed(p)) return json({ error: 'not found' }, 404);

  const raw = await readBody(req, 1024);
  let body: any;
  try { body = JSON.parse(raw ?? ''); } catch { return json({ error: 'bad request' }, 400); }
  const id = typeof body?.request === 'string' ? body.request : '';
  const action = body?.decision;
  if (!/^rq_[A-Za-z0-9_-]{32}$/.test(id) || !['info', 'allow', 'deny'].includes(action)) return json({ error: 'bad request' }, 400);
  const hash = await sha256Hex(id);
  const { data: rq } = await admin.from('mcp_oauth_requests').select('*').eq('id_hash', hash).maybeSingle();
  if (!rq || new Date(rq.expires_at).getTime() < Date.now() || rq.decided_at) return json({ error: 'expired', error_description: 'This request has expired. Start again from Claude.' }, 410);
  const { data: client } = await admin.from('mcp_oauth_clients').select('client_name').eq('client_id', rq.client_id).maybeSingle();

  if (action === 'info') {
    return json({ client_name: client?.client_name ?? 'Claude', redirect_host: new URL(rq.redirect_uri).hostname, email: u.user.email ?? null });
  }
  // One decision per request: the update only succeeds while it is still undecided.
  const { data: won } = await admin.from('mcp_oauth_requests').update({ user_id: u.user.id, decided_at: new Date().toISOString() }).eq('id_hash', hash).is('decided_at', null).select('id_hash');
  if (!won?.length) return json({ error: 'expired', error_description: 'This request was already answered.' }, 410);
  if (action === 'deny') return json({ redirect_url: redirectWith(rq.redirect_uri, { error: 'access_denied', state: rq.state }) });
  const code = randomToken('wxk', 32);
  const { error } = await admin.from('mcp_oauth_codes').insert({
    code_hash: await sha256Hex(code), client_id: rq.client_id, user_id: u.user.id, redirect_uri: rq.redirect_uri,
    code_challenge: rq.code_challenge, resource: rq.resource, expires_at: new Date(Date.now() + CODE_TTL_S * 1000).toISOString(),
  });
  if (error) return json({ error: 'server_error' }, 500);
  return json({ redirect_url: redirectWith(rq.redirect_uri, { code, state: rq.state }) });
}

// ---- token ------------------------------------------------------------------------------------
const tokErr = (e: TokenError, status = 400) => json(e, status, NO_STORE);

async function mint(admin: any, userId: string, clientId: string, resource: string, family: string, codeHash: string | null) {
  const access = randomToken('wxa', 32), refresh = randomToken('wxr', 32);
  const { error } = await admin.from('mcp_oauth_tokens').insert({
    family_id: family, user_id: userId, client_id: clientId, resource, code_hash: codeHash,
    access_hash: await sha256Hex(access), access_expires_at: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(),
    refresh_hash: await sha256Hex(refresh), refresh_expires_at: new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString(),
  });
  return error ? null : tokenResponse(access, refresh);
}

export async function token(req: Request, { admin, base }: Cfg): Promise<Response> {
  const raw = await readBody(req, 4096);
  if (raw === null) return tokErr(tokenError('invalid_request', 'too large'));
  const f = new URLSearchParams(raw);
  const grant = f.get('grant_type');
  const clientId = f.get('client_id') ?? '';
  const resource = f.get('resource');
  if (resource !== null && trimBase(resource) !== resourceUrl(base)) return tokErr(tokenError('invalid_target', 'unknown resource'));
  if (Math.random() < 0.03) admin.rpc('mcp_oauth_cleanup').then(() => {}, () => {});

  if (grant === 'authorization_code') {
    const code = f.get('code') ?? '', verifier = f.get('code_verifier') ?? '', redirectUri = f.get('redirect_uri') ?? '';
    if (!code || !clientId || !verifier) return tokErr(tokenError('invalid_request', 'code, client_id and code_verifier are required'));
    const codeHash = await sha256Hex(code);
    const { data: rows, error } = await admin.rpc('mcp_oauth_consume_code', { p_hash: codeHash });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (error || !row) return tokErr(tokenError('invalid_grant', 'code is invalid, expired or already used'));
    if (!safeEqual(row.client_id, clientId) || !safeEqual(row.redirect_uri, redirectUri)) return tokErr(tokenError('invalid_grant', 'code does not match this client'));
    if (!(await pkceOk(verifier, row.code_challenge))) return tokErr(tokenError('invalid_grant', 'code_verifier does not match'));
    const { data: p } = await admin.from('profiles').select('role, is_active, deleted_at').eq('id', row.user_id).maybeSingle();
    if (!mcpAllowed(p)) return tokErr(tokenError('invalid_grant', 'this account cannot use the connector'));
    const out = await mint(admin, row.user_id, row.client_id, row.resource, crypto.randomUUID(), codeHash);
    return out ? json(out, 200, NO_STORE) : tokErr(tokenError('invalid_request', 'could not issue tokens'), 500);
  }

  if (grant === 'refresh_token') {
    const rt = f.get('refresh_token') ?? '';
    if (!clientId || !looksLikeOurRefreshToken(rt)) return tokErr(tokenError('invalid_grant', 'refresh token is invalid'));
    const access = randomToken('wxa', 32), refresh = randomToken('wxr', 32);
    const { data: rows, error } = await admin.rpc('mcp_oauth_rotate', {
      p_old: await sha256Hex(rt), p_client: clientId, p_new_access: await sha256Hex(access), p_new_refresh: await sha256Hex(refresh),
      p_access_exp: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString(), p_refresh_exp: new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString(),
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (error || !row) return tokErr(tokenError('invalid_grant', 'refresh token is invalid, expired or already used'));
    const { data: p } = await admin.from('profiles').select('role, is_active, deleted_at').eq('id', row.user_id).maybeSingle();
    if (!mcpAllowed(p)) {
      await admin.rpc('mcp_oauth_revoke', { p_hash: await sha256Hex(access) });
      return tokErr(tokenError('invalid_grant', 'this account cannot use the connector'));
    }
    return json(tokenResponse(access, refresh), 200, NO_STORE);
  }
  return tokErr(tokenError('unsupported_grant_type', 'authorization_code or refresh_token'));
}

// RFC 7009: always 200, whether or not the token was ours.
export async function revoke(req: Request, { admin }: Cfg): Promise<Response> {
  const raw = await readBody(req, 4096);
  const t = new URLSearchParams(raw ?? '').get('token');
  if (t && /^wx[ar]_[A-Za-z0-9_-]{43}$/.test(t)) await admin.rpc('mcp_oauth_revoke', { p_hash: await sha256Hex(t) });
  return json({}, 200, NO_STORE);
}
