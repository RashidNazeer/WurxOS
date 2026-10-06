# WurxOS Assistant v2 — Architecture

> Companion to [plan.md](plan.md). `plan.md` says **what** we build and in what
> order; this document says **how**: every component, table, parameter,
> algorithm and failure mode. It is the reference we build against. When the
> build deviates from it, update this file in the same commit.

**Status:** design, v1.0 (2026-09-26), **partly superseded by what shipped.**

> **Read this first (2026-10-06).** This document is the original design. The
> build has moved past it in several places, and where they disagree, the code
> in `supabase/functions/_shared/ai/` and `supabase/migrations/` is the truth:
>
> | Designed here | What actually shipped |
> |---|---|
> | §12.1 one OpenAI/Gemini adapter, failover "off by default" | six key slots (`primary`, `fallback`, `groq`, `gemini`, `nvidia`, `nvidia2`) across two APIs, a Boss-configured model chain, an automatic safety net over the whole `ai_model_catalog`, per-model cooldowns, learned unsupported-parameter and token-budget handling (migs 397, 401, 405) |
> | §13 `ai_assistant_config.engine` v1/v2 switch | dropped at cutover; `assistant` replaced `ai-chat` outright |
> | §7 one embedding space | two: `embedding` (OpenAI) + `embedding_alt` (NVIDIA/Gemini); `vector_pending` means no vector in **either** (migs 406, 408) |
> | — | per-role models (mig 404). The budget-saver/economy tier was built and then **removed** on Owner instruction 2026-10-02 |
> | — | ingestion quiet hours, 18:00–02:00 PKT (migs 407, 409) |
> | — | **web search and browsing** (mig 415) — see §24 below |
> | §11.1 tool catalog | as built: 5 search tools + 16 data tools = 21, plus the 2 web tools when web search is on (23) |
>
> The duplicate `wurx-buddy/supabase/` has been removed; the tests now live beside the shipped code in
> `supabase/functions/_shared/ai/__tests__/`.

---

## Contents

