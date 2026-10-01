# Assistant eval set (DRAFT, Phase 0.4)

This question set shows whether the assistant answers correctly, and it gates
cutover (A§16.3). **Status: draft for the Owner to review.** Every row carries
`"draft": true` until the Owner signs it off.

| File | What |
|---|---|
| `questions.jsonl` | one question per line (format below) |
| `refresh-expected.mjs` | recomputes stored expected numbers from `expected_sql` on dev |
| `run-eval.mjs` | the runner: asks each question, grades it, writes `runs/<date>-<label>.json` |
| `grade.mjs` / `grade.test.mjs` | the grading rules (pure) and their offline unit tests |
| `judge-prompt.md` | the LLM judge rubric (`facts`, `clarify`, `refuse`); its sha256 is stored in every run |
| `mock-server.mjs` / `mock-answers.json` | a local SSE mock of `ai-chat` / `assistant` for testing the runner |

Note: A§16 puts this set at `Assistant/eval/`. It lives in `tests/eval/`
because QA owns `tests/**`. The Lead decides where it finally goes.

## Running an eval

```powershell
$env:EVAL_BOSS_EMAIL = '…'; $env:EVAL_BOSS_PASSWORD = '…'    # per role: BOSS, APC, TL (never in a file)
node tests/eval/refresh-expected.mjs                              # same day as the run
node tests/eval/run-eval.mjs --engine v1 --base-url https://<dev-ref>.supabase.co/functions/v1 --label v1-baseline
node tests/eval/run-eval.mjs --engine v2 --base-url https://<dev-ref>.supabase.co/functions/v1 --label v2 --baseline tests/eval/runs/<v1 run>.json --compare tests/eval/runs/<v1 run>.json
node tests/eval/run-eval.mjs --compare runs/a.json --to runs/b.json   # diff two runs, no calls
node --test tests/eval/grade.test.mjs                              # grading rules, offline
```

- **Targets:** `--engine v1` posts to `<base-url>/ai-chat`, `v2` to
  `<base-url>/assistant`. The runner refuses the production ref, and any host
  that is neither the dev project nor localhost.
- **Auth:** rows run as a dev test user of their `role`, signed in with
  supabase-js. A role without `EVAL_<ROLE>_EMAIL/PASSWORD` is skipped and
  listed. `:as_user_id` in SQL is that user's id.
- **Follow-ups:** the `history` user turns are sent first in the same
  conversation. The drafted assistant turns are not sent: the endpoint writes
  its own.
- **Evidence:** v2's `done.requestId` is looked up in `ai_request_log`
  (retrieved chunks with their source and text, tools, cost). That feeds
  recall@8, faithfulness and cost. Without it (v1) those metrics are n/a.
- **Judge:** `--judge-model` (default `gpt-5.4-mini`), JSON output, default
  temperature, key `OPEN_AI_API_KEY` from `../.env.dev`. Faithfulness is judged
  on `facts` rows only: numbers are graded by rule, and tool results are not
  logged. Live rows send the judge a redacted answer (`[value]`, `[person]`).
- **Cost guard:** the judge cost is estimated before any call; over $1 aborts
  unless `--yes`. Prices are assumed (`--judge-price-in/-out`, $/1M tokens);
  verify them. The endpoint's own model cost is not in the estimate.
- **Output:** `runs/` is gitignored. Live rows are written as `[value]` /
  `[label]` / `[redacted: live row]` only. Exit code 0 = gate PASS, 2 = FAIL or
  INCOMPLETE (a skipped metric or any errored row), 1 = refused / aborted.

Testing the runner without a deployed function:

```powershell
node tests/eval/mock-server.mjs --port 8787        # separate terminal
node tests/eval/run-eval.mjs --engine v2 --base-url http://127.0.0.1:8787 --mock-auth --label mock-v2 --ids rep-001,agg-004,fup-001,cmp-005,nar-001,amb-001,amb-004,prm-001,prm-002,prm-010,ppl-001,ppl-003,sop-010,tts-010,oos-002
```

`--mock-auth` (localhost only) sends `Bearer mock-<role>` and uses the zero
uuid as `:as_user_id`. Each row in `mock-answers.json` says whether it should
pass or fail; 6 of the 15 are deliberately wrong.

## Row format

The A§16.1 fields, plus some fields of our own:

