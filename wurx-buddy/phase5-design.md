# Phase 5: Assistant v2 backend design

_Lead, 2026-09-29. Scope: backend machinery only (no UI; the Owner will give UI
changes before any integration). It builds on the live dev store: 1,927 docs /
11,556 chunks._

**Owner's requirement:** the model must answer accurately from **our reports**
and **our own SOPs**, and the TikTok-heavy retrieval problem must be solved
properly, not patched.

---

## 1. Diagnosis: why search leans on TikTok (measured on dev)

| Corpus | Docs | Chunks | Avg tokens | Nature |
|---|---|---|---|---|
| TikTok Academy | 1,070 | **5,091** | 460 | dense, topical prose, written to rank |
| Reports | 583 | 6,060 | 158 | **mostly number tables**: products 607, creators 578, videos 575, GMV Max 556 chunks; narrative sections are fewer |
| KB + SOP text | 149 | **174** | 359 | our process, often step lists |
| Curated docs | 6 | 15 | 396 | app how-to |
| Incentive plans | 119 | 216 | 117 | short, structured |

Four causes, each needing its own remedy:
1. **Volume imbalance: TikTok prose outnumbers our SOPs by 27 to 1** (5,091 vs
   189 chunks). One pooled ranking returns the most *similar* chunks, and with
   27× more candidates, TikTok wins on sheer count.
2. **Topical overlap.** Our SOPs cover the same subjects as the Academy
   (samples, violations, GMV Max, listings). "How to approve sample requests"
   (our SOP) competes with ~40 TikTok sample articles.
3. **Reports embed poorly for questions.** Most report chunks are number
   tables, which carry little meaning for a semantic search. A question like
   "which brands did well on GMV Max" is semantically closest to TikTok's GMV
   Max *explainers*, not to our tables.
4. **Questions often lack the anchors that find reports**: brand names and periods.

**Conclusion.** Better scoring alone cannot fix a single pooled ranking. The fix
is architectural: **separate the corpora, let the agent choose between them, and
answer numbers with tools rather than search.**

---

## 2. Retrieval architecture: multi-index agentic retrieval

### 2.1 Four logical indexes over one store
| Index | Source types | Authority |
|---|---|---|
| `company` | kb_article (incl. merged SOP text), ai_doc, app_guide | **our process**: how WE work |
| `reports` | report (approved only) | **our clients' performance** (narrative; numbers via tools) |
| `tiktok` | tts_article | **TikTok platform rules and how-tos** |
| `incentives` | incentive | plan structure (payouts and progress via tools) |

No schema change: `ai_search` already filters by `p_source_types`, brand and
period, under the same ACL.

### 2.2 One search tool per index, plus a balanced federated search
The model **chooses the index**, which is the most reliable fix for volume
imbalance:
- `search_company_knowledge(query)`: SOPs, KB, app guides.
- `search_reports(query, brand?, period_from?, period_to?, report_type?, sections?)`.
- `search_tiktok_academy(query)`.
- `search_incentive_plans(query, person?, month?)`.
- `search_everything(query)`: **federated** for unclear intent. It runs the
  four indexes **in parallel** with **fixed quotas** (company 4, reports 3,
  tiktok 3, incentives 1 when readable) and returns results **grouped and
  labelled by index**. A large corpus can never crowd a small one out.

### 2.3 Inside each index
1. **Candidate pool:** `ai_search` with 40 candidates, as the caller (ACL applies).
2. **Diversity:** at most 2 chunks per document, so one long article can't fill the list.
3. **Neighbour expansion:** for the top 3 chunks, attach the adjacent chunk
   (index ±1) when it fits the budget, so steps aren't cut mid-list.
   - Needs a small ACL-checked RPC: `ai_get_chunks(document_id, from_idx, to_idx)`.
4. **Recency (reports only):** when no period is given, apply a half-life decay of 120 days.
5. **Reports: sections are narrative by default.** `search_reports` searches
   `summary`, `insights:*`, `written:*` and `offsite` unless the question asks
   for tables (e.g. "which creators…" → `table:creators`).
   - **Number tables are for the data tools**, not for semantic search.
