// The connector's sign-in layer: the pure rules (_shared/mcp/oauth.ts) and the whole HTTP flow
// (mcp/oauthRoutes.ts) against an in-memory stand-in for the database that mirrors migration 436.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_REDIRECTS, authorizationServerMetadata, bearer, looksLikeOurAccessToken, looksLikeOurRefreshToken, parseAuthorize, parseRegistration,
  pkceOk, protectedResourceMetadata, randomToken, redirectAllowed, redirectWith, resourceUrl, safeEqual, sha256B64Url, sha256Hex,
} from '../mcp/oauth.ts';
import * as O from '../../mcp/oauthRoutes.ts';

const BASE = 'https://wurxos.vercel.app';
const CB = 'https://claude.ai/api/mcp/auth_callback';

// ---------------------------------------------------------------- pure rules
test('PKCE: the RFC 7636 test vector verifies; wrong, short and "plain" verifiers do not', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(await sha256B64Url(verifier), challenge);
  assert.equal(await pkceOk(verifier, challenge), true);
  assert.equal(await pkceOk(verifier + 'x', challenge), false);
  assert.equal(await pkceOk('short', challenge), false);
  assert.equal(await pkceOk(verifier, verifier), false);               // "plain": challenge == verifier is refused
  assert.equal(await pkceOk(verifier, ''), false);
  assert.equal(await pkceOk(undefined, challenge), false);
  assert.equal(await pkceOk('a'.repeat(129), challenge), false);
  assert.equal(await pkceOk(verifier.replace('-', '+'), challenge), false);
});

test('redirect allowlist: exact Claude callbacks only (no userinfo, ports, subdomains, http, path or case tricks)', () => {
  for (const ok of ALLOWED_REDIRECTS) assert.equal(redirectAllowed(ok), true);
  for (const bad of [
    'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai:8443/api/mcp/auth_callback', 'https://evil.claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.com/api/mcp/auth_callback',
    'https://evil.com@claude.ai/api/mcp/auth_callback', 'https://claude.ai@evil.com/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback#x',
    'https://CLAUDE.AI/api/mcp/auth_callback', 'https://claude.ai/API/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback%2f', '', null, undefined, 5,
    'javascript:alert(1)', 'http://localhost:6274/oauth/callback', 'https://claude.ai/api/mcp/auth_callback ',
  ]) assert.equal(redirectAllowed(bad), false, String(bad));
});

test('registration: only Claude callbacks; names are cleaned; grant types limited', () => {
  assert.deepEqual(parseRegistration({ redirect_uris: [CB], client_name: 'Claude' }), { ok: true, name: 'Claude', redirectUris: [CB] });
  const nasty: any = parseRegistration({ redirect_uris: [CB, CB], client_name: '<script>x</script>\u0007Bob'.padEnd(200, 'z') });
  assert.equal(nasty.ok, true);
  assert.ok(!/[<>\u0007]/.test(nasty.name) && nasty.name.length <= 80 && nasty.redirectUris.length === 1);
  for (const bad of [null, [], 'x', {}, { redirect_uris: [] }, { redirect_uris: ['https://evil.com/cb'] }, { redirect_uris: [CB, 'https://evil.com/cb'] },
    { redirect_uris: [CB], grant_types: ['password'] }, { redirect_uris: Array(6).fill(CB) }, { redirect_uris: [{}] }]) {
    assert.equal((parseRegistration(bad) as any).ok, false, JSON.stringify(bad));
  }
});

const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const client = { client_id: 'wxc_1', redirect_uris: [CB] };
const authQ = (o: Record<string, string>) => new URLSearchParams({ client_id: 'wxc_1', redirect_uri: CB, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's1', ...o });

