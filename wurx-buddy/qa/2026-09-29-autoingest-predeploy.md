# QA: auto-ingestion package, pre-deployment acceptance (2026-09-29)

**Verdict: DEPLOY-READY.** Nothing blocks the deploy. There is one medium issue in a test harness (M1, it is not in the package) and five low ones.

Scope: migrations 379, 380, 381, 374 and 375, the edge functions `ai-ingest` and `tts-crawl`, and `scripts/deploy-dev.ps1` and `deploy-dev-config.mjs`. The code is at commits `475133d` and `a122c5c`, and none of it is applied or deployed. I tested on dev `vyvkwbvreeycmmnikqbz` only. Every database test ran inside a transaction that was rolled back, and each runner checked its transaction id before the rollback. Dev when I started: 367–373, 376, 377, 378 and 383 applied; the queue had 1,927 rows, all `done`, none failed; the store held 1,927 active documents and 11,556 chunks with no missing vectors.

## 1. Tests run

The package was applied in order, 379 → 380 → 374 → 375 → 381, inside the rolled-back transaction wherever a suite needed it.

| Suite | Mode | Result |
|---|---|---|
| `tests/sql/acl.sql` | before the package / with the package | ACL MATRIX PASS (0 leaks, 0 missing) / PASS |
| `tests/sql/search.sql` | before / with | PASS / PASS 44 ok, 1 known WARN (P3/P4 period filter, not new) |
| `tests/sql/queue.sql` | before / with | PASS / PASS 80 |
| `tests/sql/v1compat.sql` | before / with | PASS / PASS 6 |
| `tests/sql/grants.sql` (updated) | before / with | PASS 267 / PASS 385 |
| `tests/sql/store_health.sql` (new; replaces `hold_state.sql`) | before / with | HEALTHY 18 / HEALTHY WITH WARNINGS 24 ok, 4 WARN (expected before the first sweep and before the config step) |
| `tests/sql/sources.sql` (rewritten) | with 379 + 380 | PASS 28 |
| `tests/sql/autoingest.sql` (new) | with the package | PASS 57 |
| `tests/ingest/phase2b.test.mjs` (updated) | 379 + 380 in the transaction, real store set aside inside it | 124/124 in 1,207 s |
| `tests/ingest/phase2b-triggers.test.mjs` (rewritten for the new 374) | 379 + 380 + 374 | 18/18 in 43 s |
| `scripts/test-schedule.mjs` | engineer | 68/68 |
| `scripts/test-380.mjs --pages 8` | engineer, with 8 real pages | 64/64; the 45 real records are unchanged against dev |
| `scripts/test-triggers.mjs` | engineer | 22/22 (the first attempt failed on a DNS error and was retried) |
| `scripts/test-ingest.mjs --no-real` | engineer | **49/50**. The failure is a harness artifact (M1). A copy with the one-line fix passes 50/50. |
| `npm test` | unit tests | 173/173 |
| `scripts/ingest.mjs --dry-run` | read-only | 0 writes, 0 embeds; SQL-vs-TypeScript `indexable()` disagreements 0 for all six types |
| `deploy-dev.ps1 -DryRun` | real | exit 0; target shown as DEV; every "would run" names `--project-ref vyvkwbvreeycmmnikqbz` |

### Test changes (tests/ only)
- `tests/run-with-migrations.mjs` (new) runs one or more SQL files after executing the named migrations, all in one transaction that is always rolled back. It skips migrations dev has already recorded, so the same command works after the deploy.
- `sources.sql`: the save-time refusals now expect 23514 (13 bad shapes, including NULL, an INSERT, and case and whitespace variants). For 379's second net, the suite disables `ai_assistant_config_sources_check`, runs reconcile, backfill and sweep, then enables the trigger again. I removed the obsolete "no real tts_articles" precondition.
- `phase2b.test.mjs`:
  - ~l.875 now expects 23514, and the second-net check runs with the trigger disabled. Since 379 that check is refused as "not enabled" before the deny-list is reached; both refusals are accepted.
  - The PRE step now sets the real store aside inside its own transaction, so the harness can run on the populated store.
  - The T9-A kb_article truth count subtracts excluded documents.