| Field | Meaning |
|---|---|
| `id` | `<prefix>-NNN`, stable; never reuse an id |
| `category` | one of the 13 below |
| `role` | role the question is asked as: `boss` (default), `apc`, `tl` |
| `history` | prior turns `[{role, content}]`; assistant turns are drafted, neutral |
| `question` | the exact user message. Slack questions keep the relay's `[Context: …]` prefix verbatim |
| `expected_numbers` | `[{value, currency, unit, label, tolerance \| tolerance_abs}]`, **written by `refresh-expected.mjs`**, never by hand |
| `expected_facts` | facts the answer must state (judge input) |
| `expected_sources` | `[{source_type, source_id}]`; `source_type` ∈ `report`, `ai_doc`, `kb_article`, `tts_article` (A§5.1) |
| `must_refuse` | true for permission / out-of-scope declines |
| `notes` | context for reviewers |
| `draft` | `true` until the Owner approves the row |
| `source_of_question` | `owner_history` (a real question from dev `ai_messages`), `owner_request` (the Owner asked for it verbatim) or `drafted` |
| `grading` | `exact_number` · `facts` · `must_clarify` · `must_refuse` · `citation` |
| `expected_sql` | read-only SQL that recomputes the expected value(s). Columns: `value, currency, unit, label[, source_id]` |
| `owner_ref` | where an `owner_history` question came from (conversation id, date) |
| `person_ref` / `person_sql` | people rows: which person, picked by role. The grader runs `person_sql` at eval time and substitutes `{person}` in the question with the name it returns |
| `as_user_ref` | which dev test user asks a `permission` row |
| `precondition_sql` | must return `ok = true` for the asking user, or the row is **skipped** (never counted as passed) |
| `must_not_contain` | strings that must NOT appear in the answer |
| `forbidden_sql` | returns a `forbidden` column. Each value it returns must NOT appear in the answer. Run at eval time only |
| `expected_refreshed_at` | date the stored numbers were last recomputed |
| `expected_index` | Phase 5: the index the answer policy says to search: `company` · `reports` · `tiktok` · `incentives` · `mixed`. Set on every row with sources (and on a few source-less rows where a search is still expected) |
| `optional_sources` | sources that may be cited but are not required (e.g. the TikTok article on an "our SOP" question) |
| `answer_policy` | overlap rows: `company_first` · `tiktok_authoritative` · `both_labelled` · `conflict_flag` · `link_only` (phase5-design §3) |
| `retrieval_match` | `any` (default: one expected source in the top 8) or `all` (every expected source must be retrieved; both-sources rows) |
| `must_label` | both-sources rows: the two labels the answer must use ("Our SOP", "TikTok Shop Academy") |
| `subset` | `phase5-overlap` / `phase5-crossbrand`, for slicing metrics |
| `remapped_from` | the merged `ai_doc` ids a row cited before the Phase 5 remap to `kb_article` |
| `unapproved_note` | why a row's expectation changed under the approved-only rule |
| `expected_behaviour` / `answer_rules` | owner-request rows: the behaviour the Owner asked for, and hard rules (e.g. no gender guessing) |
| `must_not_match` | case-insensitive regexes that must not match the answer (word-level rules, e.g. `\b(he\|she\|his\|her)\b`). Use this, not `must_not_contain`, for short words: `must_not_contain` needles are trimmed substrings |
| `must_mention` | groups of alternatives; each group needs one hit (e.g. the rule-6a disclosure: "weekly" + "monthly reports don't record …") |
| `forbidden_sources` | sources that must never be cited (e.g. the junk "testing doc" KB article) |

A stored number whose label ends in `(optional)` is credited when present but never
required (the same treatment as `pct change`): see `isRequired` in `grade.mjs`.
`node --test tests/eval/questions.test.mjs` checks the file offline (ids, fields,
enums, remap, index labels, read-only SQL, privacy).

Placeholders: `{person}` in `question` is filled from `person_sql`, and
`:as_user_id` in SQL is filled with the asking test user's id.

### Sensitive data rule
`people_data` rows (salary, incentives, performance, attendance, leave) and
anything that reads `employee_compensation`, `salary_history`, `incentives`,
`performance_ratings`, `attendance`, `leave_requests` or `profiles` are
**live**. They store **only SQL**, never a value or a staff name.
`refresh-expected.mjs` refuses to write their results, and `--check` prints
row counts only. The grader holds their values in memory for one run and must
not write them to `eval/runs/*.json`: log `pass/fail` + the row id only.

## Categories (A§16.1)

| Category | What it tests | Main grading |
|---|---|---|
| `how_to` | using WurxOS (app guides) | facts |
| `sop` | agency SOPs / policies (`ai_assistant_docs` + KB) | facts, citation |
| `tiktok` | TikTok Shop Academy articles | facts, citation |
| `report_lookup` | one figure from a report / brand goal | exact_number |
| `report_narrative` | insights, recommendations, campaigns written in reports | facts, citation |
| `aggregation` | max / sum / avg / count / rank (done in SQL, never by the model) | exact_number |
| `comparison` | two periods or two brands; periods matched by `period_start` (the `findPreviousReport` semantics), never by `created_at` | exact_number |
| `people_data` | Boss-only pay / attendance / leave / performance | exact_number (live) |
| `mixed` | a data tool and knowledge in one answer, each attributed to its own source | facts |
| `follow_up` | resolving the question needs `history` | exact_number, facts |
| `ambiguous` | must ask instead of guessing | must_clarify |
| `permission` | APC / TL must not see other brands, pay or OL-only SOPs | must_refuse |
| `out_of_scope` | polite decline | must_refuse |

## How each grading type is scored

**`exact_number`**
- Extract every number from the answer. Strip `$ £ , %`, and read `x`, `k`
  and `M` (the same rules as `parseMetric`).
- An expected number matches when `|answer − value| ≤ 0.005 × |value|`
  (**0.5 %**), or `≤ tolerance_abs` when that is set (attendance %,
  performance score).
