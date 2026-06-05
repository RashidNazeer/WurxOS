---
name: euka-integration
description: Euka → TikTok Shop metrics integration — v1 shipped
metadata: 
  node_type: memory
  type: project
  originSessionId: bcc0fa68-83c2-4ad6-b487-ce2665be9ba7
---

WurxOS pulls per-store TikTok Shop figures from Euka (euka.ai — TikTok Shop
affiliate platform) and shows them in a dashboard.

**v1 — shipped & deployed 2026-05-18** (branch `feat/euka-shop-metrics`,
migration 183):
- Euka exposes only an **MCP server** (`https://app.euka.ai/api/mcp`). Auth =
  a static **bearer token** (in `.env.local` as `EUKA_TOKEN`, and set as the
  `euka-sync` edge-function secret). The token is the only viable auth for an
  unattended sync — OAuth needs a human.
- `euka-sync` edge function = an MCP client: handshake → `list_accessible_stores`
  → `query_store_data` per store asking for **strict JSON** output → parse →
  insert into `euka_shop_metrics`. Self-rate-limited to once per 10 min.
- Migration 183: `euka_shop_metrics` table (append-history), `brands.euka_store_id`
  mapping column, RLS, realtime, pg_cron every 3h (pg_net POST to the function).
- Frontend: `/shop-metrics` dashboard (Boss/OL) — GMV/units/orders for 7d & 30d
  per store, Sync now, OL store→brand link control. `src/lib/eukaApi.js`.

**Known limitations / phase-2 notes:**
- `query_store_data` is LLM-mediated — numbers can vary slightly between calls
  (it's not a deterministic API). Good enough for directional dashboards.
- Euka only covers shops connected in the Euka account (currently 1: InnoSupps).
- The robust long-term alternative is the **TikTok Shop Partner API** (own
  pipeline, all shops, structured) — deferred unless v1 proves insufficient.
- One-off probe scripts: `migration/euka_probe*.mjs` (uncommitted).
