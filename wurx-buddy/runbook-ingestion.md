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
| (b) | Sets the function secrets `OPEN_AI_API_KEY` and `AI_INGEST_SECRET` on dev. The values come from `..\.env.dev` through a temporary env file, never the command line. If `AI_INGEST_SECRET` is missing, a random 32-byte hex secret is generated and appended to `..\.env.dev`. It is never printed. |
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

A sweep reads every source in about 1.5–3 s of database time and queues only what differs from the store. The worker embeds only chunks whose text is new. An idle queue makes no function calls.