- `grants.sql` adds the following. All the package checks are state-aware: each migration must be all present or all absent.
  - All 26 package functions (379, the 13 crawl/apply functions of 380, the redefined `ai_can_read_document` and `ai_ingest_source`, 374 and 375), each checked for kind, definer, pinned search_path and grants.
  - `ai_run_ingestion` on the authenticated allow-list, plus 378's `ai_get_chunks`, `ai_resolve_brands` and `ai_report_periods`, which are already on dev.
  - Privileges, RLS and policies on the four new tables.
  - The cron job set must match exactly what is applied.
  - The Boss is shown to be unable to call 22 service-only functions.
- `hold_state.sql` is **deleted**. `store_health.sql` replaces it: counts, 0 missing vectors, 0 orphan chunks, `chunk_count` consistent, 0 failed / stuck / old-pending queue items, no run errors, ignored sources, excluded documents that are still active, crawl sanity, cron jobs and wiring, pg_net failures.
- `phase2b-triggers.test.mjs` is rewritten for the new 374. It uses real indexed KB articles:
  - The Boss restricts an article. Before the drain the APC still finds it (the window the trigger closes). After one drain the ACL is rewritten with 0 embeds and the APC no longer finds it.
  - Withdrawing approval gives a soft delete. A DELETE removes the document and its chunks.
  - An access change to the excluded testing doc results in a soft delete; the document is not revived.
  - A non-Boss author (TL) can edit an article's access through KB RLS, and the definer trigger enqueues the change. That author cannot insert into `ai_ingest_queue` directly (42501).
  - Content edits and report edits enqueue nothing.
  - When kb_article is switched off, nothing is enqueued.
  - If the queue insert raises, the user's save still succeeds.

## 2. Review points

**(a) Who can run ingestion?** Only the Boss and **active** developers (`tests/sql/autoingest.sql`).
- Refused with 42501 `not allowed`: OL, TL, APC, IPC, PCTL, ads_manager, a JWT with no `sub`, a JWT for a uid with no profile, an inactive developer, a soft-deleted developer whose `is_active` is still true, and an inactive Boss.
- anon has no EXECUTE.
- None of the refused calls wrote a sweep row.
- An active developer's call returns `swept`, and the run row records `trigger=manual` and the developer's uid.
- `too_soon` (5 minutes) and `already_running` both work. An item in retry (`last_error` set) does not block a new sweep.
- The rolling 12-hour clock works: 11h54m → not_due; 11h56m → swept (5-minute slack); a sweep row with an error is ignored, so the hourly check retries.
- The direct-session bypass requires `session_user` postgres or supabase_admin. PostgREST connects as `authenticator`, so clients cannot use it.

**(b) Can a developer change any config?** No. For every non-Boss role, including both developers:
- `ai_assistant_config`: UPDATE touches 0 rows; INSERT is refused by RLS.
- `app_config`: 0 rows visible (the URLs and the secret cannot be read); UPDATE touches 0 rows; INSERT is refused.
- The crawl tables and `ai_crawl_start` give 42501.
- `tts_articles` and `ai_ingest_queue` cannot be written.
- `is_ai_admin` is still Boss-only.

The Boss can read `ai_crawl_state` but cannot write it or start a crawl through the API.

**(c) The exclusion list** is Boss-only.
- For all eight non-Boss labels (OL, TL, APC, IPC, PCTL, ads_manager and both developers): SELECT returns 0 rows, INSERT fails RLS, UPDATE and DELETE touch 0 rows, TRUNCATE is denied, and `ai_ingest_source` cannot be executed.
- anon is denied, and an inactive Boss sees 0 rows.
- The Boss can read, add (`excluded_by` = the Boss) and remove rows.
- Effect on real read access: every role's readable KB documents drop by exactly the testing doc (Boss 149→148, APC 131→130, …), and nobody can read it.
- The four new tables have no column-level grants and are not in the realtime publication.

**(d) Crawl safety**
- Outage guard, verified (test-380):
  - When every page is a shell, the retire step is skipped.
  - At 1 failed page in 21 (4.8 %), retiring still runs.
  - A crawl that saw 21 of about 1,090 active articles skips retiring, and the real rows are byte-for-byte untouched.
  - A course page that fails does not count its stored lessons as missing.
  - A dead page is not stored.
  - 10 sitemap failures end the crawl as `aborted`.