0. [Conventions](#0-conventions)
1. [Design principles](#1-design-principles)
2. [System overview](#2-system-overview)
3. [Data layer: schema](#3-data-layer-schema)
4. [Access control](#4-access-control)
5. [Source catalog & extractors](#5-source-catalog--extractors)
6. [Chunking](#6-chunking)
7. [Embedding](#7-embedding)
8. [Indexing](#8-indexing)
9. [Ingestion pipeline](#9-ingestion-pipeline)
10. [Retrieval pipeline](#10-retrieval-pipeline)
11. [Structured data tools](#11-structured-data-tools)
12. [Agent orchestration](#12-agent-orchestration)
13. [API & streaming protocol](#13-api--streaming-protocol)
14. [Security & privacy](#14-security--privacy)
15. [Observability](#15-observability)
16. [Evaluation framework](#16-evaluation-framework)
17. [Master parameter table](#17-master-parameter-table)
18. [Cost model](#18-cost-model)
19. [Deployment & environments](#19-deployment--environments)
20. [Step-by-step build sequence](#20-step-by-step-build-sequence)
21. [Runbooks](#21-runbooks)
22. [Risks & open questions](#22-risks--open-questions)
23. [Glossary](#23-glossary)
24. [Web search and browsing](#24-web-search-and-browsing-mig-415-2026-10-06)

---

## 0. Conventions

| Item | Convention |
|---|---|
| Migrations | `supabase/migrations/NNN_ai_*.sql`. 365 and 366 are taken (366 = GMV Max goal sync, on `origin/main`), so this project starts at **367**. Always `ls` first; the number moves. Every migration is idempotent (`if not exists`, `create or replace`, `drop policy if exists`). |
| Edge functions | Deno, `supabase/functions/<name>/index.ts`. Shared code in `supabase/functions/_shared/ai/`. |
| New functions | `ai-ingest` (worker), `tts-crawl` (crawler), `assistant` (v2 chat). **`ai-chat` stays untouched until cutover** (§19). |
| Time | DB is locked to `Asia/Karachi` (mig 095). All "month/week" logic resolves in PKT. pg_cron expressions carry a PKT comment. |
| Token estimate | `ceil(chars / 4)` (same heuristic as `scripts/tts-ingest/ingest.mjs`), with a 10 % safety margin on every hard limit. |
| Hash | `sha256` hex. |
| IDs | `uuid` for our rows; `source_id` is `text` so external IDs (TikTok `knowledge_id`) fit. |
| Git | Branch `feat/assistant-rag`, local commits only. **No push, no `db push`, no `functions deploy` without explicit approval.** |

---

## 1. Design principles

1. **Numbers come from SQL, words come from retrieval.** Embeddings are never
   the source of a figure: GMV, pay, attendance %, scores. Tools return exact
   values; chunks provide narrative, context and pointers.
2. **One knowledge store, one ingestion path.** Every text source flows
   `source row → queue → worker → ai_documents/ai_chunks`. There are no
   per-source side pipelines, so each fix applies everywhere.
3. **The source table is the truth; the index is a cache.** The index can be
   dropped and rebuilt from sources at any time (backfill). Nothing is only in
   the index.
4. **Permissions are enforced by the database at query time,** using the same
   helper functions the app uses (`can_view_report`, `can_view_brand`,
   `is_boss`). The index never grants more than the app does.
5. **Never block a user's save.** Triggers do one tiny insert inside an
   exception guard. All heavy work is asynchronous.
6. **Idempotent everything.** Processing an item twice gives the same state.
   Crashes are recovered by lock timeouts and a nightly reconciler.
7. **Pay only for change.** Per-chunk content hashes mean unchanged text is
   never re-embedded.
8. **Additive rollout.** v2 runs beside v1 behind a switch until the evaluation
   proves it better.
9. **Measure before and after.** Every phase is gated by the evaluation suite.

---

## 2. System overview

### 2.1 Component diagram

```
┌──────────────────────────── SOURCES ─────────────────────────────┐
│ reports · gmv_max_reports · kb_articles · ai_assistant_docs      │
│ (incl. app guides) · agenda_tasks/presentations · brands         │
│ ai_generated_docs (brand profiles) · tts_articles (crawl staging)│
└───────────────┬──────────────────────────────────────────────────┘
                │ AFTER INSERT/UPDATE/DELETE triggers (guarded, tiny)
                ▼
        ┌────────────────┐   pg_cron 1/min    ┌──────────────────────────┐
        │ ai_ingest_queue│◄──── claim ────────│ ai-ingest (edge fn)      │
        └────────────────┘   net.http_post    │ extract → chunk → hash → │
                ▲                              │ embed(batch) → upsert    │
   reconciler   │  backfill                    └────────────┬─────────────┘
   (nightly) ───┘  (on demand)                              │ OpenAI embeddings
                                                            ▼
                                   ┌──────────────────────────────────────┐
                                   │ ai_documents (1 per source item, ACL)│
                                   │ ai_chunks    (vector + fts)          │
                                   └──────────────┬───────────────────────┘
                                                  │ ai_search() hybrid RRF + ACL
┌────────────┐   SSE    ┌─────────────────────────┴─────────────────────────┐
│ /assistant │◄────────►│ assistant (edge fn) — agent loop                  │
│  React UI  │          │  condense → tools (search_knowledge | data tools) │
└────────────┘          │  → answer + citations → log                       │
      ▲                 │  LLM adapter: OpenAI (Responses) | Gemini         │
      │ Slack relay     └───────────────────────────────────────────────────┘
      └── slack-events ──► (internal secret, answer-as-Boss)

  tts-crawl (weekly + ticks) ──► tts_articles ──trigger──► queue
  sync-app-guides.mjs (manual/pre-deploy) ──► ai_assistant_docs ──trigger──► queue
  brand-profile generator (nightly) ──► ai_generated_docs ──trigger──► queue
```

### 2.2 Component inventory

| Component | Type | Responsibility | New / existing |
|---|---|---|---|
| `ai_documents`, `ai_chunks` | tables | knowledge store | new |
| `ai_ingest_queue` | table | change log / work queue | new |
| `ai_ingest_runs` | table | worker run history | new |
| `tts_articles` | table | crawl staging for TikTok Academy | new |
| `ai_generated_docs` | table | derived docs (brand profiles) | new |
| `ai_request_log` | table | per-question telemetry | new |
| `ai_crawl_state` | table | crawler cursor | new |
| `ai_assistant_config` | table | + new columns (§17) | existing (mig 206) |
| `ai_assistant_docs` | table | + `kind`, `slug`, `meta` | existing (mig 206) |
| `ai_conversations`, `ai_messages` | tables | + `ai_messages.meta` | existing (mig 206) |
| `tts_knowledge` | table | migrated into `ai_chunks`, then dropped | existing (mig 223) |
| `ai_search()` | RPC | hybrid, permission-filtered search | new |
| `ai_can_read_document()` | SQL fn | ACL check | new |
| `ai_ingest_claim()`, `ai_ingest_complete()`, `ai_ingest_fail()` | RPCs | queue ops | new |
| `ai_enqueue()` | SQL fn | used by all triggers | new |
| `ai-ingest` | edge fn | worker | new |
| `tts-crawl` | edge fn | crawler | new (port of `scripts/tts-ingest/ingest.mjs`) |
| `assistant` | edge fn | v2 chat agent | new (evolves from `ai-chat`) |
| `_shared/ai/*` | Deno modules | extractors, chunker, embedder, llm adapter, tools | new |
| `Assistant/scripts/*.mjs` | Node scripts | guide sync, backfill trigger, eval runner | new |
| Train tab | React | + ingest health, v1/v2 switch, provider/model | existing, extended |

---

## 3. Data layer: schema

Draft DDL. Final column lists are confirmed in Phase 0 (inventory) and may
gain columns, but the structure is fixed here.

### 3.1 `ai_documents`: one row per indexed source item

```sql
create table public.ai_documents (
  id                 uuid primary key default gen_random_uuid(),
  source_type        text not null,          -- see §5 catalog
  source_id          text not null,          -- PK of source row / external id
  title              text not null,
  url                text,                   -- in-app path (/weekly-reports/…) or external URL
  -- Filters (promoted from metadata for index use)
  brand_id           uuid references public.brands(id) on delete cascade,
  period_start       date,
  period_end         date,
  -- ACL (§4)
  acl_mode           text not null,          -- 'all'|'roles'|'report'|'brand'|'kb'|'boss'
  acl_roles          text[] not null default '{}',
  acl_users          uuid[] not null default '{}',
  author_id          uuid,                   -- used by acl_mode='report' / 'kb'
  -- Bookkeeping
  metadata           jsonb not null default '{}'::jsonb,
  doc_hash           text not null,          -- hash of the full extracted text + ACL
  chunk_count        int  not null default 0,
  status             text not null default 'active' check (status in ('active','deleted')),
  source_updated_at  timestamptz,
  indexed_at         timestamptz not null default now(),
  unique (source_type, source_id)
);
create index on public.ai_documents (source_type, status);
create index on public.ai_documents (brand_id) where brand_id is not null;
create index on public.ai_documents (period_start desc) where period_start is not null;
```

### 3.2 `ai_chunks`: retrievable units

```sql
create table public.ai_chunks (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references public.ai_documents(id) on delete cascade,
  chunk_index      int  not null,
  section          text,                     -- 'summary','insights:overall','written:recommendations',…
  content          text not null,            -- what the model sees (with context header)
  embed_text       text not null,            -- what was embedded (header + content, normalised)
  token_count      int  not null,
  content_hash     text not null,            -- sha256(embed_text || '|' || embedding_model)
  embedding        extensions.vector(1536),
  embedding_model  text not null,
  fts              tsvector generated always as (
                     setweight(to_tsvector('english', coalesce(section,'')), 'B') ||
                     setweight(to_tsvector('english', content), 'A')) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index ai_chunks_embedding_hnsw on public.ai_chunks
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index ai_chunks_fts_gin on public.ai_chunks using gin (fts);
create index on public.ai_chunks (document_id);
```

Why documents and chunks are split: the ACL, filters and "has this item
changed at all?" checks happen once per document, not per chunk. A deleted
source removes one row, and its chunks cascade.

### 3.3 `ai_ingest_queue`

```sql
create table public.ai_ingest_queue (
  id           bigserial primary key,
  source_type  text not null,
  source_id    text not null,
  op           text not null check (op in ('upsert','delete','acl')),
  priority     smallint not null default 5,   -- 0 = urgent … 9 = backfill
  reason       text,                          -- 'trigger','backfill','reconcile','manual','cascade'
  status       text not null default 'pending'
                 check (status in ('pending','processing','done','failed')),
  enqueued_at  timestamptz not null default now(),  -- bumped on every re-enqueue (debounce)
  not_before   timestamptz not null default now(),  -- debounce / backoff gate
  attempts     int not null default 0,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  done_at      timestamptz
);
-- At most ONE pending item per source → re-enqueue collapses into it.
create unique index ai_ingest_queue_pending_uk
  on public.ai_ingest_queue (source_type, source_id) where status = 'pending';
create index ai_ingest_queue_claim_idx
  on public.ai_ingest_queue (priority, not_before) where status = 'pending';
```

`op='acl'` is the **fast path**: re-read the ACL fields and update
`ai_documents` only. There is no extraction or embedding, and no debounce
(§9.4).

### 3.4 Supporting tables

| Table | Key columns | Notes |
|---|---|---|
| `ai_ingest_runs` | `id, started_at, finished_at, claimed, succeeded, failed, embedded_chunks, embed_tokens, skipped_unchanged, error` | one row per worker invocation; retention 30 days |
| `tts_articles` | `knowledge_id pk, url, title, breadcrumb, content_type, category, body, content_hash, first_seen_at, last_seen_at, missed_crawls int, is_active` | the crawler writes here; its trigger enqueues |
| `ai_crawl_state` | `crawler pk, status ('idle','running'), cursor jsonb, started_at, finished_at, stats jsonb` | makes the crawl resumable across invocations |
| `ai_generated_docs` | `id, kind ('brand_profile'), subject_id, title, body, inputs_hash, generated_at, model` | derived documents; its trigger enqueues |
| `ai_request_log` | §15 | per-question telemetry |

### 3.5 Changes to existing tables

| Table | Change |
|---|---|
| `ai_assistant_docs` | `+ kind text default 'doc'` (`'doc'`/`'app_guide'`), `+ slug text unique`, `+ meta jsonb default '{}'` (roles, route, feature, last_reviewed) |
| `ai_assistant_config` | `+ engine text default 'v1'` (`'v1'`/`'v2'`), `+ provider text default 'openai'`, `+ retrieval jsonb` (overrides for §17), `+ monthly_budget_usd numeric` |
| `ai_messages` | `+ meta jsonb` (sources, tools called, request_id) |

### 3.6 RLS summary

| Table | Select | Write |
|---|---|---|
| `ai_documents`, `ai_chunks` | none directly; read only through `ai_search()` (SECURITY DEFINER, ACL inside) | service role only |
| `ai_ingest_queue`, `ai_ingest_runs`, `ai_crawl_state` | `is_ai_admin(auth.uid())` (health panel) | service role; manual retry via RPC `ai_ingest_retry(id)` (admin) |
| `tts_articles`, `ai_generated_docs` | `is_ai_admin` | service role |
| `ai_request_log` | own rows + `is_ai_admin` | service role |

---

## 4. Access control

### 4.1 Model

Each document stores an **ACL mode** plus the minimum keys needed to evaluate
it. The check calls the **app's own helper functions** at query time, so
brand reassignment, role changes and deactivation take effect immediately
with no re-index.

| `acl_mode` | Used by | Rule (`uid` = asking user) |
|---|---|---|
| `all` | TikTok Academy, curated docs, app guides with no role restriction | any active user allowed to use the assistant |
| `roles` | app guides with `roles` frontmatter | caller's role ∈ `acl_roles`, or boss |
| `report` | `reports` | `can_view_report(brand_id, author_id, uid)`, the same function as the `reports_select` policy (mig 012) |
| `brand` | `gmv_max_reports`, brand profiles, agenda tasks | `exists (select 1 from brands b where b.id = brand_id and can_view_brand(b.owner_id, b.id, uid))` |
| `kb` | `kb_articles` | mirrors `kb_select` (mig 134): boss, OL/developer, creator/submitter, or approved and (`office` / role ∈ `acl_roles` / uid ∈ `acl_users`) |
| `boss` | anything sensitive (e.g. agenda task reviews: OL-private) | `is_boss(uid)`, plus `acl_roles` for OL where the source allows |
| `incentive` | incentive plans (mig 373) | exact copy of the app's `inc_select` policy (mig 213): the employee themselves, the boss, an active OL, or their `reports_to` manager |

**Default deny:** an unknown `acl_mode` returns false.

### 4.2 `ai_can_read_document`

```sql
create or replace function public.ai_can_read_document(d public.ai_documents, uid uuid, urole text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.is_boss(uid) then true
    when d.acl_mode = 'all'    then true
    when d.acl_mode = 'roles'  then urole = any(d.acl_roles)
    when d.acl_mode = 'report' then public.can_view_report(d.brand_id, d.author_id, uid)
    when d.acl_mode = 'brand'  then exists (select 1 from public.brands b
                                     where b.id = d.brand_id and public.can_view_brand(b.owner_id, b.id, uid))
    when d.acl_mode = 'kb'     then urole in ('ol','developer') or d.author_id = uid
                                    or coalesce(d.metadata->>'visibility','') = 'office'
                                    or (d.metadata->>'visibility' = 'role'  and urole = any(d.acl_roles))
                                    or (d.metadata->>'visibility' = 'users' and uid   = any(d.acl_users))
    when d.acl_mode = 'boss'   then urole = any(d.acl_roles)   -- e.g. {'ol'} where allowed
    else false
  end;
$$;
```

`urole` is resolved **once per query** by the caller (`ai_search`), per the
mig 134 lesson: per-row profile lookups made the KB page time out.

### 4.3 Identity inside `ai_search`

- Browser path: the edge function calls `ai_search` with the **user's JWT**,
  so `uid := auth.uid()`.
- Slack relay path (no JWT): the function is called with the service role and
  `p_as_user`. `ai_search` accepts `p_as_user` **only** when
  `auth.role() = 'service_role'`, and the edge function has already verified
  that user is an active Boss (existing rule in `ai-chat`).

### 4.4 What is never indexed

Salaries (`employee_compensation`, `salary_history`, basic salary on
incentives), incentive **achieved values / completion / payout state**,
attendance, leave, performance scores, profile emails and phone numbers. These
are available **only** through role-checked tools (§11).
`ai_ingest_write` refuses deny-listed source types
(`^(salar|compensation|attendance|leave|performance)`).

**Incentive plans ARE indexed**. That covers goal text, target, amount, the
source type (attendance/GMV Max/commission) and the linked brand, under ACL
mode `incentive` (the Owner asked for all incentives to be embedded). This is
**provisional**: it's confirmed at the ingestion go/no-go, and it can be
switched off by deleting that source type's documents. Current progress and
payouts always come from the incentives tool.

---

## 5. Source catalog & extractors

Each source has one **extractor** in `_shared/ai/extractors/<source>.ts`
implementing:

```ts
interface Extractor {
  sourceType: string;
  load(admin, sourceId): Promise<SourceRow | null>;   // null → treat as delete
  indexable(row): boolean;                            // false → delete from index
  toDocument(row): ExtractedDoc;                      // title, url, filters, ACL, sections[]
}
type ExtractedDoc = {
  title: string; url?: string; brandId?: string; periodStart?: string; periodEnd?: string;
  acl: { mode: string; roles?: string[]; users?: string[]; authorId?: string };
  metadata: Record<string, unknown>;
  header: string;                       // context header prepended to every chunk (§6.3)
  sections: { key: string; title: string; text: string; kind: 'prose'|'table'|'metrics' }[];
  sourceUpdatedAt?: string;
};
```

### 5.1 Catalog

| # | `source_type` | Source table | Indexable when | Granularity | ACL | Priority |
|---|---|---|---|---|---|---|
| S1 | `kb_article` | `kb_articles` | `approval_status='approved'` **and** latest `version` in its `sop_group_id` | one doc per SOP group (latest version) | `kb` | P1 |
| S2 | `ai_doc` | `ai_assistant_docs` (`kind='doc'`) | `is_active` | one doc per row | `all` | P1 |
| S3 | `app_guide` | `ai_assistant_docs` (`kind='app_guide'`) | `is_active` | one doc per guide | `roles` (from `meta.roles`) or `all` | P1 |
| S4 | `tts_article` | `tts_articles` | `is_active` | one doc per article | `all` | P1 |
| S5 | `report` | `reports` (weekly / biweekly / monthly) | `status = 'approved'` **only** (Owner, 2026-09-28) | one doc per report | `report` | P1 |
| S6 | `gmv_max_report` | `gmv_max_reports` | always | one doc per brand-month | `brand` | P2 |
| S7 | `brand_profile` | `ai_generated_docs` (`kind='brand_profile'`) | brand `status='active'` | one per brand | `brand` | P2 |
| S8 | `agenda_task` | `agenda_tasks` | always | one doc per task | `brand` (+ assignee) | P2 |
| S9 | `agenda_presentation` | `agenda_presentations` (`overall_summary`) | summary non-empty | one per presentation | `boss` + `{ol}` | P3 |
| S10 | others | broadcasts, product campaigns, campaign tracker, paid-collab notes | decided in Phase 0 | — | per source | P3 |
| S11 | `incentive` | `incentives` (user × month) | always (plans only, provisional; see §4.4) | one doc per row | `incentive` | P1 |

**As built (2026-09-28):**
- S6 (GMV Max) and S8/S9 (agenda) are **tool-only**; there's too little text to be worth indexing (inventory §4).
- A report or KB article that stops being indexable is **soft-deleted**
  (`ai_documents.status='deleted'`, vectors kept, hidden from `ai_search`), so
  re-publishing it costs no embedding. A source row that is really deleted is
  hard-deleted.
- Volatile fields live in `metadata` only, never in `content` or
  `embed_text`: report status, incentive verified/paid, TikTok views. Changing
  them rewrites no chunk. The Phase 5 `search_knowledge` tool surfaces
  `metadata.status` where it matters.

`agenda_task_reviews` are **excluded** until their visibility rules are final
(they are OL-private today, mig 179).

### 5.2 Report extractor (S5): the critical one

Real shape facts (from `src/lib/reportsApi.js`):

- **Three layouts:**
  1. **Weekly, new form:** `data.insightsSingle === true`. One narrative in `reportInsights`.
  2. **Weekly legacy / bi-weekly:** six per-section insight fields
     (`overallInsights`, `topCreatorsInsights`, `topVideosInsights`,
     `gmvMaxInsights`, `productHighlightsInsights`, `offsiteInsights`).
     Bi-weekly forces `insightsSingle: false`.
  3. **Monthly:** a different shape entirely: `totalSales`, `keyMetrics`,
     `kpis`, `gmvBreakdown`, `videoPerformance`, `creatorsPerformance`,
     `productAnalytics`, `gmvMax`, `customers`, `keyWinsInsights`,
     `campaignsText`, `recommendations`.
- **All figures are strings** (`''` when empty).
- **Currency is per report:** `data.currency`. **Missing means USD** (pre-feature
  reports render as USD). Every chunk states its currency.
- `sections_enabled` (column) / `data.sectionsEnabled`: disabled sections are skipped.
- `customFields: { [id]: { name, value } }` is included as its own section.
- Insight fields may contain HTML, which is converted to text (same rules as
  `htmlToText` in `ai-chat`).

**Section plan per report:**

| Section key | Built from | Kind |
|---|---|---|
| `summary` | headline metrics (weekly: `overallPerformance` + `overallNotes` MTD; monthly: `totalSales` + `keyMetrics` + `kpis`) rendered as one sentence | metrics |
| `insights:all` | `reportInsights` (new weekly) **or** one `insights:<area>` per legacy field | prose |
| `insights:keywins` | monthly `keyWinsInsights` | prose |
| `written:campaigns` | `upcomingCampaigns` / `campaignsText` | prose |
| `written:operational` | `operationalUpdates` | prose |
| `written:recommendations` | `recommendations` + `actionItems` | prose |
| `table:creators` | `topCreators` (name / username, GMV, videos, items sold, notes) | table |
| `table:videos` | `topVideos` (creator, GMV, views, clicks, link, notes) | table |
| `table:products` | `productHighlights` / `productAnalytics` | table |
| `table:gmvmax` | `gmvMax` (+ `gmvMaxMtd`) campaigns | table |
| `monthly:breakdown` | `gmvBreakdown`, `videoPerformance`, `creatorsPerformance`, `customers` | metrics |
| `custom` | `customFields` | table |
| `offsite` | `offsitePerformance` + `offsiteInsights` (note `dataFrom`/`dataTo` if set) | prose |

Empty sections (all values `''`, `'N/A'`, or only placeholders) are dropped.

**Header** (prepended to every chunk; see §6.3):

```
[Weekly report · Bentgo (client: Bentgo Inc.) · Week 12 · 2026-03-16 → 2026-03-22 · status: approved · currency: USD]
```

The brand name and period go into the embedded text because they are search
targets. The **author name does not**; it lives in metadata only, so a profile
rename doesn't trigger a re-embed.

**Metadata:** `report_id, report_type, brand_name, period_label, status, currency, author_id, layout ('single'|'legacy'|'monthly')`.

**URL:** the report's in-app view path, resolved from the router in Phase 5
(weekly / biweekly / monthly routes differ).

### 5.3 KB extractor (S1)

- Resolve the **latest version per `sop_group_id`** (`version desc`, first per
  group; same as `ai-chat` today). Older versions → delete.
- Text = `body` (HTML → text). If `url` is set, append `Full guide: <url>`.
  If there's no body but there is a URL, create one **pointer chunk**:
  "`<title>` — the full SOP is at `<url>`". Most KB rows in this org are
  link-only.
- Metadata: `category, tags, version, sop_group_id, visibility, url, requires_ack`.
- ACL `kb`: `acl_roles = visible_to_roles`, `acl_users = visible_to_users`,
  `author_id = created_by`, `metadata.visibility = visibility`.
- **A new version** enqueues `upsert` for the new row's group and `delete` for
  the superseded row.

### 5.4 TikTok Academy extractor (S4)

Reads `tts_articles` (already cleaned by the crawler). Header:
`[TikTok Shop Academy · <breadcrumb> · <title>]`. Metadata: `knowledge_id,
content_type, category, url`. Citation URL = `url`.

**Migration of existing data:** `tts_knowledge` rows are grouped by
`knowledge_id` into `ai_documents` + `ai_chunks`, reusing their embeddings
(same model), and a matching `tts_articles` row is created. No API cost.

### 5.5 App guide extractor (S3)

Guides are Markdown with frontmatter (spec in §9.9). Sections come from `##`
headings. ACL `roles` from `meta.roles` (`all` if absent). URL = `meta.route`.

### 5.6 GMV Max report extractor (S6)

Numbers are `numeric`, USD (mig 108). Sections: `summary` (cost, SKU orders,
CPO, gross revenue, ROI), `table:campaigns` (from `campaigns` jsonb: name,
target ROI, budget, status, cost, orders, revenue, ROI, notes), `notes`.

### 5.7 Brand profile extractor (S7)

Reads `ai_generated_docs.body` (already prose). Generation is described in §9.10.

### 5.8 Agenda extractors (S8, S9)

- **Task:** `title` + `details` + status / due date / assignee name → one small
  chunk. Brand-scoped ACL.
- **Presentation:** `overall_rating` + `overall_summary` + meeting date + APC
  name. ACL `boss` with `acl_roles={'ol'}`.

---

## 6. Chunking

A single chunker in `_shared/ai/chunker.ts` is driven by per-source parameters.

### 6.1 Algorithm (structure-aware, recursive)

```
for each section in doc.sections:
  if section.kind == 'metrics'  → render as ONE chunk (never split; small by construction)
  if section.kind == 'table'    → one line per row: "- <col>: <val>, <col>: <val>"
                                  split into groups of ≤ TABLE_ROWS_PER_CHUNK rows
  if section.kind == 'prose':
     if tokens(section) ≤ MAX_TOKENS → one chunk
     else split by, in order: markdown headings → blank-line paragraphs →
          sentences (/(?<=[.!?])\s+/) → hard cut at MAX_TOKENS
          pack pieces greedily up to TARGET_TOKENS, carry OVERLAP_TOKENS
          of trailing text into the next chunk
merge any chunk < MIN_TOKENS into its neighbour in the SAME section
cap total chunks per document at MAX_CHUNKS_PER_DOC (log a warning if hit)
```

### 6.2 Parameters by source

| Source | TARGET | MAX | OVERLAP | MIN | Notes |
|---|---|---|---|---|---|
| `report` | 450 | 700 | 60 | 40 | sections are naturally small; most = 1 chunk |
| `kb_article` | 550 | 800 | 80 | 60 | SOPs have headings; keep steps together |
| `app_guide` | 500 | 800 | 60 | 60 | split on `##` first |
| `tts_article` | 600 | 750 | 90 | 60 | matches existing ingest (700 / 90) |
| `gmv_max_report`, `agenda_*`, `brand_profile` | 450 | 700 | 50 | 30 | |

Global: `TABLE_ROWS_PER_CHUNK = 12`, `MAX_CHUNKS_PER_DOC = 40`.

### 6.3 Contextual header

Every chunk's `content` and `embed_text` start with the document header
(§5.2), followed by `§ <section title>`. This is the single biggest retrieval
quality lever for short chunks: "ROI dropped to 2.1" is useless alone and
precise with `[Weekly report · Bentgo · Week 12 …] § GMV Max insights`.

### 6.4 Normalisation for `embed_text`

Collapse whitespace, strip zero-width characters, decode HTML entities,
remove the `<!--wurx-sop-import-->` sentinel, and truncate to
`EMBED_MAX_TOKENS = 7500` (below the model's 8191 limit).

---

## 7. Embedding

| Parameter | Value | Why |
|---|---|---|
| Model | `text-embedding-3-small` | already used; the TikTok corpus migrates free; cheap |
| Dimensions | 1536 | matches `tts_knowledge`; no reduction needed at our scale |
| Batch size | 96 inputs **and** ≤ 250k est. tokens per request | well inside API per-request limits (verify at build) |
| Concurrency | 2 requests in flight per worker | stays under rate limits |
| Retry | 429/5xx: exponential 1s, 2s, 4s, 8s (+ jitter), max 4; then the item fails back to the queue | |
| Timeout | 30 s per request | |
| Query embedding | same model; cached per `(normalised query)` for 10 min in memory | follow-ups often repeat queries |
| `content_hash` | `sha256(embed_text + '|' + model)` | a model change re-embeds naturally |

**Provider independence:** the chat model can be Gemini while embeddings stay
on OpenAI. Switching the embedding model is a **planned migration**: add the
new model, re-embed progressively (`embedding_model` per chunk), search only
chunks of the active model, then flip.

---

## 8. Indexing

| Index | Setting | Notes |
|---|---|---|
| HNSW (cosine) | `m = 16`, `ef_construction = 64` | builds on an empty table (unlike the ivfflat in mig 223) |
| Query-time | `set local hnsw.ef_search = 100` inside `ai_search` | recall vs speed |
| Filtered search | `set local hnsw.iterative_scan = relaxed_order` **if pgvector ≥ 0.8** | keeps recall when ACL/filters remove many candidates. Check `select extversion from pg_extension where extname='vector'` in Phase 0; if older, the fallback is exact search over the allowed set (fast at < 100k chunks) |
| GIN on `fts` | weighted A (content) / B (section) | keyword arm |
| Btrees | `ai_documents(source_type,status)`, `(brand_id)`, `(period_start)` | pre-filtering |

**Scale expectation:** thousands of reports × ~6 chunks + KB + TikTok ≈
10k–60k chunks. Phase 0 gives the real number. At this size Postgres + pgvector
is comfortably sufficient; no external vector DB.

---

## 9. Ingestion pipeline

### 9.1 Enqueue function (used by every trigger)

```sql
create or replace function public.ai_enqueue(p_type text, p_id text, p_op text,
                                             p_priority smallint default 5,
                                             p_debounce interval default '0'::interval,
                                             p_reason text default 'trigger')
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.ai_ingest_queue (source_type, source_id, op, priority, reason, not_before)
  values (p_type, p_id, p_op, p_priority, p_reason, now() + p_debounce)
  on conflict (source_type, source_id) where status = 'pending'
  do update set
    enqueued_at = now(),
    not_before  = greatest(ai_ingest_queue.not_before, now() + p_debounce),
    priority    = least(ai_ingest_queue.priority, excluded.priority),
    -- delete wins over upsert; upsert wins over acl (it re-syncs ACL anyway)
    op = case when excluded.op = 'delete' or ai_ingest_queue.op = 'delete' then 'delete'
              when excluded.op = 'upsert' or ai_ingest_queue.op = 'upsert' then 'upsert'
              else 'acl' end;
exception when others then
  raise warning 'ai_enqueue failed (%/%): %', p_type, p_id, sqlerrm;   -- never block the user's save
end $$;
```

A later `upsert` after a queued `delete` (e.g. a report re-submitted) is
handled by the worker: it re-checks `indexable()` on the live row, so the
final op always reflects the **current** source state.

### 9.2 Triggers per source

| Table | Fires on | Logic | op | Priority | Debounce |
|---|---|---|---|---|---|
| `reports` | INSERT/UPDATE | if `status` indexable **and** (`data`, `status`, `period_*`, `brand_id`, `sections_enabled` changed) | upsert | 5 | **180 s** |
| `reports` | UPDATE to `draft` / DELETE | | delete | 1 | 0 |
| `kb_articles` | INSERT/UPDATE of content fields | | upsert | 4 | 30 s |
| `kb_articles` | UPDATE of `visibility`, `visible_to_roles`, `visible_to_users`, `approval_status` only | | acl (or delete if no longer approved) | **0** | 0 |
| `kb_articles` | DELETE | | delete | 0 | 0 |
| `ai_assistant_docs` | any | `is_active=false` → delete | upsert/delete | 4 | 10 s |
| `tts_articles` | INSERT/UPDATE of `content_hash`/`is_active` | | upsert/delete | 7 | 0 |
| `gmv_max_reports` | any | | upsert/delete | 6 | 120 s |
| `agenda_tasks` | title/details/status/brand change; DELETE | | upsert/delete | 6 | 60 s |
| `agenda_presentations` | `overall_summary`/`overall_rating` change | | upsert | 6 | 60 s |
| `brands` | `brand_name`/`client_name` change | **cascade:** enqueue every report + GMV Max report of the brand (headers contain the name) | upsert | 8 | 0 |
| `brands` | `status` change | enqueue that brand's `brand_profile` | upsert | 6 | 0 |
| `ai_generated_docs` | any | | upsert/delete | 6 | 0 |

**Not triggers:** brand reassignment, role changes and user deactivation need
**no** re-index, because the ACL is evaluated live (§4).

Example:

```sql
create or replace function public.ai_trg_reports() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.ai_enqueue('report', old.id::text, 'delete', 1::smallint);
    return old;
  end if;
  if new.status = 'draft' then
    if tg_op = 'UPDATE' and old.status <> 'draft' then
      perform public.ai_enqueue('report', new.id::text, 'delete', 1::smallint);
    end if;
    return new;
  end if;
  if tg_op = 'INSERT'
     or new.data is distinct from old.data or new.status is distinct from old.status
     or new.period_start is distinct from old.period_start or new.brand_id is distinct from old.brand_id
     or new.sections_enabled is distinct from old.sections_enabled then
    perform public.ai_enqueue('report', new.id::text, 'upsert', 5::smallint, interval '180 seconds');
  end if;
  return new;
end $$;
create trigger ai_reports_enqueue after insert or update or delete on public.reports
  for each row execute function public.ai_trg_reports();
```

### 9.3 Debounce: why 180 s for reports

The report editor autosaves while the APC types. Each save bumps
`not_before = now() + 180s`. The item is claimable only once the report has
been quiet for 3 minutes. Result: one embedding pass per editing session.
Deletes and ACL changes skip debounce, because **removing access must be fast**.

### 9.4 Claim / complete / fail RPCs (service role only)

```sql
-- Claim: urgent first, then oldest; skip rows another worker holds.
create or replace function public.ai_ingest_claim(p_limit int, p_worker text)
returns setof public.ai_ingest_queue language sql security definer set search_path = public as $$
  update public.ai_ingest_queue q
     set status = 'processing', locked_at = now(), locked_by = p_worker, attempts = q.attempts + 1
   where q.id in (
     select id from public.ai_ingest_queue
      where (status = 'pending' and not_before <= now())
         or (status = 'processing' and locked_at < now() - interval '10 minutes')  -- crashed worker
      order by priority, not_before
      limit p_limit
      for update skip locked)
  returning q.*;
$$;
-- ai_ingest_complete(id)          → status='done', done_at=now()
-- ai_ingest_fail(id, err)         → attempts < MAX_ATTEMPTS ? status='pending', not_before=now()+backoff(attempts)
--                                                           : status='failed'
```

A re-enqueue that arrives **while** an item is processing creates a new
pending row (the unique index covers only `pending`), so no change is lost.

Backoff by attempt: 1 min, 5 min, 30 min, 2 h. `MAX_ATTEMPTS = 5`, then
`failed`, which is visible in the health panel with a Retry button.

### 9.5 Worker: `ai-ingest`

**Trigger:** pg_cron every minute → `net.http_post(app_config.ai_ingest_url,
headers {x-webhook-secret: app_config.ai_ingest_secret})`. This is the same
pattern as the push dispatcher (mig 013/027). The function rejects any call
without the secret.

```
t0 = now; run = insert ai_ingest_runs
loop while now - t0 < WORKER_TIME_BUDGET (100 s):
  items = ai_ingest_claim(CLAIM_BATCH = 20)
  if none → break
  for item in items:                             -- sequential; embeds are batched below
    try:
      ex = extractors[item.source_type]
      if item.op == 'delete': deleteDocument(item); complete; continue
      row = ex.load(item.source_id)
      if !row or !ex.indexable(row): deleteDocument(item); complete; continue
      doc = ex.toDocument(row)
      if item.op == 'acl': updateAcl(doc); complete; continue
      docHash = sha256(header + sections + acl)
      existing = select ai_documents where (type,id)
      if existing && existing.doc_hash == docHash: touch indexed_at; complete; continue
      chunks = chunk(doc, params[source_type])
      old = select chunk_index, content_hash from ai_chunks where document_id = existing.id
      toEmbed = chunks where hash ∉ old hashes at same index
      vectors = embedInBatches(toEmbed)          -- §7
      TRANSACTION (via RPC ai_ingest_write(doc, chunks, vectors)):
        upsert ai_documents (…, doc_hash, chunk_count, indexed_at, status='active')
        upsert changed chunks; update unchanged chunks' content only if header changed
        delete from ai_chunks where document_id = … and chunk_index >= chunks.length
      complete
    catch e: ai_ingest_fail(item.id, e)
finish run stats
```

- The write is **one RPC in one transaction**, so readers never see
  half-written documents.
- **Idempotent:** same input → same hashes → no-op.
- Two overlapping invocations are safe thanks to `SKIP LOCKED`.
- CPU-light: hashing and string work only. Wall time is dominated by the
  embedding API, bounded by the time budget (edge limits: verify the plan's
  wall-clock limit; 100 s stays under the free-tier 150 s).

### 9.6 Backfill

`select public.ai_backfill(p_source_type text default null)` enqueues every
indexable row with `priority = 9, reason = 'backfill'`. Order: KB → docs →
guides → TikTok (migration, no embeds) → reports newest first → the rest. It
can be run from the health panel ("Index everything") or via
`Assistant/scripts/backfill.mjs`.

**Throughput estimate:** 20 items/claim × ~4 claims per 100 s run ≈ 80
items/min, so ~5k reports in about an hour. Backfill priority 9 never starves
live changes (priority ≤ 5 is always claimed first).

### 9.7 Reconciler (nightly, 03:00 PKT)

For each source type:
1. **Missing / stale:** source rows that are indexable and have no
   `ai_documents` row, or whose current **source fingerprint** (`source_fp`,
   which includes `PIPELINE_VERSION` and the model) differs from the stored one
   → enqueue upsert (priority 8, reason `reconcile`). Comparing fingerprints
   rather than timestamps is what makes repeated runs do nothing
   (`ai_backfill_candidates`). It also catches changes that no trigger covers,
   such as a profile rename appearing in an incentive header.
2. **Orphans:** `ai_documents` whose source row is gone or no longer indexable → enqueue delete.
3. **Model drift:** chunks with `embedding_model <> active model` → enqueue upsert (budgeted, N per night).
4. Report counts to `ai_ingest_runs` (reconcile row). A non-zero "missing"
   count on consecutive nights means a trigger bug and is alerted.

### 9.8 TikTok Academy crawler: `tts-crawl`

**How the Academy works (verified 2026-09-28):**
- The link `seller-us.tiktok.com/ai-university/home` is **login-only**: it
  redirects to the seller sign-in. It's a new front end over the same
  knowledge base; the **public Academy** (`/university/...`) serves the same
  articles without login. We crawl the public Academy and use no seller
  credentials.
- **Discovery:** the Academy's own sitemap API,
  `GET /api/v1/seller/learning_center/sitemap/urls/get?version=1&region=US`,
  returns every public US URL (1,323 on 2026-09-28): **988 essays**, **214
  course-lesson URLs in 41 courses**, 106 category index pages, 12 policy
  indexes and 2 hubs. The old `seed-urls.json` (found through web search) covered
  only 514 of the 988 essays, and 112 of its IDs are dead.
- **Content:** each page embeds its server-side data in `window._ROUTER_DATA`
  (`loaderData['essay/page']` or `['course/page']`). Essays carry
  `knowledge_detail.knowledge_plain_content` (clean text), `knowledge_name`,
  `keywords`, `learning_info.modify_time`/`views`/`ai_summary`, `toc_list`
  (headings), `country_scope_info` and `sidebar_contents` (the section tree →
  breadcrumb). **One course fetch returns every lesson** (`course_contents[]`,
  lesson text as a Quill delta), so 41 fetches cover 214 lessons.
- **Traps:**
  1. The site sometimes serves a **JS-only shell** with no `_ROUTER_DATA`.
     That is *transient*; retry with backoff. Only the "content does not
     exist" page means dead. (The old `ingest.mjs` treated shells as dead.)
  2. It **throttles bursts**: connections time out after rapid requests. Keep
     ~2.5 s between requests, with backoff up to 2 minutes.
- The JSON API endpoints for detail pages (`knowledge_detail/get`, etc.)
  exist but need parameters that aren't exposed publicly; the embedded page
  data is the reliable path.

Reference implementation: `Assistant/scripts/tts-crawl.mjs` (Node, local).
The `tts-crawl` edge function is a port of it.

| Step | Detail |
|---|---|
| Start | weekly cron (Sun 04:00 PKT) sets `ai_crawl_state('tts').status = 'running'` and builds the frontier from the **sitemap API** (essay ids + one entry per course `learning_id`) ∪ all active `tts_articles` ids |
| Tick | while running, the every-minute cron also calls `tts-crawl`, which processes `CRAWL_BATCH = 20` pages per invocation from `cursor` (≈ 60 s at the politeness rate) |
| Fetch | server-side GET of the page, ~2.5 s + jitter between requests, timeout 30 s, up to 6 attempts with backoff 5 s → 2 min; a JS shell counts as a retry |
| Extract | parse `_ROUTER_DATA`: essay → one record; course → one record per lesson (delta → text). Breadcrumb from `sidebar_contents` (essays) or `Courses > <course name>` |
| Change detect | `modify_time` unchanged **and** `content_hash = sha256(title + text)` unchanged → only `last_seen_at = now()` |
| Write | upsert `tts_articles` (trigger enqueues the ingest) |
| Discover | prev/next/recommended and sidebar-tree ids not already in the frontier are added, as a safety net for pages missing from the sitemap |
| Finish | when the frontier is exhausted: articles not seen this crawl get `missed_crawls++`; at `≥ 3` set `is_active = false` → trigger → delete. Status → idle, stats stored |
| Manual | health panel "Re-crawl now" |

`tts_articles` gains columns from the richer data: `kind ('essay'|'course_lesson')`,
`course jsonb`, `keywords text[]`, `applies_to`, `ai_summary`, `toc jsonb`,
`views`, `source_modified_at`. `ai_summary` is indexed as an extra short chunk
per article; summaries are good retrieval targets.

### 9.9 App guides: authoring and sync

**File format** `Assistant/app-guides/<slug>.md`:

```markdown
---
slug: leave
title: Leave
route: /leave
roles: [ol, tl, pctl, apc, ipc, developer]     # omit = everyone
feature: leave
last_reviewed: 2026-09-26
---
## What this page is for
## Who can use it
## How to … (numbered steps, one ## per task)
## Rules & gotchas
## Related pages
```

**`Assistant/scripts/sync-app-guides.mjs`:**
1. Parse all guides and validate frontmatter (a required-field error fails the script).
2. Upsert into `ai_assistant_docs` by `slug` (`kind='app_guide'`, `meta`
   from the frontmatter). Guides deleted from the folder → `is_active=false`.
3. **Coverage check:** extract routes from `src/App.jsx` + `src/components/layout/menu.js`;
   print routes with no guide and guides whose route no longer exists. Exit
   non-zero with `--strict`.
4. Triggers do the rest.

The `PAGES` list in the prompt (today hard-coded in `ai-chat`) is generated at
runtime from active `app_guide` rows, filtered by the caller's role.

### 9.10 Brand profile generator (nightly, 02:00 PKT)

1. For each active brand, compute
   `inputs_hash = sha256(latest 6 indexed report doc_hashes + brand_monthly_metrics rows for the last 3 months + owner)`.
2. If it's unchanged vs `ai_generated_docs.inputs_hash` → skip.
3. Otherwise call the **cheap chat model** with the facts, which are pulled
   **by tools / SQL**, not retrieval: owner, status, last 3 months'
   GMV target vs achieved, and the recent report insights text. Output
   ≤ 400 words: trend, recurring issues, recent wins, open action items.
4. Upsert `ai_generated_docs` → trigger → queue → index.
5. Cap `BRAND_PROFILE_MAX_PER_NIGHT = 60`.

### 9.11 Scheduler: all cron jobs

| Job | Cron (UTC) | PKT | Calls |
|---|---|---|---|
| `ai-ingest-tick` | `* * * * *` | every minute | `ai-ingest` (and `tts-crawl` when crawl state is running) |
| `ai-brand-profiles` | `0 21 * * *` | 02:00 | brand profile generator |
| `ai-reconcile` | `0 22 * * *` | 03:00 | `ai_reconcile()` |
| `ai-tts-crawl-start` | `0 23 * * 6` | Sun 04:00 | sets crawl running |
| `ai-housekeeping` | `30 22 * * *` | 03:30 | delete `done` queue rows > 14 d, runs > 30 d, request logs > 180 d |

Verify `cron.timezone` on the project (pg_cron defaults to GMT) before finalising.

### 9.12 Secrets & config

| Name | Where | Used by |
|---|---|---|
| `OPEN_AI_API_KEY` | function secret (exists) | embeddings, chat |
| `GEMINI_API_KEY` | function secret (Phase 6) | chat adapter |
| `AI_INTERNAL_SECRET` | function secret (exists) | Slack relay → `assistant` |
| `AI_INGEST_SECRET` | function secret + `app_config.ai_ingest_secret` | cron → `ai-ingest` / `tts-crawl` |
| `app_config.ai_ingest_url`, `app_config.tts_crawl_url` | table (no RLS read) | cron |

### 9.13 Failure modes

| Failure | Behaviour | Detection |
|---|---|---|
| OpenAI embeddings down / 429 | items fail → backoff → retry; search falls back to keyword-only if the **query** embedding fails | failed count, `ai_ingest_runs.error` |
| Worker crash mid-batch | items stay `processing`; reclaimed after 10 min | stuck-processing count |
| Poison item (bad JSON, extractor bug) | 5 attempts → `failed`; others continue | failed list with error |
| Trigger error | swallowed with a warning; the save proceeds; reconciler catches it | reconcile "missing" count |
| Cron not firing | queue grows | alert: oldest pending > 30 min |
| Report oscillates draft↔submitted | delete / upsert collapse via op precedence; the worker re-checks the live row | — |
| Brand rename storms | cascade enqueue at priority 8; unchanged bodies re-embed only header-affected chunks | queue depth |
| Chunk explosion (giant report) | `MAX_CHUNKS_PER_DOC` cap + warning | warning log |
| Duplicate processing | unique `(document_id, chunk_index)` + hash no-op | — |

---

## 10. Retrieval pipeline

Invoked by the agent's `search_knowledge` tool.

### 10.1 Steps

```
1. Query build     query = agent-provided query (already standalone; §12.3)
2. Filters         source_types[], brand_ids[] (resolved from names), period_from/to (PKT)
3. Embed           q_vec = embed(query)   (cached 10 min; on failure → keyword-only)
4. ai_search RPC   hybrid RRF within the caller's allowed documents
5. Diversify       ≤ MAX_CHUNKS_PER_DOC_IN_RESULTS (3) per document
6. Recency         for source_type='report' with no period filter:
                   score *= 0.5 ^ (age_days / RECENCY_HALF_LIFE_DAYS)
7. (optional)      rerank top RERANK_CANDIDATES (30) → TOP_K with a cheap LLM/cross-encoder
8. Expand          attach the neighbouring chunk (index ±1) of the top 3 if budget allows
9. Pack            order by score; add until RETRIEVAL_TOKEN_BUDGET; assign citation ids [S1..Sn]
10. Return         JSON to the model: [{cite:"S1", source_type, title, section, url, period, text}]
```

### 10.2 `ai_search` (sketch)

```sql
create or replace function public.ai_search(
  p_query_embedding extensions.vector(1536), p_query_text text,
  p_source_types text[] default null, p_brand_ids uuid[] default null,
  p_period_from date default null, p_period_to date default null,
  p_match_count int default 30, p_as_user uuid default null)
returns table (chunk_id uuid, document_id uuid, source_type text, title text, url text,
               section text, content text, period_start date, brand_id uuid,
               metadata jsonb, score double precision)
language plpgsql stable security definer set search_path = public, extensions as $$
declare uid uuid; urole text;
begin
  uid := case when auth.role() = 'service_role' and p_as_user is not null then p_as_user else auth.uid() end;
  if uid is null then return; end if;
  select role into urole from profiles where id = uid and is_active;
  if urole is null then return; end if;
  perform set_config('hnsw.ef_search', '100', true);
  return query
  with allowed as (
    select d.* from ai_documents d
     where d.status = 'active'
       and (p_source_types is null or d.source_type = any(p_source_types))
       and (p_brand_ids   is null or d.brand_id   = any(p_brand_ids))
       and (p_period_from is null or coalesce(d.period_end, d.period_start) >= p_period_from)
       and (p_period_to   is null or d.period_start <= p_period_to)
       and ai_can_read_document(d, uid, urole)),
  sem as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) rnk
      from ai_chunks c join allowed a on a.id = c.document_id
     where p_query_embedding is not null
     order by c.embedding <=> p_query_embedding limit 60),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text)) desc) rnk
      from ai_chunks c join allowed a on a.id = c.document_id
     where c.fts @@ websearch_to_tsquery('english', p_query_text)
     limit 60),
  fused as (
    select id, sum(w / (60 + rnk)) rrf from (
      select id, rnk, 1.0 w from sem union all select id, rnk, 1.0 w from kw) u
    group by id order by rrf desc limit p_match_count)
  select c.id, a.id, a.source_type, a.title, a.url, c.section, c.content,
         a.period_start, a.brand_id, a.metadata, f.rrf
    from fused f join ai_chunks c on c.id = f.id join allowed a on a.id = c.document_id
   order by f.rrf desc;
end $$;
grant execute on function public.ai_search to authenticated;
```

Steps 5–9 (diversify, recency, rerank, expand, pack) run in the edge
function, where they're easier to tune and test.

### 10.3 Period & entity resolution (shared helpers)

- `resolvePeriod("June" | "last week" | "Q3" | "2026-06" | "week 12")` →
  `{from, to}` in **Asia/Karachi**. A bare month = the most recent past
  occurrence. Ambiguous input → the agent asks.
- `resolveBrands(name)` → brand ids via `ilike` + trigram similarity (enable
  `pg_trgm` if absent); more than one strong match → return candidates so the
  agent can ask.
- These helpers are **shared by `search_knowledge` and the data tools**, so
  "June" means the same thing everywhere.

---

## 11. Structured data tools

All tools live in `_shared/ai/tools/`. Contract: **read-only, parameterized,
role-checked, bounded output**. The model never writes SQL.

### 11.1 Catalog

| Tool | Args | Returns | Access | Status |
|---|---|---|---|---|
| `search_knowledge` | `query, source_types?, brand?, period?` | cited chunks (§10) | per-document ACL | new |
| `find_person` | `name` | profile card | boss (later: OL/TL scoped) | existing |
| `get_employees` | `role?, search?, include_inactive?` | grouped directory | boss | existing |
| `get_reports` | `brand?, period?, type?, sections[]` | report data by section | `can_view_report` | existing, gains currency + numeric parsing |
| `compare_periods` | `brand, metric, period_a, period_b, type?` | values + abs/% delta | `can_view_report` | **new**, uses `findPreviousReport` semantics: compare by period, never `created_at` |
| `rank_brands` | `metric, period, type?, top_n?, order?` | ranked list | brands the caller can view | **new** |
| `brand_overview` | `brand` | owner, status, tier, last 3 months target vs achieved (`brand_monthly_metrics`), latest report headline | `can_view_brand` | **new** |
| `get_gmv_max` | `brand?, period?` | GMV Max report rows + campaigns | `can_view_brand` | **new** |
| `get_incentives` | `person?, month?` | goals, earned, overlays | boss | existing: **keep the attendance / GMV Max / commission overlays verbatim** |
| `get_salary` | `person?` | salary + history | boss; the Boss's own salary is never included | existing |
| `get_performance` | `person?, month?` | composite (via `get_performance_composite`) + metrics | boss | existing |
| `get_attendance` | `person?, month?, detail?` | canonical % + hours | boss | existing |
| `get_leave` | `person?, status?, type?, month?` | requests | boss | existing |
| `list_brands` | — | brands + owner | viewable brands | existing |
| `get_agenda_tasks` | `brand?, person?, status?` | tasks | brand ACL | **new** |

### 11.2 Numeric correctness rules

- **Approved reports only (Owner, 2026-09-28).** Every report-reading tool
  (`get_reports`, `compare_periods`, `rank_brands`, `brand_overview`, …) filters
  `status = 'approved'`. This matches the vector store (D2).
  - If a newer report for the same brand and type exists but isn't approved,
    the tool returns a `pending` note (period + status), and the answer says so,
    e.g. "Week 38 is awaiting approval; the latest approved figure is Week 37: $12,340.00".
  - Pending figures are never quoted as numbers.
  - Aggregations and rankings count approved reports only, and state their
    coverage ("12 of 20 active brands have an approved June report").
- Report figures are **strings**. Parse with a single `parseMetric()` helper
  (strip currency symbols, commas, `%`, `x`, handle `k`/`M`); keep the raw
  string alongside. Unparseable → returned as text, **never guessed**.
- Always return the **currency** with money figures. Reports default to USD
  when missing; payroll is PKR (CLAUDE.md). Never sum across currencies;
  report the mix.
- Money is printed with 2 decimals, exact (project style).
- Aggregations (`rank_brands`, totals) happen in SQL/TypeScript, never in the model.
- Every tool result includes a `source` line (table + period + ids), so the
  answer can cite data like it cites chunks.

### 11.3 Output bounds

`TOOL_RESULT_CHAR_CAP = 6000`; list tools accept `limit` (default 20, max 100)
and state explicitly when truncated (as `get_leave` does today).

---

## 12. Agent orchestration

### 12.1 LLM adapter: `_shared/ai/llm.ts`

```ts
interface LlmAdapter {
  chat(req: {
    system: string; messages: Msg[]; tools?: ToolDef[];
    maxOutputTokens: number; effort?: 'none'|'low'|'medium';
    stream?: boolean; signal?: AbortSignal;
  }): AsyncIterable<LlmEvent>;   // {type:'text',delta} | {type:'tool_calls',calls} | {type:'usage',in,out,cached} | {type:'done'}
}
```

- **OpenAI implementation:** **Responses API** (`/v1/responses`). This fixes
  the `reasoning_effort` + tools restriction that caused the 2026-09-08 outage
  on Chat Completions. Tools use the Responses function-tool format. Stable
  prefix ordering for prompt caching (§12.4).
- **Gemini implementation:** `generateContent` / `streamGenerateContent` with
  `functionDeclarations`; same events out.
- Provider + model are allow-listed server-side (as `ALLOWED_MODELS` is today)
  and selected in the Train tab.
- **Failover (optional, off by default):** on a provider 5xx for the final
  answer, retry once on the other provider.

### 12.2 Loop

```
build system prompt (§12.4); messages = history (§12.5) + user
for round in 1..MAX_ROUNDS (3):
  if tokens_used ≥ COST_CEILING_TOKENS: break
  resp = llm.chat(tools = TOOL_DEFS, effort = TOOL_EFFORT, maxOutput = 1200)
  if resp has tool_calls:
     emit status(label of first tool)
     run up to MAX_PARALLEL_TOOLS (4) calls concurrently; each result capped
     append results (with citation ids for search results)
     continue
  else: answer = resp.text; break
if no answer: stream final with effort = ANSWER_EFFORT (low), maxOutput = 2500
if empty and under ceiling: one retry with maxOutput = 6000 (existing behaviour)
validate citations (§12.6); emit sources; persist; log
```

### 12.3 Query condensing

On turns with history, the model is instructed to pass a **standalone** query
to `search_knowledge` ("and last month?" → "Bentgo GMV Max insights August 2026").
This is enforced by the tool description; no separate LLM call is needed. If
evals show it's weak, add an explicit condense call using the cheap model with
`effort: none`.

### 12.4 System prompt layout (cache-friendly)

Stable prefix first, dynamic tail last (same principle as the current
`ai-chat`):

1. Persona (Boss-editable)
2. Role capabilities for the caller's role
3. Page list (generated from app guides for this role)
4. Answer rules: grounding, citations, no invention, clarify when ambiguous,
   source separation (SOP vs TikTok vs report data), **numbers only from tool
   results**, currency rules, PKT times
5. Tool-use rules (when to search vs query data; request minimal sections)
6. *(dynamic)* caller name/role, today's date in PKT

Retrieved knowledge is **no longer injected into the system prompt**. It
arrives as tool results. That keeps the prefix byte-stable and cacheable, and
the model only pays for knowledge it asked for.

### 12.5 Memory

Last `HISTORY_TURNS = 12` messages within `HISTORY_CHAR_CAP = 6000`. Tool
results are **not** replayed from history (they're re-fetched if needed), so
old data can't go stale inside a thread. `ai_messages.meta` stores sources and
tools for the UI and audits.

### 12.6 Citations

- Search results carry ids `S1..Sn`; data tools carry `D1..Dn`.
- The model writes `[S2]`, `[D1]` inline.
- The server validates every id against the ids actually returned this turn.
  Unknown ids are stripped.
- The final `sources` event maps ids → `{title, url, type, period}`. The UI
  renders chips: in-app routes navigate inside the SPA (existing `data-nav`
  mechanism); external links open in a new tab.

### 12.7 Guardrails

- Retrieved text is wrapped as `<<<SOURCE S3 … >>>` data blocks. The prompt
  states that source content is never instructions.
- No write tools exist, so injected text can't cause actions.
- Out-of-scope requests are politely declined (existing persona rule).
- An answer that states a number with no `[D*]` or `[S*]` citation is flagged
  in the log (the eval tracks this rate).

---

## 13. API & streaming protocol

**Endpoint:** `POST /functions/v1/assistant`, the same request as today
(`{conversationId?, message, stream: true}`). Auth: user JWT, or the internal
secret + `as_user_id` (Boss only), exactly as `ai-chat` does now.

**SSE events** (superset of today's, so the existing client parser keeps working):

| Event | Shape | When |
|---|---|---|
| status | `{"status":"Searching the knowledge base…"}` | each phase / tool |
| delta | `{"delta":"text"}` | answer tokens |
| sources | `{"sources":[{"id":"S1","type":"report","title":"…","url":"/…","period":"…"}]}` | once, before done |
| done | `{"done":true,"conversationId":"…","requestId":"…"}` | end |
| error | `{"error":"…"}` | failure |

**Feedback:** `POST` via RPC `ai_feedback(request_id, rating smallint, note text)`,
which writes to `ai_request_log` (only the owner can rate).

**Client switch:** `aiSendStream` picks the endpoint from
`ai_assistant_config.engine` (`v1` → `ai-chat`, `v2` → `assistant`), so the
Boss can flip it in the Train tab and flip back instantly.

---

## 14. Security & privacy

| Threat | Control |
|---|---|
| User sees data beyond their role | ACL evaluated in-DB with the app's own helpers (§4); tools role-checked; default deny; permission tests in the eval set |
| Stale permissions in the index | none stored except KB visibility, which has an instant `acl` fast path; reconciler re-verifies nightly |
| Prompt injection via report text / TikTok pages | data-block wrapping, no write tools, citation validation |
| Salary/incentive leakage through embeddings | never embedded (§4.4) |
| Forged assistant messages | `ai_messages` insert blocked for clients (mig 206); server-only writes |
| Unauthorised worker calls | `x-webhook-secret` check; secrets in function secrets / `app_config` (no RLS read) |
| Slack impersonation | existing rule: internal calls may answer only as an active Boss |
| Cost abuse | per-question token ceiling, per-user rate limit (`RATE_LIMIT_PER_USER = 30/hour`), monthly budget alert |
| Deleted users' data | `profiles` delete flows (mig 290) keep content; reports stay indexed under their brand ACL; `author_id` isn't used for access except in KB and report helpers, as the app does |
| Data wipe (`wipe-data` function) | the wipe must also truncate `ai_documents`/`ai_chunks`/queue; add this to the wipe RPC when it ships |

---

## 15. Observability

### 15.1 `ai_request_log`

`id, created_at, user_id, conversation_id, engine, provider, model, question,
rounds, tools jsonb ([{name,args,ms,result_chars}]), retrieved jsonb
([{chunk_id,document_id,score,cited bool}]), tokens_in, tokens_cached,
tokens_out, est_cost_usd, latency_ms, first_token_ms, error, rating, rating_note`.

### 15.2 Health panel (Train tab)

- **Ingest:** queue depth by status/priority, oldest pending age, failed items
  (error + Retry), last run stats, documents & chunks per source, freshness lag
  (p95 of `indexed_at − source_updated_at` over 24 h), crawl status.
- **Usage:** questions/day, p50/p95 latency, cost today / this month vs budget,
  👍/👎 rate, zero-result searches, uncited-number rate.
- **Actions:** Index everything, Re-index source, Re-crawl TikTok, Retry failed.

### 15.3 Alerts (to the Boss, via `emit_notification`)

New notification category `ai_system`. Per CLAUDE.md, the category must also be
added to `NotificationBell.jsx`, `NotificationsPage.jsx` and
`NotificationPrefsSection.jsx`.

| Alert | Condition |
|---|---|
| Ingest stalled | oldest pending (`not_before`) > 30 min |
| Ingest failures | ≥ 10 `failed` items in 24 h |
| Reconcile drift | "missing" > 0 two nights running |
| Budget | month-to-date cost ≥ 80 % of `monthly_budget_usd` |
| Crawl failure | crawl run ends with > 20 % fetch errors |

---

## 16. Evaluation framework

### 16.1 Dataset: `Assistant/eval/questions.jsonl`

```json
{"id":"rep-014","category":"report_lookup","role":"boss",
 "history":[],
 "question":"What was Bentgo's GMV in week 12?",
 "expected_numbers":[{"value":12345.67,"tolerance":0.005,"currency":"USD"}],
 "expected_facts":["week 12","Bentgo"],
 "expected_sources":[{"source_type":"report","source_id":"<uuid>"}],
 "must_refuse":false,
 "notes":""}
```

Categories: `how_to`, `sop`, `tiktok`, `report_lookup`, `report_narrative`,
`aggregation`, `comparison`, `people_data`, `mixed`, `follow_up`,
`ambiguous` (should clarify), `permission` (must refuse / must not leak),
`out_of_scope`. Target: **≥ 100 questions**, at least 6 per category.

### 16.2 Runner: `Assistant/eval/run-eval.mjs`

`node Assistant/eval/run-eval.mjs --engine v2 --model gpt-5.4-mini --label baseline`

- Calls the endpoint as a test user per `role`.
- Pulls `requestId`, then reads `ai_request_log` for retrieved chunks, tools and cost.
- Writes `eval/runs/<date>-<label>.json` and prints a category table plus a diff
  against the previous run.

### 16.3 Metrics & gates

| Metric | Definition | Gate for cutover |
|---|---|---|
| Retrieval recall@8 | expected source in the top 8 retrieved | ≥ 0.85 |
| Numeric accuracy | expected numbers present within tolerance | ≥ 0.95 |
| Answer correctness | LLM judge (1–5) against expected facts | mean ≥ 4.2 |
| Faithfulness | judge: every claim supported by tool/chunk content | ≥ 0.90 |
| Citation validity | cited ids ⊆ returned ids | 1.00 |
| Permission safety | `permission` category: no leak | 1.00 (hard gate) |
| Clarify rate | `ambiguous` category asks instead of guessing | ≥ 0.8 |
| Latency | p95 end-to-end | ≤ 20 s |
| Cost | mean est. $/question | ≤ baseline × 1.3 |

The judge model is fixed per comparison, so results stay comparable between runs.

---

## 17. Master parameter table

Defaults live in `_shared/ai/config.ts`. Values marked ⚙ can be overridden
without a redeploy via `ai_assistant_config.retrieval` (jsonb).

| Group | Parameter | Default | ⚙ |
|---|---|---|---|
| Chunking | `TARGET/MAX/OVERLAP/MIN` tokens | per source, §6.2 | |
| Chunking | `TABLE_ROWS_PER_CHUNK` | 12 | |
| Chunking | `MAX_CHUNKS_PER_DOC` | 40 | |
| Embedding | model / dims | `text-embedding-3-small` / 1536 | |
| Embedding | batch inputs / tokens | 96 / 250k | |
| Embedding | `EMBED_MAX_TOKENS` | 7500 | |
| Embedding | query cache TTL | 10 min | |
| Index | HNSW `m` / `ef_construction` / `ef_search` | 16 / 64 / 100 | ef_search ⚙ |
| Retrieval | semantic / keyword candidates | 60 / 60 | ⚙ |
| Retrieval | RRF `k`, weights (sem, kw) | 60, (1.0, 1.0) | ⚙ |
| Retrieval | `TOP_K` returned to model | 8 | ⚙ |
| Retrieval | `MAX_CHUNKS_PER_DOC_IN_RESULTS` | 3 | ⚙ |
| Retrieval | `RECENCY_HALF_LIFE_DAYS` (reports) | 120 | ⚙ |
| Retrieval | `RERANK_ENABLED` / candidates | false / 30 | ⚙ |
| Retrieval | `RETRIEVAL_TOKEN_BUDGET` per search call | 3500 | ⚙ |
| Agent | `MAX_ROUNDS` | 3 | ⚙ |
| Agent | `MAX_PARALLEL_TOOLS` | 4 | |
| Agent | tool-round max output tokens | 1200 | |
| Agent | answer max output / retry | 2500 / 6000 | ⚙ |
| Agent | effort tool rounds / answer | none / low | ⚙ |
| Agent | `COST_CEILING_TOKENS` | 60000 | ⚙ |
| Agent | `TOOL_RESULT_CHAR_CAP` | 6000 | |
| Agent | `HISTORY_TURNS` / `HISTORY_CHAR_CAP` | 12 / 6000 | |
| Limits | message max chars | 4000 | |
| Limits | `RATE_LIMIT_PER_USER` | 30 / hour | ⚙ |
| Ingest | `WORKER_TIME_BUDGET` | 100 s | |
| Ingest | `CLAIM_BATCH` | 20 | |
| Ingest | lock timeout | 10 min | |
| Ingest | `MAX_ATTEMPTS`, backoff | 5; 1m/5m/30m/2h | |
| Ingest | debounce (reports/kb/docs/gmv/agenda) | 180/30/10/120/60 s | |
| Crawl | `CRAWL_BATCH` / gap between requests / max attempts | 20 / 2.5 s + ≤ 1 s jitter / 6 (backoff 5 s → 2 min) | |
| Crawl | stale after missed crawls | 3 | |
| Profiles | `BRAND_PROFILE_MAX_PER_NIGHT` / words | 60 / 400 | |
| Retention | queue done / runs / request log | 14 d / 30 d / 180 d | |

---

## 18. Cost model

Prices change, so plug in current list prices at build time.

**Embedding (one-off backfill):**
`cost = Σ tokens(embed_text) × price_embed`.
For example, 40k chunks × 450 tokens = 18M tokens, which at the current
small-model price is **well under $1**. Phase 0 computes the real figure.

**Embedding (ongoing):** only changed chunks. Roughly (reports/week × changed
chunks × 450 tokens). Negligible.

**Per question:**
`cost = Σ_rounds [ (in − cached)·p_in + cached·p_cached + out·p_out ] + query_embed`

Levers, in order of impact:
1. Knowledge moves out of the system prompt into on-demand tool results.
2. Stable, cacheable prefix.
3. `TOP_K` and the retrieval token budget.
4. Low effort.
5. The token ceiling.

**Brand profiles:** ≤ 60 short generations/night on the cheap model.

**Budget control:** month-to-date sum from `ai_request_log.est_cost_usd`, with
an alert at 80 %. Optionally, hard-stop non-Boss users at 100 % once the
assistant opens to other roles.

---

## 19. Deployment & environments

- **Two Supabase projects:** production (`xoaaidgvblondjpvxjqp`) and a **dev
  project** (credentials in the gitignored `.env.dev`). Production data is
  copied into dev (blank dev `app_config` push rows and skip the `cron` schema
  when copying). **Everything is built and verified on dev first**; production
  gets each step only with approval (phases.md G9).
- Production changes remain **additive**: new tables/functions only; `ai-chat`
  is untouched until cutover; v2 is selected by `ai_assistant_config.engine`.
- **Dev commands:** `npx supabase db push --db-url "$WURXOS_DEV_DB_URL" --include-all`;
  `npx supabase functions deploy <fn> --project-ref $WURXOS_DEV_PROJECT_REF`.
- **Deploy order per step** (each approved individually): migration →
  function → set `app_config` URL/secret → enable cron → backfill → verify.
- **Kill switches:**
  - `ai_assistant_config.engine='v1'` (instant rollback of chat)
  - unschedule `ai-ingest-tick` (stops ingestion)
  - `enabled=false` (assistant off)
- **Cutover (Owner, 2026-09-29): a hard switch, no fallback.** After every eval
  gate passes, v2 replaces v1 outright and `ai-chat` is retired. Rollback = a
  redeploy from the `stable-pre-assistant-v2` tag (phases.md P7-1/P7-2).
- **Git:** local branch only; push and PR only on your say-so.

---

## 20. Step-by-step build sequence

Each step is small, testable, and ends with a verification. Migration
numbers are indicative; re-check `ls` each time.

### Phase 0: Inventory & baseline
| Step | Work | Verify |
|---|---|---|
| 0.1 | Count rows / text volume per source; sample `reports.data` per layout; pgvector version; `cron.timezone`; `pg_trgm` present? | `Assistant/inventory.md` written |
| 0.2 | Backfill token and cost estimate from real counts | figure in inventory |
| 0.3 | Draft ≥ 100 eval questions with you | `eval/questions.jsonl` |
| 0.4 | Build `run-eval.mjs`; run against current `ai-chat` (v1) | `eval/runs/<date>-v1-baseline.json` |
| 0.5 | Record decisions D1–D6 | `decisions.md` |

### Phase 1: Store & search
| Step | Work | Verify |
|---|---|---|
| 1.1 | Mig 367: `ai_documents`, `ai_chunks`, indexes, RLS | tables exist; direct select denied for non-admin |
| 1.2 | Mig 368: `ai_can_read_document`, `ai_search` | SQL tests: boss sees all; test APC sees only own-brand reports; KB role/users visibility honoured |
| 1.3 | Mig 369: queue, runs, `ai_enqueue`, claim/complete/fail/retry RPCs | concurrent-claim test: no double claims |
| 1.4 | Mig 370: config/doc/message column additions; `ai_request_log`; `ai_feedback` | columns present; v1 unaffected |
| 1.5 | Migrate `tts_knowledge` → `ai_documents`/`ai_chunks` + `tts_articles` | counts match; `ai_search` returns TikTok chunks |

### Phase 2: Ingester
| Step | Work | Verify |
|---|---|---|
| 2.1 | `_shared/ai`: chunker, hasher, embedder (+ unit tests with fixtures per report layout) | fixture tests pass (legacy, single, monthly) |
| 2.2 | Extractors: kb, ai_doc, app_guide, tts, report | extractor tests on real sample rows |
| 2.3 | `ai-ingest` function + `ai_ingest_write` RPC | manual enqueue of one report → document + chunks written |
| 2.4 | Mig 371: triggers on `reports`, `kb_articles`, `ai_assistant_docs`, `tts_articles`, `brands` | edit a report → 1 queue row after 5 edits; draft → delete |
| 2.5 | Mig 372: `app_config` keys, cron `ai-ingest-tick` | runs appear in `ai_ingest_runs` every minute |
| 2.6 | Backfill function + script; run it | reconcile "missing" = 0 |
| 2.7 | Reconciler + housekeeping crons | orphan/missing detection test |
| 2.8 | Health panel in Train tab | shows live queue/doc stats; Retry works |

### Phase 3: TikTok crawler
| Step | Work | Verify |
|---|---|---|
| 3.1 | `tts-crawl` (port extraction, frontier, discovery, stale logic), `ai_crawl_state` | dry crawl lists discovered URLs |
| 3.2 | Weekly start cron + tick integration | full crawl completes; new article becomes searchable |

### Phase 4: App guides
| Step | Work | Verify |
|---|---|---|
| 4.1 | Generate draft guides for every route from the code | one `.md` per route |
| 4.2 | Human review pass (you / team) | `last_reviewed` set |
| 4.3 | `sync-app-guides.mjs` + coverage check | 0 uncovered routes |

### Phase 5: Agent v2
| Step | Work | Verify |
|---|---|---|
| 5.1 | `llm.ts` OpenAI Responses adapter + streaming | adapter tests: text, tool calls, usage |
| 5.2 | Tools: port the existing 9 unchanged; add `search_knowledge` | parity: v1 tool answers == v2 tool answers |
| 5.3 | New tools: `compare_periods`, `rank_brands`, `brand_overview`, `get_gmv_max`, `get_agenda_tasks`; shared `parseMetric`, `resolvePeriod`, `resolveBrands` | unit tests incl. currency and PKT edges |
| 5.4 | `assistant` function: loop, prompt, citations, SSE `sources`, logging, rate limit | eval run on v2 |
| 5.5 | UI: engine switch, source chips, 👍/👎 | manual check; v1/v2 flip works |
| 5.6 | Remaining extractors + triggers: gmv_max, agenda, brand profiles generator | eval categories improve |

### Phase 6: Bake-off & tuning
| Step | Work | Verify |
|---|---|---|
| 6.1 | Gemini adapter | same eval, side by side |
| 6.2 | Tune ⚙ parameters; enable rerank only if recall@8 < 0.85 | eval diff |
| 6.3 | Choose provider/model | `decisions.md` entry |

### Phase 7: Cutover
| Step | Work | Verify |
|---|---|---|
| 7.1 | Alerts (`ai_system` category, 3 UI files) | test alert delivered |
| 7.2 | `engine='v2'` default; shadow week | health green, 👎 rate ≤ v1 |
| 7.3 | Retire `ai-chat` and `tts_knowledge`; remove v1 code paths | clean build; eval unchanged |

### Phase 8 (optional): Other roles
Per role: extend `ALLOWED_ROLES`, scope people tools to the role's team,
permission eval must be 100 %, then enable.

---

## 21. Runbooks

**"The assistant doesn't know about a new report."**
1. Check the report status. Drafts are not indexed.
2. Look at the queue: is the item pending with a future `not_before`? That's
   the debounce, so wait 3 min after the last edit.
3. Failed? Read `last_error` → fix → Retry.
4. Not in the queue at all? The trigger didn't fire, so run the reconciler for
   `report` and investigate the trigger.

**"The queue is growing."**
1. Check `ai_ingest_runs` has recent rows (is cron alive?). Check
   `cron.job_run_details`.
2. Check OpenAI errors in `last_error` (429 → lower the concurrency).
3. During a backfill this is expected: priority 9 drains after live work.

**"An answer used the wrong number."**
Open the request in `ai_request_log`: which tool returned what? If the tool is
correct and the model misquoted it → prompt/eval fix. If the tool is wrong →
fix the tool (and check the overlays match the Incentives page).

**"A user saw something they shouldn't."**
Set `engine=v1` or `enabled=false` immediately. Reproduce with `ai_search` as
that user; check `ai_can_read_document` for the document's `acl_mode`; add a
permission eval case; fix; re-verify.

**"Rebuild the index from scratch."**
Unschedule the tick → truncate `ai_chunks`, `ai_documents`, `ai_ingest_queue`
→ reschedule → `ai_backfill()`. The TikTok embeddings come back from
`tts_articles` only via re-embedding, which is cheap. The source tables are
the truth.

---

## 22. Risks & open questions

| Risk / question | Mitigation / next action |
|---|---|
| Report `data` has undocumented legacy variants (v1 imports, `legacy_id` rows) | Phase 0 samples every layout; the extractor has a "generic" fallback that flattens unknown string fields |
| Edge wall-clock limit on the project's plan | verify; the time budget is a parameter |
| pgvector < 0.8 (no iterative scan) | fallback: exact search on the pre-filtered set (fine at our scale) |
| Numbers stored as free text ("$1.2k", "12,345") | `parseMetric` with tests; raw string always kept |
| TikTok Academy page structure changes | extraction-failure rate alert; the crawl never deletes on a single miss (3-strike rule) |
| App guides drift from the app | coverage check + `last_reviewed`; stale-guide list in the health panel |
| Opening to non-Boss roles | ACL designed in from day one; the permission eval is a hard gate |
| Dev copy drifts from prod during the build | re-copy before P6 and P7; additive-only prod changes + kill switches + per-step approval |
| `ads_manager` role (mig 316) unknown to v1's role maps | added to role capabilities, ACL tests and the eval (phases.md P5) |
| Brand `tier` values inconsistent (`Unlimited`/`unlimited`, `2K`/`2000`) | `normTier()` helper before any tier filter |

Open: D1–D6 in `plan.md` §2.

---

## 23. Glossary

| Term | Meaning |
|---|---|
| **RAG** | Retrieval-Augmented Generation: fetch relevant text, then have the model answer from it |
| **Hybrid search** | semantic (vector) + keyword (full-text) search, results merged |
| **RRF** | Reciprocal Rank Fusion: merge ranked lists by summing `1/(k + rank)` |
| **Chunk** | a small, self-contained passage of a document that is embedded and retrieved |
| **Embedding** | a numeric vector representing text meaning; similar texts have nearby vectors |
| **HNSW** | an approximate nearest-neighbour index for fast vector search |
| **Debounce** | wait until changes stop before processing, to avoid redundant work |
| **ACL** | access-control rule deciding who may read a document |
| **Agentic RAG** | the model decides when and what to retrieve, via tools, instead of a fixed retrieve-then-answer step |
| **Reconciler** | periodic job that compares source vs index and fixes drift |

---

## 24. Web search and browsing (mig 415, 2026-10-06)

Buddy can search the open internet and read a public page. Added on Owner
request; **off by default** and off until a provider is configured.

### 24.1 Why it is deliberately hard to trigger

The risk is not that Buddy cannot search — it is that it searches when the
honest answer was "our own systems do not have this", and then presents a
stranger's blog post as company process. So the gate is three-fold, and all
three must pass before the tools even exist for a turn:

1. `ai_assistant_config.web_search_enabled` is true;
2. the caller's role is in `web_allowed_roles` (null = anyone who may use Buddy);
3. at least one provider is usable (SearXNG has a URL, or Tavily has a key).

If any fails, `toolDefsFor(false)` is used and the model never sees a web tool,
and `WEB_RULES` is left out of the prompt so it never offers to look online.

On top of that the prompt (`agent/prompt.ts` `WEB_RULES`) restricts use to
three cases — the person asked; the person gave a link or named a public page;
or the question is about the outside world and no Wurx tool could answer it —
and forbids the web outright for our processes, SOPs, KB, reports, brands,
people, attendance, leave, performance, incentives and pay.

### 24.2 Providers

| | SearXNG | Brave Search | Tavily |
|---|---|---|---|
| What | the company's own meta-search instance | an independent crawler and index | commercial search + page extraction |
| Config | `searxng_url` (no default, on purpose) | `BRAVE_API_KEY` function secret | `TAVILY_API_KEY` function secret |
| Auth | none | `X-Subscription-Token` header (**not** a bearer token) | `Authorization: Bearer` |
| Cost | none | free tier, billed per request | credits, logged per call |
| Note | **`format=json` returns HTTP 403 until the instance admin adds `json` to `search.formats` in settings.yml** | free tier allows ~1 request/second (429 otherwise); machinery added 2026-10-06 (mig 416) **before** the key, so it lies dormant | REST API, not the CLI — Tavily's own guidance is never to use the CLI as a runtime |

Default order is **SearXNG → Brave → Tavily**: the company's own instance
first (free, and it leaks no questions to a third party), then Brave's free
tier, then the one that bills credits. `web_merge` switches from
first-that-works to querying every enabled provider and merging. There is
deliberately **no default `searxng_url`**: pointing Buddy at a stranger's
public instance would leak every question the company asks into third-party
logs.

Brave is worth having beside the others because it runs its own crawler rather
than reselling Google or Bing, so when it disagrees it is a real second opinion
rather than the same answer twice.

**A provider with no key or URL is simply skipped** (`usableProviders`), with no
error and no empty result set. That is what lets Brave be listed, ordered and
toggled in the settings screen before its key exists, and it is why adding the
key later needs no code change — only the function secret.

### 24.3 Files

| File | Responsibility |
|---|---|
| `web/guard.ts` | the SSRF guard: scheme, credentials, port denylist, IPv4/IPv6 private ranges, wildcard-DNS domains, embedded private IPs, DNS resolution, and `safeFetch` which re-checks every redirect hop by hand |
| `web/searxng.ts` | SearXNG POST `/search` with `format=json` |
| `web/brave.ts` | Brave `GET /res/v1/web/search` |
| `web/tavily.ts` | Tavily `POST /search` and `POST /extract` |
| `web/html.ts` | HTML → readable text for the fallback page read (linear scanners, not backtracking regexes) |
| `web/index.ts` | config parsing, provider orchestration, dedupe/merge, `webFetchPage` |
| `agent/tools.ts` | `search_the_web`, `open_web_page`, the `W#` citation kind, `runWeb` |

### 24.4 Security

`open_web_page` fetches a URL chosen by the **model**, which may have read it
out of an untrusted web page. That is attacker-influenced input to a server
holding the service-role key, so:

- only `https` (plain `http` only for an admin-configured LAN SearXNG), no
  credentials in the URL, no non-web ports;
- private and reserved IPv4 and IPv6 are refused, including the transition
  formats that smuggle an IPv4 inside an IPv6 (`::ffff:`, `::`, `64:ff9b::/96`
  NAT64, `2002::/16` 6to4) — these were a real hole found in QA;
- the wildcard-DNS services (`nip.io`, `sslip.io`, `xip.io`, `localtest.me`, …)
  are blocked, and any hostname spelling a private IPv4 in dots or dashes is
  refused;
- the host is resolved (`Deno.resolveDns`) and refused if any A/AAAA answer is
  private;
- **redirects are followed by hand**, re-checked and re-resolved at every hop —
  automatic redirect following would walk straight into `169.254.169.254`;
- loopback, link-local/metadata, multicast and reserved are refused **even for
  an admin-typed URL**, because assistant settings are writable by every active
  developer, so "an admin typed it" is not enough to allow the cloud metadata
  service;
- bodies are streamed and capped; HTML parsing uses linear scanners because the
  obvious lazy regexes are quadratic on an unclosed tag and would pin the edge
  CPU on a hostile page;
- results are wrapped as `<web>` / `<result>` DATA, with the wrapper
  neutralised, and the prompt states web content is never an instruction.

**Accepted residual risk — generic DNS rebinding.** `resolvesPublic` resolves
the host, then `fetch` resolves it *again* to connect, so a record with TTL 0
can answer public to our lookup and `169.254.169.254` to the connection. The
known no-setup routes (`nip.io`, `sslip.io`, `localtest.me`, and any hostname
spelling a private IPv4) are refused by string, but an attacker-controlled
domain is not. Closing it properly means connecting to the already-vetted IP
(`Deno.createHttpClient` with a custom dial), which is not wired up; until then
the runtime's egress rules are the backstop. `resolvesPublic` also skips
resolution entirely where `Deno.resolveDns` is absent (the Node test runner),
which is why it takes an injectable resolver.

`allowPrivate` is granted **only to the first hop** — the URL an admin typed.
A LAN SearXNG that redirects onward gets no such trust, or one compromised
instance could walk Buddy around the whole internal network.

**Test coverage:** `supabase/functions/_shared/ai/__tests__/web.test.ts`
— 126 tests, every fetch stubbed, DNS via an injected resolver. Four of these
assertions exist because QA found the bug they now guard: the IPv6 transition
formats, the v4-mapped spelling under `allowPrivate`, `open_web_page` handing an
unvalidated URL to Tavily, and the quadratic HTML regexes (50 KB of `<`
characters took 6.2 s before the linear tokeniser; it is 7 ms now).

### 24.5 Citations and cost

Web sources get `W1..Wn`, beside `S#` (passages) and `D#` (data). A `[W#]`
counts as grounding for a figure, so a number quoted from a page the model
actually read is attributed — but `WEB_RULES` forbids presenting a web number
as a Wurx number. The UI labels them "Web" / "Web page" so a reader can see at
a glance the fact did not come from our systems.

Tavily credits land in `ai_usage_log` as kinds `web_search` / `web_extract`,
with the credit count in `tokens_in` and `est_cost_usd` left at 0 and
`unpriced` true: the Boss sees how much was used without Buddy inventing a
dollar rate for a plan it cannot see. SearXNG is free by definition.

### 24.6 Still to do

- Deploy `assistant` and set the `TAVILY_API_KEY` function secret.
- Set `BRAVE_API_KEY` when the Owner has it. No code change is needed; Brave is
  already listed, ordered and toggleable, and starts working the moment the
  secret exists.
- Stand up a SearXNG instance with `json` in `search.formats`, and put its URL
  in Settings › Wurx Buddy › Web.
- Decide `web_allowed_roles` before switching it on for everyone.
