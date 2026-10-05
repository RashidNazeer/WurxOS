# WurxOS Assistant v2 — Project Plan

**Goal:** an assistant that knows *all* of WurxOS — how the app works, the
Knowledge Base / SOPs, TikTok Shop Academy, every report, incentives,
performance, attendance, leave, brands, meetings — and answers from real,
current data with citations.

**Status:** planning. Nothing is pushed to GitHub until explicitly approved.
Work happens on a local branch (`feat/assistant-rag`), committed locally only.

---

## 1. Architecture decision

### 1.1 Not Graph RAG — agentic hybrid RAG

WurxOS data comes in two shapes, and each needs a different retrieval method:

| Shape | Examples | Retrieval |
|---|---|---|
| **Unstructured text** | KB/SOP articles, TikTok Academy, app how-to guides, report insights/recommendations/action items, meeting notes | **Hybrid search** (vector + keyword, fused) over chunks in pgvector |
| **Structured facts & numbers** | GMV/orders/ROI, incentives, salaries, attendance %, performance scores, leave | **Tools** — fixed, parameterized, read-only queries against the live DB |

Why:

- **Numbers must never come from embeddings.** "Top brand by GMV in June",
  "total bonus paid in July", "rank APCs by attendance" need sorting, sums and
  exact values. Vector search returns the ~8 chunks that *sound* similar and
  the model invents the rest. Numbers come from SQL.
- **Graph RAG is not worth it here.** It pays off when relationships are
  buried in a huge unstructured corpus. Ours aren't buried. Employee → brand →
  report → incentive are foreign keys, so a join *is* the graph traversal.
  Graph RAG would add an LLM entity-extraction pipeline, a second store to keep
  in sync, and heavy re-indexing for data that changes daily. Revisit only if
  the eval set shows cross-document "themes over time" questions failing, and
  even then try generated summary documents (§4.4) first.
- **"Agentic"**: retrieval is itself a *tool*. The model decides whether to
  search knowledge, query data, or both, which replaces today's regex
  `looksData` / `looksHowTo` router in `ai-chat`.

### 1.2 Target picture

```
                        ┌──────────────── Ingestion (always running) ────────────────┐
 Source tables ──trigger──► ai_ingest_queue ──pg_cron (1 min)──► ai-ingest (edge fn) ──┐
 (reports, kb_articles,                                         extract → chunk →     │
  ai_assistant_docs, agenda…)                                   hash → embed → upsert │
 TikTok Academy ──weekly crawl (tts-crawl)──► ai_ingest_queue                         │
 App guides (Assistant/app-guides/*.md) ──sync script──► ai_assistant_docs ──trigger──┘
                                                                                      ▼
                                                                          ai_chunks (pgvector)
 User ──► /assistant UI ──SSE──► ai-chat (agent loop)                                 │
                                   ├─ search_knowledge ─► ai_search (hybrid RRF, RLS) ─┘
                                   ├─ data tools ──────► live tables / views (exact numbers)
                                   └─ LLM adapter ─────► OpenAI (Responses API) | Gemini
```

### 1.3 What we keep from today

- pgvector + the hybrid RRF search pattern (`tts_knowledge_search`, mig 223).
- The 9 data tools and their business logic. The attendance, GMV Max and
  commission overlays in particular must keep matching the Incentives page.
- Streaming SSE UI, status events, conversation memory, cost guards,
  Boss-only gating, and the Slack relay (it calls `ai-chat` and inherits
  everything automatically).
- `text-embedding-3-small` (1536-d). Keeping it means the existing TikTok
  Academy embeddings migrate over with **no re-embedding cost**.

---

## 2. Open decisions (defaults assumed until you decide)

