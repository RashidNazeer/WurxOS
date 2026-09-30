# QA: Phase 5 WP-C, eval-set preparation (2026-09-29)

**Verdict: PASS WITH ISSUES.** The eval set is ready for the Phase 5 retrieval eval. It had 117 rows and now has **157**. No row fails the schema check, and every expected source except one resolves to an active document. The issues are data and design findings, listed below. None of them blocks WP-A or WP-B.

Scope: `tests/eval/questions.jsonl`, plus small grader and README changes in `tests/eval/`. All database access was read-only against dev (the `begin read only` transaction was always rolled back). No product code was touched.

## 1. What changed

| Change | Rows |
|---|---|
| Remap of merged `ai_doc` ids to `kb_article` ids | 12 references in 12 rows (sop-001 to sop-010, mix-002, mix-007). 10 rows already listed both ids, so the duplicate pair was collapsed. The old ids are kept in `remapped_from`. |
| Curated (non-merged) `ai_doc` rows kept as they were | 6 docs, cited by how-001 to how-009 and fup-006 |
| `expected_index` added | all 109 rows with sources, plus 3 source-less rows where a search is still expected (rep-013, xbr-010, xbr-013) |
| Overlap questions (SOP and TikTok on the same topic) | **22** new rows: `ovl-001` to `ovl-022` |
| Cross-brand report questions (no brand named) | **13** new rows: `xbr-001` to `xbr-013` |
| Owner requests (Lead, 2026-09-29) | **5** new rows: `rep-011` to `rep-015` |
| Rows reworded under the approved-only rule | nar-004, fup-007, mix-007 (see issue M2) |
| Grader | `isRequired`: a label ending in `(optional)` is credited when present but never required. Covered by a new unit test. |
| New offline schema test | `tests/eval/questions.test.mjs` (8 tests) |

### Counts by category (before → after)
| Category | Before | After |
|---|---|---|
| how_to | 9 | 9 |
| sop | 10 | **19** (+7 overlap company_first, +2 link_only) |
| tiktok | 10 | 10 |
| report_lookup | 10 | **15** (+5 owner requests) |
| report_narrative | 10 | **16** (+6 cross-brand) |
| aggregation | 9 | **15** (+6 cross-brand) |
| comparison | 8 | 8 |
| people_data | 10 | 10 |
| mixed | 7 | **21** (+13 overlap, +1 cross-brand) |
| follow_up, ambiguous, permission, out_of_scope | 8, 8, 10, 8 | unchanged |
| **Total** | **117** | **157** |

### Counts by `expected_index` (112 rows)
| Index | Rows |
|---|---|
| company | 29 |
| reports | 53 |
| tiktok | 16 |
| mixed | 14 |
| incentives | 0 (no incentive-plan question exists yet; the set has no `incentive` sources) |

### Overlap rows by answer policy (§3)
| Policy | Rows | Expected sources / grading |
|---|---|---|
| `company_first` ("how do we / our SOP") | 7 | the KB article; TikTok is listed in `optional_sources` |
| `tiktok_authoritative` ("what does TikTok require") | 5 | the TikTok article(s); our SOP is optional |
| `both_labelled` | 6 | both sources, `retrieval_match: all`, `must_label: ["Our SOP", "TikTok Shop Academy"]` |
| `conflict_flag` | 2 | both sources; the answer must say they differ and advise confirming with the TL or OL (ovl-011 promotion-days ROI; ovl-014 category approval) |
| `link_only` | 2 | the link-only KB pointer; the answer must give the link and must not invent steps (ovl-021 Outreach Standard SOP; ovl-022 GMV Max New Terms) |

Topics covered: samples (3), violations and appeals (3), GMV Max setup, audit, ROI and Max delivery (7), category approval (1), flash sale (1), LIVE GMV Max (2), creator outreach and invites (3), link-only pointers (2). Every `expected_facts` entry was taken from the chunk text on dev, not from memory.

## 2. Remap summary: do the expected sources exist?
I checked all 102 distinct expected and optional sources against `ai_documents`: 6 `ai_doc`, 24 `kb_article`, 46 `report` and 26 `tts_article`.
- **101 of 102 are active documents.**
- **Missing: `report:401bed5a-be17-41f0-a4eb-b27e79338fe7`** (rep-009). This is a `public.gmv_max_reports` id, not a `reports` id, so it can never be in the store. That is harmless: rep-009 is a data-tool row, and `needsRetrieval()` leaves `report_lookup` out of recall. See L1.
- **Removed:** `report:d9791c56…` (the Cutler Nutritions August 2026 monthly report). Its status is `verified`, so it is not in the approved-only store. It was cited by nar-004, fup-007 and mix-007. See M2.

