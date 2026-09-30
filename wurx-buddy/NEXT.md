# Resume point: read this first on "continue"

## ✅ 2026-09-29 23:35: AUTO-INGESTION DEPLOYED ON DEV
- Functions `ai-ingest` + `tts-crawl` are live (401 without the secret).
- 379, 380, 374, 375, 381 are applied, and 5 cron jobs are active.
- The first manual sweep queued 1 item (the testing-doc soft delete); drained with HTTP 200 and 0 failures.
- The next auto sweep is due 2026-09-30 11:33 PKT.
- The first TikTok crawl was started manually at 23:36 (36/1,032 pages after 3 min, 0 errors).
- Engineer 3 resumed on 382 latency + small fixes.
- **Next:** 382 decision → QA full 158-question eval of v2.

## ▶ 2026-09-29 23:20: resumed. QA's pre-deploy check restarted first; Engineer 3's latency work waits until QA finishes (clean benchmarks).

## ⏸ (2026-09-29, evening): agents stopped by the account usage limit (resets 11:10 pm PKT)
Committed up to `d4ff71e`: WP-A retrieval, WP-B data tools (+ wording fix), WP-D the
Buddy agent core (live smoke 6/6 grounded), migrations 378 and 383 applied to dev.
379–381 / 374 / 375 are written and committed but **NOT applied or deployed**.
Interrupted mid-task, **partial work uncommitted on disk; don't discard it**:
1. **QA pre-deploy acceptance** of auto-ingestion (379/380/381/374/375 + `deploy-dev.ps1`).
   - Partial edits: `tests/sql/{grants,sources}.sql`, `tests/ingest/phase2b*.test.mjs`,
     deleted `tests/sql/hold_state.sql`, new `tests/sql/{autoingest,store_health}.sql`,
     `tests/run-with-migrations.mjs`.
   - Resume: re-dispatch assistant-qa with the same brief (verdict DEPLOY-READY / NOT READY → `qa/2026-09-29-autoingest-predeploy.md`).
2. **Engineer 3: search latency.** Partial: `supabase/migrations/382_ai_corpus_indexes.sql`
   (NOT applied) and `scripts/bench-search.mjs`.
   - Resume: per-corpus partial HNSW + a halfvec evaluation, measured before/after; recall must not regress; apply only with the Lead's approval.
Then: the Lead deploys auto-ingestion to DEV (`scripts/deploy-dev.ps1`; the CLI is logged in;
**production is off-limits**, TEAM.md rule 0) → the first manual sweep and crawl → QA runs the full
158-question eval on v2 (`serve-assistant.mjs` + `run-eval --engine v2`; exempt the eval user from the rate limit on dev).
The Owner is making an animated Buddy logo (4 states: idle, thinking, happy, calm) for the UI phase.

_Updated by the Lead, 2026-09-29._

## Where we are
- Phases 1 and 2 (store, search, ingester) are built and committed. QA's final
  verdict is **GO-READY** (`cc96ced`): phase2b 122/122, triggers 33/33,
  concurrency 12/12, grants 251/0, acl with 0 leaks, npm test 80/80.
- **Pre-ingestion backup:** tag `backup/20260929-pre-ingestion` plus the export in
  `backups/20260929-pre-ingestion/` (the vector store is empty; 133 SOP↔KB links saved).
- Dev migrations: 367–373, 376, 377. **374 (triggers) and 375 (cron) are NOT applied.**
- `ingest_sources` is **Boss-only** (Owner). There is no developer RPC; 378 was withdrawn and cleaned from dev.
- **FIRST INGESTION DONE (dev, 2026-09-29, Owner's go):**
  - 1,927 documents (583 approved reports, 149 KB+SOP, 6 docs, 1,070 TikTok, 119 incentive plans) / 11,556 chunks, 0 failures, ≈ $0.07.
  - Verified: the re-run embeds 0, the backfill queues `{}`, the TikTok re-import writes 0, and all security suites pass.
  - Real search as Boss/APC works. **APC visibility:** 30/583 reports, 2/119 incentive plans (their own), 131/149 KB, all TikTok.
- **Retrieval finding for Phase 5:** raw `ai_search` is dominated by the large
  TikTok corpus. "our SOP on approving sample requests" returned only TikTok
  articles, and "which brands had strong GMV Max results" returned TikTok, not
  reports. The Phase 5 `search_knowledge` tool must be **source-aware**: search
  SOP/KB, reports and TikTok separately and merge them, apply source filters when
  the question says "our SOP", "our brands", etc., diversify ≤3 chunks per doc,
  and route data questions to the report tools. The eval will measure it.

## The ingestion checklist (run only after the Owner says go)
From `C:\Users\Umar Ilyas\WurxOS\Assistant`:
1. `node --experimental-strip-types scripts/import-tts.mjs --apply --owner-approved` (1,070 TikTok rows, $0)
2. `node --experimental-strip-types scripts/ingest.mjs --dry-run` (expect 1,927 docs / 11,556 chunks)
3. `node --experimental-strip-types scripts/ingest.mjs --backfill --owner-approved` (queues only what's missing)
4. Optional trial: `… scripts/ingest.mjs --drain --owner-approved --limit 50`, then the full `--drain --owner-approved`
   (~15–35 min, ≈ $0.07)
5. Verify: `--dry-run` shows everything unchanged and 0 to embed; `--backfill` queues `{}`; run the `npm run sql:*` suites.

Apply the Owner's choices before step 3:
- **incentives** on/off (Boss: `update ai_assistant_config set ingest_sources = array_remove(ingest_sources,'incentive') where id=1`);
- **app guides** (not synced yet, so they're excluded unless the Owner says ingest the drafts).

## Waiting on the Owner
1. Their ingestion **conditions**.
2. Incentives: plans with amounts / without amounts / off.
3. App guides: wait for review / ingest the drafts.
4. The 50-doc trial first: yes/no.
5. (Non-blocking) QA's data questions; permission for the read-only listing of the ~6 old curated docs.

## ⚠ Owner reminder
Before ANY UI or integration work: **remind the Owner.** They have UI changes in
mind and want to give them first (said 2026-09-29).

## After ingestion
- **M1:** make `ai_source_types()` ignore unknown names (or add a CHECK) → `tests/sql/sources.sql` goes green. Required before 375.
- L6: add an idle-in-transaction timeout to `scripts/test-ingest.mjs` and `test-triggers.mjs`.
- Separate go-aheads: apply 374 (live triggers), then deploy `ai-ingest` + 375 (cron).
- Phase 0 leftover: the v1 baseline eval needs ai-chat deployed to dev (the Owner's `supabase login`).
- Speed up QA: move the heavy DB tests server-side (1 call instead of thousands of round trips).
- Phase 3 (the tts-crawl edge function), Phase 4 (app-guide review with the Owner), Phase 5 (assistant v2 agent + tools, approved-only report tools).
