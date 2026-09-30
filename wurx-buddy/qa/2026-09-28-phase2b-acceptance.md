# QA: Phase 2B acceptance round (ingester), 2026-09-28/29

> **Superseded by §9 (re-check, 2026-09-29): GO-READY.** B1 and B2 are fixed by mig 377. One
> medium follow-up (M1) should be fixed before the nightly cron (375) is switched on.

**Verdict: NOT READY.** Two small blockers, both in the incentive and deny-list area. The
Owner's core rule ("only new data is processed") passes on every test.

1. **B1.** The deny-list is anchored, so `employee_compensation` gets through.
2. **B2.** Incentives cannot be switched off cleanly.

Both fit in one small migration plus a few lines of TypeScript. After the fix, re-running
`tests/ingest/phase2b.test.mjs` (sections R8 and T11-OFF) is enough to turn this into
GO-READY. Everything else passes. The hold held.

Plan: `qa/2026-09-28-phase2b-test-plan.md`. Its new "Revisions" table records the Owner
and Lead rules V1–V9 that this round tested against.

## 1. What was run (independently of the engineer's numbers)

| Suite | Result |
|---|---|
| `tests/ingest/phase2b.test.mjs` (new; real worker, extractors, chunker, write RPCs; real `embedTexts` batching with a counting fake endpoint; one rolled-back transaction) | **97 / 98**. The only FAIL is B1. Run time about 13 min: dev latency is high on this link. |
| `tests/ingest/phase2b-triggers.test.mjs` (new; mig 374 executed inside a rolled-back transaction, triggers → queue → worker end to end) | **27 / 27** |
| `tests/ingest/phase2b-concurrency.test.mjs` (new; T8 mode C: 60 committed `qa_test` queue rows, 2 then 4 workers on separate connections, deleted in `finally`) | **12 / 12** |
| `tests/ingest/t0-embed.test.mjs` (T0: the one real OpenAI call, 3 strings, 6 tokens) | ok (1536 dims, unit norm, 1 batch) |
| `tests/sql/grants.sql` (extended with the 2B functions) | **237 / 0 / 0**, PASS |
| `tests/sql/search.sql` (fixtures now use `ai_embed_model()`; new A§7 check) | **39 / 0**, 1 WARN (the documented period WARN), PASS. It was 5 FAIL before the fixture fix. |
| `acl.sql` / `queue.sql` / `v1compat.sql` | PASS (ACL 0 leaks, 0 missing; direct access denied; queue 80/0; v1 6/0) |
| `tests/sql/hold_state.sql` (new) | HOLD: INTACT, 9/9 (before and after the round) |
| `npm test` | 79 / 79 |
| `tests/eval/grade.test.mjs` | 10 / 10 |
| Engineer's `scripts/test-triggers.mjs` / `scripts/test-ingest.mjs --no-real` | 33 / 33 and 36 / 36. The Lead had already confirmed 38 / 38 with the real call. |
| `scripts/ingest.mjs --dry-run` | See §3 |
| `scripts/import-tts.mjs` (dry run) | 1,201 records → 1,094 ids (97 repeated, one winner each), 24 without text skipped, **1,070 would be inserted**, nothing written. `--apply` without `--owner-approved` is refused (exit 2); so are `ingest.mjs --backfill` and `--drain`. |

## 2. The Owner's rule, test by test (all mode H unless noted)