test('authorize: a good request passes; bad client/redirect go to an error PAGE, other errors back to Claude', () => {
  const ok: any = parseAuthorize(authQ({ resource: `${BASE}/mcp` }), client, BASE);
  assert.equal(ok.ok, true);
  assert.equal(ok.resource, resourceUrl(BASE));
  assert.equal((parseAuthorize(authQ({}), client, BASE) as any).ok, true);                         // resource may be omitted
  assert.equal((parseAuthorize(authQ({ resource: `${BASE}/mcp/` }), client, BASE) as any).ok, true);
  const page = (q: URLSearchParams, c: any) => (parseAuthorize(q, c, BASE) as any);
  assert.equal(page(authQ({}), null).to, 'page');
  assert.equal(page(authQ({ client_id: 'other' }), client).to, 'page');
  assert.equal(page(authQ({ redirect_uri: 'https://evil.com/cb' }), client).to, 'page');
  assert.equal(page(authQ({ redirect_uri: CB + '/' }), client).to, 'page');
  assert.equal(page(authQ({ redirect_uri: 'https://claude.com/api/mcp/auth_callback' }), client).to, 'page');   // allowed host, but not registered
  for (const [o, err] of [[{ response_type: 'token' }, 'unsupported_response_type'], [{ code_challenge_method: 'plain' }, 'invalid_request'],
    [{ code_challenge_method: '' }, 'invalid_request'], [{ code_challenge: 'short' }, 'invalid_request'], [{ code_challenge: challenge + 'x' }, 'invalid_request'],
    [{ resource: 'https://evil.com/mcp' }, 'invalid_target'], [{ scope: 'admin' }, 'invalid_scope']] as const) {
    const r = page(authQ({ ...o }), client);
    assert.equal(r.ok, false); assert.equal(r.to, 'redirect'); assert.equal(r.error, err); assert.equal(r.redirectUri, CB);
  }
  const noChallenge = authQ({}); noChallenge.delete('code_challenge');
  assert.equal(page(noChallenge, client).error, 'invalid_request');
});

test('tokens: random, prefixed, 43 chars of entropy; shape checks; constant-time compare; bearer parsing', async () => {
  const a = randomToken('wxa', 32), b = randomToken('wxa', 32);
  assert.notEqual(a, b);
  assert.ok(looksLikeOurAccessToken(a) && !looksLikeOurAccessToken(a + 'x') && !looksLikeOurAccessToken('wxr_' + a.slice(4)) && !looksLikeOurAccessToken('eyJhbGciOi'));
  assert.ok(looksLikeOurRefreshToken(randomToken('wxr', 32)));
  assert.equal((await sha256Hex('abc')).length, 64);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(bearer('Bearer abc'), 'abc');
  assert.equal(bearer('bearer abc'), 'abc');
  assert.equal(bearer('Basic abc'), null);
  assert.equal(bearer('Bearer a b'), null);
  assert.equal(bearer(null), null);
});

test('redirectWith keeps the query it adds and metadata points at the configured base only', () => {
  assert.equal(redirectWith(CB, { code: 'c', state: 's' }), `${CB}?code=c&state=s`);
  assert.equal(redirectWith(CB, { error: 'access_denied', state: null }), `${CB}?error=access_denied`);
  const m = authorizationServerMetadata(BASE + '/');
  assert.equal(m.issuer, BASE);
  assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ['none']);
  assert.ok(Object.values(m).flat().filter((v) => typeof v === 'string' && v.startsWith('http')).every((u) => (u as string).startsWith(BASE)));
  assert.deepEqual(protectedResourceMetadata(BASE).authorization_servers, [BASE]);
  assert.equal(protectedResourceMetadata(BASE).resource, `${BASE}/mcp`);
});

