# QA: eval question set, DRAFT (Phase 0.4), 2026-09-28

**Verdict: DRAFT READY FOR OWNER REVIEW.** There are 117 questions, and every
category has at least 7. All 55 SQL statements run on dev. No salary or staff
data is stored.

Files:
- `tests/eval/questions.jsonl`: the set
- `tests/eval/README.md`: format, scoring, gates, how to refresh
- `tests/eval/refresh-expected.mjs`: recomputes stored numbers from `expected_sql`

## Counts

| Category | Rows | of which Owner-history |
|---|---|---|
| how_to | 9 | 1 |
| sop | 10 | 0 |
| tiktok | 10 | 1 |
| report_lookup | 10 | 3 |
| report_narrative | 10 | 2 |
| aggregation | 9 | 2 |
| comparison | 8 | 0 |
| people_data | 10 | 0 |
| mixed | 7 | 0 |
| follow_up | 8 | 2 |
| ambiguous | 8 | 2 |
| permission | 10 | 0 |
| out_of_scope | 8 | 1 |
| **Total** | **117** | **14** |

By grading type: `facts` 51, `exact_number` 38, `must_refuse` 17,
`must_clarify` 8, `citation` 3. Citation validity is also checked on every row.

## Tests run

| Check | Result |
|---|---|
| `refresh-expected.mjs --check`: every `expected_sql` / `person_sql` / `forbidden_sql` / `precondition_sql` runs on dev (read-only, rolled back) | 55 statements, **0 failures** |
| `refresh-expected.mjs`: stored values written | 32 rows stored, 10 live (people_data), 0 failures |
| Second refresh straight after | 0 changes (idempotent) |
| Schema check: all required fields present, ids unique, no stored numbers on `people_data` rows | 0 problems |
| Leak scan: file compared with every `profiles.display_name` and every distinct `basic_salary` (values held in memory, never printed) | No staff name with pay. Two harmless coincidences: brand GMV targets in `agg-009` that equal round salary amounts, and the dev test account's name inside a note on `ppl-010` |
| Stored values spot-checked by hand against raw pulls | PDC weeks 1–24, the August monthly list, the Sep 13–19 weekly list: all match |

## Owner-history questions found

Dev `ai_messages` holds **18** `role='user'` rows (the "36 messages"
includes assistant replies) across 14 conversations. That makes 14 distinct
questions, all in the set:

| Real question | Row | Note |
|---|---|---|
| "Hey!" | oos-001 | greeting, graded as a friendly reply |
| "tell me the gmv of the Pure daily care in last week" | rep-001 | |
| "Check PDC and yes weekly report" (+ "Pure Daily Care") | fup-002 | v1 needed 3 turns for this; two follow-ups merged |
| "what is our current gmv" | amb-001 | |
| "tell me about wurx os" | how-001 | |
| "how is pure daily care doing" (asked twice) | nar-001 | |
| Slack: "how are we doing this month?" (asked 3×, once in bold) | rep-003 | |
| Slack: "and how is Klassy Network doing?" | nar-002 | brand override of the Slack context |
| Slack: "in which week our gmv was highest?" | agg-001 | |
| Slack: "when did we hit the highest order no in which week?" | agg-002 | |
| Slack: "what was our gmv last week" | rep-002 | |
| "what was our gmv last week" (no Slack context) | amb-002 | |
| "what was our gmv for Pure Daily Care?" (its follow-up) | fup-001 | |
| "…at which SPS … the affiliate operations are stopped?" | tts-001 | answer: below 3.0; 3.5+ to regain |

That is only 14 real questions, and 12 of them are about Pure Daily Care. The
other 103 are drafted. P0-3 says the set should be written with the Owner, so
**more real questions from the Owner are the biggest improvement available.**

## Categories that were hard to fill

- **people_data:** values can't be stored, so each row picks a person by role
  ("first active APC by name"). That is brittle when staff change. The grader
  must run the SQL at eval time. "Earned incentive" can't be checked by SQL
  (it needs the three overlays), so only "potential" is checked here, and
  earned is left to the P5 tool-parity test.
- **permission:** this depends on things that don't exist yet:
  - Only **one** test APC exists on dev, no test TL, and I don't know the
    APC's brand assignments. `precondition_sql` skips rows that don't apply.
  - **`ai_assistant_docs.kb_article_id` is NULL on all 139 docs**, so the
    OL-only SOPs (Brand Offboarding, Auditing Workflows, Documenting Process
    Improvements) would leak today if indexed as plain `ai_doc`. `prm-007`–`prm-009`
    will fail until the KB link lands. That's intended: they are the test for it.