| Test | Evidence |
|---|---|
| **T1**: run 2 and run 3 on a 28-item corpus (24 indexed: 6 synthetic `qa_test` docs, including a 45-chunk one capped at 40, an empty one and a unicode one; every report layout; KB office / role / users / private / linked SOP; curated doc; 2 guides; 2 TikTok articles; 1 incentive) | Run 1: 102 chunks, each embedded exactly once, in 2 requests (max 52 inputs). Runs 2 and 3: **0 HTTP requests, 0 embedded, 0 tokens; `ai_documents` / `ai_chunks` ins/upd/del 0/0/0; 0 ctids moved**; skipped_unchanged 24, noop 4; `ai_search` returns the same chunk ids and scores. `ai_ingest_runs` records claimed / embedded / `stats.embed_requests`. |
| **T2-A**: one insight edited | 1 request with **1 input**; 1 chunk row + 1 document row updated; the changed chunk is `insights:overall`; every other vector identical. |
| **T2-B**: one paragraph in a 3-chunk section | Embeds = hashes changed per an in-memory `chunkDocument` (1). |
| **T2-C**: a new section shifts 7 later chunks | **1** embed; the shifted chunks keep their vectors (F4 fixed). |
| **T2-D**: 10 autosaves while approved (triggers) | 1 pending row, due +180 s; one pass embeds exactly 1 chunk. |
| **T3**: approved → submitted → verified → approved (V1) | Soft delete, hidden from everyone including the Boss. **0 requests, 0 chunk writes**; submitted → verified is a noop. Re-approval: **0 requests, 0 chunk writes, 1 document update, identical vectors**. Draft → edit → approve embeds only the edited chunk. Status is in metadata only. |
| **T4-A**: pipeline bump | Every active document reprocessed once (23), **0 requests**, then idempotent. The salt includes the chunk parameters (F2 fixed). |
| **T4-C**: model change | Every distinct chunk text re-embedded **exactly once** (102), ≤ 96 per request; every chunk carries the new model; run 2 idempotent. `search.sql`: an old-model vector is never compared, while the keyword arm still finds the chunk. |
| **T4-D**: reconcile budget 2 over 7 drifted TikTok docs | Enqueued per call: 2, 2, 2, 1, 0. |
| **T5**: DELETE, KB ACL, approval revoke, SOP link move | DELETE: hard delete with cascade, 0 requests. KB office → role {ol}: 0 requests, 0 chunk writes, 1 document update; the APC loses the doc at once; a full re-run afterwards is 0/0/0 (F7 fixed). Approval revoked / restored: soft delete, then 0 embeds. SOP A → B: only those 2 documents rewritten; the text is now reachable only under B. |
| **T6**: brand rename | Exactly the brand's 4 approved reports re-embedded (31 chunks). **Header line differs only by the name; every later line is byte-identical.** No other document was touched; run 2 did nothing. With triggers: exactly the 2 approved reports plus the incentive naming the brand at p8, not the submitted report. A no-op rename enqueues 0. |
| **T5-C / T5-G** (triggers) | A draft plus 10 autosaves, submitted or verified: 0 queue rows. Stars / `updated_at`, role change, profile rename: 0. The brand owner change is blocked by the app itself. |
| **T7-A**: crash after 7 of 20 writes | 7 done, 13 processing. After lock expiry: 20 documents; the 13 unwritten items embedded once more; the 7 written ones never again; attempts 1 / 2. |
| **T7-B**: raise inside the write | No partial rows; the item is back to pending with a 60 s backoff; the other item completes. |
| **T7-C**: zombie worker | A's late write gets `{ok:false, reason:'lost_lock'}`, `complete` returns false, and B's newer document is kept. |
| **T7-D**: poison item | `failed` after 5 attempts and listed by `ai_ingest_stats()`. |
| **T8** (mode C) | 2 workers (40 / 20) and 4 workers (20 / 20 / 0 / 20): claims disjoint, union = 60, 60 embeds total, no deadlock, lock timeout or unique violation. **T8-B**: the same source written twice gives 1 document holding the second call's chunks. |
| **T9-A**: real candidates, read-only, twice | Identical both times and equal to independent counts: report 583 (all approved; the 41 non-approved excluded), KB 149, ai_doc 6, app_guide 0, TikTok 0, incentive 119. 0 queue rows. |
| **T9-B**: backfill twice | `{}` `{}`. After one article changes: `{"changed":1}` then `{}`. A live p5 item is claimed before p9. The drain embeds only the new chunk. |
| **T10**: TikTok (V6) | Re-import (reordered, views changed): **0 inserts, 0 updates** on `tts_articles`, 0 queue rows. A duplicate id in 4 orders gives the same `content_hash`. **The real crawl in 8 random orders (in memory) gives identical hashes for all 1,070 articles** (F6 fixed; the comparator is total in practice). One body change embeds 1 chunk. T10-D moves to Phase 3. |

## 3. Dry-run totals (confirmed)

- `ingest.mjs --dry-run --tts-jsonl data/tts-academy/articles.jsonl` gives **1,927 documents / 11,556 chunks / 3,394,856 tokens ≈ $0.0679**, matching the engineer's figures.
  - Those totals include the crawl as if it were imported.
  - Without the crawl (dev as it stands): 857 documents / 6,465 chunks / $0.0211.