// ---------------------------------------------------------------- the whole flow, in memory
type Row = Record<string, any>;
function memDb(users: Record<string, { id: string; email: string }>, profiles: Row[]) {
  const t: Record<string, Row[]> = { mcp_oauth_clients: [], mcp_oauth_requests: [], mcp_oauth_codes: [], mcp_oauth_tokens: [], profiles };
  const q = (table: string) => {
    let rows = t[table]; const filt: Array<(r: Row) => boolean> = []; let patch: Row | null = null; let ins: Row | null = null; let head = false, count = false, single = false, retSel = false;
    const run = () => {
      if (ins) { if (table === 'mcp_oauth_tokens' && t[table].some((r) => r.access_hash === ins!.access_hash || r.refresh_hash === ins!.refresh_hash)) return { error: { message: 'dup' } };
        t[table].push({ created_at: new Date().toISOString(), ...ins }); return { error: null }; }
      const hit = rows.filter((r) => filt.every((f) => f(r)));
      if (patch) { hit.forEach((r) => Object.assign(r, patch)); return { data: retSel ? hit.map((r) => ({ ...r })) : null, error: null }; }
      if (head && count) return { count: hit.length, error: null };
      return { data: single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
    };
    const api: any = {
      select: (_c?: string, o?: any) => { if (patch) retSel = true; if (o?.count) count = true; if (o?.head) head = true; return api; },
      insert: (r: Row) => { ins = r; return api; }, update: (p: Row) => { patch = p; return api; },
      eq: (c: string, v: any) => { filt.push((r) => r[c] === v); return api; }, gte: (c: string, v: any) => { filt.push((r) => String(r[c]) >= String(v)); return api; },
      is: (c: string, v: any) => { filt.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      maybeSingle: () => { single = true; return api; }, limit: () => api,
      then: (ok: any, no: any) => Promise.resolve(run()).then(ok, no),
    };
    return api;
  };
  const rpc = async (fn: string, a: any) => {
    const now = Date.now(); const T = t.mcp_oauth_tokens, C = t.mcp_oauth_codes;
    if (fn === 'mcp_oauth_consume_code') {
      const c = C.find((x) => x.code_hash === a.p_hash && !x.used_at && new Date(x.expires_at).getTime() > now);
      if (c) { c.used_at = new Date().toISOString(); return { data: [{ client_id: c.client_id, user_id: c.user_id, redirect_uri: c.redirect_uri, code_challenge: c.code_challenge, resource: c.resource }], error: null }; }
      T.filter((x) => x.code_hash === a.p_hash && !x.revoked_at).forEach((x) => { x.revoked_at = new Date().toISOString(); });
      return { data: [], error: null };
    }
    if (fn === 'mcp_oauth_rotate') {
      const o = T.find((x) => x.refresh_hash === a.p_old);
      if (!o || o.client_id !== a.p_client) return { data: [], error: null };
      if (o.refresh_used_at) { T.filter((x) => x.family_id === o.family_id && !x.revoked_at).forEach((x) => { x.revoked_at = new Date().toISOString(); }); return { data: [], error: null }; }
      if (o.revoked_at || new Date(o.refresh_expires_at).getTime() <= now) return { data: [], error: null };
      o.refresh_used_at = o.revoked_at = new Date().toISOString();
      T.push({ family_id: o.family_id, user_id: o.user_id, client_id: o.client_id, resource: o.resource, code_hash: o.code_hash, access_hash: a.p_new_access, access_expires_at: a.p_access_exp, refresh_hash: a.p_new_refresh, refresh_expires_at: a.p_refresh_exp });
      return { data: [{ user_id: o.user_id, family_id: o.family_id, resource: o.resource }], error: null };
    }
    if (fn === 'mcp_oauth_revoke') { const f = T.filter((x) => x.access_hash === a.p_hash || x.refresh_hash === a.p_hash).map((x) => x.family_id); T.filter((x) => f.includes(x.family_id)).forEach((x) => { x.revoked_at = new Date().toISOString(); }); return { data: null, error: null }; }
    return { data: null, error: null };
  };
  return { t, from: q, rpc, auth: { getUser: async (tok: string) => ({ data: { user: users[tok] ?? null } }) } };
}

const BOSS = { id: 'u-boss', email: 'boss@x.test' }, OLU = { id: 'u-ol', email: 'ol@x.test' }, APC = { id: 'u-apc', email: 'apc@x.test' };
const mk = () => memDb({ 'jwt-boss': BOSS, 'jwt-ol': OLU, 'jwt-apc': APC }, [
  { id: 'u-boss', role: 'boss', is_active: true, deleted_at: null }, { id: 'u-ol', role: 'ol', is_active: true, deleted_at: null }, { id: 'u-apc', role: 'apc', is_active: true, deleted_at: null }]);
const post = (url: string, body: string, headers: Record<string, string> = {}) => new Request(`https://x.test${url}`, { method: 'POST', body, headers });
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const jbody = async (r: Response) => await r.json();

async function connect(db: any, who: string) {
  const cfg = { admin: db, base: BASE };
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const reg: any = await jbody(await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: [CB], client_name: 'Claude' })), cfg));
  const auth = await O.authorize(new Request(`https://x.test/oauth/authorize?${authQ({ client_id: reg.client_id, resource: `${BASE}/mcp` })}`), cfg);
  const loc = new URL(auth.headers.get('Location')!);
  const requestId = loc.searchParams.get('request')!;
  const cookie = (auth.headers.get('Set-Cookie') ?? '').split(';')[0];
  const dec = async (decision: string, jwt = who, ck = cookie) =>
    O.decision(post('/oauth/decision', JSON.stringify({ request: requestId, decision }), { Authorization: `Bearer ${jwt}`, ...(ck ? { Cookie: ck } : {}) }), cfg);
  return { cfg, reg, auth, loc, requestId, dec, verifier, cookie };
}

