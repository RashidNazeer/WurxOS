# WurxOS Assistant v2: Phase-by-Phase Implementation Guide

> **What this file is:** the build manual. For every phase it covers the goal,
> the technical design, every decision with its alternatives and reasoning,
> the exact work items (files and migrations), parameters, tests, exit
> criteria, rollback and risks.
>
> **Related documents:**
> - [plan.md](plan.md): the short overview
> - [architecture.md](architecture.md): the full reference design (schemas, SQL, algorithms). This file cites it as **A§n**.
>
> **Status:** v1.0, 2026-09-26. Data-dependent numbers are marked **⟨P0⟩**.
> They get filled in once production data has been copied to dev and profiled
> (Phase 0.2).

---

## How to read this document

Each phase uses the same template:

| Block | Contents |
|---|---|
| **Goal** | what exists at the end that didn't before |
| **Prerequisites** | what must be done first |
| **Technical design** | how it works, in enough detail to build |
| **Decisions** | `ID · Decision · Alternatives considered · Why` |
| **Work breakdown** | numbered steps → files / migrations |
| **Parameters** | knobs introduced in this phase |
| **Testing & verification** | how we prove it works |
| **Exit criteria** | the gate to the next phase |
| **Rollback** | how to undo it safely |
| **Risks** | what could go wrong and the mitigation |

Phase map:

```
P0 Foundations ─► P1 Store & Search ─► P2 Ingestion Engine ─┬─► P3 TikTok Crawler ─┐
                                                            └─► P4 App Guides ─────┤
                                                                                   ▼
                                  P5 Assistant v2 (tools · agent · UI · extra sources)
                                                                                   ▼
                                  P6 Evaluation & Model Bake-off ─► P7 Cutover ─► P8 Role rollout (optional)
```

P3 and P4 can run in parallel once P2 is done.

---

## Global decisions (apply to every phase)

| ID | Decision | Alternatives considered | Why |
|---|---|---|---|
| **G1** | **Agentic hybrid RAG**: vector + keyword search over text, SQL tools for numbers, and the model decides which to call | (a) naive RAG: embed everything, retrieve top-k; (b) Graph RAG; (c) text-to-SQL | (a) can't sort, sum or give exact figures, so it invents numbers. (b) Our relationships are already foreign keys; an LLM-built graph adds cost and staleness for no gain at our scale. (c) Letting a model write SQL against payroll data is a security and correctness risk; fixed tools are auditable. |
| **G2** | **Postgres + pgvector inside the existing Supabase project** as the vector store | Pinecone, Weaviate, Qdrant, Chroma | Expected size is tens of thousands of chunks ⟨P0⟩, which pgvector handles easily. The data stays next to the RLS helpers, so permissions are enforced in one place. No new vendor, bill or sync job. Already proven here (`tts_knowledge`, mig 223). |
| **G3** | **Embeddings: OpenAI `text-embedding-3-small`, 1536 dims** | `text-embedding-3-large` (3072); Gemini `gemini-embedding-001`; open-source models (bge, e5) | Already used, so the existing TikTok vectors are reused at no cost. Very cheap. Quality is sufficient for short, header-enriched chunks. Switching later is a controlled re-embed (A§7). |
| **G4** | **Numbers only come from tools, never from embeddings** | let the model read figures from retrieved report chunks | Figures in chunks are strings in mixed formats, and top-k retrieval can't aggregate. Incentive/pay figures need the overlay logic (attendance, GMV Max, commission) that only the tools have. |
| **G5** | **Permissions checked at query time**, using the app's own helpers (`can_view_report`, `can_view_brand`, `is_boss`) | copy an ACL into every chunk at ingest | Copied ACLs go stale on every brand reassignment and role change. Live checks never do. KB visibility is the one denormalised case and has an instant fast path. |
| **G6** | **Asynchronous, queue-based ingestion** (trigger → queue → worker) | (a) embed inside the trigger; (b) Supabase Database Webhooks per row; (c) Realtime listener service; (d) nightly full rebuild | (a) blocks user saves and fails when OpenAI is down. (b) One HTTP call per autosave, with no debounce, no retries and no backpressure. (c) Needs a server that is always on. (d) Up to 24 h stale, and re-embeds everything. The queue gives debounce, retries, priorities, idempotency and visibility. |
| **G7** | **Supabase Edge Functions (Deno) + pg_cron** for all background work | a separate Node worker on a VPS / Vercel cron / GitHub Actions | The same runtime and deploy flow as the 14 existing functions. pg_cron → `net.http_post` is already the pattern used for push notifications (mig 013/027). Nothing new to host. |
| **G8** | **Additive rollout**: v2 is built beside v1 and selected by a config switch | replace `ai-chat` in place | Instant rollback. Side-by-side comparison. Production is never broken mid-build. |
| **G9** | **Build and test on the DEV project first**; production only step by step, each approved | build directly against production | A dev project exists (`.env.dev`, `WURXOS_DEV_PROJECT_REF`). Once prod data is copied in, every migration, trigger, cron and backfill can be proven there first. |
| **G10** | **Git: local branch `feat/assistant-rag`, no push** until approved | — | Your instruction. |
| **G11** | **The chat model is swappable behind an adapter**; the choice is made by the eval in P6 | commit to one provider now | Decide on measured quality, cost and latency, not preference. |

---

# Phase 0: Foundations, data inventory & baseline

### Goal
Know exactly what data we're indexing, have a measurable baseline for today's
assistant, and a dev environment that mirrors production.

### Prerequisites
- **Production data copied into the dev project** (you are doing this).
- Cautions for the copy: blank `app_config.send_push_url` / `send_push_secret`
  in dev, and don't copy the `cron` schema (otherwise dev triggers and jobs
  would push notifications to staff and run reminders).

### Technical design

**0.1 Dev environment**
- Credentials come from `.env.dev` (gitignored): `VITE_SUPABASE_URL`,
  `WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY`, `WURXOS_DEV_DB_URL`,
  `WURXOS_DEV_PROJECT_REF`.
- Migrations to dev: `npx supabase db push --db-url "$WURXOS_DEV_DB_URL" --include-all`.
- Functions to dev: `npx supabase functions deploy <name> --project-ref $WURXOS_DEV_PROJECT_REF`
  (needs `supabase login` once).
- Dev function secrets: `OPEN_AI_API_KEY`, `AI_INTERNAL_SECRET`, `AI_INGEST_SECRET`,
  set via `supabase secrets set --project-ref …`.

**0.2 Data profiling**, with [scripts/profile-data.mjs](scripts/profile-data.mjs) (read-only, aggregates only):