- Reports: 624 rows, of which **583 are indexable (approved)** and **41 are excluded** (every non-approved report).
- SQL and TypeScript `indexable()` disagreements: 0 for every type.
- Backfill would enqueue only `upsert:missing`.
- Note: dev holds **0 `app_guide` rows** (the guides are not synced yet), so the estimate excludes them.

## 4. Security

- **Non-admins cannot reach the write or backfill paths.**
  - All 13 service-only 2B functions deny PUBLIC, anon and authenticated. The behavioural check as the Boss's JWT gives `permission denied` for every one.
  - `ai_backfill` and `ai_ingest_stats` are callable by authenticated users, but the first statement is the `ai_is_service_or_admin()` check (`is_ai_admin` = `is_boss`). Anon cannot call them.
  - The 3 constants are not SECURITY DEFINER and read no table.
  - No other `ai_*` function is executable by authenticated.
  - Every SECURITY DEFINER function has a pinned `search_path`.
  - The 6 trigger functions of 374 are definer, pinned and service-only.
  - Limitation: `ai_is_service_or_admin()` trusts `session_user = 'postgres'`, and the test runner's session is `postgres`. So the non-admin denial *inside* `ai_backfill` can only be shown by code reading. A PostgREST client's `session_user` is `authenticator`.
- **Incentive text cannot leak to an unrelated APC or TL.**
  - `ai_can_read_document(…, 'incentive')` equals the live `inc_select` policy for **33 active viewers × 33 targets (1,089 pairs, 0 differences)**, including inactive targets.
  - Through `ai_search` (keyword arm, real extractor document): the APC sees own plan; the Boss, OL and `reports_to` manager see it; another APC, another TL and the developer see nothing. Also denied: the service relay `p_as_user = other APC` and an APC passing `p_as_user = boss`.
  - The full 11-document ACL matrix × 9 callers: 0 leaks, 0 missing.
- **No basic salary or achieved values in any chunk.**
  - Synthetic plan: basic 7,777,777.77, achieved 987,654,321 / 55,555 / 3,333,333, commission amount 4,444,444. None of these appears in any chunk or in metadata.
  - Every real plan (119, in memory, counts only): 0 chunks contain the person's `incentives.basic_salary` or `employee_compensation.basic_salary`; 0 payloads carry `achievedValue` / `completed*`; 0 chunks mention achieved or completed.
  - Progress, verified and paid together: 0 requests, 0 chunk writes, 1 document update.
- **The deny-list is not sound (B1).**
- The unlinked imported SOP produces 0 documents and nobody can find its text.
- Secrets: T0 reads the key from `../.env.dev` and prints none. `refresh-expected.mjs` now uses the shared host guard (L11). 375 would keep `ai_ingest_secret` in `app_config`, which is Boss-read only, the same pattern as `send_push_secret`.

## 5. Blockers

**B1. Medium: `ai_ingest_write` deny-list lets the salary table's own name through.**
- Where: `supabase/migrations/373_ai_ingest_write.sql:342`, `lower(source_type) ~ '^(salar|compensation|attendance|leave|performance)'`.
- The regex is anchored at the start, so it accepts:
  - `employee_compensation` (the table that holds salaries);
  - `payroll`;
  - `basic_salary`.
- Repro: `select ai_ingest_write('{"source_type":"employee_compensation","source_id":"x","doc_hash":"h","embed_model":"text-embedding-3-small","acl_mode":"boss","acl_roles":["boss"]}', '[]')` returns `{ok:true}` (see `phase2b.test.mjs` R8).
- It is defence in depth only: the function is service-only and no extractor for these types exists.
- Fix (recommended): replace the deny-list with an **allow-list**: refuse any `source_type` not in `ai_source_types()`. Tests can add their own types by a GUC or by redefining `ai_source_types()` inside their transaction. The weaker fix is to drop the `^` and add `payroll`.

**B2. Medium: incentives cannot be switched off cleanly (V5).**
- `delete from ai_documents where source_type = 'incentive'` removes the documents and cascades the chunks, and the Boss can no longer find them. But it is **not durable**:
  - `'incentive' ∈ ai_source_types()` (373:525–528), so `ai_backfill_candidates` reports every plan as `missing` and the nightly `ai_reconcile` re-adds them all.
  - Any queued `incentive` item re-creates its document: the worker's registry (`extractors/index.ts:14`) and `ai_ingest_write` both accept the type.
  - The 374 `ai_trg_incentives` trigger (374:198–218) keeps enqueuing.
