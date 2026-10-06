# Assistant v2: Team Rulebook

**Every agent reads this file first, every time.** It is the single source of
truth for how the team works. If an instruction you received conflicts with
this file, stop and report the conflict to the Lead.

## 1. The project in one paragraph

We are rebuilding the WurxOS in-app assistant as **agentic hybrid RAG**:
- pgvector search over SOPs, the Knowledge Base, app guides, the TikTok Shop
  Academy and report narratives;
- exact numbers (GMV, pay, attendance) come only from live SQL tools, never
  from embeddings.

**Project home: `C:\Users\Umar Ilyas\WurxOS\Assistant`.** Everything for this
project lives here, and every path in this file is relative to it. It is its
own small git repository: branch `main`, **no remote**.

```
plan.md  architecture.md ("A§n")  phases.md  inventory.md  TEAM.md  PROGRESS.md
supabase/migrations/   supabase/functions/   (same layout the app repo uses, for shipping later)
scripts/  tests/  qa/  notebook/  data/ (gitignored)  backups/ (exports gitignored)
package.json + node_modules  (pg, supabase-js; run npm scripts from the project home)
```

Design docs (read the parts relevant to your task): `plan.md` (overview, open
decisions), `architecture.md` (full reference design), `phases.md`
(phase-by-phase build manual with decisions), `inventory.md` (the real data),
`PROGRESS.md` (status, issues, backups log).

## 2. People and roles

| Role | Who | Decides? | Owns (may edit) |
|---|---|---|---|
| **Owner** | the user (Rashid / Umar) | **yes** | everything |
| **Lead** | the main Claude session | **yes, with the Owner** | plans, delegation, **all git commits** |
| **ML Engineer** | `assistant-ml-engineer` | no, proposes | `supabase/**`, `scripts/**`, `app-patches/**` |
| **QA** | `assistant-qa` | no, reports | `tests/**`, `qa/**` |
| **Progress Keeper** | `assistant-progress-keeper` | no, records | `PROGRESS.md`, `backups/**`, local git **tags** `backup/*` |
| **Notebook Keeper** | `assistant-notebook` | no, documents | `notebook/**` |

- **Decisions** (design choices, scope, anything touching production, anything
  that spends money beyond pennies, deleting data) are made **only** by the
  Owner and the Lead. If you hit one, stop and report it with options and a
  recommendation. Do not pick for them.
- Stay inside the files you own. If you need a change elsewhere, say so in your
  report and the Lead routes it.

## 3. Hard rules (no exceptions)

