// The connector's own sign-in layer (OAuth 2.1 authorization-code + PKCE), pure helpers. No database, no
// network: the endpoints in mcp/index.ts call these and keep the state in the mcp_oauth_* tables (mig 436).
//
// The tokens it issues are OPAQUE and work ONLY at /mcp. They are not Supabase tokens, so they cannot be used
// against PostgREST, Auth or any other function, whatever the signed-in person could otherwise do.

export const ACCESS_TTL_S = 3600;                 // 1 hour
export const REFRESH_TTL_S = 30 * 24 * 3600;      // 30 days, rotated on every use
export const CODE_TTL_S = 60;
export const REQUEST_TTL_S = 600;
export const SCOPE = 'mcp';

// Claude's own callbacks, EXACT strings (Anthropic: may move from claude.ai to claude.com, so both).
export const ALLOWED_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
export const redirectAllowed = (uri: unknown) => typeof uri === 'string' && ALLOWED_REDIRECTS.includes(uri);

const B64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(prefix: string, bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix}_${B64(b)}`;
}
export const randomId = () => randomToken('c', 16).slice(2);

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export async function sha256B64Url(s: string): Promise<string> {
  return B64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(String(a)), eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// RFC 7636: S256 only. The verifier is 43-128 unreserved characters.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;                 // base64url of a SHA-256: always 43 characters
export const challengeShapeOk = (c: unknown) => typeof c === 'string' && CHALLENGE.test(c);
export async function pkceOk(verifier: unknown, challenge: unknown): Promise<boolean> {
  if (typeof verifier !== 'string' || !VERIFIER.test(verifier) || !challengeShapeOk(challenge)) return false;
  return safeEqual(await sha256B64Url(verifier), challenge as string);
}

// Public URLs. They come from configuration, never from the incoming request, so a spoofed Host header cannot
// move them. `base` = the origin Claude talks to (https://wurxos.vercel.app), proxied to the function.
export const trimBase = (b: string) => String(b || '').replace(/\/+$/, '');
export const resourceUrl = (base: string) => `${trimBase(base)}/mcp`;

export function protectedResourceMetadata(base: string) {
  return { resource: resourceUrl(base), authorization_servers: [trimBase(base)], bearer_methods_supported: ['header'], scopes_supported: [SCOPE], resource_name: 'WurxOS' };
}
export function authorizationServerMetadata(base: string) {
  const b = trimBase(base);
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

// ---- dynamic client registration (RFC 7591) ---------------------------------------------------
export type ClientReg = { ok: true; name: string; redirectUris: string[] } | { ok: false; error: string; description: string };
const cleanName = (s: unknown) => String(s ?? 'Claude').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) || 'Claude';
export function parseRegistration(body: any): ClientReg {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_client_metadata', description: 'JSON object expected' };
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 5) return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris is required' };
  if (!uris.every(redirectAllowed)) return { ok: false, error: 'invalid_redirect_uri', description: 'only Claude\'s own callback addresses are allowed' };
  const grants = body.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g: unknown) => g === 'authorization_code' || g === 'refresh_token'))) return { ok: false, error: 'invalid_client_metadata', description: 'unsupported grant_types' };
  return { ok: true, name: cleanName(body.client_name), redirectUris: [...new Set(uris as string[])] };
}

// ---- authorization request --------------------------------------------------------------------
export type AuthReq =
  | { ok: true; clientId: string; redirectUri: string; state: string | null; challenge: string; resource: string }
  | { ok: false; to: 'page' | 'redirect'; error: string; description: string; redirectUri?: string; state?: string | null };

// `client` = the registered client (or null). A bad client or redirect is NEVER redirected to: it gets an error page.
export function parseAuthorize(q: URLSearchParams, client: { client_id: string; redirect_uris: string[] } | null, base: string): AuthReq {
  const redirectUri = q.get('redirect_uri') ?? '';
  const clientId = q.get('client_id') ?? '';
  if (!client || client.client_id !== clientId) return { ok: false, to: 'page', error: 'invalid_client', description: 'unknown client' };
  if (!client.redirect_uris.includes(redirectUri) || !redirectAllowed(redirectUri)) return { ok: false, to: 'page', error: 'invalid_request', description: 'redirect_uri does not match the registration' };
  const state = q.get('state');
  const back = (error: string, description: string): AuthReq => ({ ok: false, to: 'redirect', error, description, redirectUri, state });
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
  const challenge = q.get('code_challenge') ?? '';
  if (!challengeShapeOk(challenge)) return back('invalid_request', 'a valid code_challenge is required');
  if ((q.get('code_challenge_method') ?? '') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
  const resource = q.get('resource');
  const mine = resourceUrl(base);
  if (resource !== null && trimBase(resource) !== mine) return back('invalid_target', 'unknown resource');
  const scope = q.get('scope');
  if (scope && scope.split(/\s+/).some((s) => s && s !== SCOPE && s !== 'openid' && s !== 'profile' && s !== 'email' && s !== 'offline_access')) return back('invalid_scope', 'unknown scope');
  return { ok: true, clientId, redirectUri, state, challenge, resource: mine };
}

export function redirectWith(uri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// ---- token endpoint ---------------------------------------------------------------------------
export type TokenError = { error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_target'; error_description: string };
export const tokenError = (error: TokenError['error'], error_description: string): TokenError => ({ error, error_description });

export function tokenResponse(access: string, refresh: string) {
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}

// Bearer token off a request header; null when absent or not shaped like ours.
export function bearer(h: string | null): string | null {
  const m = String(h ?? '').match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}
export const looksLikeOurAccessToken = (t: string) => /^wxa_[A-Za-z0-9_-]{43}$/.test(t);
export const looksLikeOurRefreshToken = (t: string) => /^wxr_[A-Za-z0-9_-]{43}$/.test(t);
