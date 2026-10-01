# QA: Phase 2B acceptance test plan (ingestion worker), 2026-09-28

**Status: RUN on 2026-09-28/29.** Results: `qa/2026-09-28-phase2b-acceptance.md`.
Implemented in `tests/ingest/phase2b.test.mjs` (mode H),
`tests/ingest/phase2b-triggers.test.mjs` (374 inside a rolled-back
transaction), `tests/ingest/phase2b-concurrency.test.mjs` (mode C, T8),
`tests/ingest/t0-embed.test.mjs` (T0), `tests/sql/hold_state.sql`, and the
2B section of `tests/sql/grants.sql`.

## Revisions after the Owner's rules and the Lead's decisions (2026-09-28)

These override the matching expectations further down.

| # | Rule / decision | What changes in this plan |
|---|---|---|
| V1 | **Owner:** only `status='approved'` reports are indexed. Leaving approved → **soft delete** (hidden, vectors kept), due immediately. Re-approving unchanged text → 0 embeds. | T3: `submitted`/`verified` are *not indexable*. approved → submitted/verified/draft = soft delete (0 embeds, 0 chunk writes, hidden for everyone incl. Boss); → approved with same text = 0 embeds, 0 chunk writes, ≤ 1 document update. T5-A/T5-C: drafts **and** submitted/verified never enter the queue. T9-A: report candidates = approved rows only. Decision 3 resolved: soft. |
| V2 | **Owner:** report DATA tools read approved reports only (Phase 5). | `tests/eval/questions.jsonl`: every report `expected_sql` / `forbidden_sql` uses `r.status = 'approved'`; `unapproved_note` where the answer differs; values refreshed. |
| V3 | **Lead:** report status and incentive verified / paid live in metadata only. | F1 fixed by design; T3 and T11 check no chunk carries them. |
| V4 | **Lead:** `search.sql` fixtures use `public.ai_embed_model()` (the semantic arm filters to the active model, A§7). | Fixtures updated; new check: a vector of another model is never compared, the keyword arm still finds it. |
| V5 | **Incentives PROVISIONALLY indexed** (plan text + amounts; never achieved values, completion or basic salary), ACL mode `incentive` = `inc_select` (mig 213). Owner confirms at go/no-go. | T11-A/T11-D replaced: T11 now proves (a) `ai_can_read_document(incentive)` ≡ `inc_select` for every active viewer × every profile as target, (b) APC sees only their own plan; Boss, active OL and the `reports_to` manager see it; everyone else nothing (through `ai_search`), (c) 0 chunks with basic salary / achieved values (synthetic + in-memory scan of every real plan), (d) it can be switched off cleanly. R8 no longer lists `incentive*`. |
| V6 | **T10-A:** a re-import writes nothing to unchanged rows; the `last_seen_at` expectation is dropped. **T10-D** (retire after 3 missed crawls) moves to Phase 3. | T10-A expects 0 inserts / 0 updates on `tts_articles`; T10-D not run. |
| V7 | `grants.sql` covers the 2B functions: service-only (13), authenticated + admin check (`ai_backfill`, `ai_ingest_stats`), harmless constants (3); 374/375 functions absent on dev. | Added. |
| V8 | Decision 1 (no `indexed_at` touch) and Decision 4 (zombie guard: the write RPC checks the queue lock) were built as recommended; Decision 2: a pipeline bump re-extracts every document once and re-embeds only changed text. | T1, T4-A, T7-C expectations as recommended. |
| V9 | Decision 5 (T8 committed `qa_test` queue rows): allowed by the Lead as "queue rows you clean up". | T8 run. |

**The Owner's requirement, which every test below serves:**

> "No matter how many times we run the ingester, only new data must be
> processed; already-processed data must not be processed again, until the
> ingester or embedding rule changes."

## 0. What "processed" means (so it can be measured)

A run **processes** an item when it does any of these. Every test counts all three:

