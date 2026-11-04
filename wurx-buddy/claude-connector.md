# Claude connector (MCP) — runbook

WurxOS as a read-only connector for claude.ai. Boss, OL and developer roles only (`_shared/mcp/access.ts`).

## What ships
- `supabase/functions/mcp` — MCP over HTTP; tools = Wurx Buddy's data tools (`_shared/ai/tools`). Boss runs on the service client; OL/developer on their own JWT so RLS applies, plus the page guards in `tools/roles.ts`.
- `supabase/migrations/435_mcp_call_log.sql` — audit log (Boss-readable) that also backs the 30 calls/minute limit.
- `/oauth/consent` (`src/pages/oauth/ConnectorConsentPage.jsx`) — the Allow/Deny screen.

## Go-live (in this order; the Boss decides when)
1. Apply migration 435.
2. Deploy: `npx supabase functions deploy mcp --no-verify-jwt --project-ref xoaaidgvblondjpvxjqp --use-api`
3. Supabase dashboard → Authentication → OAuth Server: enable it, allow dynamic client registration, set
   Authorization Path = `/oauth/consent`. (The site URL must be the production app URL.)
4. claude.ai (workspace admin) → Settings → Connectors → Add custom connector →
   `https://xoaaidgvblondjpvxjqp.supabase.co/functions/v1/mcp`. Each person signs in on first use.
5. Test as the Boss: ask "who has the highest performance score among TLs in October?" (expect Muhammad Azam, 79,
   2026-11-03), then as an OL: ask for another person's salary (expect a refusal).

## Notes
- Read-only by design. Writes need a confirmation step and a separate review.
- Audit: `select * from mcp_call_log order by id desc` (Boss). Nothing prunes it yet.
- To let more roles in, edit `MCP_ROLES`; to change the limit, `MCP_CALLS_PER_MINUTE`.