- Politeness: 2.5 s plus up to 1 s jitter between requests within a call. The gap between two calls is not enforced (L3).
- Edge CPU and time, measured locally:
  - Parsing is under 16 ms of CPU per page (the Windows timer resolution), for pages of 136–620 KB.
  - Finalize (`crawlToRows` over the full 1,201-record crawl) is at worst 62 ms per 100-id group and 313 ms in total.
  - A 100-second call covers about 30 pages, so it stays far below the 2-second CPU limit.
  - Worst-case wall time is about 124 s: the last fetch starts at 99.9 s and can take up to 20 s to time out. That is under both the 150-second edge limit and the 150-second pg_net timeout.
  - The 3-minute lease prevents overlapping calls.
- Risk I could not test before the deploy: TikTok may serve shells or 403s to Supabase edge IPs, which differ from the Owner's IP. The guard protects the catalogue, but such a crawl would be useless. Watch `stats.failed` on the first manual crawl.

**(e) Can `deploy-dev.ps1` ever target production?** No, not without editing the script.
- Every CLI call appends the hard-coded `--project-ref vyvkwbvreeycmmnikqbz` and `--workdir`.
- Database work goes through `db-dev.mjs`, which checks the URL's host and pooler user.
- `deploy-dev-config.mjs` and the smoke check build their URLs from the hard-coded ref.

I tried to make it pick another ref; each attempt was refused or impossible:

| Attempt | Outcome |
|---|---|
| An extra positional argument, or `-ProjectRef` | PowerShell parameter binding fails; the script never runs |
| `SUPABASE_PROJECT_ID` = production | refused |
| `SUPABASE_PROJECT_REF` = another ref, including an uppercase one | refused |
| Any environment variable containing the gmv-intel ref | refused |
| `.temp/project-ref` = production, in Assistant or in the app repo | refused |
| `.temp/project-ref` = an unlisted project | refused |
| `linked-project.json` = production | refused |
| `.env.dev` with `WURXOS_DEV_PROJECT_REF` = production, or another key naming production | refused |
| `.env.dev` with a DB URL for an unlisted project | passes the PowerShell guard; `db-dev.mjs` refuses it |
| `.env.dev` missing | refused |

These were tested on copies of the script in scratchpad directory layouts, always with `-DryRun`. Only unparseable JSON slips through (L2), and it is harmless.

A read-only `supabase functions list --project-ref <dev> --workdir Assistant` works without a `config.toml`. It shows 0 functions on dev today, with CLI 2.118.0.

**(f) Does the first sweep enqueue or re-embed unchanged data?** No.
- Candidates over the real store with 380 applied: exactly `{"kb_article":{"delete:not indexable":1}}`, and that one is the testing doc.
- The first sweep enqueues exactly 1 item.
- No document has pipeline or model drift.
- The dry run shows 0 changes and 0 SQL/TypeScript disagreements.
- 380's `ai_ingest_source` is byte-identical to 377's apart from the exclusion step, so no fingerprint changes.

The first weekly crawl was checked on 30 real pages (read-only):
- At record level, 53 of 54 records are identical to the crawl the store was imported from; one text differs, most likely a genuine edit.
- At row level, 9 of 53 rows differed. All 9 are sampling artifacts: an id's `course` aggregation is incomplete when only some of its pages are fetched.
- A full crawl should rewrite only genuine changes. `test-380`'s 8 pages gave 45/45 unchanged.

## 3. Bugs and issues

**M1 (medium, test harness, not the package): `scripts/test-ingest.mjs:141-142` fails on current dev.**
- The `stat()` query reads `pg_stat_xact_user_tables where relname in ('ai_documents','ai_chunks')` without filtering on the schema.
- Dev now holds a committed schema, **`scratch382`**. It contains `ai_chunks`: 220 MB, 11,556 rows, a full copy of every chunk including incentive text and the testing doc, with 382's partial HNSW indexes. It is not recorded in `schema_migrations`, and it looks like the retrieval engineer's bench copy.
- `Object.fromEntries` keeps the `scratch382` row, so the counts are wrong. Repro: `node --experimental-strip-types scripts/test-ingest.mjs --no-real` → `FAIL edit one insight … ai_chunks u:0`.
- Fix (for the engineer): add `schemaname = 'public' and` to that query. A scratchpad copy with only that change passes 50/50.
- `scratch382` cannot be reached by clients: no USAGE for anon or authenticated, and the schema is not exposed by PostgREST. It should still be dropped once benchmarking is done, because it is an unprotected, stale copy of the store that the exclusion list does not cover. That is a Lead decision.

