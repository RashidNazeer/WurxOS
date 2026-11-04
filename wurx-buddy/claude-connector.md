# Claude connector (MCP) — runbook

WurxOS as a read-only connector for claude.ai. **Boss and OL roles ONLY** (`_shared/mcp/access.ts`, read from the
database on every request). To everyone else it does not exist (404; the consent route redirects away).

## Architecture (the security layer is ours)
```
Claude ──https://wurxos.vercel.app/mcp──▶ Vercel rewrite ──▶ edge function `mcp`
         /.well-known/oauth-*  /oauth/{register,authorize,decision,token,revoke}   (same rewrites)
```
- **Our own OAuth 2.1** (authorization code + PKCE S256, public clients, dynamic registration restricted to
  Claude's two exact callback URLs). Tokens are opaque (`wxa_…` access 1 h, `wxr_…` refresh 30 d, rotating, reuse
  revokes the family), stored as SHA-256 hashes in `mcp_oauth_*` (mig 436, service-role only). They are **not Supabase
  tokens**: they work only at `/mcp`, never against PostgREST, Auth or other functions.
- **Supabase's own OAuth Server must stay OFF** (and "Allow Dynamic OAuth Apps" off, no registered apps).
- **Boss** → Wurx Buddy's data tools on the service client. **OL** → a *read-only* Postgres session as that person
  (`_shared/mcp/sqlBuilder.ts` + `mcp/pgExec.ts`: `role authenticated`, their id in the JWT claims, `read only`, 8 s
  timeout), so RLS decides, then `tools/roles.ts` `OL_SEES` narrows to what the app shows an OL; salary own-only.
- Consent page `/oauth/consent` (app route, Boss/OL only) → `POST /oauth/decision` with the person's Supabase login AND the HttpOnly cookie set by `/oauth/authorize` (a link opened in another browser cannot be approved).
- Every tool call: logged (`mcp_call_log`, mig 435), Boss 30/min and OL 12/min, at most 2 running at once per person and 6 OL sessions in all, reserve-then-count, fail closed. Body ≤ 64 KB, batches ≤ 5 run one at a time. Each OL call holds one database connection for its duration (set `MCP_DB_URL` to the transaction pooler, port 6543, if headroom is tight; check `select count(*) from pg_stat_activity` before go-live).

## Go-live (in this order; the Boss decides when)
1. Supabase dashboard → Authentication → OAuth Server: **disable** it and "Allow Dynamic OAuth Apps"; delete any apps.
2. Merge the PR, apply migrations 435 and 436, deploy: `npx supabase functions deploy mcp --no-verify-jwt --project-ref xoaaidgvblondjpvxjqp --use-api` (Vercel deploys the rewrites from `vercel.json` on merge).
3. Check: `curl https://wurxos.vercel.app/.well-known/oauth-authorization-server` and `…/oauth-protected-resource/mcp`
   return JSON; `POST https://wurxos.vercel.app/mcp` with no token returns 401 + `WWW-Authenticate`.
4. Each Boss/OL (own Claude, Pro/Max): Settings → Connectors → Add custom connector → `https://wurxos.vercel.app/mcp`
   → Connect → sign in to WurxOS → Allow.
5. Test as the Boss ("who has the highest performance score among TLs in October?" → Muhammad Azam, 79), then as an
   OL (another person's salary → refused; another OL's performance → refused).

## Controls
- Kill switch: `update app_config set value='false' where key='mcp_enabled'` (insert the row if absent) stops sign-in
  and every call; `select mcp_revoke_all()` (Boss) revokes every connection; `mcp_connections()` /
  `mcp_revoke_connection(family)` list and revoke one.
- Audit: `select * from mcp_call_log order by id desc` (Boss). Refused attempts are logged as `(refused)`.
- Widening roles is a deliberate, reviewed change to `MCP_ROLES`.

## OL sees what the app shows an OL (audit 2026-11-04)
`tools/roles.ts` `OL_SEES`: Performance = TL/PCTL/APC/IPC; Incentives = active apc/ipc/tl/ol/ads_manager; directory
email/responsibilities = tl/pctl/ol/apc/ipc; attendance roster = tl/pctl/ol/apc/ipc; no employment type or start date of
others; salary own-only. An OL with no database session of their own is refused, never served by the service client.

## Known limits
- A person can be tricked into approving a connection someone else started in their own Claude (the consent page says
  to approve only if you just pressed Connect). Tokens are read-only and logged, and revocable.
- Not yet verified against real Claude: the exact registration/token requests it sends. The first live connection is
  the test; log request shapes (no secrets) if it fails.
- Not yet verified: the `postgres` driver connecting from the edge runtime with `SUPABASE_DB_URL`.