6. **Pack:** up to a token budget (as tuned in WP-A: company 2,500 · **reports 3,500 · tiktok 3,500** · incentives 1,200). **Rerank is ON** by default, but only for `search_reports` with no brand filter (it lifts cross-brand narrative recall from 0.85 to 0.90). **The crowd-out gate is causal crowd-out = 0 %**, with overlap-strict as a watch figure,
   each chunk with a citation id and metadata (title, url, brand, period,
   approved status, currency).

### 2.4 Query formulation
- The agent writes a **corpus-specific query**: short and keyword-rich, with
  names and periods resolved. Follow-ups are rewritten into standalone queries.
- **Brand resolution:** `resolveBrands(name)` → ids, via `ilike` + trigram
  similarity; ambiguous → the agent asks. Needs `pg_trgm` (available on dev,
  not installed; install it in the Phase 5 migration).
- **Period resolution:** `resolvePeriod("June" | "last week" | "Q3" | "week 12")`
  → a PKT date range.
- **Synonyms** (the v1 list plus more): time off→leave, punch/clock→attendance,
  budget/ROI→GMV Max, influencer→creator, banned→violation.

### 2.5 Optional rerank stage, only if the numbers justify it
A cheap LLM relevance scorer (the fast model, low effort) over the top ~20
candidates of an index → top N. **Off by default. Switched on per index only if
the retrieval eval (§6.1) shows recall@8 below target.** It's a parameter in
`ai_assistant_config.retrieval`.

---

## 3. Source authority and answer policy
Rules in the system prompt, **verified by the eval**:
1. **"How do we / our process / our SOP / what should I do at Wurx"** → `company` first. It governs.
2. **TikTok platform rules** (policy, fees, eligibility, ad products) → `tiktok` is authoritative for *what TikTok requires*.
3. **Both relevant** → answer in two labelled parts, "Our SOP says …" and
   "TikTok Shop Academy says …", then a one-line summary.
   - **If they conflict**, say so and advise confirming with the TL or OL. Never blend them silently.
4. **Link-only KB articles** (28 still pointers) → give the link and say the
   full text isn't in the assistant yet. **Never invent the steps.**
5. **Brand and client performance** → numbers from the data tools
   (approved-only), narrative from `search_reports`. **Never quote a number
   that appears only in retrieved text.** Numbers come from `[D#]` tool results.
6. **Unapproved newer report** → mention "awaiting approval", never quote it.
6a. **Monthly figures the monthly report doesn't record** (Owner, 2026-09-29),
   e.g. items sold per creator, which monthly reports lack (they have only
   username + GMV):
   - Buddy **calculates them from the approved weekly reports** for that month
     and **says so explicitly**: "Monthly reports don't record items sold, so
     I've added them up from the approved weekly reports (Weeks 10–12)."
   - It always states which weeks were used, which were excluded (straddling
     weeks, unapproved weeks) and why, and that a creator's weekly total covers
     only the weeks they made the top list.
   - When the monthly report IS approved, its figures (e.g. the top creator by
     GMV) are used first, and the weekly-derived figures only fill the gaps.
   - When the monthly report is NOT approved, the whole answer is derived from
     the approved weeklies, labelled as such, and the monthly is mentioned as awaiting approval.
7. **Every factual sentence carries a citation** (`[S#]` search, `[D#]` data).
   The server strips any id it didn't return this turn.

---

