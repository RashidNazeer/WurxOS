# Runbook: automatic ingestion (every 12 hours, or on demand)

_ML Engineer, 2026-09-29 (updated for migrations 380 and 381). Dev only until the Owner says otherwise. Owner decisions of 2026-09-29: the KB trigger (374), the weekly TikTok re-crawl and the dev deploy are approved; the deploy is run by the Lead with `scripts\deploy-dev.ps1`._

## What runs

| Piece | Where | What it does |
|---|---|---|
| **Sweep** `ai_ingest_sweep()` | mig 379 | One pass over every enabled source (reconcile + backfill): new or changed rows → upsert, unapproved / superseded / inactive → soft delete, gone → delete. Nothing changed → nothing queued. Writes one `ai_ingest_runs` row, `kind='sweep'`. |
| **Hourly check** `ai_ingest_sweep_if_due()` | cron `ai-ingest-sweep`, `5 * * * *` (every hour at :05) | Sweeps only if no successful sweep (manual or scheduled) started in the last 12 h. It is a **rolling** 12 hours: a manual run resets the clock. |
| **On-demand run** `ai_run_ingestion()` | mig 379 | The Boss or an **active** developer. Refused for 5 min after a sweep (`too_soon`) and while the last sweep's items are still queued (`already_running`). It does not let anyone change settings: `ingest_sources` stays Boss-only. |
| **Drain tick** `ai_ingest_tick()` | cron `ai-ingest-tick`, every minute | Calls the `ai-ingest` edge function **only** when due work is queued. When the queue is idle it makes no call. |
| **KB security trigger** | mig 374 (optional) | When an indexed KB article's visibility, approval or owners change, or it is deleted, it is queued at once, so the change reaches search in about 1 minute instead of 12 hours. No other trigger exists. |
| **Housekeeping** `ai_housekeeping()` | cron `ai-housekeeping`, `30 22 * * *` | 03:30 PKT: deletes done queue rows older than 14 days, runs older than 30 days, and request logs older than 180 days. |
| **Source-name check** | mig 380 (trigger on `ai_assistant_config`) | Saving `ingest_sources` with a name that is not a known source (or a test fixture name) is refused at once (error 23514, listing the allowed names). 379's ignore-and-report stays behind it. |
| **Exclusion list** `ai_excluded_documents` | mig 380 | Documents the Boss has removed from Buddy. Hidden from search at once; the next sweep soft-deletes them; never re-added. See [Exclusions](#exclusions). |
| **Weekly TikTok re-crawl** `tts-crawl` | cron `ai-tts-crawl-start` `0 23 * * 6` + `ai-tts-crawl-tick` every minute (mig 381) | Sunday 04:00 PKT. Re-reads the whole TikTok Shop Academy and writes only new / changed articles to `tts_articles`. See [TikTok re-crawl](#tiktok-re-crawl). |

pg_cron runs in **GMT** on dev (`show cron.timezone`). PKT = GMT+5.

## Deploy (dev): `scripts\deploy-dev.ps1`

**Target only DEV `wurxos-dev` = `vyvkwbvreeycmmnikqbz`.** Never production (`xoaaidgvblondjpvxjqp`) or `gmv-intel` (`yrthghmzlbdmgwzaoeec`). Never `supabase link`. Every CLI command passes `--project-ref vyvkwbvreeycmmnikqbz`.

1. **The Owner logs in once:** `npx supabase login`.
2. **Rehearse** (read-only, changes nothing): `powershell -ExecutionPolicy Bypass -File scripts\deploy-dev.ps1 -DryRun`.
3. **Deploy, only when the Lead says go:** `powershell -ExecutionPolicy Bypass -File scripts\deploy-dev.ps1`. It runs these steps in order:

| Step | What it does |
|---|---|
| (a) | `npx supabase projects list` must work and show the dev project. |
| (b) | Sets the function secrets `AI_INGEST_SECRET` and the free embedding keys (`NVIDIA_API_KEY`, `NVIDIA_API_KEY_2`, `GEMINI_API_KEY`) on dev. The values come from `..\.env.dev` through a temporary env file, never the command line. If `AI_INGEST_SECRET` is missing, a random 32-byte hex secret is generated and appended to `..\.env.dev`. It is never printed. |
| (c) | `supabase functions deploy ai-ingest` and `tts-crawl`, each with `--no-verify-jwt --use-api --project-ref <dev> --workdir <repo root>`. |
| (d) | `node scripts/db-dev.mjs apply 379 380 374 375 381`. It stops at the first failure, which is rolled back; the migrations before it stay applied. |
| (e) | `node scripts/deploy-dev-config.mjs` sets `app_config.ai_ingest_url`, `ai_crawl_url` and `ai_ingest_secret`. `--check` shows them without the secret. |
| (f) | Smoke check: each function must answer our own `401 Unauthorized` when called without the secret, which shows it is live and JWT checking is off. Then it prints the checklist below. |

Refusals: the script stops before doing anything if any command-line argument, environment variable, `..\.env.dev` value or `supabase\.temp\project-ref` / `linked-project.json` (in the repo root) names another project. The same happens if `WURXOS_DEV_PROJECT_REF` is not the dev ref. Skip steps with `-SkipSecrets`, `-SkipFunctions`, `-SkipMigrations` or `-SkipConfig`.

**No `config.toml` needed.** `--workdir <repo root>` makes the CLI use `supabase\functions\...` as given, with no upward search. On 2026-09-29 the CLI (2.118.0) listed dev's functions and secrets fine from this folder without a `config.toml`. `--no-verify-jwt` is passed on each deploy. The CLI caches `supabase\.temp\` here; it is gitignored and holds the dev ref only.

**Checklist after the deploy:**
1. `npx supabase functions list --project-ref vyvkwbvreeycmmnikqbz --workdir ..` shows both functions ACTIVE with verify_jwt false.
2. `node scripts/db-dev.mjs status` lists 374, 375, 379, 380 and 381.
3. `select jobname, schedule from cron.job where jobname like 'ai-%';` returns five jobs.
4. `node scripts/deploy-dev-config.mjs --check` shows both URLs set and the secret matching `.env.dev`.
5. `select public.ai_run_ingestion();` returns `swept`. The first sweep also queues the excluded "testing doc" soft delete (`{"kb_article":{"not indexable":1}}`).
6. About 1 minute later, `net._http_response` shows 200, the testing doc's `ai_documents.status` is `deleted`, and `ai_ingest_stats()` has an empty `failed`.

Migrations applied by hand instead of by the script go in the same order: 379 (sweep), 380 (source-name check, exclusions, crawl state; schedules nothing), 374 (KB security trigger), 375 (ingest cron + app_config keys), 381 (crawl cron + `ai_crawl_url`). Until the URLs are set, both ticks do nothing.

For production later: a separate script and a separate go from the Lead and the Owner. This one refuses production by design.

## Exclusions

`ai_excluded_documents (source_type, source_id, reason, excluded_by, excluded_at)` lists documents the Boss has taken out of Buddy. Only the Boss (`is_ai_admin`) can read or write it: others see 0 rows and cannot insert, and no client role can `TRUNCATE` it.

- **At once:** `ai_can_read_document` refuses an excluded document for everyone, the Boss included. So `ai_search` and `ai_get_chunks` never return it.
- **Next sweep:** `ai_ingest_source` marks it `{indexable:false, excluded:true}`. The sweep queues a soft delete, and the worker performs it; `plan.ts` honours the flag, because the extractors cannot see the list. The vectors are kept, and no sweep adds the document back.
- **Remove an exclusion:** delete the row. The next sweep revives the document (`revived`), with 0 embeds for unchanged text.

```sql
-- exclude (as the Boss in the app, or the SQL editor)
insert into public.ai_excluded_documents (source_type, source_id, reason)
values ('kb_article', '<kb article id>', 'why');
-- include again
delete from public.ai_excluded_documents where source_type = 'kb_article' and source_id = '<id>';
select * from public.ai_excluded_documents;
```

Seeded by 380: the KB article "testing doc" (`833b9bda-8282-41dc-a8da-8ff3f032354d`), reason "junk test article, Owner 2026-09-29". The Owner will also delete it from the KB; once it is gone, the sweep turns the soft delete into a hard delete (`orphan`), and the exclusion row does no harm.

## TikTok re-crawl

The `tts-crawl` edge function is a Deno port of `scripts/tts-crawl.mjs`; its logic lives in `_shared/ai/crawl/`. It works like the script:
- it discovers pages through the Academy's sitemap API;
- it reads the `_ROUTER_DATA` JSON on each page; a course page returns all of its lessons;
- it leaves about 2.5 s (plus up to 1 s of jitter) between requests;
- a JS-only shell is retried, and only a 404 or the "content does not exist" page counts as dead.

It works in resumable batches of about 100 s, because the edge function limit is 150 s. All state is in the database (mig 380):

| Table | Holds |
|---|---|
| `ai_crawl_state` (one row; the Boss can read it) | `status` idle → discover → crawl → finalize → idle, `crawl_no`, the lease, `stats`, `last_error` |
| `ai_crawl_items` | one row per page of the current crawl: pending / done / dead / failed, attempts, next retry |
| `ai_crawl_records` | the records each page returned (emptied when the next crawl starts) |

- **Start:** `ai_crawl_start()` runs from cron on Sunday at 04:00 PKT, or by hand. A crawl that is still running is left alone, unless it started more than 6 days ago; then it starts over.
- **Tick** (every minute): `ai_crawl_tick()` posts `{"mode":"continue"}` to the function only while a crawl is running, nobody holds the 3-minute lease, and there is work due now. While idle, it makes no call.
- **Retries:** a page that fails (JS shell, HTTP 429/5xx, timeout) is retried after 5 s, 15 s, 30 s, 60 s and 2 min. It is marked `failed` after 6 attempts.
- **Finalize:** records are read in whole-id groups and passed through the importer's winner rules (`crawlToRows` in `ingest/ttsImport.ts`: one row per id, the essay beats a lesson, and every course is kept). `ai_tts_apply` then writes only new rows, rows whose `content_hash` changed, and retired rows that came back. Unchanged rows are not touched.
- **Missing articles:** an active article that no fetched page returned gets `missed_crawls + 1`. After 3 consecutive misses it gets `is_active = false`, and the next sweep soft-deletes it. An article that is seen again goes back to 0, and a retired one that comes back is revived.
  - A page that failed (as opposed to dead) never counts against its articles: a failed essay, or the stored lessons of a failed course, count as seen.
  - **Outage guard:** the retire step is skipped when more than 5 % of pages failed, or when the crawl saw fewer than half of the active articles. `stats.retire_skipped` then says why.
- **Sitemap failures:** the crawl stays in `discover` and the next tick tries again. After 10 failures in a row, the crawl ends (`stats.aborted`).
- **Embedding:** the crawl never embeds anything. The next sweep, or `select public.ai_run_ingestion();`, embeds only the changed articles.

A full crawl is about 1,030 pages (990 essays + 42 courses on 2026-09-29) at about 3 s each, so roughly an hour. Only tts_articles is written.

| To | Run |
|---|---|
| Start one now | `select public.ai_crawl_start();`, or POST `{"mode":"start"}` to `tts-crawl` with the `x-webhook-secret` header |
| Watch it | `select status, crawl_no, started_at, finished_at, stats, last_error from public.ai_crawl_state;` and `select status, count(*) from public.ai_crawl_items group by 1;` |
| Stop the current crawl | `update public.ai_crawl_state set status = 'idle', lease_owner = null, lease_until = null where id = 1;` |
| Pause the weekly start | `select cron.unschedule('ai-tts-crawl-start');` |
| Stop all crawl calls | `select cron.unschedule('ai-tts-crawl-tick');` or `update public.app_config set value = '' where key = 'ai_crawl_url';` |
| Resume | re-run 381 (safe to repeat) |

**Healthy after a crawl:** `status` is idle, `stats.failed` is near 0, `stats.retire_skipped` is null, and `stats.inserted + stats.updated` is small (the Academy changes a few articles a week).

## Run it manually

- **SQL** (the Boss or a developer in the app, or the SQL editor): `select public.ai_run_ingestion();`
  - `{"status":"swept","enqueued_total":N,"enqueued":{type:{why:n}}}`: N items were queued, and the tick drains them within about a minute.
  - `{"status":"too_soon","next_allowed_at":…}`: a sweep started less than 5 minutes ago.
  - `{"status":"already_running","queued":N}`: the last sweep's items are still being processed.
  - `not allowed`: the caller is neither the Boss nor an active developer.
- **HTTP**, which also drains straight away: `POST https://<dev-ref>.supabase.co/functions/v1/ai-ingest` with the header `x-webhook-secret: <secret>` and the body `{"mode":"sweep"}`. The body `{"mode":"drain"}` (or no body) only drains.
- **App button (later, Phase 7):** `supabase.rpc('ai_run_ingestion')`, shown to the Boss and developers.

A run is recorded in `ai_ingest_runs` with `kind='sweep'` and `stats.trigger` set to `manual` or `schedule`. `stats.triggered_by` holds the user id (null for the service role, cron or SQL).

## Pause and resume

| To | Run |
|---|---|
| Stop new sweeps (the queue still drains) | `select cron.unschedule('ai-ingest-sweep');` |
| Stop processing (items wait in the queue) | `select cron.unschedule('ai-ingest-tick');` or `update public.app_config set value = '' where key = 'ai_ingest_url';` |
| Pause the KB security trigger | `alter table public.kb_articles disable trigger ai_kb_articles_acl;` (`enable` to resume) |
| Switch one source off (Boss only) | `update public.ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'incentive') where id = 1;` |
| Resume the jobs | re-run 375's three `cron.schedule(...)` lines (safe to repeat) |
| Remove everything | unschedule the five `ai-*` jobs (three from 375, two from 381) and `drop trigger ai_kb_articles_acl on public.kb_articles;` |

## Embeddings: free providers only (mig 432)

OpenAI is not used for embeddings. The paid key has had no credits since 2026-10-02, and the free-tier key cannot embed either (`HTTP 429 you have no credits remaining`, tested 2026-11-02). `embedTexts` refuses `api.openai.com`, and a unit test fails if any retrieval or ingest file names it.

| Space | Column | Provider and model | Dimensions | Search role |
|---|---|---|---|---|
| **main** | `ai_chunks.embedding`, label in `embedding_model` | NVIDIA `llama-nemotron-embed-vl-1b-v2` (documents `passage`, questions `query`) | 1536 | The space searches rely on. Takes every type in `free_provider_sources` (including reports). |
| **second** | `ai_chunks.embedding_alt`, label in `embed_model_alt` | Gemini `gemini-embedding-001` (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`), `ai_assistant_config.embed_alt_provider` | 1536 | A safety net for company docs and TikTok articles if NVIDIA is down. |

- **One model per column, never mixed.** `ai_search` filters each arm by the model label, and now also takes `p_query_model` / `p_query_model_alt`: a query vector that is unlabelled (an old caller) or labelled with another model than the space holds is ignored, not compared. A question is embedded by NVIDIA first; only if that fails is Gemini asked (its allowance is small and its quality was not measured). Each vector is fused with the keyword arm by RRF at 20 : 1 (see the benchmark below).
- **Privacy is per provider.** NVIDIA sees `free_provider_sources` (the Boss setting). Gemini sees `gemini_provider_sources` AND `free_provider_sources`; the default now includes `report` (Boss decision 2026-11-03: client reports may go to Gemini's free tier, accepting that Google's unpaid tier may use submitted content to improve its products) and leaves out `incentive`. `incentive` (pay data) is on no list, so those chunks are **keyword-only for good**. The database enforces this in `ai_ingest_write` and `ai_vector_fill`, not only the worker.
- **Free limits (measured 2026-11-02/03).** NVIDIA: 70 rapid requests drew no 429, a batch of 128 chunks (49k tokens) answers in 3 s; the worker uses batches of 96 and a 1.2 s gap. Gemini: **100 inputs per minute and 1,000 inputs per day, per model** (a 429 says `limit: 1000 … retry in 13h`). A question costs one of them, so the backfill keeps 150 back (`ai_alt_budget()`: at most 850 vectors per rolling 24 h).
- **Re-embed time (production, 13,339 chunks).** The 8,245 NVIDIA vectors are moved, not re-embedded. About 4,858 chunks wait for NVIDIA: roughly 1.9 M tokens, about 51 requests of 96, so **one or two ticks** (a few minutes, outside quiet hours 18:00-02:00 PKT). Gemini fills about 850 a day: its ~6,000 company and TikTok chunks take **about a week**, and new content after that.

### States and recovery

`ai_vector_state` holds one row per space only while it is deferred. Every failure defers the space and a success clears it (`ai_vector_ok`), so nothing stays "down":

| Event | Deferred for |
|---|---|
| quota, key refused (401/403) after both NVIDIA keys, a limit of hours | the provider's stated wait (at most 6 h), else 30 min |
| passing 429 (per minute), 5xx, timeout, network | the stated wait, at least 1 min; else 2 min |
| no API key configured for the provider | 1 h, error text `no API key configured for <provider>` |
| the provider refuses one chunk (400) | nothing: the batch is halved until the bad row stands alone (`skipped_rows`) |

`select public.ai_ingest_tick();` wakes the worker only when work that can be done exists (a type allowed on a free provider, the space not deferred, the daily allowance not used). The incentive chunks no longer wake it every minute.

### Stats (`ai_ingest_stats()`, new fields for the settings screen)

| Field | Meaning |
|---|---|
| `vector_pending` | chunks **waiting** for a vector: none yet, and a free provider may embed them |
| `vectors.keyword_only_not_allowed`, `keyword_only_by_type` | chunks no free provider may see (incentive): keyword search only, not waiting |
| `vectors.spaces.main` / `.alt` | `{provider, model, filled, missing, not_allowed, allowed_types, status, next_try_at, last_error}` |
| `vectors.spaces.*.status` | `complete`, `filling`, `down` (deferred after an error; see `last_error`), `paused_quiet_hours`, `daily_limit` (second space only; resumes by itself) |
| `vectors.by_space.none` | chunks no space finds by meaning (waiting plus keyword-only) |
| `vectors.main_provider/main_model/alt_provider/alt_model` | what fills each space |

Old keys are kept (`by_space`, `main_missing`, `alt_filled`, `alt_models`, `pending_by_type`, `state`).

### Benchmark (own data, 2026-11-03)

2,386 chunks (all app guides, KB and AI docs, 1,800 TikTok articles) and 127 questions (120 paraphrased by a free LLM from a known chunk, 7 real questions from `ai_request_log` with hand-labelled documents). Scripts and notes: `scripts/embed-bench/`.

| System | recall@5 | recall@10 | MRR |
|---|---|---|---|
| keywords only (BM25 approximation) | 0.600 | 0.700 | 0.454 |
| **NVIDIA dense** | **0.908** | **0.975** | **0.789** |
| NVIDIA + keywords, RRF 1:1 | 0.783 | 0.858 | 0.618 |
| NVIDIA + keywords, RRF 3:1 (through the real `ai_search`, DEV) | 0.700 | 0.883 | 0.515 |
| NVIDIA + keywords, RRF 20:1 (through the real `ai_search`, DEV) | 0.900 | 0.967 | 0.736 |
| keywords only, the real Postgres arm (DEV) | 0.208 | 0.300 | 0.152 |

Chunk-level gold (n = 120); the BM25 rows are an offline approximation, the DEV rows go through the real function. The Postgres keyword arm is weak on natural-language questions (recall@5 0.21 alone), so it is kept as a tiebreaker (weight 1 against 20), not an equal partner; the questions are paraphrases, which favour meaning over words, so exact names and week numbers rely on that tiebreaker. A better keyword arm (for example `websearch_to_tsquery` with an AND-first pass) is the next retrieval gain. Gemini could not be measured: its free tier (1,000 inputs a day per model) was used up before a comparable corpus could be embedded; re-run `scripts/embed-bench` tomorrow on a corpus of at most 800 chunks.

### Rollout order (production)

1. Blank `app_config.ai_ingest_url` (the minute tick then does nothing).
2. Apply 432 during quiet hours (18:00-02:00 PKT). It drops and rebuilds the ten HNSW indexes inside one transaction, which holds an exclusive lock on `ai_chunks`: Buddy search and ingest wait for it. DEV took 7-16 s for 2.5k rows; production has 13k rows and 8k vectors to index, so expect a few minutes (an estimate, not measured).
3. Deploy `ai-ingest` and `assistant` (the new code). Make sure the function secrets `NVIDIA_API_KEY`, `NVIDIA_API_KEY_2` and `GEMINI_API_KEY` are set on `ai-ingest`.
4. Restore `ai_ingest_url`.

If the order is broken: the OLD `ai-ingest` on the new database refuses to run (`pipeline mismatch`, it embeds nothing, no harm). The OLD `assistant` on the new database sends no model label, so every semantic arm is ignored and search is keyword-only until it is redeployed (no wrong-model comparison). The NEW functions on the OLD database fail on the missing 12-argument `ai_search`.

### Operations

- Check: `select public.ai_ingest_stats()->'vectors'->'spaces';`. Healthy: both `complete`, or `filling` / `daily_limit` with a falling `missing`.
- Gemini never recovers by itself after a refused key: replace the secret, then `delete from public.ai_vector_state where space = 'alt';`.
- Re-embed a space from scratch: `select public.ai_vector_reset_alt();` (second) or `select public.ai_vector_reset_main();` (main). The backfill refills them.
- Switch the second provider: `update ai_assistant_config set embed_alt_provider = 'gemini'` (it must differ from the main one; the database refuses a switch while the column holds another model's vectors, run `ai_vector_reset_alt()` first).

## Health

```sql
select public.ai_ingest_stats();   -- Boss / service
```

| Field | Healthy |
|---|---|
| `last_sweep_at` / `next_sweep_due_at` | `last_sweep_at` is less than about 13 h old |
| `queue` | mostly `done`; `pending` near 0 between sweeps |
| `oldest_pending_seconds` | under 1800 (older means the tick or function isn't running) |
| `stuck_processing` | 0 |
| `failed` | empty (retry with `select ai_ingest_retry(<id>)`) |
| `ignored_sources` | `[]` (anything listed is a typo in `ingest_sources`) |
| `documents.*.other_pipeline` | 0 once a pipeline bump has been processed |

```sql
-- the last sweeps and worker runs
select id, kind, started_at, stats->>'trigger' as trigger, stats->>'triggered_by' as by,
       stats->'enqueued_total' as queued, claimed, succeeded, failed, embedded_chunks, error
  from public.ai_ingest_runs order by id desc limit 20;

-- did cron fire, and did the function answer?
select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname like 'ai-%' order by d.start_time desc limit 20;
select id, status_code, left(content, 200) as body, error_msg, created
  from net._http_response order by id desc limit 10;
```

**Warning signs:**
- A sweep row with `error` set: `ai_ingest_sweep_if_due` retries every hour until a sweep succeeds.
- `failed` items.
- `status_code` 401: the secret in `app_config` differs from the function secret.
- 500 `function secrets missing`: a function secret is not set.
- A sweep that queues the same `changed` items night after night: check whether the SQL and TypeScript `indexable()` disagree (`scripts/ingest.mjs --dry-run`).

## Cost

A sweep reads every source in about 1.5–3 s of database time and queues only what differs from the store. The worker embeds only chunks whose text is new, on the free tiers (no billed call exists). An idle queue makes no function calls.


## Decisions recorded (Boss, 2026-11-03)

1. **Pay and performance data may reach free chat providers** (Gemini, Groq, the OpenAI free tier). It never goes to NVIDIA, whose keys are testing-only: if only NVIDIA is left for such a question the turn fails rather than sending it there. Free tiers may keep or learn from what they receive; the Boss accepted that.
2. **Reports may be embedded by Gemini** (the second search space), as well as NVIDIA. **Incentive/pay documents are never embedded** by any free provider and stay keyword-searchable only.
3. **The old `ai-chat` function is deleted** (it ran on the paid OpenAI key and nothing calls it any more). Order matters in production: deploy `slack-events` and `assistant` first, then delete `ai-chat`.