test('flow: register -> authorize -> approve -> token -> refresh (rotating) works end to end for the Boss', async () => {
  const db = mk(); const f = await connect(db, 'jwt-boss');
  assert.equal(f.reg.token_endpoint_auth_method, 'none');
  assert.equal(f.auth.status, 302);
  assert.equal(f.loc.origin + f.loc.pathname, `${BASE}/oauth/consent`);
  const info: any = await jbody(await f.dec('info'));
  assert.deepEqual({ ...info, started_at: typeof info.started_at }, { client_name: 'Claude', redirect_host: 'claude.ai', email: 'boss@x.test', started_at: 'string' });
  const ok: any = await jbody(await f.dec('allow'));
  const cb = new URL(ok.redirect_url);
  assert.equal(cb.origin + cb.pathname, CB);
  assert.equal(cb.searchParams.get('state'), 's1');
  const code = cb.searchParams.get('code')!;
  const tok = await O.token(post('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: f.reg.client_id, code_verifier: f.verifier, resource: `${BASE}/mcp` })), f.cfg);
  assert.equal(tok.status, 200);
  assert.equal(tok.headers.get('Cache-Control'), 'no-store');
  const t: any = await jbody(tok);
  assert.ok(looksLikeOurAccessToken(t.access_token) && looksLikeOurRefreshToken(t.refresh_token) && t.expires_in === 3600 && t.token_type === 'Bearer');
  // only hashes are stored
  const stored = JSON.stringify(db.t);
  assert.ok(!stored.includes(t.access_token) && !stored.includes(t.refresh_token) && !stored.includes(code) && !stored.includes(f.requestId));
  // refresh rotates; the old refresh token then kills the family
  const r1: any = await jbody(await O.token(post('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.reg.client_id })), f.cfg));
  assert.ok(r1.access_token && r1.access_token !== t.access_token && r1.refresh_token !== t.refresh_token);
  const replay = await O.token(post('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.reg.client_id })), f.cfg);
  assert.equal(replay.status, 400);
  assert.equal((await jbody(replay)).error, 'invalid_grant');
  assert.equal(db.t.mcp_oauth_tokens.filter((x: Row) => !x.revoked_at).length, 0);          // theft response: family revoked
  const again = await O.token(post('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: r1.refresh_token, client_id: f.reg.client_id })), f.cfg);
  assert.equal(again.status, 400);
});

test('flow: an OL can connect; an APC (or anyone else) gets 404 and no code; a request can be answered once', async () => {
  const db = mk();
  const ol = await connect(db, 'jwt-ol');
  assert.equal((await ol.dec('allow')).status, 200);
  assert.equal((await ol.dec('allow')).status, 410);                                         // already answered
  assert.equal((await ol.dec('deny')).status, 410);
  const apc = await connect(db, 'jwt-apc');
  for (const d of ['info', 'allow', 'deny']) { const r = await apc.dec(d); assert.equal(r.status, 404, d); }
  assert.equal(db.t.mcp_oauth_codes.filter((c: Row) => c.user_id === 'u-apc').length, 0);
  assert.equal((await apc.dec('allow', 'not-a-jwt')).status, 401);
  assert.equal((await O.decision(post('/oauth/decision', '{}', {}), apc.cfg)).status, 401);
  // a deactivated OL is refused too
  db.t.profiles.find((p: Row) => p.id === 'u-ol')!.is_active = false;
  const gone = await connect(db, 'jwt-ol');
  assert.equal((await gone.dec('allow')).status, 404);
});

test('flow: deny goes back to Claude with access_denied; expired requests are refused', async () => {
  const db = mk(); const f = await connect(db, 'jwt-boss');
  const d: any = await jbody(await f.dec('deny'));
  assert.equal(new URL(d.redirect_url).searchParams.get('error'), 'access_denied');
  assert.equal(db.t.mcp_oauth_codes.length, 0);
  const g = await connect(db, 'jwt-boss');
  db.t.mcp_oauth_requests.find((r: Row) => !r.decided_at)!.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await g.dec('allow')).status, 410);
});

test('token endpoint: wrong verifier, client, redirect or resource, a replayed code and unknown grants all fail', async () => {
  const db = mk(); const f = await connect(db, 'jwt-boss');
  const code = new URL(((await jbody(await f.dec('allow'))) as any).redirect_url).searchParams.get('code')!;
  const base = { grant_type: 'authorization_code', code, redirect_uri: CB, client_id: f.reg.client_id, code_verifier: f.verifier };
  const call = (o: Record<string, string>) => O.token(post('/oauth/token', form(o)), f.cfg);
  // each failed attempt below burns the single-use code, so use a fresh one per attempt
  const fresh = async () => { const g = await connect(db, 'jwt-boss'); const c = new URL(((await jbody(await g.dec('allow'))) as any).redirect_url).searchParams.get('code')!; return { g, c }; };
  { const { g, c } = await fresh(); assert.equal((await O.token(post('/oauth/token', form({ ...base, code: c, client_id: g.reg.client_id, code_verifier: 'a'.repeat(50) })), g.cfg)).status, 400); }
  { const { g, c } = await fresh(); assert.equal((await O.token(post('/oauth/token', form({ ...base, code: c, client_id: 'wxc_other' })), g.cfg)).status, 400); }
  { const { g, c } = await fresh(); assert.equal((await O.token(post('/oauth/token', form({ ...base, code: c, client_id: g.reg.client_id, redirect_uri: 'https://claude.com/api/mcp/auth_callback' })), g.cfg)).status, 400); }
  { const { g, c } = await fresh(); const r = await O.token(post('/oauth/token', form({ ...base, code: c, client_id: g.reg.client_id, resource: 'https://evil.com/mcp' })), g.cfg); assert.equal((await jbody(r)).error, 'invalid_target'); }
  assert.equal((await call({ ...base, client_id: f.reg.client_id })).status, 200);           // the real one still works...
  const replay = await call({ ...base, client_id: f.reg.client_id });                         // ...once
  assert.equal(replay.status, 400);
  assert.equal(db.t.mcp_oauth_tokens.filter((x: Row) => !x.revoked_at).length, 0);           // replay revoked what the code produced
  assert.equal((await jbody(await call({ grant_type: 'password', username: 'a', password: 'b' }))).error, 'unsupported_grant_type');
  assert.equal((await call({ grant_type: 'authorization_code' })).status, 400);
  assert.equal((await O.token(post('/oauth/token', 'x'.repeat(5000)), f.cfg)).status, 400);
});

test('token endpoint refuses to issue to an account that lost access between approval and exchange', async () => {
  const db = mk(); const f = await connect(db, 'jwt-boss');
  const code = new URL(((await jbody(await f.dec('allow'))) as any).redirect_url).searchParams.get('code')!;
  db.t.profiles.find((p: Row) => p.id === 'u-boss')!.role = 'apc';
  const r = await O.token(post('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: f.reg.client_id, code_verifier: f.verifier })), f.cfg);
  assert.equal(r.status, 400);
  assert.equal(db.t.mcp_oauth_tokens.length, 0);
});

test('authorize: unknown client or unregistered redirect gives an error page, never a redirect; registration is throttled', async () => {
  const db = mk(); const cfg = { admin: db, base: BASE };
  const bad = await O.authorize(new Request(`https://x.test/oauth/authorize?${authQ({ client_id: 'wxc_nope' })}`), cfg);
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('Location'), null);
  const reg: any = await jbody(await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: [CB] })), cfg));
  const evil = await O.authorize(new Request(`https://x.test/oauth/authorize?${authQ({ client_id: reg.client_id, redirect_uri: 'https://evil.com/cb' })}`), cfg);
  assert.equal(evil.status, 400);
  assert.equal(evil.headers.get('Location'), null);
  assert.equal((await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: ['https://evil.com/cb'] })), cfg)).status, 400);
  assert.equal((await O.register(post('/oauth/register', 'x'.repeat(5000)), cfg)).status, 400);
  // Flooding registration cannot grow the table: every registration of the same redirect set shares one client.
  for (let i = 0; i < 40; i++) await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: [CB], client_name: `spam ${i}` })), cfg);
  assert.equal(db.t.mcp_oauth_clients.length, 1);
  assert.equal((await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: [CB] })), cfg)).status, 201);
  const other = 'https://claude.com/api/mcp/auth_callback';
  await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: [other] })), cfg);
  await O.register(post('/oauth/register', JSON.stringify({ redirect_uris: [other, CB] })), cfg);
  assert.equal(db.t.mcp_oauth_clients.length, 3);                                              // at most three distinct sets exist
});