- Switching off today therefore needs:
  - a migration that redefines `ai_source_types()` and drops the incentives trigger;
  - a code change;
  - a delete.
- Fix (recommended): with B1's allow-list keyed on `ai_source_types()`, switching off becomes one migration (redefine `ai_source_types()` without `incentive`, drop `ai_incentives_enqueue`, delete the documents).
  - The worker should treat a type that is no longer allowed as delete/noop instead of failing 5×.
  - A test for "redefine then drain" should come with the fix.

## 6. Other findings (not blocking)

| # | Sev | Where | Finding |
|---|---|---|---|
| L1 | Low | `376_ai_reports_approved_only.sql:36` (and 373:175) vs `ingest/loaders.ts:25-28` | The report source fingerprint includes `author_name` (`profiles.display_name`), which the extractor never reads. A profile rename therefore makes the nightly reconcile flag every approved report of that author as `changed`, and the worker does a `touch` on each: 1 row write per report, 0 embeds. Fix: drop `author_name` from the report payload. |
| L2 | Info | design (374 header comment) | A profile rename or role change enqueues nothing. The person's incentive plans pick up the new name and role at the nightly reconcile and then re-embed their chunks, because the name and role are in every chunk header (verified: `why = changed`, then re-embedded). Cheap, and as designed. |
| L3 | Low | `tests/eval/questions.jsonl` cmp-004, agg-006 | Under approved-only, cmp-004 has no approved Cutler Nutritions August report (it is *verified*), so the expected difference is now `null`. The question needs rewording, or the grader must credit "that report isn't approved yet". agg-006 says "submitted" but counts approved (16 either way). Both carry an `unapproved_note`. |
| L4 | Info | `ai_backfill` | Executable by the Boss via PostgREST today on dev. It only enqueues; nothing processes without the 375 cron or a drain. It is still worth knowing while the hold stands. |
| L5 | Info | dev data | 0 `app_guide` rows on dev, so the dry-run cost excludes app guides. |

## 7. Changes QA made (tests/** and qa/** only)

- **New tests:**
  - `tests/ingest/phase2b.test.mjs`
  - `tests/ingest/phase2b-triggers.test.mjs`
  - `tests/ingest/phase2b-concurrency.test.mjs`
  - `tests/ingest/t0-embed.test.mjs`
  - `tests/sql/hold_state.sql`
- **Edited:**
  - `tests/sql/grants.sql`: 2B section with 122 new checks.
  - `tests/sql/search.sql`: `ai_embed_model()` fixtures, plus the A§7 check.
  - `tests/eval/refresh-expected.mjs`: L11, now uses `devDbUrl()` / `SSL` from `scripts/dev-env.mjs`.
  - `tests/eval/questions.jsonl`: 28 SQL fields re-pointed to `r.status = 'approved'`; `refresh-expected` re-run (32 stored, 10 live, 3 changed, 0 failed); `unapproved_note` on agg-004, agg-006 and cmp-004; agg-003 note updated.
- **Updated:** `qa/2026-09-28-phase2b-test-plan.md` (Revisions V1–V9).

## 8. Hold

- Before and after: `ai_documents` 0, `ai_chunks` 0, `tts_articles` 0, `ai_ingest_queue` 0.
- No `ai%` cron job and no `ai_*` trigger. The 374/375 functions and the `app_config` keys are absent, and 374/375 are not recorded as applied.
- Every harness proved that its transaction id never changed.
- The only committed writes were T8's 60 `qa_test` queue rows (Lead-approved), deleted in `finally`, with 0 remaining.
- OpenAI spend: T0 (6 tokens).

## 9. Re-check after mig 377 (2026-09-29): final regression

**Verdict: GO-READY.**
- B1 and B2 are fixed by mig 377 (allow-list `ingest_sources` plus a deny-list second net; a per-source off switch).
- The three open failures from the interrupted run (117/120) are resolved: two were test expectations, and the third was settled by the Owner.
- One medium follow-up (M1, below) does not block the first ingestion. Fix it before 375 (the nightly cron) goes on.

Dev state during this run: migrations 367–373, 376 and 377 applied. 378 (`ai_set_source_enabled`) was dropped with the Owner's approval, and its `schema_migrations` row and file are gone.

### 9.1 The three open failures