- **how_to:** only 5 real app guides exist, all stored as `kind='doc'`. No
  `app_guide` rows exist yet, so the rows reuse those 5 guides.
- **mixed / follow_up:** there are no real examples, so all but the 2
  Owner-history follow-ups are drafted.
- **tiktok:** `tts_knowledge` and `tts_articles` are empty on dev (ingestion
  hold). `expected_sources` use the `knowledge_id` from the crawl file with
  `source_type='tts_article'`; they'll match once the Owner allows the import.

## Findings along the way (for the Lead)

1. **Two GMV sources disagree.** Take August 2026: the brand goal
   (`brand_monthly_metrics.gmv_achieved`) and the monthly report give
   different numbers:

   | Brand | Brand goal | Monthly report |
   |---|---|---|
   | PDC | $212,321.08 | $191,707.10 |
   | Klassy Network | $361,535.96 | $346,182.15 |
   | Cutler Nutritions | $239,773.37 | $235,668.46 |

   The assistant must say which one it quotes. Rows here state their source.
2. **The app decides report currency two different ways.** `ReportView.jsx:638`
   uses `data.currency || 'USD'`, but `ClientReportsSection.jsx:75` uses the
   brand's currency first. Longevity Box weekly reports have no currency set,
   so the same report shows **$** in-app and **£** in the client portal. The
   eval SQL uses report → brand → USD (so £ for Longevity Box).
3. **Week numbers are per brand.** For the week of Aug 30 – Sep 5, most
   brands call it Week 22, but Apothecary calls it Week 5, Swisse Week 21 and
   Inno Supps Week 1. So "Week 23" without a brand is ambiguous (`amb-003`).
4. The **active "Test Brand"** appears in the brand goals
   (`brand_monthly_metrics`), so it shows up in `agg-009`.
5. **Path mismatch:** A§16 says the set lives in `Assistant/eval/`. I put it
   in `tests/eval/` because QA owns `tests/**`.
6. **My mistake:** a mistyped write path created an empty folder `C:\UMARIL~1`
   at the C: drive root, outside the project. I deleted the file; the tool
   guard blocked deleting the folder. It's empty. Please remove it by hand.

## Questions for the Owner to review

"Is this the answer you'd expect?" Values are dev data on 2026-09-28.

1. **rep-001 / rep-002** "gmv of Pure Daily Care last week": there is no
   report yet for Sep 20–26. Expected answer: *"No report yet for Sep 20–26;
   the latest is Week 24 (Sep 13–19): $46,533.47."* Right?
2. **rep-003** Slack "how are we doing this month?" for PDC: expected
   *"$164,430.06 of the $215,000.00 September goal (76.5 %)"* plus the recent
   weekly trend. Should "this month" come from the **brand goal** figures, or
   should it add up the weekly reports?
3. **Finding 1:** when you ask "PDC's August GMV", is the answer
   **$191,707.10** (monthly report) or **$212,321.08** (brand goal)?
4. **amb-001** "what is our current gmv": should the assistant **ask which
   brand**, or give an **agency-wide month-to-date total** straight away?
5. **rep-007 / finding 2:** is Longevity Box always **£ (GBP)**, even on
   reports where nobody set the currency?
6. **agg-004** total August GMV = **$1,158,337.43 across 16 USD reports +
   £5,056.59 (Longevity Box)**. It excludes **draft** monthly reports (Inno
   Supps $92,233.09, Penetrex $57,220.42). Should drafts count?
7. **agg-001 / agg-002** PDC's best week = **Week 1 (Apr 5–11): $73,460.44,
   1,178 orders**. PDC weekly reports start in April, so March isn't
   considered. OK?
8. **cmp-005** Longevity Box vs Bentgo: the assistant should **refuse to
   subtract £ from $** and give both figures. Or do you want a converted
   figure (that needs an FX rate source)?
9. **prm-010** a TL asks to "rank all brands": expected = rank **only the
   brands they can see**. Or should the assistant refuse the question
   entirely?
10. **ppl-003** total payroll: count **active staff only** (inactive or
    deleted people with a compensation row excluded)? And should "Test Brand"
    and test users ever appear in answers (`agg-009`, `ppl-010`)?

Also: please mark any drafted question you **wouldn't** actually ask, and add
5–10 real questions per role you care about.