test('binding: a consent link opened in a different browser (no or wrong cookie) cannot be answered', async () => {
  const db = mk(); const f = await connect(db, 'jwt-boss');
  assert.match(f.auth.headers.get('Set-Cookie')!, /^wx_mcp_bind=wn_[A-Za-z0-9_-]{32}; Path=\/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  for (const d of ['info', 'allow', 'deny']) {
    assert.equal((await f.dec(d, 'jwt-boss', '')).status, 403, `${d} without the cookie`);
    assert.equal((await f.dec(d, 'jwt-boss', 'wx_mcp_bind=wn_' + 'A'.repeat(32))).status, 403, `${d} with a wrong cookie`);
  }
  assert.equal(db.t.mcp_oauth_codes.length, 0);
  assert.equal(db.t.mcp_oauth_requests[0].decided_at ?? null, null);                          // still undecided: the real browser can answer
  assert.equal((await f.dec('allow')).status, 200);
  // the state is length-capped before anything is stored
  const long = await O.authorize(new Request(`https://x.test/oauth/authorize?${authQ({ client_id: f.reg.client_id, state: 's'.repeat(600) })}`), f.cfg);
  assert.equal(new URL(long.headers.get('Location')!).searchParams.get('error'), 'invalid_request');
});

test('revoke: either token ends the connection; unknown tokens still answer 200', async () => {
  const db = mk(); const f = await connect(db, 'jwt-boss');
  const code = new URL(((await jbody(await f.dec('allow'))) as any).redirect_url).searchParams.get('code')!;
  const t: any = await jbody(await O.token(post('/oauth/token', form({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: f.reg.client_id, code_verifier: f.verifier })), f.cfg));
  assert.equal((await O.revoke(post('/oauth/revoke', form({ token: 'garbage' })), f.cfg)).status, 200);
  assert.equal(db.t.mcp_oauth_tokens.filter((x: Row) => !x.revoked_at).length, 1);
  assert.equal((await O.revoke(post('/oauth/revoke', form({ token: t.refresh_token })), f.cfg)).status, 200);
  assert.equal(db.t.mcp_oauth_tokens.filter((x: Row) => !x.revoked_at).length, 0);
});
