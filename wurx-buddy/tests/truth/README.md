# Buddy truth evaluation

Does Buddy ever state something false? This suite answers that for the data side: people, performance, attendance,
leave, incentives, pay, reports and brands. 51 golden questions (`golden.mjs`), two legs.

| Leg | What runs | Data | Network |
|---|---|---|---|
| 1 Tools (default) | each question's data tool, as the Boss | the REAL production snapshot | none |
| 2 LLM (`--llm`) | the full agent loop (`runTurn`, grounding check included) with a free model | a PSEUDONYMISED copy of the snapshot | Gemini or Groq |

Leg 1 compares every tool's text with truth computed from the raw rows by code that shares nothing with the tools
(`truth.mjs`). `--sql` also re-checks the key numbers with live **read-only** SQL on production (headcounts, payroll
total, brand counts, leave overlap).

Leg 2 never sends real people, pay or clients to a free model: `pseudo.mjs` replaces names, salaries, incentive
amounts, brand names, creator handles and every free-text note first, and the expected answers are computed from the
fake world. (The turn runs in the normal "paid slot" mode so the free-tier guard for pay data stays untouched; only the
test seam sends the call to the free model.)

## Run it

```bash
node wurx-buddy/tests/truth/snapshot.mjs                 # once: read-only snapshot of production (needs .env.production)
node --experimental-strip-types --no-warnings wurx-buddy/tests/truth/run.mjs --sql          # leg 1 + SQL twins
node --experimental-strip-types --no-warnings wurx-buddy/tests/truth/run.mjs --llm --pace-ms 6000   # + leg 2 (Gemini)
#   --provider groq --model openai/gpt-oss-120b     --only perf-03,people-01     --limit 10
```

Prints a pass/fail table; exit code 2 if leg 1 or an SQL twin fails. Output goes to `runs/` (gitignored).

`.snapshot/` and `runs/` hold real people, pay and client data and are gitignored. Never commit them.

## What a question looks like

`must` / `mustNot` are lists of strings, regexes or `{any: [...]}`, resolved from the snapshot at run time (so no real
name or figure lives in git). `formerOk` names may appear only with a "former / left / no longer" marker in their line or
block. Every answer is also checked for the incident: a former employee shown as current staff.

## Files

`snapshot.mjs` (read-only dump) · `prodq.mjs` (SELECT-only Management API helper) · `load.mjs` (snapshot as a fake
supabase client) · `pseudo.mjs` · `truth.mjs` · `golden.mjs` · `run.mjs` · `selfcheck.mjs` (a tool's own text must pass
the grounding check: false-positive guard) · `explore.mjs` / `lengths.mjs` (inspect one tool / output sizes).

## Known limits

RLS is not modelled (the snapshot is read as the Boss): access control is tested at the tool-gate level in
`__tests__/tools.test.ts`. Truth for incentive "earned" does not re-implement the attendance / GMV Max overlays, so
those questions ask for goal counts instead. The free models are weaker than the production model and rate limited.