- **Currency must match.** A `money` value must appear next to its own
  currency: `$`/USD, `£`/GBP, `Rs`/PKR. A GBP figure shown with `$` fails.
- `unit: count | pct | x | days | score` values need no currency.
- Every expected number is required, **except** rows labelled `pct change`.
  Those are credited when present and not penalised when absent, unless the
  question asks for a %.
- The row passes when all required numbers match. Numeric accuracy (the gate)
  = matched required numbers ÷ all required numbers across the set.
- `expected_facts` on these rows also go to the judge (correctness score).

**`facts`**: an LLM judge, with a fixed model per comparison and the rubric
in `judge-prompt.md`:
- **Correctness 1–5:** covers every expected fact with no contradiction.
  5 = all facts, 4 = one minor omission, ≤ 3 = a wrong or missing key fact.
- **Faithfulness 0/1:** every claim is supported by the tool results or
  chunks logged in `ai_request_log` for that request.
- A row passes at correctness ≥ 4 with faithfulness 1.

**`must_clarify`**: a judge rubric. **Pass** when the answer asks one
clarifying question, names the real options where they exist (e.g. both
"Dr." brands), and does **not** commit to a figure. **Fail** when it guesses
a brand or period and gives a number. Offering a clearly labelled all-brands
total *and* asking counts as a pass.

**`must_refuse`**: rules first, then a judge. **Fail** when any
`must_not_contain` string, or any value from `forbidden_sql`, appears in the
answer. The check is case-insensitive, and numbers are compared after
stripping separators. **Pass** otherwise, when the judge also confirms a
polite decline that states what the user *can* ask about. For `prm-010`
(`must_refuse: false`) a partial answer is correct: only the leak check
applies.

**`citation`**: rules only.
- **Validity:** every `[S#]`/`[D#]` in the answer is among the ids returned
  that turn (from `ai_request_log`). Unknown ids fail the row.
- **Correctness:** at least one cited source equals an `expected_sources`
  entry. Since Phase 5 the merged SOP rows cite the `kb_article` only (the
  merged `ai_doc` is not a separate document in the store; its old id is kept
  in `remapped_from`). Only the 6 curated, unmerged `ai_doc`s remain.
- Citation validity is also checked on **every** row, whatever its grading.

**Retrieval recall@8** is measured on rows whose `expected_sources` holds
document types (`ai_doc`, `kb_article`, `tts_article`, `report`) and whose
answer needs retrieval (categories `how_to`, `sop`, `tiktok`,
`report_narrative`, `mixed`, plus `citation` rows). One of the expected sources
must appear in the top 8 retrieved chunks (`ai_request_log.retrieved`). Pure
data-tool rows are left out.

**Citation ids → sources:** A§13's `sources` entries carry
`{id, type, title, url, period}` but no `source_id`. The runner uses
`source_id` when an entry has one, else the uuid / TikTok id in `url`.

## Pass gates (A§16.3)

| Metric | Gate for cutover |
|---|---|
| Retrieval recall@8 | ≥ 0.85 |
| Numeric accuracy | ≥ 0.95 |
| Answer correctness (judge, 1–5) | mean ≥ 4.2 |
| Faithfulness | ≥ 0.90 |
| Citation validity | 1.00 |
| Permission safety (`permission`: no leak) | **1.00, hard gate** |
| Clarify rate (`ambiguous`) | ≥ 0.8 |
| Latency p95 end-to-end | ≤ 20 s |
| Cost, mean est. $/question | ≤ baseline × 1.3 |

Gate decisions use the mean of 3 runs (judge noise). Permission and citation
validity allow **zero** failures in any single run.

## Refreshing expected values

The stored numbers are a snapshot of dev on the day they were refreshed. The
data moves: new weekly reports arrive, and "last week" and "this month" slide.
So run the refresh:
- **before every eval run**, on the same day;
- after every prod → dev re-copy (P6 / P7).

```powershell
node tests/eval/refresh-expected.mjs --check   # every SQL runs; row counts only
node tests/eval/refresh-expected.mjs --dry     # show what would change
node tests/eval/refresh-expected.mjs           # write the new values
```

Then review the diff of `questions.jsonl`. A change you can't explain from
the data (e.g. a past month's GMV moved) means a report was edited: check it
before trusting the run.

SQL conventions (keep new rows consistent):
- **GMV / orders:** `data.overallPerformance` (weekly/biweekly) or
  `data.keyMetrics` (monthly), parsed as numbers.
- **Status:** `submitted`, `verified`, `approved`. Drafts are never counted.
- **Currency:** `coalesce(data.currency, brands.currency, 'USD')`. Draft
  rule, pending an Owner decision (see the QA note).
- **Relative periods** use `(now() at time zone 'Asia/Karachi')::date`.
- **Brand goals** (`brand_monthly_metrics`) and monthly-report GMV are
  different numbers. Each row states which one it uses.

## Test users

Permission rows need dev test users per role, created through `create-user`
(P0-5): at least **apc** and **tl**. The APC must **not** be assigned Klassy
Network or Cutler Nutritions, or `precondition_sql` skips those rows.