| Source | What we measure | Why it matters |
|---|---|---|
| `reports` | count by type × status; period range; **layout** (weekly-single / weekly-legacy / biweekly / monthly); key frequency per type; text size per narrative field; HTML presence; table row counts; `customFields`; **currency distribution**; **number-format shapes** (e.g. `$9,9.9`, `9.9x`, `9%`) | chunk sizes, extractor branches, `parseMetric` rules, backfill cost |
| `kb_articles` | total vs latest-per-group; approval; visibility modes; body-filled vs **link-only**; URL hosts; categories | pointer-chunk strategy, ACL modes |
| `ai_assistant_docs` | count, sizes, SOP-import sentinel | migration into `ai_doc` |
| `tts_knowledge` | chunks, articles, categories, null embeddings | migration without re-embedding |
| `gmv_max_reports` | count, campaigns per row, notes filled | S6 value |
| `agenda_*` | tasks, details filled, presentation summaries | S8/S9 value |
| `brands` | status, **tier values** (dev already shows `unlimited`/`Unlimited`/`2000`/`2K`, so they need normalising) | filters, brand profiles |
| `profiles` | count by role (dev shows **`ads_manager`** exists, mig 316, and the v1 assistant doesn't know it) | role caps, ACL |
| Postgres | pgvector version (`select extversion from pg_extension where extname='vector'`), `cron.timezone`, `pg_trgm` installed | HNSW iterative scan, cron expressions, brand fuzzy match |

Output: `Assistant/inventory.md` (human-readable) and `Assistant/inventory.json` (raw).

**0.3 Backfill cost estimate**
`tokens ≈ Σ(extracted text chars)/4 × 1.15` (headers + overlap) ⟨P0⟩ ×
embedding price, with the price verified on the day. Recorded in `inventory.md`.

**0.4 Evaluation dataset.** Format in A§16.1. At least 100 questions across 13
categories, written together. Each question records:
- `expected_numbers` with tolerance and currency
- `expected_sources` (document IDs)
- `must_refuse` for permission cases
- `role`: the role the question is asked as

**0.5 Eval runner** `Assistant/eval/run-eval.mjs`:
- Calls the chat endpoint as a test user of the given role.
- Parses the SSE stream.
- For v1 there's no request log, so it scores the answer text only.
- The judge is a fixed model with a rubric prompt stored in `eval/judge-prompt.md`.
- Output: `eval/runs/<date>-<label>.json` plus a printed table by category.

**0.6 Baseline:** run the eval against the current `ai-chat` (v1) **on dev**.

### Decisions

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P0-1 | Profile through the service-role REST API from Node | `psql` / direct DB connection | No `psql` or `pg` driver on this machine; supabase-js is already a dependency. Postgres-level facts (extension version, cron tz) come from a single `supabase db` query or the dashboard. |
| P0-2 | Aggregates only, never row content of sensitive tables | full dumps for analysis | Payroll/PII must not be copied into files or chat. |
| P0-3 | Eval set written with you, from real questions | synthetic LLM-generated questions | Synthetic questions test what's easy, not what you actually ask. |
| P0-4 | LLM-as-judge for prose + exact match for numbers | human grading only / judge for everything | Humans don't scale per run. A judge on numbers is unreliable, so numbers are checked exactly. |
| P0-5 | Test users per role on dev (boss, ol, tl, apc, ads_manager) | only the Boss | Permission tests must exist before any ACL code is written (P1). |

### Work breakdown
1. Confirm the prod → dev copy is complete; blank the dev `app_config` push rows; confirm dev cron jobs are removed.
2. Run `node Assistant/scripts/profile-data.mjs > Assistant/inventory.json`.
3. Query Postgres facts (pgvector version, `cron.timezone`, `pg_trgm`).
4. Write `Assistant/inventory.md` with findings and their impact on the design.
5. Update A§5 / A§6 / A§17 where the data contradicts assumptions.
6. Create dev test users per role (through the `create-user` function, never by hand).
7. Write `eval/questions.jsonl` (≥ 100) and `eval/judge-prompt.md`.
8. Build `eval/run-eval.mjs`; run the v1 baseline.
9. Write `Assistant/decisions.md` with D1–D6 (plan.md §2) plus every P0 decision.

### Parameters introduced
None in code. Eval gates are defined in A§16.3.

### Testing & verification
- The profiler's totals match the dashboard's table row counts.
- The eval runner reproduces the same score ±3 % on two consecutive v1 runs (judge stability).

### Exit criteria
- `inventory.md` approved by you; backfill cost known.
- ≥ 100 eval questions; v1 baseline recorded.
- D1–D6 decided.

### Rollback
Nothing to roll back: read-only work plus local files.

### Risks
| Risk | Mitigation |
|---|---|
| The dev copy drifts from prod over the months of the build | re-copy before P6 (evaluation) and before P7 (cutover) |
| Judge noise hides real changes | fixed judge model, temperature default, 3-run average for gate decisions |

---

# Phase 1: Knowledge store & permission-aware search

### Goal
A single store for all retrievable knowledge, with a search function that
returns only what the caller may see. The existing TikTok Academy corpus is
migrated into it.

### Prerequisites
P0 exit. pgvector version known.

### Technical design

**1.1 Tables** (full DDL in A§3):
- `ai_documents`: one row per source item. Holds the ACL keys, filters
  (`brand_id`, `period_start/end`) and a document-level hash.
- `ai_chunks`: text, `embed_text`, `embedding vector(1536)`, a weighted `fts`,
  and a per-chunk hash. FK to its document with cascade delete.
- `ai_ingest_queue`, `ai_ingest_runs`: created here so P2 only adds logic.
- `ai_request_log`: telemetry (A§15.1).
- Column additions:
  - `ai_assistant_docs`: `kind`, `slug`, `meta`
  - `ai_assistant_config`: `engine`, `provider`, `retrieval`, `monthly_budget_usd`
  - `ai_messages`: `meta`

**1.2 Indexes**
- HNSW `(m=16, ef_construction=64)` on `ai_chunks.embedding` (cosine).
- GIN on `fts`.
- B-trees on `ai_documents (source_type,status)`, `(brand_id)`, `(period_start)`.

**1.3 Access control** (A§4):
- `ai_can_read_document(doc, uid, urole)` with the modes `all`, `roles`,
  `report`, `brand`, `kb`, `boss`. Default deny.
- The `report` mode calls `can_view_report(brand_id, author_id, uid)`, the same
  function as the `reports_select` policy.
- The `brand` mode calls `can_view_brand(owner_id, brand_id, uid)`, whose
  current body (mig 316) covers boss, OL, PCTL, `canViewAllBrands`, owner,
  `brand_assignments`, `pctl_brand_selections` and `ads_manager_brands`.
- `urole` is resolved **once per query**. This is the mig 134 lesson: per-row
  profile lookups timed out the KB page.

**1.4 `ai_search` RPC** (A§10.2):
- SECURITY DEFINER.
- Identity: `auth.uid()`, or `p_as_user` only when `auth.role()='service_role'`
  (the Slack relay).
- Filters: source types, brand ids, period window.
- The semantic arm (60 candidates) and keyword arm (60, `websearch_to_tsquery`
  + `ts_rank_cd`) are merged by RRF (k=60) and return up to `p_match_count`.
- Sets `hnsw.ef_search=100`, and `hnsw.iterative_scan=relaxed_order` if
  pgvector ≥ 0.8.

**1.5 Direct table access is blocked.** No select policy on
`ai_documents`/`ai_chunks` for `authenticated`. All reads go through
`ai_search`, so there's exactly one enforcement point.

**1.6 TikTok migration** (mig 371, SQL only, no API calls):
- `tts_articles` ← one row per distinct `knowledge_id` (title, breadcrumb, URL,
  body reconstructed from chunks in order, `content_hash`).
- `ai_documents` ← one per article (`source_type='tts_article'`, `acl_mode='all'`).
- `ai_chunks` ← existing `chunk_text` + **existing embedding**,
  `embedding_model='text-embedding-3-small'`, hash computed in SQL (`encode(sha256(...),'hex')`).
- `tts_knowledge` is kept untouched; v1 still reads it until P7.

### Decisions

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P1-1 | **Two tables** (documents + chunks) | one flat chunks table (like `tts_knowledge`) | The ACL, filters and "unchanged?" checks happen once per document. Deleting a document cascades to its chunks. Filtering happens on the small table. |
| P1-2 | **HNSW** index | ivfflat (used in mig 223); no index (exact scan) | HNSW builds on an empty table, needs no `lists` tuning, and has better recall. Exact scan is the fallback if pgvector < 0.8 makes filtered HNSW recall poor. |
| P1-3 | **RRF** to merge the arms | weighted score sum; semantic only | RRF needs no score normalisation between cosine and `ts_rank`. Keyword search catches exact names (brands, creators, SKUs) that embeddings blur. |
| P1-4 | Weighted fts: content A, section B | unweighted | The section name ("GMV Max insights") helps ranking without dominating it. |
| P1-5 | Access only through the SECURITY DEFINER RPC | RLS policies on `ai_chunks` directly | One enforcement point; the ACL function is easy to test; no risk of a forgotten policy. |
| P1-6 | `source_id` as text | uuid | External IDs (TikTok `knowledge_id`) need to fit. |
| P1-7 | Migrate the TikTok vectors in SQL | re-run `ingest.mjs` against the new tables | Zero API cost; exactly the same content. |
| P1-8 | Migration numbers 367+ (verify with `ls`) | — | Next free number; it moves weekly. |

### Work breakdown
| # | File | Contents |
|---|---|---|
| 1 | `supabase/migrations/367_ai_store.sql` | `ai_documents`, `ai_chunks`, indexes, RLS enabled (no public policies) |
| 2 | `368_ai_search.sql` | `ai_can_read_document`, `ai_search`, grants |
| 3 | `369_ai_queue.sql` | `ai_ingest_queue`, `ai_ingest_runs`, `ai_enqueue`, `ai_ingest_claim/complete/fail/retry` (logic tested now, used in P2) |
| 4 | `370_ai_config_ext.sql` | column additions (1.1), `ai_request_log`, `ai_feedback` RPC |
| 5 | `371_ai_tts_migrate.sql` | `tts_articles` + one-shot copy of the TikTok corpus into the store |
| 6 | `Assistant/tests/sql/acl.sql` | permission test script (below) |
| 7 | `Assistant/scripts/search.mjs` | CLI: embed a query, call `ai_search` as a chosen test user, print results |

### Parameters introduced
`ef_search=100`, candidates 60/60, RRF k=60, `p_match_count` default 30 (A§17).

### Testing & verification
- **Permissions (hard gate).** On dev, with synthetic documents:
  - Boss sees every mode.
  - A test APC sees reports only for brands they're assigned to, and loses
    them **immediately** after reassignment (with no re-index).
  - KB `role`/`users` visibility is honoured.
  - `boss` mode is hidden from an APC.
  - An unknown mode is denied for everyone except the Boss.
- **Search quality smoke test:** 10 TikTok questions from the eval set return
  the same top articles as v1's `tts_knowledge_search`.
- **Performance:** `ai_search` p95 < 300 ms on the migrated corpus
  (`explain analyze`).
- **v1 unaffected:** the v1 baseline eval gives the same score.

### Exit criteria
All ACL tests pass; the TikTok corpus is fully migrated (chunk counts equal);
search latency is within budget; v1 is unchanged.

### Rollback
Drop the new tables and functions (they're additive; nothing else references them).

### Risks
| Risk | Mitigation |
|---|---|
| `can_view_report` signature/behaviour differs from what we assume | read its latest definition before writing mig 368; the tests use real helpers |
| Filtered HNSW recall drops when an APC can see only a few brands | iterative scan (≥ 0.8) or exact scan over the allowed set, whose size is small by definition |

---

# Phase 2: Ingestion engine

### Goal
Every change to an indexed source shows up in the store automatically within
minutes, with retries, debounce, monitoring and a full backfill. This covers
the P1 sources: KB, curated docs, reports and TikTok articles.

### Prerequisites
P1 exit.

### Technical design

**2.1 Shared library** `supabase/functions/_shared/ai/`:

| Module | Responsibility |
|---|---|
| `config.ts` | all parameters (A§17), with overrides merged from `ai_assistant_config.retrieval` |
| `text.ts` | `htmlToText`, entity decoding, whitespace/zero-width normalisation, sentinel removal, `estimateTokens` |
| `hash.ts` | `sha256Hex` (Web Crypto) |
| `chunker.ts` | structure-aware recursive chunker (A§6.1): metrics = 1 chunk, tables = row groups, prose = headings → paragraphs → sentences, greedy packing with overlap, merge-small, cap |
| `embedder.ts` | batched OpenAI embeddings: batch 96 inputs / ≤ 250k tokens, concurrency 2, retry with jittered backoff on 429/5xx, timeout 30 s |
| `extractors/index.ts` | registry `source_type → Extractor` |
| `extractors/report.ts` | layout detection and the section plan (A§5.2) |
| `extractors/kb.ts` | latest-version resolution, pointer chunk for link-only articles, KB ACL |
| `extractors/aiDoc.ts` | curated docs (`kind='doc'`) |
| `extractors/tts.ts` | reads `tts_articles` |
| `writer.ts` | calls `ai_ingest_write` (one transaction per document) |

**2.2 Report extractor details** (the main risk area):
- **Layout:**
  - `type='monthly'` → monthly
  - `data.insightsSingle===true` → weekly-single (`reportInsights`)
  - else → legacy per-section insights (weekly-legacy and all biweekly)
- **Sections:** as in A§5.2. `sections_enabled` / `data.sectionsEnabled`
  disables sections. Empty values (`''`, `'N/A'`, whitespace, placeholder rows)
  are dropped.
- **Currency:** `data.currency`, or `USD` when missing (the app's own rule).
  It's printed in every chunk header.
- **Header:** `[<Type> report · <brand> (client: <client>) · <period_label> · <start> → <end> · status: <status> · currency: <cur>]`
  with the section title appended. The author name goes in metadata only.
- **Unknown layout** (legacy imports with `legacy_id`) → the generic extractor
  flattens every non-empty string field into one prose section and adds the
  flag `metadata.layout='generic'`.
- **Numbers are copied as written.** They are *context*, not answers (G4).

**2.3 Transactional write** `ai_ingest_write(doc jsonb, chunks jsonb)`,
SECURITY DEFINER, callable by the service role only:
1. Upsert `ai_documents` on `(source_type, source_id)`.
2. Upsert chunks on `(document_id, chunk_index)`. Rows with a new embedding
   replace it; rows with an unchanged hash update content/metadata only.
3. Delete chunks with `chunk_index ≥ new count`.
4. Set `chunk_count`, `doc_hash`, `indexed_at`, `source_updated_at`, `status='active'`.

Delete is the separate RPC `ai_ingest_delete(source_type, source_id)`, which
also cascades to chunks.

**2.4 Worker** `supabase/functions/ai-ingest/index.ts` (algorithm A§9.5):
- Auth: header `x-webhook-secret` must equal `AI_INGEST_SECRET`, else 401.
- Loop: claim 20 items → process → until the 100 s budget is used up or the
  queue is empty.
- Per item:
  - `delete` op → delete.
  - Load the live row → not indexable → delete.
  - `acl` op → update ACL columns only.
  - Otherwise: extract → document hash. Unchanged → touch `indexed_at`.
    Changed → chunk → per-chunk hash diff → embed only the changed chunks →
    transactional write.
- Errors → `ai_ingest_fail` (backoff 1m/5m/30m/2h, max 5 attempts, then `failed`).
- Every run writes to `ai_ingest_runs`: claimed, succeeded, failed, embedded
  chunks, embed tokens, skipped (unchanged), duration.

**2.5 Triggers** (A§9.2), all through `ai_enqueue` with its exception guard:

| Table | Change → op | Priority | Debounce |
|---|---|---|---|
| `reports` | content/status/period/brand/sections change on a non-draft → upsert; → draft or DELETE → delete | 5 / 1 | 180 s / 0 |
| `kb_articles` | content → upsert; visibility/approval only → `acl` (or delete if unapproved); new version → upsert new + delete superseded; DELETE → delete | 4 / 0 | 30 s / 0 |
| `ai_assistant_docs` | any; inactive → delete | 4 | 10 s |
| `tts_articles` | `content_hash`/`is_active` change | 7 | 0 |
| `brands` | name/client change → cascade-enqueue all of the brand's reports | 8 | 0 |

**2.6 Scheduling:**
- `app_config` rows: `ai_ingest_url`, `ai_ingest_secret`.
- A SECURITY DEFINER function `ai_ingest_tick()` reads them and calls
  `net.http_post` (the same pattern as `notifications_dispatch_push`, mig 027).
- `cron.schedule('ai-ingest-tick', '* * * * *', 'select public.ai_ingest_tick()')`.
- The tick is skipped when the queue has no claimable rows, a cheap `exists`
  check that avoids 1,440 empty function calls a day.

**2.7 Backfill** `ai_backfill(p_source_type text default null)`:
- Enqueues all indexable rows at priority 9, reason `backfill`.
- Order: KB → docs → reports newest-first.
- Throughput ~80 items/min, so ≈ ⟨P0⟩ minutes in total.
- Live changes (priority ≤ 5) always go first.

**2.8 Reconciler** `ai_reconcile()`, nightly at 03:00 PKT: enqueues sources
that are missing or stale, deletes orphans, and re-embeds a budgeted number of
chunks stuck on an old model. It writes a "reconcile" run row with counts.

**2.9 Housekeeping**, nightly: deletes `done` queue rows older than 14 days
and run rows older than 30 days.

**2.10 Health panel** (Train tab, Boss only, new component `IngestHealthPanel.jsx`):
- Queue depth by status/priority, oldest pending age, failed list (error + Retry).
- Per-source document/chunk counts, last run stats, freshness lag p95 (24 h).
- Buttons: Index everything, Re-index source.

The admin RPCs are `ai_ingest_stats()`, `ai_ingest_retry(id)` and
`ai_backfill(source)`, all checked with `is_ai_admin`.

### Decisions

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P2-1 | **Debounce by pushing `not_before`** on re-enqueue | process every change; fixed delay after the first change | Autosave means dozens of updates per session. Pushing the deadline means we index once, 3 min after the *last* edit. |
| P2-2 | **Report debounce 180 s** | 60 s / 10 min | Long enough to cover typing pauses, short enough that "I just submitted it" is searchable within ~4 min. Tunable. |
| P2-3 | **Drafts are not indexed** (D2) | index drafts with a flag | Drafts are incomplete and change constantly. Submission is the natural "publish" point. |
| P2-4 | **Hash at two levels** (document, then chunk) | re-embed the whole document on any change | The document hash skips no-op saves entirely. The chunk hash means an edit to one insight re-embeds one chunk. |
| P2-5 | **`SKIP LOCKED` claim + 10-minute lock timeout** | advisory locks; a single-worker assumption | Overlapping cron runs are possible; this is the standard safe queue pattern in Postgres. A crashed worker's items are reclaimed automatically. |
| P2-6 | **Op precedence delete > upsert > acl**, and the worker re-reads the live row | trust the queued op | Queued ops can be outdated by the time they run. The live row is the truth. |
| P2-7 | **Guarded triggers** (swallow the error, log a warning) | fail the user's transaction on enqueue error | Never block a save. The nightly reconciler catches anything missed. |
| P2-8 | **One-transaction write RPC** | several REST calls from the function | Readers never see half-written documents; atomic replace. |
| P2-9 | **The author name isn't embedded; the brand name is** | embed both | Brand is a search target; author isn't. This avoids re-embedding on profile renames. |
| P2-10 | **Cascade on brand rename** | leave old names in headers | Stale brand names would break search for that brand. Renames are rare, so the cost is small. |
| P2-11 | **Tick only when there's work** | always call the function every minute | Saves ~1,400 edge invocations a day. |
| P2-12 | **Unknown report layouts → generic extractor** | skip unknown layouts | Nothing is silently left out of the index. Flagged for review. |

### Work breakdown
| # | File | Contents |
|---|---|---|
| 1 | `_shared/ai/{config,text,hash,chunker,embedder}.ts` + tests | core library |
| 2 | `_shared/ai/extractors/{index,report,kb,aiDoc,tts}.ts` + fixtures in `Assistant/tests/fixtures/` (one sanitised report per layout) | extractors |
| 3 | `372_ai_ingest_write.sql` | `ai_ingest_write`, `ai_ingest_delete`, `ai_ingest_stats`, `ai_backfill`, `ai_reconcile` |
| 4 | `supabase/functions/ai-ingest/index.ts` | worker |
| 5 | `373_ai_triggers.sql` | trigger functions + triggers (2.5) |
| 6 | `374_ai_schedule.sql` | `app_config` keys, `ai_ingest_tick()`, cron jobs (tick, reconcile, housekeeping) |
| 7 | `src/pages/assistant/IngestHealthPanel.jsx` + `aiAssistantApi.js` additions | health panel |
| 8 | `Assistant/scripts/backfill.mjs` | wraps `ai_backfill` with progress output |

### Parameters introduced
Chunk sizes per source (A§6.2), embed batching, `WORKER_TIME_BUDGET=100s`,
`CLAIM_BATCH=20`, lock timeout 10 min, `MAX_ATTEMPTS=5`, backoff schedule,
debounce per source, retention periods.

### Testing & verification
| Test | Expected |
|---|---|
| Unit: chunker on fixtures | deterministic output; no chunk > MAX; tables split at 12 rows; headers present |
| Unit: report extractor for each layout (single, legacy, biweekly, monthly, generic) | correct sections; empty sections dropped; currency present |
| Unit: embedder with a mocked 429 | retries, then succeeds; fails cleanly after max retries |
| Integration: edit a submitted report 10× within 2 min | **one** queue row; one embedding pass ~3 min after the last edit |
| Integration: change one insight | exactly 1 chunk re-embedded (`ai_ingest_runs.embedded_chunks = 1`) |
| Integration: report → draft | document removed within the next tick |
| Integration: KB visibility change | `acl` op processed in < 2 min with no embedding call |
| Integration: kill the worker mid-batch | items reclaimed after 10 min and completed |
| Integration: poison item | 5 attempts → `failed` and shown in the panel; other items unaffected |
| Backfill on dev | queue drains; reconciler "missing" = 0; counts match indexable rows |
| Load: backfill throughput | ≥ 60 items/min |

### Exit criteria
Full dev backfill complete; every integration test passes; freshness lag p95
< 5 min during a day of simulated edits; the health panel shows correct figures.

### Rollback
`select cron.unschedule('ai-ingest-tick')`; drop the triggers (mig 373 has a
matching down script in `Assistant/tests/sql/down_373.sql`). The store stays
intact; v1 is unaffected.

### Risks
| Risk | Mitigation |
|---|---|
| Edge wall-clock limit shorter than expected | budget is a parameter; batch sizes shrink automatically |
| OpenAI rate limits during backfill | concurrency 2, backoff, priority keeps live work first |
| Trigger overhead on report saves | the trigger is a single guarded upsert; measure save latency before and after on dev |

---

# Phase 3: TikTok Shop Academy crawler

### Goal
The Academy corpus refreshes itself: new articles are discovered, changed ones
updated, removed ones retired. No manual `seed-urls.json` editing.

### Prerequisites
P2 exit (the queue and worker process `tts_article`).

### Technical design

**Source investigation (done 2026-09-28; details in A§9.8):**
- The requested link, `/ai-university/home`, is **login-only** (it redirects to
  the seller sign-in). It fronts the same knowledge base that the **public
  Academy** serves, so we crawl the public Academy.
- The **official sitemap API** (`/api/v1/seller/learning_center/sitemap/urls/get?version=1&region=US`)
  lists the full US catalog: 988 essays + 41 courses (214 lessons).
- Content comes from the JSON each page embeds (`window._ROUTER_DATA`): plain
  text, section trail, keywords, `modify_time`, AI summary and headings.
  **One course page returns all of its lessons.**
- The site throttles bursts and sometimes serves a JS-only shell. The shell
  is transient and gets retried.
- **Reference crawler, already built and running:** `Assistant/scripts/tts-crawl.mjs`
  → `Assistant/data/tts-academy/articles.jsonl` (gitignored).

**Production design:**
- **Function** `supabase/functions/tts-crawl/index.ts`: a Deno port of
  `Assistant/scripts/tts-crawl.mjs` (sitemap discovery, `_ROUTER_DATA`
  parsing, shell = retry, delta → text for lessons).
- **State** `ai_crawl_state('tts')`: `status`, `cursor` (frontier position),
  `started_at`, `stats`.
- **Start:** weekly cron, Sun 04:00 PKT. The frontier is the sitemap (essay
  ids + one entry per course) ∪ active `tts_articles` ids.
- **Tick:** the existing minute tick also calls `tts-crawl` while the status is
  `running`. Each call handles 20 pages at ~2.5 s spacing (≈ 60 s). A full
  crawl of ~1,030 pages takes ≈ 50 ticks.
- **Discovery safety net:** prev/next/recommended/sidebar ids that aren't in
  the sitemap are added to the frontier.
- **Change detection:** `modify_time` + `content_hash = sha256(title|text)`.
  Unchanged → `last_seen_at` only. Changed or new → upsert `tts_articles` →
  trigger → queue → worker embeds.
- **First load:** import `articles.jsonl` from the reference crawl into
  `tts_articles` (script), instead of crawling again.
- **Retirement:** at the end of a crawl, unseen articles get `missed_crawls++`.
  At 3, they're set `is_active=false` → delete.
- **Health:** crawl stats in the health panel, plus a "Re-crawl now" button.

### Decisions
| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P3-1 | Crawl into a **staging table**, and embed through the normal queue | crawler embeds directly | One ingestion path (principle 2); retries and monitoring for free. |
| P3-2 | **Resumable, ticked crawl** | one long invocation | Edge wall-clock limits; a crash loses at most one batch. |
| P3-3 | **Weekly cadence** | daily | Academy content changes slowly; weekly is polite and cheap. |
| P3-4 | **3-strike retirement** | delete on the first miss | Protects against temporary outages and site glitches. |
| P3-5 | **Discovery from the official sitemap API**, with page links as a safety net | a hand-maintained seed list (old approach); web-search discovery | The sitemap is TikTok's own complete list: 988 essays vs the 514 the seed list found. |
| P3-6 | **Parse the embedded `_ROUTER_DATA` JSON** | scrape HTML classes (old `ingest.mjs`); call the detail JSON API | Structured, clean plain text and metadata (`modify_time`, keywords, trail) that survives markup redesigns. The detail API needs undisclosed parameters. |
| P3-7 | **Crawl the public Academy, not the login-only AI University** | log in with a seller account | Same knowledge base; no credentials to store or rotate; no account risk. |
| P3-8 | **JS-only shell = transient** | treat as a dead page (old behaviour) | The old script silently dropped live articles whenever the site served a shell. |

### Work breakdown
1. ✅ Reference crawler `Assistant/scripts/tts-crawl.mjs` and the first full crawl.
2. `375_ai_crawl.sql`: `ai_crawl_state`, the richer `tts_articles` columns (A§9.8), trigger on `tts_articles`, weekly start cron.
3. `Assistant/scripts/import-tts.mjs`: load `articles.jsonl` → `tts_articles`.
4. `supabase/functions/tts-crawl/index.ts` (port), plus parsing tests against saved `_ROUTER_DATA` fixtures (essay, course, shell, dead).
5. Health panel section and button.

### Parameters
`CRAWL_BATCH=20`, 2.5 s + ≤ 1 s jitter between requests, timeout 30 s, 6 attempts
(backoff 5 s / 15 s / 30 s / 60 s / 120 s), stale after 3 missed crawls.

### Testing & verification
- The parsing fixtures produce identical records to the reference crawler.
- Sitemap coverage: crawled essays + dead = the sitemap's essay count.
- A full crawl on dev completes; an article with manually altered stored
  content is detected as changed and re-embedded.

### Exit criteria
A full crawl completes unattended; at least one newly discovered article
becomes searchable; the error rate is < 5 %.

### Rollback
Unschedule the start cron; `tts_articles` remains as last crawled.

### Risks
| Risk | Mitigation |
|---|---|
| Site structure / markup changes | extraction-failure rate alert (> 20 %); the fixtures catch regressions; `_ROUTER_DATA` is more stable than CSS classes |
| Blocking / rate limiting by the site | ~2.5 s spacing, backoff up to 2 min, realistic UA; crawl only weekly |
| Sitemap API changes or disappears | fall back to the frontier of known ids + page-link discovery (still in place as the safety net) |
| TikTok moves everything behind the AI University login | the existing corpus stays indexed (3-strike retirement protects it); revisit with a seller account only if you decide so |

---

# Phase 4: App knowledge (WurxOS how-to guides)

### Goal
The assistant knows how every page of WurxOS works, per role, from guides
that are reviewed and kept in sync with the code.

### Prerequisites
P2 exit (`app_guide` flows through the normal path).

### Technical design
- **Guide format** (A§9.9): Markdown with frontmatter `slug, title, route,
  roles, feature, last_reviewed`; sections are `##` headings.
- **Drafting:** for each route in `src/App.jsx` + `src/components/layout/menu.js`,
  read the page component(s) and write: what the page is for, who sees it
  (from `RoleGuard` / the menu), step-by-step flows (from the buttons/forms in
  the code), rules and gotchas (validation, approval chains, e.g. APC → TL
  verify → OL approve), and related pages.
- **Review:** each guide is checked by you or the team; `last_reviewed` is set on approval.
- **Sync:** `Assistant/scripts/sync-app-guides.mjs`:
  1. validates frontmatter;
  2. upserts `ai_assistant_docs` by `slug` (`kind='app_guide'`, `meta` = frontmatter);
  3. deactivates guides removed from the folder;
  4. runs a coverage report (routes without guides, guides without routes);
  5. with `--strict`, exits non-zero on gaps.
- **Role awareness:** `meta.roles` → `acl_mode='roles'`. A TL never retrieves
  a Boss-only page guide.
- **Page list for the prompt:** generated at runtime from active guides'
  `route`/`title`/`roles`. This replaces the hard-coded `PAGES` array in
  `ai-chat`, which already misses routes (e.g. the Development pages) and the
  `ads_manager` role.

### Decisions
| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P4-1 | **Guides live as Markdown in the repo**, synced to the DB | written only in the Train tab UI | Versioned with the code, reviewable in diffs, and the coverage check can compare them against routes. |
| P4-2 | **Auto-draft from code + human review** (D5) | fully manual / fully automatic | Fast coverage of 60+ routes; review stops hallucinated buttons from reaching staff. |
| P4-3 | **One guide per route/feature** | one big manual | Precise retrieval and citations; role ACL per page. |
| P4-4 | **Generated page list** | keep the hard-coded `PAGES` | One source of truth; new pages appear automatically. |

### Work breakdown
1. Route inventory → `Assistant/app-guides/_routes.json`.
2. Draft guides (`Assistant/app-guides/*.md`), in batches by area: HR, reporting, brands, agenda, paid collab, admin.
3. Review rounds with you.
4. `sync-app-guides.mjs` + coverage check.
5. Sync to dev → the queue indexes them.

### Parameters
Chunking for `app_guide`: 500 / 800 / 60 / 60 (A§6.2).

### Testing & verification
- Coverage: 0 uncovered routes (excluding a documented allow-list, e.g. dev-only pages).
- Eval `how_to` category: every question retrieves the right guide in the top 3.
- Role test: a TL searching for a Boss-only page gets no guide chunk.

### Exit criteria
All routes covered and reviewed; `how_to` recall@3 ≥ 0.9.

### Rollback
Deactivate the guides (`is_active=false`) → the triggers delete them from the index.

### Risks
| Risk | Mitigation |
|---|---|
| Guides go stale as the app changes | coverage check before each deploy; `last_reviewed` older than 90 days shows in the health panel |
| Review bottleneck | batch by area; the most-asked pages first (from eval categories) |

---

# Phase 5: Assistant v2 (tools, agent, UI, extended sources)

### Goal
A new `assistant` edge function that answers with an agent loop over
`search_knowledge` and exact data tools, streams cited answers, logs every
request, and runs beside v1 behind a switch.

### Prerequisites
P2 exit (P3/P4 can land during P5; the agent just sees more sources as they arrive).

## 5A. Shared helpers & data tools

**Helpers** (`_shared/ai/`):

| Helper | Behaviour |
|---|---|
| `resolvePeriod(text, now)` | "June", "last week", "Q3", "2026-06", "week 12", "this month" → `{from,to,label}` in **Asia/Karachi**. A bare month = most recent past occurrence. Ambiguous → `{ambiguous:true, options}` |
| `resolveBrands(name)` | `ilike` + `pg_trgm` similarity over `brand_name`/`client_name`; > 1 strong match → candidates for a clarifying question |
| `resolvePeople(name)` | existing logic (active, not deleted), with candidates on ambiguity |
| `parseMetric(raw)` | report strings → `{value:number|null, unit:'money'|'pct'|'x'|'count', currency?, raw}`; handles `$`, `,`, `%`, `x`, `k`/`M`, ranges. Unparseable → `value:null` (never guessed). Rules come from the ⟨P0⟩ number-shape profile |
| `normTier(raw)` | brand tier normalisation (`Unlimited`/`unlimited` → `unlimited`, `2K`/`2000` → `2000`) |

**Tools** (A§11). Existing ones are **ported unchanged**, including the
attendance / GMV Max / commission overlays in `get_incentives` and the
composite in `get_performance`. New tools:

| Tool | Core query | Notes |
|---|---|---|
| `search_knowledge` | `ai_search` + diversify (≤ 3/doc) + recency decay for reports without a period (half-life 120 d) + neighbour expansion + packing to 3,500 tokens + citation ids `S1..` | caller JWT → ACL applies |
| `compare_periods` | two reports of the same brand/type chosen **by period** (the `findPreviousReport` semantics from `reportsApi.js`, never by `created_at`) → `parseMetric` → abs/% delta | currency-aware; refuses cross-currency deltas |
| `rank_brands` | latest report per brand in the period → metric → sort | only brands the caller can view; reports its data coverage ("12 of 20 active brands have a June report") |
| `brand_overview` | `brands` + `brand_monthly_metrics` (3 months target vs achieved) + latest report headline | |
| `get_gmv_max` | `gmv_max_reports` (+ campaigns) | USD, numeric |
| `get_agenda_tasks` | `agenda_tasks` by brand/person/status | |

Every data tool returns a `source` block (table, ids, period), which gets a
citation id `D1..`.

## 5B. LLM adapter & agent loop

- **Adapter** `_shared/ai/llm.ts` (A§12.1): one event stream from OpenAI
  **Responses API** / Gemini `streamGenerateContent`. Provider and model are
  allow-listed server-side.
- **Loop** (A§12.2): up to 3 rounds; up to 4 parallel tool calls per round;
  tool rounds at effort `none` with 1,200 output tokens; answer at `low` with
  2,500 tokens; empty-answer retry at 6,000; 60k token ceiling per question.
- **Prompt** (A§12.4), cache-stable prefix:
  1. persona
  2. role capabilities (**now including `ads_manager`**)
  3. generated page list
  4. answer rules (numbers only from `D*` results; currency; PKT; source separation SOP vs TikTok vs report; clarify when ambiguous)
  5. tool rules

  Dynamic tail: user name/role and today's date (PKT).
- **Knowledge moves out of the system prompt** into tool results, so the model
  pays only for what it retrieves.
- **Citations:** inline `[S2]`/`[D1]`; ids are validated against this turn's
  results and unknown ones stripped; a `sources` SSE event is sent before `done`.
- **Memory:** 12 turns / 6,000 chars; tool outputs are not replayed from history.
- **Rate limit:** 30 questions/user/hour (from `ai_request_log`).
- **Logging:** one `ai_request_log` row per question (tools, retrieved chunk
  ids, cited flags, tokens incl. cached, estimated cost, latency, first-token time).
- **Slack relay:** `slack-events` switches its target from `ai-chat` to
  `assistant` only at cutover (P7). Same internal-secret contract.

## 5C. UI

- `aiSendStream` picks the endpoint from `ai_assistant_config.engine`.
- The Train tab adds:
  - an engine switch (v1/v2)
  - a provider + model select (allow-listed)
  - retrieval overrides (advanced, collapsible)
  - the health panel
- Chat shows **source chips** under each answer (report → in-app route via
  `data-nav`; KB/TikTok → external link), plus 👍/👎 with an optional note →
  `ai_feedback`.
- The `sources` event is parsed in `aiSendStream` (a new `onSources` callback).

## 5D. Extended sources

| Source | Work |
|---|---|
| `gmv_max_report` | extractor (A§5.6), trigger (debounce 120 s) |
| `agenda_task`, `agenda_presentation` | extractors (A§5.8), triggers (60 s); presentations ACL `boss` + `{ol}` |
| `brand_profile` | `ai_generated_docs` table; nightly generator 02:00 PKT (A§9.10) using the cheap model, with facts from SQL (not retrieval); `inputs_hash` skips unchanged brands; max 60/night; then trigger → index |

### Decisions
| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P5-1 | **New function `assistant`**, `ai-chat` untouched | edit `ai-chat` in place | G8: instant rollback, side-by-side eval. |
| P5-2 | **Responses API** for OpenAI | stay on Chat Completions | Chat Completions rejects `reasoning_effort` + tools (the 2026-09-08 outage); Responses is OpenAI's forward path. |
| P5-3 | **Retrieval as a tool** | always-retrieve before answering (v1) | Data questions don't pay for knowledge; mixed questions can do both; this removes the brittle regex router. |
| P5-4 | **Port the existing tools verbatim** first, improve later | rewrite them | Money logic mirrors the Incentives page (overlays); rewriting risks drift. Parity is tested. |
| P5-5 | **Standalone query written by the model** in the `search_knowledge` args | a separate condense LLM call | Saves a model call; add the condense step only if the `follow_up` eval category fails. |
| P5-6 | **Citation ids validated server-side** | trust the model's citations | Invented citations are the most damaging hallucination in a RAG system. |
| P5-7 | **Brand profiles generated from SQL facts** | summarise retrieved chunks | Keeps numbers exact; retrieval-built summaries can mix brands/periods. |
| P5-8 | **Rate limit from the request log** | no limit (Boss only) | Costs nothing now; required before any wider rollout. |

### Work breakdown
| # | File(s) |
|---|---|
| 1 | `_shared/ai/{period,brands,people,metrics,tier}.ts` + unit tests (PKT month edges, ambiguous periods, number shapes from P0) |
| 2 | `_shared/ai/tools/*.ts`: port the 9 existing tools (copied from `ai-chat/index.ts`, same queries) |
| 3 | `_shared/ai/tools/{searchKnowledge,comparePeriods,rankBrands,brandOverview,gmvMax,agendaTasks}.ts` |
| 4 | `_shared/ai/llm.ts` (OpenAI Responses), with streaming tests |
| 5 | `supabase/functions/assistant/index.ts`: auth (JWT / internal), config, loop, prompt, SSE, citations, logging, rate limit |
| 6 | `376_ai_extended_sources.sql`: `ai_generated_docs`, triggers for gmv_max / agenda / generated docs, brand-profile cron |
| 7 | `_shared/ai/extractors/{gmvMax,agenda,brandProfile}.ts` + `supabase/functions/ai-brand-profiles/index.ts` |
| 8 | UI: `aiAssistantApi.js` (endpoint switch, `onSources`, feedback), `AiAssistantPage.jsx` (chips, 👍/👎, Train additions) |

### Parameters introduced
Everything under "Retrieval" and "Agent" in A§17, `RATE_LIMIT_PER_USER=30/h`,
brand profile limits.

### Testing & verification
| Test | Expected |
|---|---|
| **Tool parity:** each of the 9 ported tools vs v1 on the same args (dev data) | identical output text |
| Helper unit tests | PKT boundaries (e.g. 00:30 PKT on the 1st = new month); `parseMetric` on every ⟨P0⟩ shape |
| `compare_periods` on out-of-order report creation (OL backfills) | picks by period, not creation time |
| Citation validator with forged ids | stripped |
| Permission eval category run as the APC test user | no leakage (hard gate) |
| Full eval on v2 vs the v1 baseline | improvement in every category; no regression on `people_data`/money |
| Streaming | first token ≤ 6 s p50 for knowledge questions |
| Slack relay dry run against `assistant` (dev) | answers as Boss; the internal secret is required |

### Exit criteria
v2 passes the A§16.3 gates on dev except the cutover-only items; the Boss can
flip v1 ↔ v2 in the Train tab.

### Rollback
`engine='v1'` (instant). Extended-source triggers can be dropped independently.

### Risks
| Risk | Mitigation |
|---|---|
| The model quotes numbers from chunks instead of tools | prompt rule + uncited-number metric in the log + eval `aggregation` category |
| Tool latency stacks up over 3 rounds | parallel tool calls; round cap; status events keep the user informed |
| Responses API behaviour differs from Chat Completions | adapter tests; keep a Chat Completions implementation as a fallback path in the adapter |

---

# Phase 6: Evaluation & model bake-off

### Goal
Choose the chat provider/model and the retrieval parameters based on measured
quality, cost and latency.

### Prerequisites
P5 exit; **re-copy prod → dev** so the eval runs on current data.

### Technical design
- **Gemini adapter** implementing the same `LlmAdapter` (function
  declarations, streaming, usage metadata).
- **Matrix:**

  | Axis | Values |
  |---|---|
  | Provider/model | the allow-listed OpenAI models (e.g. `gpt-5.4-mini`, `gpt-5.5`) × Gemini candidates |
  | Effort | none / low (answer) |
  | `TOP_K` | 6 / 8 / 12 |
  | Rerank | off / on |

- **Runs:** each configuration runs the full eval 3× (judge noise); the mean is reported.
- **Scoring:** the A§16.3 metrics plus cost per question and p95 latency.
- **Choice rule:** the highest mean correctness that meets every hard gate
  (permission 1.0, citation validity 1.0, numeric ≥ 0.95), with ties broken by
  cost, then latency.
- **Rerank** is enabled only if recall@8 < 0.85 without it.

### Decisions
| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P6-1 | **Embeddings stay on OpenAI** regardless of chat provider | switch embeddings with the chat model | Embedding quality isn't the bottleneck; switching means a full re-embed. |
| P6-2 | **Decision by eval matrix** | pick by reputation | Our data, our questions. |
| P6-3 | **Hard gates before quality ranking** | a weighted total score | Safety properties aren't tradeable against fluency. |

### Work breakdown
1. `_shared/ai/llm.gemini.ts` + tests.
2. `eval/matrix.json` + a `run-eval.mjs --matrix` mode.
3. Run the matrix; write `eval/runs/bakeoff-<date>.md`.
4. Record the choice in `decisions.md`; set the defaults in config.

### Exit criteria
Model and parameters chosen and recorded; v2 meets every A§16.3 gate on fresh data.

### Rollback
Config-only; revert the default model/params.

### Risks
Provider pricing or availability changes → the adapter keeps the alternative
ready; re-run the matrix.

---

# Phase 7: Hardening & cutover

### Goal
v2 becomes the production assistant, with alerts and runbooks, and v1 is retired.

### Prerequisites
P6 exit; your approval for each production step.

### Technical design
**7.1 Alerts:**
- New notification category `ai_system`, emitted via `emit_notification`
  from SQL (the only allowed path).
- It must also be added to `NotificationBell.jsx`, `NotificationsPage.jsx` and
  `NotificationPrefsSection.jsx` (CLAUDE.md rule).
- Conditions are in A§15.3 (stalled queue, failures, reconcile drift, budget
  80 %, crawl errors), evaluated by a 15-minute cron `ai_health_check()`.

**7.2 Production rollout sequence.** Each step is approved separately and
verified before the next:
1. Migrations 367–376 → prod (`supabase db push --include-all`).
2. Deploy `ai-ingest`, `tts-crawl`, `ai-brand-profiles`, `assistant`.
3. Set secrets and `app_config` URL/secret rows.
4. Enable crons: tick, reconcile, housekeeping, crawl, profiles, health.
5. Run the backfill; watch the health panel until the queue drains and the
   reconciler reports 0 missing.
6. Boss switches `engine='v2'` → **shadow week**: v2 is the default, v1 is one
   click away; compare 👍/👎 and the request logs.
7. Point `slack-events` at `assistant`.
8. After 2 stable weeks: remove the v1 code paths from the UI, retire `ai-chat`,
   and drop `tts_knowledge` + `tts_knowledge_search`.

**7.3 Runbooks:** A§21, copied into `Assistant/runbooks.md` with production specifics.

**7.4 Data wipe:** extend the `wipe-data` RPC to truncate the `ai_*` tables.

**7.5 Git:** only now, with your approval: push the branch, open a PR, merge
`--no-ff` per `.claude/memory/git-workflow.md`; tag
`stable-pre-assistant-v2` before the merge.

### Decisions
| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P7-1 | **Shadow week with a one-click fallback** | hard switch | Real-usage validation without risk. |
| P7-2 | **Retire v1 only after 2 stable weeks** | immediately | Cheap insurance. |
| P7-3 | **Tag before merge** | — | Project policy (`stable-*` tags before load-bearing changes). |

### Exit criteria
v2 is the default in production for 2 weeks; health green; no permission
incidents; 👎 rate ≤ v1's.

### Rollback
`engine='v1'` → unschedule crons → (if needed) drop the triggers. The data
tables can stay; they're inert.

### Risks
| Risk | Mitigation |
|---|---|
| Backfill load on the prod DB | runs at priority 9, ~80 items/min; start off-hours (PKT night) |
| An unseen production data shape | the generic extractor fallback + the `layout='generic'` count in the health panel |

---

# Phase 8 (optional): Rollout to other roles

### Goal
OL, TL, APC (and possibly `ads_manager`, PCTL, IPC) can use the assistant and
see only what their role allows.

### Technical design
- `ALLOWED_ROLES` extended one role at a time (server) + the menu/route guard (UI).
- People tools are **scoped per role**: OL = their teams; TL = their APCs; APC = self only.
  Salary tools stay Boss-only.
- Knowledge is already ACL'd (P1). Tools get a `scope(uid, role)` guard at the entry of each tool.
- Per-role eval: the `permission` category run as that role must score 1.0
  before enabling it.
- A monthly budget hard stop applies to non-Boss roles.

### Decisions
| ID | Decision | Alternatives | Why |
|---|---|---|---|
| P8-1 | **One role at a time**, gated by the permission eval | open to everyone at once | Blast radius. |
| P8-2 | **Salary/compensation tools never leave Boss** (unless decided otherwise) | role-scoped salary access | Matches the app's own salary rules (`.claude/memory/salary-management.md`). |

### Exit criteria
Per role: permission eval 1.0; a week of logs with no ACL incident.

---

## Appendix A: Decision log format (`Assistant/decisions.md`)

```markdown
## 2026-09-26 · D1 · Audience
**Decision:** Design for all roles, launch Boss-only.
**Options:** Boss-only forever · all roles at launch · design-for-all/launch-Boss
**Why:** …
**Consequences:** P1 builds the full ACL; P8 becomes a config + eval exercise.
**Decided by:** Rashid
```

## Appendix B: File & migration map (planned)

| Phase | Migrations (indicative) | Functions | Other files |
|---|---|---|---|
| P0 | — | — | `inventory.{md,json}`, `eval/*`, `decisions.md`, `scripts/profile-data.mjs` |
| P1 | 367 store · 368 search · 369 queue · 370 config ext · 371 TikTok migrate | — | `tests/sql/acl.sql`, `scripts/search.mjs` |
| P2 | 372 write RPCs · 373 triggers · 374 schedule | `ai-ingest` | `_shared/ai/*`, `IngestHealthPanel.jsx`, `scripts/backfill.mjs` |
| P3 | 375 crawl | `tts-crawl` | crawl fixtures |
| P4 | — | — | `app-guides/*.md`, `scripts/sync-app-guides.mjs` |
| P5 | 376 extended sources | `assistant`, `ai-brand-profiles` | tools, helpers, `llm.ts`, UI changes |
| P6 | — | — | `llm.gemini.ts`, `eval/matrix.json`, bake-off report |
| P7 | 377 alerts + wipe extension | — | `runbooks.md`, 3 notification UI files |
| P8 | per-role grants | — | role-scoped tool guards |

## Appendix C: Definition of done (every step)

- Code + migration are idempotent and have a down script where applicable.
- Tests from the step's table pass on dev.
- The eval shows no regression (from P1 onward).
- `architecture.md` updated if the design changed.
- The decision is recorded if a choice was made.
- A local commit on `feat/assistant-rag`. **No push.**