**L1 (low, rules): `deploy-dev.ps1:112-124` appends `AI_INGEST_SECRET` to `..\.env.dev`,** which is outside `Assistant\`. TEAM.md §3.1 says to never create or edit anything outside the project home. The Lead runs the script, but the exception should be explicit. Alternatively, the Owner adds the line by hand and the script only refuses when it is missing.

**L2 (low): `deploy-dev.ps1:75-78`, an unparseable `linked-project.json` is ignored.**
- Repro: `{"ref":"xoaaidgvblondjpvxjqp",` → not refused.
- It is harmless, because every CLI call passes `--project-ref`.
- Fix: refuse when the file cannot be parsed, or also scan the raw text for the forbidden refs.

**L3 (low): `_shared/ai/crawl/runner.ts:73` sets `let last = null` on every call,** so a call's first fetch does not wait. The tick fires at a minute boundary, and the lease is released as soon as the previous call ends, so two requests can be about 1 s apart once per call. Fix: start `last` at `now()` (wait `delayMs` first), or store the last fetch time in `ai_crawl_state`.

**L4 (low): `380_ai_exclusions_crawl.sql:58` does not validate `ai_excluded_documents.source_type`.** If the Boss types `kb_articles`, the row is accepted and silently does nothing. Fix: `check (source_type = any(public.ai_source_canon()))`; `ai_source_canon` is immutable, so a check constraint can call it.

**L5 (low, test): `scripts/test-triggers.mjs:46-47` only excludes `ai_assistant_config`.** Once 382 is applied, its `ai_chunks_source_type` trigger makes the "exactly one ingest trigger" check fail. My rewritten test limits the check to source tables; the engineer's test should do the same.

## 4. Security findings

- Every service-only function in the package revokes EXECUTE from public, anon and authenticated, is SECURITY DEFINER with a pinned search_path, and keeps service_role. The two helpers `ai_source_canon` and `ai_is_test_source` are immutable, not definer, and read no table.
- The client-callable functions are `ai_run_ingestion` (the caller check comes before any work) and `ai_ingest_stats` (Boss or service only).
- Clients can write nothing a service role should own: the queue, crawl tables, `tts_articles`, `app_config` and the config are all covered. The ACL matrix is still 100 %.
- Secrets:
  - No secret appears in the migrations, functions, tests or logs.
  - The webhook secret lives in `app_config`, which only the Boss can read. `send_push_secret` follows the same pattern already.
  - The secret passes through `net.http_request_queue`. anon and authenticated have SQL-level grants on the `net` schema, but PostgREST exposes only `public` and `graphql_public`: a REST request to `net` returned PGRST106.
  - Both functions use one shared secret and compare it in constant time.
- Information: developers can run ingestion but cannot see `ai_ingest_stats` (Boss-only). The Phase 7 button will only show the call's result to them.

## 5. Error watch (dev)

- Queue: 1,927 `done`, 0 failed, 0 stuck, 0 pending.
- No run errors in the last 24 h.
- No failed pg_net responses.
- No `ai%` cron jobs today.
- The CLI's `.temp/linked-project.json` in Assistant holds the dev ref only.

## 6. Notes for the deploy

- 381 schedules `ai-tts-crawl-start` for **Saturday 23:00 GMT (Sunday 04:00 PKT, 2026-10-04)**. If the first crawl must be started by hand, start it before then, or unschedule the job until it has been run.
- The hourly `ai-ingest-sweep` at :05 will perform the first sweep by itself if nobody calls `ai_run_ingestion()` first. That is harmless, and the result is the same.
- `npx --yes supabase` is not pinned; 2.118.0 is the cached version.
- After the deploy, run `node scripts/db-dev.mjs sql tests/sql/store_health.sql`; after the first sweep and the config step it should report HEALTHY. The same suites also run post-deploy without `--mig`.
