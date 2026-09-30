# Data Inventory (Phase 0.2)

Source: dev project after the prod → dev copy, profiled 2026-09-28 with
`scripts/profile-data.mjs` (read-only, aggregates only). Raw output is in
`inventory.json`.

## 1. What's in the database

| Area | Rows | Goes to |
|---|---|---|
| Reports (weekly / biweekly / monthly) | 624 (604 non-draft) | **RAG** narrative + **tools** for numbers |
| AI assistant docs | 139 (133 are imported SOPs) | **RAG** |
| KB articles | 150 | **RAG** (pointer chunks + ACL; see §3) |
| TikTok Academy (`tts_knowledge`) | **0 in dev: not copied** | **RAG** |
| GMV Max reports | 4 (Mar–May 2026) | tools only (too few to be worth indexing) |
| Agenda: meetings / tasks / presentations / reviews | 69 / 65 / 213 / 69 | tools (little text, see §4) |
| Incentives / performance / weekly perf ratings / flags | 132 / 131 / 145 / 25 | tools |
| Attendance / leave | 3,419 / 212 | tools |
| Compensation / salary history | 28 / 38 | tools (Boss only) |
| Brands / brand monthly metrics | 40 (20 active) / 56 | tools + brand profiles |
| Campaign tracker / product campaigns / tasks / resources | 247 / 14 / 285 / 204 | to evaluate (P3 sources) |
| Euka shop metrics | 246 | tools (later) |
| Past assistant chats | 14 conversations / 36 messages | **seed for the eval set** |
| People (active) | 33: apc 18, tl 4, ipc 4, ol 2, developer 2, pctl 1, ads_manager 1, boss 1 | — |

## 2. Reports: the main corpus

- **Period:** 2026-03-01 → 2026-09-14, **34 brands**, ~100–140 reports/month.
- **Status:** 583 approved · 10 verified · 10 submitted · 20 draft → **604 indexable**.
- **Layouts** (all four need extractor branches):

  | Layout | Count | Narrative lives in |
  |---|---|---|
  | weekly-legacy | 289 | 6 per-section `*Insights` fields |
  | weekly-single | 212 | `reportInsights` (avg 1.8k chars, max 6k) |
  | monthly | 118 | `keyWinsInsights` (avg 2.1k), `campaignsText`, `recommendations` |
  | biweekly-legacy | 5 | per-section insights |

- **Biggest text fields:** `operationalUpdates` (412 filled, avg 1.1k chars),
  `recommendations` (402, avg 780), `upcomingCampaigns` (425, avg 230).
- **HTML:** present in 60–100 % of filled text fields, so HTML → text is mandatory.
- **`actionItems` is effectively unused** (2 filled). It's merged into the recommendations section.
- **Tables are small:** top creators / videos / GMV Max / products average 3 rows (max 20).
  Row `notes` are almost never filled.
- **Currency:** 488 missing (→ USD by app rule), 129 USD, **7 GBP**. Mixed
  currency is real, so no cross-currency sums.
- **Numbers are clean:** 1,025 decimals + 80 integers, stored as strings; the only
  placeholders are `N/A` (6), `Null` (1) and `Not_Available_yet` (1).
  `parseMetric` is simple: numeric parse plus a small placeholder list.
- **Extra keys not in the documented shape:** `rejectionNote` (116), `highlights` (18),
  `submittedBy*` (104), `gmvBreakdown` on 1 weekly. **`rejectionNote` is internal
  reviewer feedback**, so it's excluded from the index by default.
- **`sectionsEnabled`:** set on 515 reports and honoured by the extractor.

## 3. Knowledge Base & SOPs: key finding

- **148 of 150 KB articles have no body; they're links** (Google Docs 129,
  Loom 12, Drive 7, other 2). KB rows alone can only produce "the SOP is here"
  pointer chunks.
- **The actual SOP text already lives in `ai_assistant_docs`:** 133 of 139 docs
  carry the `<!--wurx-sop-import-->` sentinel (imported from those Google Docs).
  Average 1.8k chars, max 5.8k.
- **ACL risk:** 25 KB articles are **role-restricted** (TL 15, OL 18, PCTL 10,
  APC 7) and 1 is private. If their imported text is indexed as a plain
  `ai_doc` (visible to everyone), a restricted SOP would leak once the
  assistant opens beyond the Boss. **Each imported SOP doc must be linked to its
  KB article and inherit that article's ACL.**
- KB categories: operational_sops 122, training_sops 14, policies 8, delivery_roadmap 4, bootcamp 2.

## 4. Low-value text sources

- Agenda tasks: 65, all `todo`, only 1 has details. Presentations: 27 of 213 have
  summaries (avg 84 chars). **Not worth embedding**; answered by the
  `get_agenda_tasks` tool.
- GMV Max reports: 4 rows, no notes. **Tool only.**

## 5. Size & cost

| Item | Estimate |
|---|---|
| Report text (all JSON strings) | ~3.7M chars ≈ **0.92M tokens** |
| Report narrative only | ~1.76M chars ≈ 0.44M tokens |
| SOP docs | ~0.24M chars ≈ 61k tokens |
| Expected chunks | reports ≈ 6–7k · SOP/docs ≈ 250 · KB pointers 150 · TikTok ⟨pending prod copy⟩ → **~8–10k total** |
| Full backfill embedding cost | **< $0.05** at text-embedding-3-small pricing (verify on the day) |

At this size pgvector is far below any scaling concern; even an exact
(unindexed) scan would be fast.

## 6. Environment issues found

| Issue | Severity | Action |
|---|---|---|
| Dev `app_config.send_push_url` **points at the PROD project**, with the prod secret | **High**: any notification created in dev pushes to real staff phones | blank `send_push_url`, `send_push_secret` in dev |
| Dev `app_config.discord_wurxos_webhook` is set | **High**: approving a KB article in dev posts to the real Discord | blank it in dev |
| `tts_knowledge` not copied (0 rows) | Medium | copy it from prod (probably skipped because of the `vector` column), or re-run `scripts/tts-ingest/ingest.mjs` against dev |
| Dev cron jobs | Unknown (not visible via REST) | check `select jobname from cron.job` in the dev SQL editor; remove the prod jobs |

## 7. Design changes this causes

1. **SOP ACL inheritance:** `ai_assistant_docs` gets a `kb_article_id` link
   (matched by URL/title). The indexed doc uses `acl_mode='kb'` with the
   article's visibility; KB link-only rows are **merged** with their imported
   text into one document instead of producing duplicate pointer chunks.
2. **Report extractor:** four layouts; `actionItems` folded into
   recommendations; `rejectionNote`/`submittedBy*` excluded; `highlights` +
   stray `gmvBreakdown` handled by the generic fallback.
3. **Agenda & GMV Max** move from RAG sources to tool-only.
4. **Currency** is shown per report; GBP exists, so `compare_periods` /
   `rank_brands` refuse to mix currencies.
5. **Eval seed:** the 14 real past conversations become the first eval questions.
6. **Future option:** automatic re-import of the linked Google Docs (Drive
   export API) so SOP edits flow in without a manual re-import. This needs
   Google API access, so it's a separate decision.