## 4. Answering from reports: worked flows
| Question | Tools (model-chosen) | Answer shape |
|---|---|---|
| "How did Pure Daily Care do in August?" | `resolveBrands` → `get_reports(brand, Aug, monthly, [metrics])` + `search_reports(brand, Aug, "insights key wins recommendations")` | GMV/orders/ROI [D1], then the "why" from insights [S1–S3] |
| "Why did Bentgo's GMV drop last week?" | `compare_periods(brand, gmv, last week, the week before)` + `search_reports(brand, both weeks, "GMV drop reasons insights")` | delta [D1], then the reasons as written by the APC [S#] |
| "Which brands had strong GMV Max results in August?" | `rank_brands(gmv_max_roi or gmv_max_gmv, Aug)` + `search_reports(period=Aug, sections=[insights, table:gmvmax], "GMV Max")` for the top 3 | ranking with coverage ("16 of 20 brands have approved reports") [D1] + the notes [S#] |
| "What did we recommend to creators this month?" | `search_reports(period=this month, sections=[written:recommendations], "creator outreach")` | grouped by brand, cited |
| "Full report for Aqua Sonic week 34" | `get_reports(brand, week 34, all sections)` | structured, from JSON |

**New data tools for reports:** `rank_brands(metric, period)` over approved
reports' parsed metrics (including GMV Max ROI/GMV/spend from the gmvMax
table), `compare_periods`, `brand_overview`, and `get_gmv_max`. All are
approved-only, currency-aware, and report their coverage.

## 5. Answering from our SOPs: worked flows
| Question | Tools | Answer |
|---|---|---|
| "What does our SOP say about approving sample requests?" | `search_company_knowledge("approve sample requests")` | the steps from "How to approve sample requests" [S1] (+ the variant SOP) |
| "How should we appeal a violation?" | `search_company_knowledge` + `search_tiktok_academy` | "Our SOP: … [S1]" / "TikTok Academy: … [S2]" + summary |
| "How do I set up a GMV Max campaign?" | `search_company_knowledge` (internal SOP) + `tiktok` for platform details | our steps first, TikTok specifics second |
| "What is TikTok's late dispatch rate requirement?" | `search_tiktok_academy` | TikTok's rule [S1] |

---

## 6. Proving it: evaluation before the agent is trusted

### 6.1 Retrieval eval: fast, no LLM, run on every change
- `scripts/eval-retrieval.mjs`: for every eval question with `expected_sources`,
  run the index tool the policy expects, and `search_everything`, as the Boss.
  Measure **recall@8 per index and category**, plus the **"crowd-out rate"**:
  the share of company/report questions whose expected source is missing
  because TikTok filled the list.
- **Targets:** company (sop, how_to) ≥ 0.90 · reports narrative ≥ 0.85 ·
  tiktok ≥ 0.90 · federated crowd-out ≤ 5 %.
- **Cost:** query embeddings only, cents per run. **Tuning loop:** quotas,
  candidate counts, sections, synonyms, rerank on/off.

### 6.2 Eval-set fixes (QA)
- **Remap** the SOP rows' `expected_sources` from `ai_doc` ids to their merged `kb_article` ids.
- **Add ~20 "overlap" questions** where our SOP and TikTok both cover the topic
  (samples, violations, GMV Max, listings, LIVE). Expected: the SOP cited, and
  TikTok cited only when relevant.
- **Add report-narrative questions without a brand name** (cross-brand), and
  "which brands…" ranking questions.

### 6.3 Agent eval (end-to-end, with an LLM judge)
- `tests/eval/run-eval.mjs --engine v2` against a **local server** running the
  agent core (no deployment needed for dev testing).
- **Gates (A§16.3):** numeric ≥ 0.95, citation validity 1.00, 0 permission
  leaks, recall@8 ≥ 0.85, correctness ≥ 4.2.

---

## 7. Agent core
- **LLM adapter:** OpenAI Responses API (function tools + reasoning).
  - Models are allow-listed; default `gpt-5.4-mini`, with `gpt-5.5` as the stronger option.
  - The Gemini adapter comes later (Phase 6 bake-off).
- **Loop:**
  - up to 3 tool rounds, up to 4 parallel calls per round;
  - tool rounds use low effort, and the answer is streamed;
  - 60k-token ceiling per question, and the empty-answer retry is kept.
- **Persona: Wurx Buddy** (Owner, 2026-09-29). Spec in `persona.md`: help / explore / grow;
  warm, short, one light touch per answer; serious topics have no jokes;
  role-aware; hard lines where facts and permissions always win. The default
  persona text is generated from `persona.md`; the Boss can edit
  `ai_assistant_config.persona`. The eval judge adds a tone rubric that never
  offsets accuracy.
- **Prompt:** a stable, cacheable prefix (persona, role capabilities, the
  authority policy of §3, the tool rules, a generated page list), then a
  dynamic tail (user, date in PKT). Retrieved text arrives only through tool results.
- **Grounding:**
  - citation validation;
  - numbers must trace to `[D#]`; answers are flagged (logged) when a number has no citation;
  - retrieved text is wrapped as data (injection guard).
- **Memory:** last 12 turns / 6k chars; tool results are not replayed from history.
- **Logging:** `ai_request_log` per question (tools, retrieved chunk ids + cited
  flags, tokens, cost, latency). A rate limit of 30 per hour per user; eval
  users are exempt.
- **Transport:** same SSE contract as v1, plus `sources` (source_type,
  source_id, title, url, period) and `requestId`. Implemented as:
  - pure-TypeScript core in `_shared/ai/agent/`;
  - `supabase/functions/assistant/index.ts` (Deno, deployed later with the Owner's login);
  - `scripts/serve-assistant.mjs` (a local Node server for dev testing and eval).
- **Auth:**
  - Boss-only (as v1);
  - search runs with the caller's JWT, so the ACL applies;
  - the Slack relay uses service role + `p_as_user`.
- **No engine switch, no fallback (Owner, 2026-09-29).** v2 (`assistant`) fully
  replaces v1 (`ai-chat`) at cutover.
  - v1 stays untouched until then; dev testing of v2 goes through the local server and the eval.
  - At cutover: the app calls `assistant`; the Slack relay points to it; `ai-chat` is retired.
  - The unused `ai_assistant_config.engine` column is dropped in the Phase 7 migration.
  - Rollback is by redeploying the previous version (backup tags), not a UI switch.

## 8. Tool catalog (v2)
- **Search:** `search_company_knowledge`, `search_reports`, `search_tiktok_academy`, `search_incentive_plans`, `search_everything`.
- **Reports (approved-only):** `get_reports`, `get_top_creators` (rule 6a: monthly
  gaps derived from the approved weeklies, with a disclosure), `compare_periods`,
  `rank_brands`, `brand_overview`, `get_gmv_max`.
  - **Before any multi-role rollout (Phase 8):** `brand_overview` must mirror the
    `brand_monthly_metrics` RLS, and `get_reports` must honour `can_view_report`'s
    "author sees own report" rule for non-Boss callers.
- **People and pay** (ported from v1 unchanged, including overlays): `find_person`, `get_employees`, `get_incentives`, `get_salary`, `get_performance`, `get_attendance`, `get_leave`.
- **Other:** `list_brands`, `get_agenda_tasks`.
- **Helpers:** `resolveBrands`, `resolvePeriod`, `parseMetric`, `normTier`.

## 9. Build plan (sequenced to avoid dev-DB contention)
| WP | Owner | Content | Depends |
|---|---|---|---|
| **A: Retrieval layer** | Engineer 1 | index tools, federated search, diversity / neighbours / recency / section defaults, `ai_get_chunks` + `pg_trgm` migration, resolvers, `eval-retrieval.mjs`; **tune to the §6.1 targets** | — |
| **B: Data tools** | Engineer 2 | port the 9 v1 tools (approved-only change on `get_reports`), new report tools, `parseMetric`, tests | — (reads only) |
| **C: Eval-set fixes** | QA | §6.2 remap and additions, plus labels for retrieval eval | — |
| **D: Agent core + servers** | Engineer 1 | LLM adapter, loop, prompt, citations, SSE, logging, the local server, the Deno wrapper | A, B |
| **E: Acceptance** | QA | retrieval eval gates, tool tests, security (ACL through tools), end-to-end eval v2 on 117+ questions | D |
| **F** | Progress Keeper / Notebook | log, backup, a minimal notebook note | E |

**DB rule:** only one agent runs heavy database tests at a time. The Lead sequences them.

## 10. Cost
| Item | Cost |
|---|---|
| Retrieval eval | ~$0.01 per run |
| Agent eval, 140 questions on `gpt-5.4-mini` + judge | ≈ $1–3 per full run (verify prices on the day) |
| Development spend | under the TEAM.md per-task cap; the Lead approves the eval runs |

## 11. Risks
| Risk | Mitigation |
|---|---|
| The model picks the wrong index | the routing policy in the prompt + `search_everything` for unclear intent + eval categories per route |
| Tool definitions cost tokens every round | stable prefix, so prompt caching applies |
| Report metrics are strings in varied formats | `parseMetric` + raw values kept; unparseable values are never guessed |
| Cross-brand questions hit reports this APC can't see | the ACL filters it; answers state their coverage |
| The dev pooler is flaky | retries and timeouts in the tools; tests run sequentially |