| # | Check | Resolution |
|---|---|---|
| 1 | T11-OFF "a Developer can switch it back on" | **Owner decision (final): only the Boss may change `ingest_sources`.** The test now asserts the following, and all of it passes: the Boss switches incentives off and on with one `UPDATE` (`is_ai_admin` = boss, mig 207); the APC, OL, TL and Developer get 0 rows in both directions and cannot insert a second config row; `ai_set_source_enabled` does not exist. `grants.sql` also asserts that the function is absent and that `is_ai_admin()` does not mention `developer`. |
| 2 | T11-OFF "every such item is completed (done, attempt 1, no error)" | **Test bug, not a worker bug.** The query picked "the latest queue row per `source_id`" over all 4 plan ids plus `qa-never-listed`, so it also caught the **idle** plan's setup item. That plan was queued and completed before the switch-off, which made 5 rows where 4 were expected. The worker was right: the 3 incentive items and the never-listed `employee_compensation` item were all `done:1:` with no error. Fix: only rows queued after the switch-off (`id > qMark`). Now `["emp:done:1:","inc:done:1:","inc:done:1:","inc:done:1:"]`, ok. |
| 3 | R8 "empty source_type" | **Expectation aligned.** `''` is stopped by the required-fields check (`377:193-195`, "source_type, source_id, doc_hash and embed_model are required") before the allow-list, so the message differs but the outcome is the same (refused). The check now passes on either message and fails only if the write is accepted. |

### 9.2 Final full regression (sequential, dev, every run rolled back)

| Suite | Result |
|---|---|
| `npm test` | 80 / 80 |
| `tests/eval/grade.test.mjs` | 10 / 10 |
| `npm run sql:acl` | ACL MATRIX: PASS (0 leaks, 0 missing); DIRECT ACCESS: PASS |
| `npm run sql:queue` | 80 / 0, PASS |
| `npm run sql:grants` | **251 / 0 / 0, PASS** (now includes "no `ai_set_source_enabled`" and "`is_ai_admin` still boss-only") |
| `npm run sql:search` | 44 / 0, 1 WARN (the documented period WARN), PASS |
| `npm run sql:v1compat` | 6 / 0, PASS |
| `tests/sql/hold_state.sql` | HOLD: INTACT 9 / 9 (before, after an aborted run, and at the end) |
| `tests/sql/sources.sql` (new) | **4 / 4 FAIL**: this is M1 below. These are robustness expectations, not regressions. |
| `tests/ingest/phase2b.test.mjs` | **122 / 122** in 946 s; after rollback d/ch/t/q = 0/0/0/0 |
| `tests/ingest/phase2b-triggers.test.mjs` | 33 / 33 |
| `tests/ingest/phase2b-concurrency.test.mjs` | 12 / 12 (60 `qa_test` queue rows, deleted in `finally`, 0 remaining) |
| `tests/ingest/t0-embed.test.mjs` | ok: 1 real request, 6 tokens, 3 × 1536 dims, unit norm |
| `scripts/test-ingest.mjs --no-real` (engineer) | 49 / 49; it checks Boss-only, and a Developer reads 0 rows of the Boss's chats |
| `scripts/test-triggers.mjs` (engineer) | 36 / 36 |
| `scripts/ingest.mjs --dry-run` | 857 docs / 6,465 chunks / 1,053,840 tokens ≈ $0.0211. With `--tts-jsonl`: 1,927 / 11,556 / 3,394,856 ≈ **$0.0679**, the same as §3. SQL vs TypeScript `indexable()` disagreements: 0 for every type. Backfill: `upsert:missing` only (report 583, KB 149, ai_doc 6, incentive 119). |
| `scripts/import-tts.mjs --dry-run` | 1,201 → 1,094 ids (97 repeated), 24 skipped, 1,070 would be inserted, nothing written |
| `tests/eval/refresh-expected.mjs --dry` | 117 rows · 32 stored · 10 live · **0 changed** · 0 failed. cmp-004 (rewritten, see L3) is current. |

**Error watch (end of run):**
- `ai_ingest_queue`: 0 rows (0 failed, 0 processing).
- `ai_ingest_runs`: 0 rows (0 errors, 0 open).
- `ingest_sources` = the 6 defaults.
- No `idle in transaction` sessions.

### 9.3 New findings