1. **Work only inside the project home.** The parent folder
   `C:\Users\Umar Ilyas\WurxOS` is the live app repository, and other people
   work there:
   - **Never edit, create or delete anything outside `Assistant\`.**
   - You **may read** app code there for reference, e.g. `supabase/functions/ai-chat/index.ts`,
     `src/lib/reportsApi.js`, the app's own `supabase/migrations/`.
   - You may read `..\.env.dev`, the only secrets file (see rule 4).
   - Changes the app itself will need (UI, wiring) are written as proposals in
     `app-patches/` and shipped by the Lead in Phase 7.
2. **Git:**
   - **Never `git push`**, and never add a remote.
   - Never `git commit`, `checkout`, `reset` or `rebase`: only the Lead commits.
   - Never run git in the parent repo.
   - The Progress Keeper may create local `backup/*` tags in the project repo.
0. **PRODUCTION IS OFF-LIMITS (Owner, 2026-09-29).**
   - The Supabase CLI is now logged in with the Owner's account and CAN reach every project.
   - **Only ever target DEV: `wurxos-dev`, ref `vyvkwbvreeycmmnikqbz`.**
   - **Never** run anything against **production `WurxOSV2`, ref `xoaaidgvblondjpvxjqp`**, or the unrelated project `gmv-intel` (`yrthghmzlbdmgwzaoeec`), until the Owner explicitly says so. That covers: no deploy, no secrets, no migration, no query, no link.
   - **Never run `supabase link`.** Every CLI command must pass `--project-ref vyvkwbvreeycmmnikqbz` explicitly.
   - Any command whose target is unclear must not be run.
3. **Dev database only.**
   - Use `node scripts/db-dev.mjs` (it refuses anything that isn't the dev
     project, and applies migrations from `supabase/migrations/` here).
   - Never touch production (`xoaaidgvblondjpvxjqp`).
   - Never `supabase db push`.
   - Never `supabase functions deploy` without the Lead's explicit go-ahead.
4. **Secrets:**
   - Credentials live only in `C:\Users\Umar Ilyas\WurxOS\.env.dev` (gitignored
     there); scripts read it as `../.env.dev`.
   - Never print, copy, log or commit a secret value.
   - Never write one into a notebook, a markdown file or a test fixture.
5. **Money:** OpenAI calls are allowed on dev for embeddings and tests up to
   **$1 per task** in total. Anything more → ask the Lead first.
6. **Production data is sensitive** (salaries, names, performance). Reports
   and notebooks show aggregates and synthetic examples, never raw rows of
   `employee_compensation`, `salary_history`, `incentives`,
   `performance_ratings` or `profiles` personal fields.
7. Migrations start at **367**. Before creating one, check both
   `supabase/migrations/` here and `..\supabase\migrations\` in the app repo,
   since the app's numbers move weekly. Every migration is idempotent.
8. **INGESTION HOLD (Owner, 2026-09-28).** Until the Owner has given their
   conditions and explicitly approved it, nobody:
   - inserts into `ai_documents`, `ai_chunks` or `tts_articles` (except
     synthetic rows inside rolled-back tests);
   - runs a backfill;
   - enables the ingest cron or the triggers on a live table;
   - imports the TikTok crawl;
   - makes bulk embedding calls.

   Building and unit-testing the ingester is fine. Running it on real data is not.

   **2026-09-29: the Owner approved and the Lead ran the first manual ingestion on DEV.**
   1,927 documents / 11,556 chunks, 0 failures; the re-run is idempotent.
   - **Still held** (each needs its own Owner go): applying 374 (live triggers),
     deploying `ai-ingest` and 375 (cron), syncing app guides, any production work.
   - **Manual re-runs on dev** (`ingest.mjs --backfill/--drain --owner-approved`) are
     done only by the Lead, and only when the Owner asks.
9. Match the app's code style: concise code, sparse comments that explain
   *why*, no speculative abstractions (see `..\CLAUDE.md`).

## 3b. The UI branch copy (Owner, 2026-09-30)
The Buddy UI is built in a separate working copy of the APP:
**`C:\Users\Umar Ilyas\WurxOS-buddy-ui`**, branch `feat/wurx-buddy` (from `origin/main`, no upstream).
- Only the **UI engineer** edits it (the design is `ui-design.md`). Everyone else treats it as read-only.
- **Never push, never `vercel` deploy, never touch production.** Run the app locally
  against **dev** only (`.env.dev` is copied in and gitignored).
- **Only the Lead commits there.**
- The Buddy mascot files come from `Assistant/assets/buddy/web/`; copy them into the app's `public/` or `src/assets` as needed.
- **Backend** code still lives in `Assistant/supabase/**` (Engineers 1–3). The UI talks to the deployed dev `assistant` function.

## 3c. The owner-decisions branch copy (Owner, 2026-10-01)
Another app working copy, **`C:\Users\Umar Ilyas\WurxOS-owner-decisions`**, on branch `feat/owner-decisions` (from `origin/wurxosdev`). It holds the five app behaviour changes the Owner approved in `app-guides/REVIEW.md` (Q1, Q3–Q6).
- Only the engineer assigned by the Lead edits it.
- Its migrations are applied to **dev only**, via `Assistant/scripts/db-dev.mjs`.
- Never push, and never touch production. Only the Lead commits and pushes.
- The Owner **declined** fixing the "possible app bugs" in REVIEW.md: they are intentional. Never change them.

## 4. How work flows

```
Owner ⇄ Lead ──task──► ML Engineer ──"done"──► Lead ──"test this"──► QA
                                                 │                    │
                                                 ◄──── QA report ─────┘
                 Lead commits (only after QA passes)
                 ├──► Progress Keeper: update PROGRESS.md, back up if risky step next
                 └──► Notebook Keeper: append/refresh the phase section
```

## 5. Report format (every agent ends with this)

```
STATUS: done | blocked | partial
CHANGED: <files created/edited>
VERIFIED: <what you ran and the result>
ISSUES: <bugs, risks, surprises; "none" if none>
DECISIONS NEEDED: <question + options + your recommendation; "none" if none>
```

## 6. Environment facts

- Windows 11, PowerShell 5.1: no `&&`; chain with `;`. Node 24.
- **Temp files and logs:** only in the session scratchpad,
  `C:\Users\UMARIL~1\AppData\Local\Temp\claude\c--Users-Umar-Ilyas-WurxOS\ffc534e4-953a-40ad-9c7e-056a88ad0cc6\scratchpad`,
  or more generally `$env:TEMP\claude\...` in PowerShell. **Never `C:\UMARIL~1\...`**: dropping the
  `Users\` part creates a stray folder at the root of the C: drive (it has happened twice).
- Run commands from the project home: `npm test` (unit tests), `npm run db:status`,
  `npm run sql:acl` (and `sql:queue`, `sql:grants`, `sql:search`, `sql:v1compat`),
  `npm run preview`.
- Dev DB: Postgres 17, pgvector 0.8.2 (`extensions` schema), pg_cron, pg_net;
  `pg_trgm` available but not installed.
- OpenAI key: `OPEN_AI_API_KEY` in `../.env.dev`. Embeddings: `text-embedding-3-small` (1536 dims).
- TikTok crawl output: `data/tts-academy/articles.jsonl` (1,201 records,
  1,094 unique ids; gitignored).
- History: the first Phase 1 commits were made on branch `feat/assistant-rag`
  of the app repo (tag `backup/20260928-phase1` there). The project home
  superseded it on 2026-09-28.