| Measure | How it is counted | Source |
|---|---|---|
| **OpenAI calls** | HTTP requests made by `embedTexts` | a counting `fetchImpl` (the embedder's existing test seam, `embedder.ts:23`) + `ai_ingest_runs.stats.embed_requests` (R6) |
| **Chunks embedded** | vectors requested | `ai_ingest_runs.embedded_chunks`, `embed_tokens` |
| **Rows rewritten** | inserts / updates / deletes on `ai_documents`, `ai_chunks` | `pg_stat_xact_user_tables` deltas (per-transaction counters) **and** `ctid` comparison (an UPDATE always makes a new tuple, even inside one transaction) |

Queue bookkeeping (`ai_ingest_queue.status`, `ai_ingest_runs`) is **not** a
rewrite: claiming and completing an item is expected on every run.

Helper used by most tests (runs inside the test's own transaction):

```sql
-- snapshot BEFORE the run under test
create temp table m0 on commit drop as
  select relname, n_tup_ins, n_tup_upd, n_tup_del
    from pg_stat_xact_user_tables where relname in ('ai_documents','ai_chunks');
create temp table s0 on commit drop as
  select 'doc' k, d.id, d.ctid::text c, d.doc_hash h, null::text e from ai_documents d where d.source_id like 'qa-%'
  union all
  select 'chunk', c.id, c.ctid::text, c.content_hash, c.embedding::text
    from ai_chunks c join ai_documents d on d.id = c.document_id where d.source_id like 'qa-%';

-- AFTER the run: rows written
select x.relname, x.n_tup_ins - m0.n_tup_ins ins, x.n_tup_upd - m0.n_tup_upd upd, x.n_tup_del - m0.n_tup_del del
  from pg_stat_xact_user_tables x join m0 using (relname);
-- AFTER the run: which rows physically changed
select s0.k, s0.id from s0
  left join ai_documents d on s0.k = 'doc'   and d.id = s0.id
  left join ai_chunks    c on s0.k = 'chunk' and c.id = s0.id
 where coalesce(d.ctid, c.ctid)::text is distinct from s0.c;
```

## 1. How every test respects the ingestion hold (TEAM rule 8)

State on dev today (read-only check, 2026-09-28): `ai_documents` 0,
`ai_chunks` 0, `ai_ingest_queue` 0, `tts_articles` 0, **no `ai%` cron job, no
trigger calling an `ai_*` function**. The suite must leave it that way.

| Mode | Used by | What it does | Why it is inside the hold |
|---|---|---|---|
| **R**: rolled-back SQL | SQL-level tests | `node scripts/db-dev.mjs sql tests/sql/ingest_*.sql`: one transaction, always rolled back, and the runner verifies it stayed open | Nothing commits. Only synthetic rows are written. |
| **H**: rolled-back harness | worker-level tests | `tests/ingest/*.test.mjs` drives the real worker core on **one** `pg` connection inside `BEGIN … ROLLBACK` (`set local role service_role`), with the **mock embedder** (real `embedTexts`, counting `fetchImpl`, deterministic unit vectors from `sha256(text)`) | Same as R. No OpenAI call except T0. The harness refuses to start if `ai_documents` has any committed row, and fails if its transaction ended early (the `db-dev.mjs` marker trick). |
| **C**: concurrency | T8 only | Two to four connections, each in its own rolled-back transaction. The shared input is `ai_ingest_queue` rows with `source_type='qa_test'`, **committed**, and deleted in `finally` | Commits touch only `ai_ingest_queue`, which rule 8 doesn't list; every `ai_documents`/`ai_chunks` write is rolled back. **Needs the Lead's OK** (it is a short committed write on dev). The pre-check `cron.job` has no `ai%` job guarantees nothing else claims those rows. |

Rules for synthetic data:
- **Pure synthetic** (`source_type='qa_test'`): a test-only extractor derives
  the text from `source_id` (e.g. `qa-conc-017` → seeded paragraphs), so there
  is no source table at all. Used wherever source-specific logic doesn't matter.
- **Synthetic rows in live source tables** (`reports`, `brands`,
  `kb_articles`, `ai_assistant_docs`, `tts_articles`): inserted **inside the
  rolled-back transaction**, every one marked (`qa-` ids, `QA Zq` names).
  Used only where the real extractor or trigger matters.
  - `reports` has 10 app triggers, `brands` 4, `kb_articles` 5: they fire
    inside the transaction and roll back with it. Some emit notifications,
    and dev's `send_push_url` points at prod (PROGRESS open issue #1).
    `pg_net` only sends committed requests, so nothing leaves dev. Each
    fixture still asserts that `net.http_request_queue` gained no rows
    **outside** the transaction.
- **Real rows are only ever read.** Real reports / KB / SOPs never go into
  `ai_documents`, not even in a rolled-back transaction (rule 8 allows only
  *synthetic* rows there). Where a test needs real-data coverage it counts
  (T9-A) or extracts in memory (T11-C).
- **T0 is the only real OpenAI call:** 3 synthetic strings, < 100 tokens,
  < $0.00001. Its only purpose is to prove the wiring; the vectors are not stored.
- The ingest **triggers** are created **inside** the rolled-back transaction
  (the harness executes the migration's SQL text), never committed on a live
  table. `CREATE TRIGGER` locks the table for the length of the transaction, so
  those tests keep their transactions short (< 10 s).

## 2. What Engineer B must build so these tests can run

| # | Requirement | Needed by |
|---|---|---|
| R1 | Worker core exported as a function (`runWorker({ db, embed, worker, budgetMs, claimBatch, now? })` or similar), with DB access and embedder **injected**. The Deno entrypoint is a thin wrapper around it. | all H tests |
| R2 | Every write goes through SQL RPCs (`ai_ingest_write`, `ai_ingest_delete`, the `acl` update) that the harness can call on its own connection | all H tests |
| R3 | An explicit `INGEST_PIPELINE_VERSION` that goes into `doc_hash` and is stored on the document (`metadata.pipeline_version` or a column), plus the chunk parameters (see F2) | T4 |
| R4 | `ai_backfill` split into `ai_backfill_candidates(p_type)` (read-only, set-returning) + the enqueue | T9-A without running a backfill |
| R5 | TikTok importer as a function taking a `pg` client (`importArticles(client, records)`), so the test can run it inside its transaction | T10 |
| R6 | `ai_ingest_runs.stats.embed_requests` (HTTP calls) alongside `embedded_chunks` | T1–T10 |
| R7 | Trigger SQL in its own migration file, so the harness can run it inside the transaction | T3, T5, T6, T10 |
| R8 | `ai_ingest_write` refuses a deny-list of source types (`incentive*`, `salary*`, `compensation*`, `attendance*`, `leave*`, `performance*`), defence in depth for A§4.4 | T11-D |

## 3. Problems the Phase 2A code already shows (fix before 2B testing)

These come from reading the committed-for-review code. Each one will make a
test below fail as the code stands.

| # | Sev | Where | Problem | Test that fails | Suggested fix |
|---|---|---|---|---|---|
| F1 | **High** | `extractors/report.ts:314` | The report header embeds `status: <status>`. The header is part of every chunk's `embed_text`, so submitted → verified → approved changes **every** chunk hash and re-embeds the whole report. That breaks the Owner's rule directly. | T3 | Drop status from the header. Keep it in `metadata` (and the ACL / filter), which is not embedded. |
| F2 | **High** | `hash.ts:23` (`docHash`) | `doc_hash` covers the extracted document + model, but not the chunker parameters, `TABLE_ROWS_PER_CHUNK`, `MAX_CHUNKS_PER_DOC`, `EMBED_MAX_TOKENS` or any pipeline version. The worker skips a document whose `doc_hash` matches (A§9.5), so **a chunking-rule change is never applied**: every document is skipped as unchanged. | T4-B | Include `INGEST_PIPELINE_VERSION` + `chunkParamsFor(type)` + those three constants in `doc_hash` (R3). |
| F3 | Medium | A§9.5 "touch indexed_at" | On an unchanged document the design updates `indexed_at`. That rewrites every document row on every re-run and breaks "0 rows rewritten". | T1 | Don't touch the row; count the item in `ai_ingest_runs.skipped_unchanged` only. |
| F4 | Medium | A§9.5 `toEmbed = chunks where hash ∉ old hashes at same index` | Reuse is bound to `chunk_index`. A new section or row early in a report shifts every later index, so all later, **unchanged** chunks are re-embedded. | T2-C | Reuse any old vector whose `content_hash` matches, whatever its index. |
| F5 | Low | `extractors/tts.ts:81` (`views`), `report.ts:360` (`author_name`) | Volatile metadata is inside `doc_hash`. A re-crawl that only changes view counts, or a profile rename, rewrites the document row (no embed). | T10-B, T1 | Keep `views` / `author_name` out of the hash (or out of metadata). |
| F6 | Medium | TikTok crawl file | `data/tts-academy/articles.jsonl`: 1,201 records, 1,094 ids, **97 ids repeated, 88 of them with different content**. An importer that keeps "the last one seen" can flip-flop between versions across runs, and each flip re-embeds. | T10-C | The importer picks a deterministic winner per id (e.g. latest `modified_at`, then longest text) and documents it. |
| F7 | Medium | ACL fast path (A§3.3, §9.5) | If the `acl` op updates the ACL columns but not `doc_hash`, the next backfill sees a hash mismatch and rewrites the document. | T5-D | The `acl` path recomputes and stores `doc_hash`. |

Not a problem: KB visibility lives in `metadata` and `acl_*`, not in the
embedded text, so a visibility change re-embeds nothing.

## 4. Tests

Each test lists its mode, steps, expected result, and the hold note when it
differs from §1. "Harness corpus" = 6 `qa_test` docs (1 chunk; 3 prose chunks;
a 13-row table; a 45-chunk doc to hit the 40 cap; an empty doc; a unicode /
HTML doc) + one synthetic row per real source type: weekly-single,
weekly-legacy, biweekly, monthly and generic reports on brand `QA Zq Brand`, a
KB article with body, a link-only KB article, a KB article with a linked SOP,
a curated `ai_doc`, an `app_guide`, a `tts_article` (`qa-tts-*`).

### T0. Embedder wiring (the only real OpenAI call)
- Mode: script. `embedTexts(['qa one','qa two','qa three'], {apiKey})`.
- Expect: 1 request, 3 vectors of 1536 dims, usage < 100 tokens. Nothing written.

### T1. Re-run with no changes → nothing processed
- Mode H. Enqueue the whole harness corpus, run the worker until the queue is
  empty (run 1). Snapshot (§0). Enqueue everything again with
  `reason='backfill'` and run (run 2). Then run 3 the same way.
- Expect for runs 2 and 3:
  - OpenAI calls **0**; `embedded_chunks` **0**; `embed_tokens` **0**
  - `ai_documents` and `ai_chunks`: ins / upd / del deltas **0 / 0 / 0**, and
    **no** row's `ctid` changed (F3)
  - `ai_ingest_runs.skipped_unchanged` = number of documents; `succeeded` = claimed; `failed` 0
  - every queue item `done`; `ai_search` returns the same chunk ids and scores as after run 1
- Also for run 1: `chunk_count` equals the actual chunk rows per document, and
  there are no duplicate `(document_id, chunk_index)`.

### T2. One edited insight → exactly one chunk re-embedded
- Mode H, with triggers (R7) inside the transaction.
- **T2-A:** weekly-legacy report: change the text of `topCreatorsInsights` only.
  Expect: 1 OpenAI call with **exactly 1 input**; `embedded_chunks = 1`; exactly
  one `ai_chunks` row changed `ctid` (section `insights:creators`); one
  `ai_documents` update (`doc_hash`); `chunk_count` unchanged; every other chunk's
  `embedding::text` identical to the snapshot.
- **T2-B:** edit one paragraph inside a prose section that spans 3 chunks.
  Expect: re-embedded = the number of chunks whose `content_hash` changed. The
  test computes that number by running `chunkDocument` before and after, in
  memory. It must be ≥ 1, at most the section's chunk count (the overlap can
  carry the edit into the next chunk), and 0 outside that section.
- **T2-C:** fill a previously empty `operationalUpdates` (a new section ahead of
  the tables, so later `chunk_index` values shift). Expect **1** chunk embedded:
  the new one. Every shifted chunk keeps its vector (F4).
- **T2-D (debounce):** 10 updates to the same report within the transaction.
  Expect 1 pending queue row, `not_before` = last update + 180 s, and 1 worker
  pass (after moving `not_before` into the past in SQL).

### T3. Status-only change → no re-embed
- Mode H + triggers. Report `submitted → verified → approved`, text unchanged.
- Expect per transition: OpenAI calls **0**, `ai_chunks` changes **0**.
  `ai_documents`: at most 1 update (metadata `status`). **Fails today (F1).**
- Also `approved → submitted` (reopened): same result.

### T4. Pipeline / rule / model version bump → everything once, then idempotent
- Mode H.
- **T4-A pipeline version** (`INGEST_PIPELINE_VERSION` 1 → 2, same code output):
  - Expect run 1 after the bump: every document re-extracted once
    (`succeeded` = all docs, each `ai_documents` row updated once with the new
    version), chunks re-embedded = those whose `embed_text` changed, which is **0**
    when the bump changed no text. (If the Lead wants the version inside
    `content_hash`, the expectation becomes "every chunk once". See Decision 2.)
  - Run 2: T1 expectations (0 / 0 / 0).
- **T4-B chunking rule** (report `target` 450 → 400, no manual version bump):
  - Expect: the change is **detected** (reports re-chunked). Re-embedded = the
    chunks whose `embed_text` changed; non-report documents untouched. Run 2 = T1.
  - **Fails today (F2):** `doc_hash` matches, so nothing is re-chunked.
- **T4-C embedding model** (`EMBED_MODEL` → a mock `qa-embed-v2`):
  - Expect: every chunk re-embedded **exactly once**, in
    `ceil(chunks / 96)` requests (the batch limit); `embedding_model` = the new
    model on every row. Run 2 = T1.
  - A§7 says search reads only the active model's chunks. Check that
    `ai_search` returns no chunk of the old model mid-migration.
- **T4-D reconciler model drift budget:** with a budget of k per night,
  `ai_reconcile()` enqueues exactly k documents per call. After ⌈N/k⌉ calls
  plus worker runs, 0 remain and further calls enqueue 0.

### T5. Deletes, drafts and ACL-only changes → no re-embed
- Mode H + triggers.
- **T5-A report → draft:**
  - Expect: a delete op (priority 1, no debounce); after the worker, the
    document is not returned by `ai_search` for anyone, including the Boss.
    OpenAI calls 0.
  - Then draft → submitted with identical text. Expect **0** OpenAI calls if a
    draft is a soft delete (`status='deleted'`, chunks kept). If the design
    hard-deletes, the document's chunks are embedded again (see Decision 3).
- **T5-B source row DELETE:**
  - Expect: the `ai_documents` row is gone and its chunks cascade (0 rows left
    for that `source_id`). 0 OpenAI calls. A re-run does nothing.
- **T5-C drafts never enter:**
  - Insert a draft report and autosave it 10×. Expect **0** queue rows, 0
    worker work.
- **T5-D KB visibility `office → role {ol}` (ACL only):**
  - Expect: one `acl` queue row at priority 0 with no debounce. The worker
    makes 0 OpenAI calls, 0 `ai_chunks` writes, 1 `ai_documents` update
    (`acl_roles`, `metadata.visibility`, and `doc_hash`, see F7).
  - `ai_search` as an APC stops returning it immediately after the worker.
  - Then a full re-enqueue + run: 0 / 0 / 0 (F7).
- **T5-E KB approval revoked:** delete path, 0 OpenAI calls.
- **T5-F SOP link moved** (`ai_assistant_docs.kb_article_id` A → B):
  - Expect: only the chunks of A's and B's documents whose text changed are
    re-embedded (A loses a section, B gains one). No other document is touched.
- **T5-G brand reassigned (`owner_id`) or a user's role changed:**
  - Expect **0** queue rows (the ACL is evaluated live, A§9.2).
  - The ACL matrix (T12) reflects the change without any worker run.

### T6. Brand rename → only the headers change
- Mode H + triggers. Rename `QA Zq Brand` → `QA Zq Brand Renamed`; separately
  change `client_name`.
- Expect:
  - the cascade enqueues every report of that brand at priority 8, and nothing else;
  - re-embedded chunks = **all chunks of that brand's documents and no other**
    (the brand is in the embedded header by design, P2-10);
  - for every re-embedded chunk, line 1 (the header) differs only by the name,
    and **everything after line 1 is byte-identical** to before;
  - `title` / `metadata.brand_name` updated;
  - no document of another brand changes `ctid`;
  - run 2 = T1.
- Also: `update brands set brand_name = brand_name` (a no-op) → 0 queue rows.

### T7. Crash mid-batch → resume without duplicates
- Mode H.
- **T7-A process death:**
  - Setup: 20 `qa_test` items. The harness aborts the worker after item 7 was
    written and item 8 was embedded but not written.
  - State after the abort: items 1–7 `done`, 8–20 `processing`. The test then
    moves `locked_at` 11 minutes into the past and runs the worker again.
  - Expect:
    - 20 documents exactly, and no unique violation on `(document_id, chunk_index)`;
    - `chunk_count` equals the rows for every document;
    - run 2 embeds only the chunks of items 8–20 (item 8 a second time, which
      is the lost work; items 1–7 never again);
    - `attempts` = 2 on items 8–20, and none `failed`.
- **T7-B crash inside the write:**
  - Setup: a test trigger makes `ai_ingest_write` raise for one document.
  - Expect: **no partial rows** for that document (the write is atomic), and
    the item goes back to `pending` with a 1-minute backoff (`ai_ingest_fail`).
    The other items complete.
- **T7-C zombie worker:**
  - Setup: worker A's lock expires, B reclaims the item and writes the newer
    version, then A finishes late.
  - Expect: `ai_ingest_complete(id, 'A')` returns false (mig 372 L2), **and A's
    stale write does not overwrite B's document.** Today nothing in the write
    path checks this. See Decision 4.
- **T7-D poison item:** 5 failures → `failed`, visible in `ai_ingest_stats()`.
  Other items unaffected.

### T8. Concurrent workers
- Mode C (needs the Lead's OK, §1).
- Setup: commit 60 `qa_test` queue rows. Start 2 workers, then 4, on separate
  connections at the same moment, `CLAIM_BATCH=20`.
- Expect:
  - the claimed ids are **disjoint** and their union is all 60 (`SKIP LOCKED`);
  - each worker embeds only its own items (total OpenAI inputs = total chunks, once);
  - no deadlock, lock timeout or unique violation.
- **T8-B same source twice** (mode R, one transaction): two `ai_ingest_write`
  calls for the same `(source_type, source_id)`. Expect 1 document, and its
  chunks = the second call's.
- Cleanup: `delete from ai_ingest_queue where source_type = 'qa_test'` in
  `finally`, then assert 0 `qa_test` rows remain and `ai_documents` is still 0.

### T9. Backfill run twice
- **T9-A real candidates, counts only** (mode R, read-only; uses R4):
  - Run `ai_backfill_candidates()` twice. Expect identical counts per source
    type, equal to the indexable rows:
    - reports with status submitted / verified / approved;
    - KB articles that are approved and the latest version;
    - active `ai_doc` rows that aren't imported SOPs waiting for a link (D9);
    - active TikTok articles;
    - no drafts, no superseded versions, no inactive rows.
  - Nothing is enqueued and nothing is processed. If R4 isn't built, this
    needs the Lead to confirm that calling `ai_backfill()` in a rolled-back
    transaction (enqueue only, no worker) is within the hold.
- **T9-B synthetic, end to end** (mode H):
  - Backfill → drain → backfill → drain. Expect the second backfill adds 0
    new pending rows beyond one per document (collapse on the unique pending
    index), and the second drain = T1 (0 / 0 / 0, `skipped_unchanged` = all).
  - A live priority-5 item enqueued after the backfill is claimed before any
    priority-9 item.

### T10. TikTok import run twice
- Mode H with the importer (R5) and the `tts_articles` trigger (R7).
- Input: `__tests__/fixtures/tts-sample.json`, remapped to synthetic ids
  (`qa-tts-<n>`) and titles (`QA …`). The real crawl is never imported (rule 8).
- **T10-A same file twice:**
  - Expect import 2: 0 inserts, 0 `content_hash` changes, only `last_seen_at`
    updated, **0 queue rows**, and the worker then does 0 work.
- **T10-B one body changed:**
  - Expect 1 queue row, and only that article's changed chunks re-embedded.
  - A change to `views` only → 0 queue rows, and the document row is not
    rewritten (F5).
- **T10-C duplicate ids with different content** (F6):
  - Build a fixture with 3 records sharing one id, with different text, in two
    different orders. Import each order twice.
  - Expect the same stored `content_hash` in every case, and 0 queue rows after
    the first import.
- **T10-D missed articles:** an article absent from 3 consecutive imports gets
  `is_active=false` → a delete op → gone from search. 0 OpenAI calls.

### T11. Incentive documents respect the app's incentive RLS
The app's rule (latest: mig 213, `inc_select`): a row is visible to the person
themselves, the Boss, active OLs, and the person's direct manager
(`reports_to`). **Developers are excluded** (demoted in 213); mig 033 had
included them.

- **T11-A never indexed:**
  - Expect `select distinct source_type from ai_documents` and the extractor
    registry (`extractors/index.ts`) to contain nothing sourced from
    `incentives`, `employee_compensation`, `salary_history`,
    `performance_*`, `attendance`, `leave_requests` (A§4.4).
- **T11-B guides about pay** (mode H: synthetic copies of the real
  `app-guides/incentives.md`, `incentive-plan-editor.md`, `salaries.md`,
  `my-compensation.md`, `performance.md`, `performance-simulator.md`,
  frontmatter kept):
  - Expect `acl_mode='roles'` with `acl_roles` = the frontmatter roles.
  - **`developer` is absent from the incentives and performance guides**
    (matches 213; true today for `incentives.md`).
  - `salaries.md` has `{boss}` only.
  - `ai_search` as a developer returns none of them; as an APC, only the
    guides listing `apc`.
  - Static check: each guide's roles ⊆ the roles the route allows in
    `..\src\App.jsx` (read-only).
- **T11-C leak scan** (read-only, in memory, counts only):
  - Run the real extractors over every indexable real source row, in memory
    (no writes).
  - Expect **0** chunks containing any `incentives.incentives[].text` /
    `bonuses[].text` string (plan items can be personal), and **0** chunks where
    a staff `display_name` appears within 80 characters of that person's
    `basic_salary` or incentive amount.
  - The values stay in memory and only counts are printed (TEAM rule 6).
- **T11-D a per-person incentive document can't be made readable:**
  - Expect `ai_ingest_write` with `source_type='incentive_plan'` to raise (R8).
  - Why: no `acl_mode` can express `inc_select`. `boss` + `{ol}` misses self
    and manager; `roles` would expose it to a whole role. So such documents
    must not exist.
  - Matrix proof (mode R): for synthetic documents in each mode, and every
    active dev user `u` against a target person `t`, `ai_can_read_document(d,
    u, role(u))` must never be true where `inc_select` for `(u, t)` is false.

### T12. ACL matrix at 100 % with real document types
- `tests/sql/acl.sql` must stay **40 / 40**, unchanged.
- New `tests/ingest/acl-real.test.mjs` (mode H). The documents are produced by
  the **real extractors and write RPC** from synthetic source rows, not by
  hand-written ACL rows.

| Document (synthetic source) | boss | ol | tl* | apc | developer | service as apc | apc spoofing boss |
|---|---|---|---|---|---|---|---|
| weekly report, brand visible to the APC | ✓ | ✓ | – | ✓ | – | ✓ | ✓ |
| monthly report, brand hidden from the APC | ✓ | ✓ | – | – | – | – | – |
| KB `office` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| KB `role {tl}` | ✓ | ✓ | ✓ | – | ✓ | – | – |
| KB `users {apc}` | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ |
| KB `private` / NULL visibility | ✓ | ✓ | – | – | ✓ | – | – |
| KB `role {ol}` with a **linked SOP** (D9/D11): one merged document | ✓ | ✓ | – | – | ✓ | – | – |
| imported SOP with **no** KB link | not indexed at all (0 documents) | | | | | | |
| curated `ai_doc` (not imported) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `app_guide` roles `{ol}` | ✓ | ✓ | – | – | – | – | – |
| `tts_article` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

\* a TL who is not the owner of either brand, as in `acl.sql`. The OL and
developer KB overrides follow mig 134 / `ai_can_read_document` (mig 372).

- Expect: every cell matches, **0 leaks, 0 missing**, and the linked SOP's text
  is findable only through the KB document.

## 5. Order and exit criteria

Run order: T0 → T1 → T2 → T3 → T5 → T6 → T12 → T11 → T4 → T7 → T9 → T10 → T8.
T8 needs the Lead's OK first.

Phase 2B passes QA when:
- every test above passes;
- F1–F7 are fixed, or the Owner / Lead explicitly accepts one;
- the existing suites still pass: `npm test`, and `sql:acl` / `sql:queue` /
  `sql:grants` / `sql:search` / `sql:v1compat`;
- dev still shows 0 rows in `ai_documents` / `ai_chunks` / `tts_articles`, 0
  `qa_test` queue rows and no `ai%` cron job afterwards (the hold held).

## 6. Decisions this plan needs (Owner / Lead)

1. **"0 rows rewritten" on a no-change re-run** means no `indexed_at` touch (F3).
   Recommend: yes, as the Owner's wording implies.
2. **Does a pipeline-version bump re-embed everything, or only chunks whose
   text changed?**
   - Recommend: only changed text. The version goes into `doc_hash`, not
     `content_hash`.
   - A full re-embed costs about $0.07 today (PROGRESS: 3.69M tokens), so
     either choice is cheap. But "only changed" is what the Owner asked for.
3. **Draft / unapprove = soft delete (keep vectors, hide from search) or hard
   delete?**
   - Recommend: soft for draft / unapproved (re-publishing costs 0 embeds),
     hard for a real source DELETE.
4. **Zombie-worker guard (T7-C):** should `ai_ingest_write` take the worker id
   and refuse when the queue item is no longer held by it?
   - Recommend yes. Otherwise a slow worker can overwrite a newer index entry
     with an older one.
5. **T8 committed `qa_test` queue rows on dev:** OK to run?