| # | Decision | Default assumed | Impact |
|---|---|---|---|
| D1 | Audience: Boss-only forever, or OL/TL/APC later? | **Design for all roles, launch Boss-only** | Permissions are built into `ai_chunks` from day one (§3.3); cheap now, painful later |
| D2 | Which reports to index | **Submitted / verified / approved only; drafts excluded** | Drafts churn on autosave and are incomplete |
| D3 | Report history depth | **All history** | Embedding is cheap; the agent filters by period |
| D4 | LLM provider | **OpenAI now, behind an adapter; Gemini benchmarked in Phase 6** | Picked by eval results, not by feel |
| D5 | App guides | **Auto-drafted from the codebase, reviewed by a human** | Fast coverage; human review keeps them accurate |
| D6 | Cost ceiling | **Keep the current ~60k tokens/question backstop; add a monthly budget alert** | Drives model choice and context size |

Every decision taken gets a dated entry in `Assistant/decisions.md`.

---

## 3. Data model

Migration numbers: 365 and 366 are taken, so this project starts at
**367**. `ls supabase/migrations` before each one; the number moves.

### 3.1 `ai_chunks` — the single knowledge store

| Column | Purpose |
|---|---|
| `id` uuid PK | |
| `source_type` text | `kb_article`, `ai_doc`, `app_guide`, `tts_article`, `report`, `agenda_meeting`, `brand_profile`, … |
| `source_id` text | PK of the source row (text so external IDs like TikTok `knowledge_id` fit) |
| `chunk_index` int | position within the source document |
| `title`, `breadcrumb` | human context, **prepended to the text before embedding** so short chunks keep their meaning |
| `content` text | the chunk |
| `embedding` vector(1536) | `text-embedding-3-small` |
| `fts` tsvector (generated) | keyword arm of hybrid search |
| `metadata` jsonb | filters: `brand_id`, `report_type`, `period_start`, `period_end`, `status`, `category`, `author_id`, `url`, … |
| `brand_id` uuid (nullable) | promoted out of metadata for the RLS check + index |
| `content_hash` text | per-chunk hash; unchanged chunks are **never re-embedded** |
| `embedding_model` text | allows a controlled re-embed if the model ever changes |
| `source_updated_at`, `indexed_at` | freshness tracking |

- Unique `(source_type, source_id, chunk_index)`.
- **HNSW** index on `embedding` (cosine). Unlike the ivfflat used in mig 223,
  it builds on an empty table and gives better recall without tuning.
- GIN index on `fts`; b-tree on `(source_type, brand_id)` and
  `(metadata->>'period_start')`.

### 3.2 `ai_ingest_queue` — the change log the ingester works from

| Column | Purpose |
|---|---|
| `source_type`, `source_id` | what changed; **unique while pending** |
| `op` | `upsert` or `delete` |
| `enqueued_at` | reset on every new change → gives us debouncing (§5.3) |
| `status` | `pending` → `processing` → `done` / `failed` |
| `attempts`, `last_error`, `locked_at` | retries + visibility |

Enqueue = `insert … on conflict (source_type, source_id) where status='pending'
do update set enqueued_at = now(), op = excluded.op`. Fifty autosaves on one
report collapse into **one** queue row.

### 3.3 Permissions: inherited from the source at query time

We do **not** copy access lists into chunks. Copies go stale whenever a brand
is reassigned or a KB article's visibility changes. Instead, `ai_chunks` has an
RLS policy that asks the *source's own* rules:

```sql
using (
  public.is_boss(auth.uid())
  or case source_type
       when 'report'        then public.can_view_brand(auth.uid(), brand_id)
       when 'brand_profile' then public.can_view_brand(auth.uid(), brand_id)
       when 'kb_article'    then exists (select 1 from public.kb_articles a
                                         where a.id::text = source_id)   -- kb RLS applies inside
       when 'tts_article'   then true      -- public TikTok content
       when 'app_guide'     then true      -- role-filtered via metadata.roles in ai_search
       when 'ai_doc'        then true
       else false
     end)
```

`ai_search` runs as **SECURITY INVOKER** with the caller's JWT, so a reassigned
brand or a restricted SOP is filtered correctly the next second, with no
re-index. The Slack relay keeps answering as a Boss (already enforced in
`ai-chat`).