## 3. Link-only KB pointers (the answer can only be "here's the link")
28 `kb_article` documents have no merged SOP text (`metadata.sop_doc_ids` is empty). Each is one chunk of about 50–70 tokens holding a title and a URL. The expected answer for any of them is the link, plus a statement that the full text isn't in the assistant yet (§3.4).

**Overlap-relevant (on the Phase 5 topics):** Outreach Standard SOP, Outreach Standard SOP Loom, GMV Max New Terms, Paid Collabs - Latest Process, End To End Paid Collab System, How to add a new video as authorised to the campaign, How to analyze Paid vs. Organic/Affiliate Performance, How to check the status of low CPO videos, Black Friday/Cyber Monday Playbook.

**Others:** Automate video review messages and weekly reporting stats, Change Management - Wurx OS, End to End Process View of Brand Onboarding, Example Projection - Penetrex, How to manage Incentives and Bonuses, How to setup Notfier app in windows, OS-V2 Tutorial, Weekly & Monthly Reporting, Weekly Agenda Meeting | WurxOS, Weekly Performance Meeting, Weekly Reporting | Updates, Wurx Media BootCamp, Wurx OS - Adding Tasks & Resources, Wurx OS - How to Report a Bug, Wurx OS - Knowledge Base Navigation, Wurx OS - Setting Configuration - Video # 1, WurxOS - Campaigns Configuration & Broadcast/Reminders/Notifications, WurxOS - How to Manage Attendance + Details on Tasks & Resources, and **testing doc** (see L2).

## 4. Owner-request rows (refreshed 2026-09-29, PKT)
| Row | Question | Expected (stored by `refresh-expected.mjs`) |
|---|---|---|
| rep-011 | "…top performing **last week**…" (verbatim) | Last week (Sep 20–26): **no report**. The latest approved week is Week 24 (Sep 13 - 19): **thalldealz, 325 items** (GMV $7,542.53). Graded `exact_number`; the SQL is relative to the current PKT week. |
| rep-012 | the explicit Week 24 variant | thalldealz, 325 items |
| rep-013 | "…top creator sell in **Week 22**" | Week 22 (Aug 30 - Sep 5) is `verified` only, so the answer must say it is awaiting approval. `must_not_contain` holds Week 22's GMVs and ttfindsbyjp. `precondition_sql` skips the row once Week 22 is approved. |
| rep-014 | "…top performing **last month**…" (verbatim) | The August monthly is **verified**, so it must not be quoted. The latest approved monthly is July 2026: **@paigetheplug, $5,514.72**. Optional sums over the approved weeklies fully inside August (Weeks 18–21): builtformore17 168 items (4 weeks), ttfindsbyjp 160 (4), tonystokfinds 72 (3), kimstoleyourfries 41 (1). `must_not_contain` holds the unapproved August monthly top-3 GMVs. Graded `facts`. |
| rep-015 | "…top performing **in June**…" (verbatim) | Approved June monthly: **@tavo2real, $9,302.45 USD** (required number). Optional sums over Weeks 10–12: tavo2real 155 items (3 weeks), domsaccount9 149 (1), kimstoleyourfries 73 (2), paigetheplug 48 (2), builtformore17 44 (1). The items-sold labels end in `(optional)`. These match the Lead's answer key. |

All five rows also:
- **forbid gender guessing:** `answer_rules`, plus `must_not_contain` of " he ", " she ", " his ", " her ", "he sold" and "she sold";
- **require resolving "Cutler Nutrition" to Cutler Nutritions;**
- **accept `@tavo2real` and `tavo2real` as the same creator** (the judge fact says so).

