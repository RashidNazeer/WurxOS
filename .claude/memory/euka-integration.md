---
name: euka-integration
description: Euka → TikTok Shop analytics integration — v2 (REST API) shipped; MCP retired
metadata: 
  node_type: memory
  type: project
  originSessionId: bcc0fa68-83c2-4ad6-b487-ce2665be9ba7
---

WurxOS pulls TikTok Shop performance/creator/content data from Euka (euka.ai)
and shows it on a Boss-only dashboard.

**v2 — shipped 2026-06-17 (REST API; replaces the v1 MCP sync).**
- Euka now has a real **REST API**: base `https://api.euka.ai/v0`, auth =
  `Authorization: Bearer euka_openapi_...` (an **OpenAPI key**, created in the
  Euka app → Settings → Integrations → OpenAPI keys). Deterministic, structured
  JSON — no LLM, unlike v1. Stored in `.env.local` as **`EUKA_API_KEY`** and as
  the `euka-api` edge-function secret.
- 20 endpoints. Bootstrap: `GET /me` (key scope; `brandAccessMode` all|selected
  + `brandIds`), `GET /brands`, `GET /stores`. Then `POST /dashboard/*` keyed on
  `storeId` (NOT brand). Dates are `YYYY-MM-DD`, **America/Los_Angeles** calendar.
  Three request shapes: flat `{startDate,endDate}` (performance-overview/series,
  campaign-breakdown, affiliate-/conversion-funnel); `{postedDateRange:{start,end}}`
  (top-creators/products, livestream, sample-approval, featured-products, ads-,
  content-, creator-level-, outreach-); nested `{filter:{postedDateRange}}`
  (top-videos, uses `fromCampaignIds`). Comparison deltas are built-in
  (`*Difference`/`delta`/`revenueDelta`). The current key is scoped to ONE brand
  (Solid Gold Pets, store `e9d58f04-…`); broaden via the key's scope in Euka.
- **Security:** the OpenAPI key is a full-read secret → NEVER sent to the
  browser. All access goes through the **`euka-api` edge function** (proxy):
  verifies the caller is an active Boss (JWT → profiles.role), allow-lists the
  path, forwards with the key, and **caches responses 15 min** in `euka_api_cache`
  (mig 205, RLS deny-all to clients) to cap billed calls. Frontend talks only to
  this function. Client lib: `src/lib/eukaAnalyticsApi.js`. Page:
  `src/pages/euka/EukaAnalyticsPage.jsx` (+ `EukaKit.jsx` SVG charts), route
  `/euka`, RoleGuard boss-only, menu item "Euka Analytics".
- **Billing/rate limits:** NOT exposed by the API/spec/headers — they live in the
  Euka dashboard. The 15-min server cache + React Query staleTime are our spend
  safeguards; there's no documented 429.

**Retired (v1, MCP):** the `euka-sync` edge function (LLM `query_store_data`,
non-deterministic, only affiliate GMV/videos/samples trustworthy) is removed and
its pg_cron unscheduled (mig 205). The old `/shop-metrics` page + `src/lib/eukaApi.js`
are deleted. The `euka_shop_metrics` table (mig 183) is LEFT IN PLACE (historical
snapshots, no data dropped) but is no longer written/read. `EUKA_TOKEN` (the old
MCP bearer) is now unused.

**API is READ-ONLY — confirmed against the live spec (2026-06).** Pulled the
full OpenAPI doc (`https://api.euka.ai/openapi.json`, OpenAPI 3.1.1, title "Euka
API"): exactly **20 paths, all reads** — `GET /ping /me /brands /stores
/data-export` + 15 `POST /dashboard/*` analytics queries. **No PUT/PATCH/DELETE,
no POST outside /dashboard/**, and NO endpoints to manage/start/stop agents,
outreach, messaging, campaigns, samples, or automations. (campaign-breakdown /
creator-outreach-funnel / sample-approval-rate are analytics, not controls.)
So Euka's automation/"agent" features (auto outreach, sampling, follow-up
sequences, reactivation, AI copilot — all real in their SaaS UI) are NOT
controllable via the public API. `GET /me` returns only brand scope
(`brandAccessMode` + `brandIds`), no read/write scope concept — the key can't
do writes because the API has none. To ever drive agents from WurxOS we'd need
Euka to ship write endpoints (ask their support/roadmap); otherwise the only
"control" path is UI-level (deep-link/embed) or webhooks if they add event push.

**Phase-2 ideas (all READ):** auto-fill weekly-report fields (top creators/
products, GMV) from the REST endpoints; CSV export passthrough (currently JSON
download only); surface `performance-series` outreach analytics + `dailyAdCost`.