**M1. Medium: one bad name in `ingest_sources` stops reconcile and backfill for every source.**
- **Where:** `ai_ingest_source()` raises on an unknown type (`377_ai_ingest_sources.sql:165-166`). `ai_backfill_candidates` calls it for every enabled type (`377:283-286`), and so do `ai_backfill(null)` (`377:323`) and `ai_reconcile` (`373:604`, through `ai_enqueue_stale(ai_source_types())`).
- **Repro:** `tests/sql/sources.sql`. `update ai_assistant_config set ingest_sources = '{tts_article,kb_articles}'`, then `select ai_reconcile(500)` raises `ai_ingest_source: unknown source type kb_articles`. The same happens with `ai_backfill(null)`, and with a deny-listed name (`payroll`).
- **Save-time check:** there is none. `update … set ingest_sources = '{report,kb_artcle}'` is accepted.
- **Effect:** only the Boss can edit the setting, so there is no leak. But one typo silently stops the nightly reconcile for **all** sources. The error only shows up in the cron log.
- **Fix (engineer):** either of these:
  - (a) `ai_source_types()` returns only names in the six-type canon (plus a test hook such as a GUC for `qa_test`);
  - (b) a `CHECK` / trigger on `ai_assistant_config.ingest_sources` that refuses names outside the canon.

  Option (a) also keeps the R8 second net meaningful. Either way, `sources.sql` turns green.
- **When:** before 375 is enabled. It does not block a manual first ingestion.

**L6. Low (test infra): a dropped connection can leave a test transaction open on the pooler.**
- **What happened:** one final-run attempt lost its connection (DNS / "Connection terminated" on this link) at T7-D. The Supavisor backend then stayed `idle in transaction` with **513 locks**, including AccessExclusive. Dev has `idle_in_transaction_session_timeout = 0`, so every later run timed out (57014).
- **Cleanup:** QA identified that backend as its own (the transaction started 18:59:53, the same moment the run began) and ended it with `pg_terminate_backend`. Termination rolls back, and HOLD stayed INTACT.
- **Mitigation (done, tests/** only):** both long harnesses now `set local idle_in_transaction_session_timeout = '5min'`. The engineer's `scripts/test-ingest.mjs` and `scripts/test-triggers.mjs` would benefit from the same line.

### 9.4 Changes QA made in this re-check (tests/** and qa/** only)

- `tests/ingest/phase2b.test.mjs`:
  - T11-OFF: the queue check is scoped to the items queued while off.
  - Boss-only switch checks in both directions for 5 roles, plus a check that `ai_set_source_enabled` is absent.
  - R8: the empty-type expectation is aligned.
  - The idle-in-transaction guard.
- `tests/ingest/phase2b-triggers.test.mjs`: the idle-in-transaction guard.
- `tests/sql/grants.sql`: `ai_set_source_enabled` absent; `is_ai_admin()` still boss-only.
- `tests/sql/sources.sql`: new (M1).
- `tests/eval/questions.jsonl`: cmp-004 now compares two **approved** August reports (Aqua Sonic vs Pure Daily Care). Its values are verified current.
- Still uncommitted from the interrupted round, and part of this regression:
  - `tests/sql/acl.sql` and `tests/sql/search.sql` enable their fixture types through `ingest_sources` inside the transaction (mig 377).
  - `tests/ingest/phase2b-concurrency.test.mjs` cannot update the config row from 4 concurrent transactions (row lock). Its workers therefore see `qa_test` as enabled, and each write is stored as `tts_article` with synthetic `qa-conc-*` ids, rolled back.

### 9.5 Security (re-check)

- **Config writes are Boss-only.** Only the Boss can write `ingest_sources`: through RLS `ai_config_write` → `is_ai_admin` = boss. APC, OL, TL and Developer get 0 rows either way. No role can insert a second config row. No SECURITY DEFINER bypass exists (`ai_set_source_enabled` is absent).
- **The Developer boundary holds.** A Developer still cannot read the Boss's chats (engineer's test: 0 rows).
- **Service-only functions stay closed.** Every service-only 2B function denies PUBLIC, anon and authenticated (251 grants checks).
- **Disabling a source hides it at once.** A disabled source is hidden from every caller, including the service relay, and a direct `ai_ingest_write` is refused ("not enabled").
- **Sensitive types are refused twice.** They are refused even after an admin adds them to the list ("never indexed").
- **Secrets:** none were printed or written. OpenAI spend this round: T0 only (6 tokens).