## 5. Cross-brand rows (approved reports only)
| Row | Type | Expected |
|---|---|---|
| xbr-001 | narrative | stock-outs hurt August performance: Longevity Box (Met4Min) and Bentgo (Lift Chug Lid bottle, Bluey lunch box) |
| xbr-002 | narrative | creator-outreach recommendations in the August monthlies: Pure Daily Care, Bentgo, Aurelia, Swisse |
| xbr-003 | narrative | an active shop violation held a brand back: Kenashii (10-order daily cap) |
| xbr-004 | narrative | Max delivery tests in August: Aurelia ($300 then $500/day) and Swisse (about $500/day, orders 145 → 211) |
| xbr-005 | narrative | brands invited to the September Stock Up campaign (Sep 16–27): at least 5 of 8 named |
| xbr-006 | narrative | September seeding pauses: Aurelia (inventory), Obagi (brand's direction), Longevity Box (Met4Min) |
| xbr-007 | mixed | xbr-004 plus TikTok's "About Max delivery optimization" article |
| xbr-008 | number | best August GMV Max ROI, blended: Klassy Network 2.57x, Aqua Sonic 2.49x, Pure Daily Care 1.75x. Cutler (3.62x, verified) is correctly excluded. |
| xbr-009 | number | August ROI below 1.0x: 8 brands. Dr Tobias (1.0009) sits just above, as an edge case. |
| xbr-010 | number | total August GMV Max spend: USD 537,804.57 over 15 reports, and GBP 5,655.36 over 1 report, never summed together |
| xbr-011 | number | highest August GMV Max spend: Klassy Network $140,492.83 |
| xbr-012 | number | brands that grew GMV from Sep 6–12 to Sep 13–19: 9 brands with the % change. Compared by date, because week numbers differ per brand. |
| xbr-013 | number | brands with an approved August monthly report: 16 (coverage denominator: 16 of 19) |

Every numeric row has `expected_sql` with `status = 'approved'` and a coverage note.

## 6. Tests run
| Test | Result |
|---|---|
| `node tests/eval/refresh-expected.mjs --check` | 157 rows · live 10 · **failed 0** |
| `node tests/eval/refresh-expected.mjs --dry` (before writing) | changed 10, **all of them new rows**. No existing row moved, so the relative-period rows still resolve to Week 24. |
| `node tests/eval/refresh-expected.mjs` (write) | stored 42 · changed 10 · failed 0 |
| `refresh --dry` again | **changed 0** (idempotent) |
| `node --test tests/eval/questions.test.mjs tests/eval/grade.test.mjs` | **19/19 pass** (8 schema + 11 grader, including the new `(optional)` test) |
| Existence of the sources on dev | 101/102 active (§2) |
| Scan of `questions.jsonl` for secrets or URLs (Google Docs, Loom, keys, JWTs) | none |

Not run: `npm test` (engineer-owned unit tests; the retrieval work from WP-A is uncommitted and in progress). No SQL ACL suite was run either, because this WP changed no database objects.

## 7. Issues
- **M1 (medium): retrieval-eval semantics the runner doesn't implement yet.**
  - `retrieval_match: "all"` and `must_label` are new fields. `grade.mjs` `recallAtK` is still any-of, and label checking is left to the judge.
  - `scripts/eval-retrieval.mjs` (WP-A) must read `expected_index`, `retrieval_match` and `optional_sources`. Optional sources must not count toward recall.
- **M2 (medium): three drafted rows expected facts from an unapproved report.**
  - nar-004, fup-007 and mix-007 quoted the Cutler August monthly report, which is only `verified`.
  - I rewrote them to the §3.6 behaviour: "awaiting approval, do not quote". The old facts are kept in `unapproved_note`, following the cmp-004 (QA L3) precedent. This needs Lead/Owner sign-off.
- **M3 (medium): our SOPs and TikTok disagree.**
  - Promotion-days ROI drop: our "Audit Performance…" SOP says 10–15%; TikTok says 10%, 20% or 30%.
  - Category approval: our SOP says Products → Category Approval, 1–3 business days; TikTok says Qualification Center, about 6 days.
  - ovl-011 and ovl-014 test the conflict policy against these. The SOPs themselves may be out of date.
- **M4 (medium): several SOPs hold their steps only in stripped images.**
  - Examples: "How to adjust Target ROI or Budget", "How to set up Max delivery", "Audit Performance of an existing GMV Max Campaign". Their bodies contain empty "Step 1: / Step 2:" headings.
  - Answers from them can only be as complete as the text. The expected facts use only the text that exists.
- **L1 (low): rep-009's `source_id` is a `gmv_max_reports` id typed as `report`.** It can never match a retrieved chunk. It is left as is because it is a data-tool row. WP-A's eval must skip rows where `needsRetrieval()` is false.
- **L2 (low): a junk KB article is live in the company index.** "testing doc" (kb `833b9bda-8282-41dc-a8da-8ff3f032354d`, body "123 / 12 / Full guide: https://www.google.com") is copied from production data and can surface in company search. It should be removed or excluded; that is the Owner's call.
- **L3 (low, for WP-B): data quirks.**
  - Report `gmvMax` values carry currency suffixes (`"22544.45USD"`, `"66241.94USD"`), so `parseMetric` must strip them.
  - Monthly `topCreators` use `username`, sometimes with `@`. Weekly reports use `name`, plus an `itemsSold` field that monthly reports lack.
  - `rank_brands` ROI must be blended (Σ GMV / Σ spend), not the mean of per-campaign ROI. xbr-008 and xbr-009 assume blended.
- **L4 (low): gender-leak strings could match legitimate text.** Phrases like " her " could, in principle, appear in a non-gendered sentence. They are kept deliberately; the judge sees the fact too.

## 7a. Follow-up: Owner decision on rule 6a (same day)
The Owner decided: monthly figures that the monthly report doesn't record are calculated from the approved weekly reports and stated directly, with a mandatory disclosure. The Lead also made decisions 1, 2 and 4.

Changes:
- **rep-015 (June):**
  - required: @tavo2real **$9,302.45** (approved monthly), and **155 items** (Weeks 10–12);
  - optional: the other creators;
  - excluded weeks are recorded in the label: Weeks 9 and 13, which straddle the month.
- **rep-014 (August):** the August monthly is pending, so the answer is derived from the approved weeklies fully inside August (Weeks 18–21):
  - required: **builtformore17, $4,975.40 GMV, 168 items**;
  - excluded: Week 17 (straddles the month) and Week 22 (straddles the month, verified only);
  - the July monthly (@paigetheplug, $5,514.72) is optional;
  - the SQL switches to the rep-015 shape automatically once last month's monthly is approved.
- **Disclosure is now enforced by rule.** A new field, `must_mention`, holds two groups: "weekly", and a phrase like "monthly reports don't record / track / include". `run-eval.mjs` fails the row if either group is missing.
- **Bug fixed in my earlier rows (this would have failed every answer).**
  - The gender check used `must_not_contain` strings such as `" he "`. `findLeaks` trims needles, so `" he "` became `"he"`, which matches "the" and "they".
  - I replaced it with a new `must_not_match` rule, a word-boundary regex, on rep-011 to rep-015.
  - The schema test now rejects `must_not_contain` needles with leading or trailing spaces.
- **New row sop-011 (Lead decision 4).** The question "Do we have an SOP about testing?" expects the real "Kill rule for creative testing" SOP. The junk "testing doc" article must never appear:
  - `must_not_match \btesting doc\b`;
  - `must_not_contain www.google.com`;
  - `forbidden_sources` = kb `833b9bda…`. Citing it now fails the row in `run-eval.mjs` (`checkCitations` returns `citedKeys`).
- **Decisions 1 and 2 need no change:** the nar-004, fup-007 and mix-007 rewrites stay, and ovl-011 and ovl-014 stay as conflict tests.

Re-run:
- the refresh changed exactly 2 rows (rep-014, rep-015) and a second dry run changed 0;
- `--check`: 158 rows, 0 failed;
- `node --test questions.test.mjs grade.test.mjs`: **23/23 pass** (2 new grader tests, 2 new schema tests);
- `node --check run-eval.mjs`: OK.

## 8. Security review
- **Writes:** only `tests/eval/**` and `qa/**`. Every DB query ran in `begin read only` and was rolled back.
- **Read-only SQL:** the new `expected_sql` and `precondition_sql` are read-only. The schema test rejects write keywords.
- **People data:** no new row touches pay, attendance, leave, performance or profiles. The live-row privacy invariants are asserted by the schema test: no stored values, the `{person}` placeholder only, no `display_name`.
- **Creator handles:** handles in the new rows are public TikTok creator handles from reports, not staff.
- **Secrets:** none in any fixture. The Google Doc URLs of the link-only SOPs are deliberately **not** copied into the eval file; the facts refer to "the link on the KB article".
- **ACL:** unchanged. ovl-014 cites a TL/OL-only KB article and is asked as the Boss. A permission variant (the APC must not get it) would be a useful WP-E addition.