### 3.4 `ai_search` RPC

`ai_search(query_embedding, query_text, source_types[], brand_id?, period_from?,
period_to?, match_count)`:

1. Semantic arm: top 40 by cosine, with the filters applied.
2. Keyword arm: top 40 by `ts_rank` on `websearch_to_tsquery`, same filters.
3. Reciprocal Rank Fusion (k = 60), then return the top N with source metadata
   for citations.
4. Optional (only if the evals show it's needed): LLM or cross-encoder rerank
   of the top 30 → 8.

### 3.5 Observability tables

- `ai_request_log`: question, model, tools called, chunk IDs retrieved,
  tokens in/out, estimated cost, latency, error, and user feedback (👍/👎).
- Ingest health is derived from `ai_ingest_queue` plus chunk counts per
  `source_type`.

---

## 4. Sources: what gets indexed and how

### 4.1 Source inventory (Phase 0 confirms counts and fields)

| Priority | Source | Table / origin | Indexed text | Structured side (tools) |
|---|---|---|---|---|
| P1 | Knowledge Base / SOPs | `kb_articles` (latest version per `sop_group_id`, approved only) | body + title; link-only articles become a "pointer" chunk with the URL | — |
| P1 | Curated assistant docs | `ai_assistant_docs` (active) | full content | — |
| P1 | App how-to guides | `Assistant/app-guides/*.md` → synced into `ai_assistant_docs` with `kind='app_guide'` | one guide per page/feature, with its roles | — |
| P1 | TikTok Shop Academy | external site → `tts-crawl` | article chunks + source URL | — |
| P1 | Reports (weekly / bi-weekly / monthly) | `reports.data` jsonb | see §4.2 | `get_reports`, `compare_periods`, `rank_brands` |
| P2 | Brand profiles (generated) | `brands` + reports + `brand_monthly_metrics` | nightly generated summary per brand (§4.4) | `list_brands`, `brand_overview` |
| P2 | Agenda meetings | `agenda_meetings`, `agenda_presentations`, `agenda_tasks`, `agenda_task_reviews` | meeting notes, presentations, action items | `get_agenda_tasks` |
| P3 | Broadcasts, product campaigns, campaign tracker, paid collab notes, tasks | respective tables | titles + descriptions | small tools as needed |
| — | **Never embedded** | salaries, compensation, incentives, attendance, leave, performance numbers | — | **tools only**: exact, access-checked, always live |

### 4.2 Report chunking (the most important source)

Each report becomes several small, self-describing chunks. Every chunk starts
with a context header so it is findable on its own:

```
[Weekly report · Bentgo · Week 12 (2026-03-16 → 2026-03-22) · approved]
```

| Chunk | Content |
|---|---|
| `summary` | header + headline metrics in a sentence (GMV, orders, ROI, samples, videos, shop score). Lets "Bentgo week 12" match, but the agent still gets exact numbers via tools |
| `insights:<area>` | one chunk per insight section (overall, GMV Max, top creators, top videos, products, offsite, key wins), HTML stripped |
| `written:<section>` | recommendations, action items, upcoming campaigns, operational updates |
| `tables` | top creators / videos / products condensed to text lines (names are good search targets) |

Rules:
- Target ~500–700 tokens per chunk with ~10–15 % overlap only when a section
  has to be split. Most sections fit in one chunk.
- Metadata on every chunk: `brand_id`, `report_type`, `period_start`,
  `period_end`, `status`, `report_id`.
- The same chunker runs for `weekly` and `biweekly` (one component, as in the
  app) and `monthly`.

### 4.3 App guides ("knowledge of the app itself")

The app isn't in the database, so its knowledge has to be written down.

1. **Draft:** generate one Markdown guide per route/feature from the codebase
   (`App.jsx` routes, `menu.js`, page components). Each guide has frontmatter
   (`route`, `roles`, `feature`, `last_reviewed`) and a body covering what the
   page is for, who sees it, step-by-step flows, and gotchas.
2. **Review:** a human checks each guide before it goes live.
3. **Sync:** `node Assistant/scripts/sync-app-guides.mjs` upserts the guides
   into `ai_assistant_docs` (`kind='app_guide'`). The normal trigger → queue →
   ingest path then embeds them. There is no separate pipeline.
4. **Coverage check:** the same script lists routes that have no guide and
   guides whose `route` no longer exists, so drift is visible. Run it before
   each deploy that touches pages.

This replaces the hand-maintained `PAGES` array in `ai-chat`. It gets generated
from the guides' frontmatter instead.

### 4.4 Generated summary documents (instead of Graph RAG)

A nightly job writes derived documents for questions that span many rows:

- **Brand profile:** owner, status, tenure, last 3 months' trend in words,
  recurring issues and wins pulled from recent report insights.
- Optionally later, **monthly org digest:** top/bottom brands, notable changes.

They are stored as `source_type='brand_profile'` chunks and regenerated when
their inputs change (the nightly cron enqueues brands whose reports changed
that day). This gives the "big picture" benefit of Graph RAG at a fraction of
the cost.

---

## 5. The ingester: keeping the vector store in sync

The ingester has one job: **every change to a source is reflected in
`ai_chunks` within minutes, and nothing is silently missed.**

### 5.1 Components

| Component | Where | Role |
|---|---|---|
| Change triggers | migration, one per source table | write a row to `ai_ingest_queue` on INSERT / UPDATE / DELETE |
| `ai-ingest` | new edge function | the worker: claim → extract → chunk → embed → upsert |
| Scheduler | `pg_cron` every minute → `net.http_post` to `ai-ingest` with `x-internal-secret` | same pattern the push dispatcher already uses (mig 013/027) |
| `tts-crawl` | new edge function (port of `scripts/tts-ingest/ingest.mjs`) | discovers new/changed TikTok Academy articles weekly and enqueues them |
| Backfill | `Assistant/scripts/backfill.mjs` (and an "Index everything" button) | enqueues every existing row once. **Triggers don't fire retroactively** (the mig 190 lesson) |
| Reconciler | nightly cron | catches anything a trigger missed (§5.6) |

### 5.2 Triggers: what counts as a change

| Table | Enqueue when | op |
|---|---|---|
| `reports` | INSERT, or UPDATE of `data` / `status` / `period_*` / `brand_id`; status becomes `draft` → **delete** | upsert / delete |
| `reports` | DELETE | delete |
| `kb_articles` | INSERT / UPDATE of body, title, url, category, approval_status, version; not approved → delete | upsert / delete |
| `ai_assistant_docs` (incl. app guides) | any change; `is_active=false` → delete | upsert / delete |
| `agenda_*` | notes / presentation / task text changes | upsert / delete |
| `brands` | name / status / owner changes → also enqueue that brand's `brand_profile` | upsert |
| TikTok Academy | no trigger (external); `tts-crawl` enqueues | upsert / delete |

Triggers stay tiny (one upsert into the queue) so they never slow down a user's
save. Permission-only changes such as brand reassignment or KB visibility need
**no** re-index, because permissions are checked at query time (§3.3).

### 5.3 Debounce (reports autosave constantly)

The report editor autosaves while an APC types. The worker only claims rows
whose `enqueued_at` is **older than 3 minutes**. Every autosave pushes
`enqueued_at` forward, so a report is indexed once, shortly after its author
stops editing, not 50 times. Deletes skip the debounce and are processed
immediately.

### 5.4 Worker algorithm (`ai-ingest`)

```
every minute (pg_cron):
  batch = ai_ingest_claim(limit 25)
          -- UPDATE … SET status='processing', locked_at=now()
          -- WHERE status='pending' AND enqueued_at < now()-debounce
          --   OR (status='processing' AND locked_at < now()-10min)   -- crashed worker
          -- FOR UPDATE SKIP LOCKED                                   -- safe if runs overlap
  for each item:
    if op = delete → delete from ai_chunks where (source_type, source_id); mark done
    doc    = extractor[source_type](source_id)      -- reads the row, strips HTML, builds text
    if doc is null (row gone / not indexable) → treat as delete
    chunks = chunker[source_type](doc)              -- §4.2 rules, context header on each
    for each chunk: hash = sha256(title + content + embedding_model)
    changed = chunks whose hash ≠ stored hash
    embeddings = embed(changed)                      -- ONE batched API call, up to ~100 inputs
    upsert changed chunks; update metadata-only on unchanged ones
    delete chunks with chunk_index ≥ new chunk count  -- a shorter report leaves no orphans
    mark done
  on error: attempts++, last_error, status back to 'pending' with backoff
            (1, 5, 30, 120 min); after 5 attempts → 'failed' (shown in the UI)
  stop claiming at ~100 s so the function never hits the edge runtime limit
```

Properties:
- **Idempotent:** processing the same item twice gives the same result.
- **Cheap:** per-chunk hashing means an edit to one insight re-embeds one
  chunk, not the whole report.
- **Safe under overlap:** `SKIP LOCKED` plus a lock timeout; two runs never
  process the same item.
- **Observable:** every failure has a row, an error message and a retry count.

### 5.5 TikTok Academy crawl (`tts-crawl`)

1. Weekly cron (plus a "Re-crawl now" button).
2. Discover article IDs from Academy category/listing pages, merged with
   `scripts/tts-ingest/seed-urls.json`, so new articles are found
   automatically rather than hand-added.
3. For each article: fetch, extract (reusing `ingest.mjs` logic), and compute an
   article-level hash. Unchanged → skip. Changed or new → store the extracted
   text in a staging table `tts_articles(knowledge_id, url, title, breadcrumb,
   body, content_hash, last_seen_at)` → the trigger enqueues it → normal worker.
4. Articles not seen for 3 consecutive crawls → enqueue `delete`.
5. Rate-limited and resumable, since the crawl can span several invocations.

**Migration:** existing `tts_knowledge` rows are copied into `ai_chunks` with
their embeddings (same model, so no cost). `tts_knowledge` is kept read-only
until cutover, then dropped.

### 5.6 Reconciler (belt and braces)

Nightly: for each source type, compare `source_updated_at` in `ai_chunks`
against the source rows' `updated_at` and enqueue anything newer or missing.
Also delete chunks whose source row no longer exists. This catches changes
made while triggers were disabled, rows restored from backup, and similar
cases, so correctness never depends on triggers alone.

### 5.7 Ingest health panel (Train tab)

- Queue depth, oldest pending age, failed items (with error and a "Retry" button).
- Chunk count and last indexed time per source.
- Buttons: *Re-index a source*, *Index everything* (backfill), *Re-crawl TikTok Academy*.

---

## 6. The agent (`ai-chat` v2)

### 6.1 Tools the model gets

| Tool | Kind | Notes |
|---|---|---|
| `search_knowledge(query, sources?, brand?, period_from?, period_to?)` | RAG | calls `ai_search`; returns chunks with citation info |
| `find_person`, `get_employees` | data | existing |
| `get_reports` | data | existing, sectioned |
| `compare_periods(brand, metric, from, to)` | data, new | MoM/WoW deltas using `findPreviousReport` semantics (compare by period, **not** `created_at`) |
| `rank_brands(metric, period, top_n)` | data, new | "highest GMV in June" |
| `brand_overview(brand)` | data, new | owner, status, latest metrics, targets vs achieved |
| `get_incentives`, `get_salary`, `get_performance`, `get_attendance`, `get_leave`, `list_brands` | data | existing, keep all overlays |
| `get_agenda_tasks` | data, new | open action items per brand/person |

All data tools stay read-only, parameterized and role-checked. The model never
writes SQL.

### 6.2 Loop

1. **Condense:** rewrite a follow-up ("and last month?") into a standalone
   query using recent history, so retrieval doesn't miss context.
2. **Plan + call tools:** the model calls `search_knowledge` and/or data tools,
   in parallel where possible. Up to 3 rounds, same cost ceiling as today.
3. **Answer:** streamed, with **inline citations**: KB/SOP title, report
   (brand + period, linking to the report page), TikTok Academy URL. Numbers
   must come from tool output. The system prompt forbids numbers that appear
   only in text chunks unless they are labelled as coming from that report's
   text.
4. **Log** to `ai_request_log`.

### 6.3 LLM adapter

`supabase/functions/_shared/llm.ts`, with one interface:
`chat({ messages, tools, stream, maxTokens, effort })`.

- **OpenAI implementation:** move to the **Responses API**. The
  reasoning_effort + tools conflict that caused the 2026-09-08 outage doesn't
  exist there.
- **Gemini implementation:** the same interface, with function calling.
- The Train tab's model dropdown becomes provider + model, and both stay
  allow-listed server-side.
- **Embeddings stay on OpenAI** regardless of the chat model. Switching them
  means re-embedding everything (§8).

### 6.4 Safety

- **Prompt injection:** retrieved text (APC-written reports, external TikTok
  pages) is wrapped as data and the system prompt says it is never
  instructions. The agent has **no write tools**, so an injected instruction
  can't change anything.
- **Sensitive data:** salary, compensation and incentive figures are never
  embedded. They are reachable only through role-checked tools.
- **Citations are verified:** only sources actually returned this turn can be
  cited. Unknown links are stripped before display.

---

## 7. Evaluation (built first, used at every step)

`Assistant/eval/`:
- `questions.jsonl`: 80–120 real questions, each with the expected answer or
  facts, the expected source IDs (for retrieval) and a category (how-to,
  SOP, TikTok, report lookup, aggregation, mixed, follow-up, permission-denied).
- `run-eval.mjs`: runs every question against a chosen pipeline/model and scores:
  - **Retrieval recall@8:** was the expected chunk in the results?
  - **Answer correctness:** exact match on numbers; LLM-as-judge on prose.
  - **Citation validity:** every cited source was actually retrieved.
  - **Faithfulness:** no claims beyond the tool and chunk content.
  - **Latency, tokens and cost** per question.
- Results are saved per run (`eval/runs/<date>-<label>.json`) so every change
  has a before/after.

**Gate:** a phase is done only when the eval doesn't regress and its target
category improves.

---

## 8. Cost notes (verify prices at build time)

- **Embedding:** `text-embedding-3-small` is very cheap (on the order of cents
  per million tokens). A full backfill of all reports and KB content is
  expected to cost well under a few dollars; Phase 0 produces the real number
  from actual row counts. Ongoing updates are tiny thanks to per-chunk hashing
  and debounce.
- **Chat:** the main cost driver. Controls: tool-result caps, chunk count caps,
  a cached stable system-prompt prefix (already done), the per-question token
  ceiling, and a monthly budget alert from `ai_request_log`.
- **Changing the embedding model later** = full re-embed. `embedding_model` is
  stored per chunk so it can be done gradually.

---

## 9. Phases: start to finish

Sizes: S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks. These are estimates, to be
refined after Phase 0.

### Phase 0: Inventory & evaluation baseline (S–M)
- Row counts and text volume per source; the exact jsonb shape of
  `reports.data`; KB visibility rules (mig 134); the agenda tables.
- Write `Assistant/inventory.md` and a cost estimate for the backfill.
- Write the first 80+ eval questions together with you, then run them against
  **today's** assistant to get the baseline.
- Settle the D1–D6 decisions → `decisions.md`.
- **Exit:** inventory signed off; baseline eval scores recorded.

### Phase 1: Knowledge store + search (M)
- Migrations: `ai_chunks`, `ai_search`, RLS (§3.3), `ai_ingest_queue`,
  `ai_request_log`.
- Copy `tts_knowledge` → `ai_chunks`.
- **Exit:** `ai_search` returns correct, permission-filtered results in SQL tests.

### Phase 2: Ingester (L)
- `ai-ingest` worker, extractors and chunkers for KB, ai_docs and reports.
- Triggers, pg_cron schedule, debounce, retries, reconciler.
- Backfill everything; ingest health panel in the Train tab.
- **Exit:** create a test report → chunks appear within ~5 min of the last
  edit; edit it → only changed chunks re-embed; set it back to draft → chunks
  removed; queue shows no failures after a full backfill.

### Phase 3: TikTok Academy crawler (M)
- `tts-crawl` edge function, staging table, discovery, weekly cron, stale
  deletion.
- **Exit:** a new Academy article appears in search after a crawl with no
  manual steps.

### Phase 4: App guides (M)
- Auto-draft guides for every route → human review → sync script → coverage check.
- Replace the hard-coded `PAGES` with generated data.
- **Exit:** every route has a reviewed guide; "how do I …" eval questions pass.

### Phase 5: Agent v2 (L)
- LLM adapter (OpenAI Responses API first), `search_knowledge` tool,
  new data tools (`compare_periods`, `rank_brands`, `brand_overview`,
  `get_agenda_tasks`), query condensing, citations, request logging, 👍/👎 in UI.
- Behind a config flag `retrieval_mode: legacy | rag`, switchable by the Boss
  in the Train tab. **Shadow period:** both modes are available and compared.
- **Exit:** the eval beats the Phase 0 baseline in every category; no
  regressions on the numbers/money questions.

### Phase 6: Model bake-off & tuning (S–M)
- Gemini adapter; run the eval on GPT vs Gemini (quality, latency, cost).
- Tune chunk sizes, match counts, and add reranking only if recall@8 is short.
- Generated brand profiles (§4.4) if the eval shows "big picture" gaps.
- **Exit:** provider/model chosen on data; recorded in `decisions.md`.

### Phase 7: Cutover & hardening (S)
- Flip the default to `rag`, remove the legacy retrieval code and the regex
  router, drop `tts_knowledge`.
- Budget alerts; runbook for "the assistant is wrong / the queue is stuck".
- **Exit:** a stable week in production with the health panel green.

### Phase 8 (optional): Wider rollout
- Only if D1 says so: open to OL → TL → APC one role at a time. Permission
  tests per role come from the eval set (the "permission-denied" category)
  before each step.

---

## 10. Where the code lives

Supabase tooling expects migrations and functions in fixed places, so:

| What | Where |
|---|---|
| Plans, decisions, inventory, eval, app guides, local scripts | `Assistant/` |
| Migrations | `supabase/migrations/367_…` onwards |
| Edge functions | `supabase/functions/ai-ingest`, `supabase/functions/tts-crawl`, `supabase/functions/ai-chat` (v2), `supabase/functions/_shared/llm.ts` |
| UI | `src/pages/assistant/` (health panel, citations, feedback) |

```
Assistant/
  plan.md            ← this file
  decisions.md       ← dated decision log (D1–D6 and later)
  inventory.md       ← Phase 0 output
  eval/
    questions.jsonl
    run-eval.mjs
    runs/
  app-guides/        ← one reviewed .md per route/feature
  scripts/
    backfill.mjs
    sync-app-guides.mjs
```

---

## 11. Ground rules for this project

- **No `git push`** until you explicitly say so. Local commits on
  `feat/assistant-rag` only. No `supabase db push` / `functions deploy` to
  production without your go-ahead for each step.
- Numbers always come from tools, never from embeddings.
- Every new source ships with: an extractor, a chunker, a trigger, a backfill,
  a reconciler rule and eval questions.
- Triggers don't fire retroactively, so every trigger ships with its backfill.
- Money logic (attendance, GMV Max and commission overlays) is reused, never
  re-implemented.
