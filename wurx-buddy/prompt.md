# Prompt: take Wurx Buddy live on production

> In the GitHub repo this workspace is the **`wurx-buddy/`** folder (on the Owner's machine it is a separate local folder called `Assistant/`; same content).
>
> **For the teammate.** Open Claude Code in the repo root on the `main` branch (`RashidNazeer/WurxOS`), then paste everything **below the line** as your first message. Claude works through it step by step and stops at every ⛔ gate for your OK. Budget about 2–3 hours, and stay at the keyboard: some steps need you to type passwords or log in. **Do not run it without the Owner's go-ahead.**

---

You are taking **Wurx Buddy** (the new in-app AI assistant) live on the **production** WurxOS stack. It is already built, tested and running on **dev**. Your job is to reproduce that setup on production **carefully, in order, with a dry run and a verification at every step**. Production serves about 30 staff, so treat every command that touches it as irreversible.

## 0. Read first (do not skip)

1. `CLAUDE.md` at the repo root: the app's conventions. Note: its line saying the "CLI is already linked" is **out of date**; nothing is linked on a fresh machine.
2. `wurx-buddy/runbook-ingestion.md`: how automatic ingestion works (queue, 12-hour sweep, crawl, pause and resume).
3. `wurx-buddy/ui-design.md` §6–§8: background replies, message status, role safeguards.
4. `wurx-buddy/architecture.md`: skim the sections on the store (`ai_documents` / `ai_chunks`), `ai_search` and the ingest queue.
5. `wurx-buddy/scripts/deploy-dev.ps1`: **the dev deploy you are reproducing.** Read all of it. Every production step below mirrors a step there. Do **not** run it: it refuses anything that isn't dev, on purpose.

**Where things live:**
- **The code that ships** is the app's own `supabase/` folder and `src/`. Deploy from there.
- **`wurx-buddy/`** is the design, test and tooling workspace. Its `supabase/` folder is a copy of the Buddy parts, not what you deploy. Its scripts read `../.env.dev`, which is dev only.

## 1. Hard rules

- **Projects:**
  - Production: `WurxOSV2`, ref `xoaaidgvblondjpvxjqp`.
  - Dev: `wurxos-dev`, ref `vyvkwbvreeycmmnikqbz`.
  - Unrelated, never touch: `gmv-intel`, ref `yrthghmzlbdmgwzaoeec`.
  - Pass `--project-ref` explicitly on every Supabase CLI call that accepts it.
- **Secrets:** never print, echo, log or commit one. When you set secrets, read them from a file or prompt the human to type them. Show only `name: set / not set`.
- **Dry run first:** a dry run before every write to production, and a ⛔ **gate** (stop and ask the human) before the real run.
- **Order matters:** database → functions and secrets → config and cron → frontend → content. If the frontend ships before the backend, Buddy breaks for everyone who loads the app.
- **Git:** no force pushes, no `reset --hard`, and no rewriting history. Tag before load-bearing changes.
- **Spend:** OpenAI spend over **$1** in one step needs a ⛔ gate. The full first ingestion is about **$0.07**; the TikTok articles about another $0.03.
- **Personal data:** salaries, performance and incentives are sensitive. Never paste real rows into chat or logs; use counts and aggregates.
- **If anything is unexpected** (a migration error, a missing extension, a history mismatch): **stop and report**. Don't improvise a fix on production.

## 2. What goes live

- **Database migrations** (in the app's `supabase/migrations/`):
  - Wurx Buddy: **367–389 and 395–397**. There is no 394.
  - The Owner's approved app changes: **390–393**. These cover Ads Manager leave going to the Boss, broadcasts limited to recipients (with a backfill), and the Resource Planner becoming Boss-only.
  - **398** (`developer_team_roles`) is someone else's change that is also on `main`. It is **not applied on dev yet**. ⛔ Ask the Owner whether it should ship now.
- **Edge Functions** (in `supabase/functions/`):
  - `assistant`: the chat agent. **JWT verification stays ON.**
  - `ai-ingest`: the ingestion worker. Deploy with `--no-verify-jwt`; it checks the `x-webhook-secret` header against `AI_INGEST_SECRET`.
  - `tts-crawl`: the weekly TikTok Shop Academy crawler. Also `--no-verify-jwt` with the same secret check.
  - All three share code in `supabase/functions/_shared/ai/`.
  - **Do not delete the old `ai-chat`**: the Slack relay (`slack-events`) still calls it.
- **Frontend** (from `main`, via Vercel):
  - the floating Buddy button, the Wurx Buddy tab (`/buddy`; `/assistant` redirects there) and Buddy settings;
  - the Owner-decision UI changes.
- **Content**, which the ingester builds on production: SOPs, the Knowledge Base, **approved** reports, incentive plans, 57 app how-to guides (from `wurx-buddy/app-guides/`) and the TikTok Shop Academy articles.
  - **Production builds its own vector store.** Never copy dev's store; the only exception is the public TikTok articles, if the Owner prefers that.

## 3. Pre-flight (read-only, then ⛔ gate)

1. **Branch and tag:**
   - `git status` is clean, you're on `main`, and it's up to date with `origin/main`.
   - Tag the commit **currently running on production**; ask the human which one it is, or use the last deploy in the Vercel dashboard: `git tag stable-pre-buddy-<date> <sha>`, then push the tag.
2. **Supabase backup:** in the Supabase dashboard (project `WurxOSV2` → Database → Backups), confirm a backup from today exists, or have the human trigger one or check that point-in-time recovery is on. ⛔ Don't continue without one.
3. **Link the CLI to production.** The human types the database password:
   ```
   npx supabase link --project-ref xoaaidgvblondjpvxjqp
   ```
4. **Extensions on production:** run through the SQL editor or `npx supabase db query` (read-only):
   ```sql
   select extname, extnamespace::regnamespace from pg_extension where extname in ('vector','pg_trgm','pg_cron','pg_net');
   ```
   - `vector` **must exist in schema `extensions`**, because migration 367 uses `extensions.vector(1536)` and does not create it.
   - `pg_cron` and `pg_net` must be enabled.
   - `pg_trgm` is created by migration 378.
   - If any is missing, ⛔ stop; the human enables it under Dashboard → Database → Extensions.
5. **Migration history:**
   ```
   npx supabase migration list --linked
   ```
   - **Known issue:** production has **365** (`emit_notification_lockdown`) applied, but the file isn't on `main`. It lives on branch `origin/fix/emit-notification-lockdown` (commit `8b6d965`). `db push` will refuse while the remote has a version that local lacks.
   - ⛔ Ask the Owner. **Preferred fix:** merge `fix/emit-notification-lockdown` into `main` first, so the file exists locally, then re-run the list. **Alternative:** `npx supabase migration repair --status applied 365` only if the Owner says so.
   - Report which versions are pending. Expect 367–393, 395–398, and nothing else.
6. **The OpenAI key must have credits.** Ingestion needs embeddings from the primary key. Probe with one tiny embedding call from a local script that reads the key from a file and **never prints it**:
   - `200` means OK;
   - `429 credit_balance_exhausted` means no credits.

   With no credits, Buddy can still answer through the free fallback model, but **production's knowledge base stays empty** until credits exist. ⛔ Tell the human and ask whether to continue.
7. **Resource Planner row:** on dev, `resource_planner_config` has a generated id instead of `'default'`. Check production: `select id from resource_planner_config;`. After migration 392 the Boss reads the `'default'` row. If it's different, ⛔ report it; don't change it on your own.

⛔ **Gate 1:** summarise the pre-flight results (tag, backup, extensions, pending migrations, credits, the 365 fix chosen) and wait for "go".

## 4. Database migrations

1. Dry run: `npx supabase db push --linked --dry-run` (add `--include-all` only if the list shows out-of-order files, and say why). Show the exact list of files it would apply.
2. ⛔ **Gate 2:** the human confirms the list.
3. Apply: `npx supabase db push --linked`. Watch for errors, and stop at the first one.
   - **382** backfills and indexes `ai_chunks`, which is empty on production, so it's quick.
   - **391** backfills `broadcast_recipients` from existing notifications and responses, so it's worth a quick count afterwards.
4. Verify (read-only):
   - `select public.ai_ingest_stats();` works.
   - The cron jobs exist: `select jobname, schedule, active from cron.job where jobname like 'ai-%';`. Expect `ai-finish-stale-replies */5`, `ai-housekeeping 30 22 * * *`, `ai-ingest-sweep 5 * * * *`, `ai-ingest-tick * * * * *`, `ai-tts-crawl-start 0 23 * * 6` and `ai-tts-crawl-tick * * * * *`. They do nothing until `app_config` has URLs (step 6); that's expected.
   - `select allowed_roles, model, fallback_enabled from ai_assistant_config;` shows `{boss}` and `gpt-5.4-mini`. **Leave `allowed_roles` as `{boss}`**: the Owner opens Buddy to roles himself.
   - Run the RLS/ACL self-checks from `wurx-buddy/tests/sql/` that are read-only and roll back. Read each file first; run only those that are wrapped in a transaction and rolled back, and never anything that inserts real data.

## 5. Function secrets and deploy

1. Secrets (`npx supabase secrets set --project-ref xoaaidgvblondjpvxjqp --env-file <temp file>`, then delete the temp file):
   - `OPEN_AI_API_KEY`: the production OpenAI key; it needs credits. `ai-ingest` and `assistant` read it. The code also accepts `OPENAI_API_KEY`.
   - `OPEN_AI_API_KEY_FALLBACK`: **optional**, the free fallback key (its `gpt-6-luna` model answers when the primary has no credits). ⛔ Ask the Owner. It may be on OpenAI's data-sharing programme, so staff data could be used for training. Set it only if he says yes.
   - `AI_INGEST_SECRET`: **generate a new random 32+ character value for production**; never reuse dev's. `ai-ingest` and `tts-crawl` use it, and it must match `app_config.ai_ingest_secret` (step 6).
   - `AI_INTERNAL_SECRET`: only if the Slack relay should call `assistant`. Today the relay calls v1 `ai-chat`, so leave it unset unless the Owner asks.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are provided by Supabase automatically; don't set them.
   - Verify with `npx supabase secrets list --project-ref xoaaidgvblondjpvxjqp` (it shows digests only).
2. Deploy each function separately, mirroring `deploy-dev.ps1`:
   ```
   npx supabase functions deploy assistant  --project-ref xoaaidgvblondjpvxjqp --use-api
   npx supabase functions deploy ai-ingest  --project-ref xoaaidgvblondjpvxjqp --use-api --no-verify-jwt
   npx supabase functions deploy tts-crawl  --project-ref xoaaidgvblondjpvxjqp --use-api --no-verify-jwt
   ```
3. Smoke test (no secrets in the output):
   - `POST .../functions/v1/assistant` with no token → **401**;
   - `POST .../functions/v1/ai-ingest` with no `x-webhook-secret` → **401**;
   - `tts-crawl` likewise → **401**.

## 6. Point the database at the functions

Mirror `wurx-buddy/scripts/deploy-dev-config.mjs`, but on production. Upsert three rows into `public.app_config`, then ⛔ gate, then run:

| key | value |
|---|---|
| `ai_ingest_url` | `https://xoaaidgvblondjpvxjqp.supabase.co/functions/v1/ai-ingest` |
| `ai_crawl_url` | `https://xoaaidgvblondjpvxjqp.supabase.co/functions/v1/tts-crawl` |
| `ai_ingest_secret` | the same value as the `AI_INGEST_SECRET` secret |

- Write the secret through a parameterised query from a file. Never type it into a visible command.
- Verify with `select key, (value <> '') as set from app_config where key like 'ai_%';`.
- The hourly sweep (`:05`) now runs and the minute tick drains the queue. **Pause** (runbook §"Pause and resume") means emptying `ai_ingest_url` / `ai_crawl_url`.

## 7. Ship the frontend

- ⛔ **Gate 3:** the backend is verified (steps 4–6). The human confirms the frontend deploy.
- Deploy from a clean `main` checkout, as `CLAUDE.md` describes: `npx vercel --prod --yes`. Vercel needs `npx vercel login` and a linked project; the human logs in. **Vercel deploys whatever working tree you're in**, so double-check the branch and `git status` first.
- Verify:
  - `https://wurxos.vercel.app` loads.
  - The main JS bundle contains `Wurx Buddy`.
  - Signed in as the **Boss**: the floating Buddy is at the bottom-right, and the **Wurx Buddy** tab is in the menu right after Chat.
  - Non-Boss users see nothing new (`allowed_roles = {boss}`).
  - Leave, Broadcasts and the Resource Planner behave as described in `wurx-buddy/app-guides/REVIEW.md` → "Owner decisions".

## 8. Build production's knowledge

1. **App how-to guides.** `wurx-buddy/scripts/sync-app-guides.mjs --apply` writes to **dev only**, on purpose.
   - Run `node wurx-buddy/scripts/sync-app-guides.mjs --strict` (validation, no database) and `--dry-run` to get the rows.
   - Then insert the same rows into production's `ai_assistant_docs` (kind `app_guide`, keyed by slug) with a small one-off script that targets production explicitly. Read the script first and copy its row shape exactly, including stripping the `<!-- source -->` comments.
   - ⛔ Gate before the write.
2. **Ingestion.** The Boss opens **Wurx Buddy → Buddy settings → Run ingestion now**, or runs `select public.ai_run_ingestion();` as the Boss. Watch it:
   ```sql
   select public.ai_ingest_stats();                -- queue drains; failed must stay []
   select source_type, count(*) from ai_documents where status='active' group by 1;
   ```
   - Expected scale, from dev: about **1,900 documents and 11,500 chunks**, **about $0.07**.
   - Reports are **approved only**.
   - If items defer with an OpenAI credit error, credits are the problem, not the code.
3. **TikTok Shop Academy.**
   - Either wait for the weekly crawl (Sunday 04:00 PKT), or start one now with `select public.ai_crawl_start();` and watch `ai_crawl_state`. It covers about 1,030 pages at about 3 s each, so roughly an hour.
   - The next sweep embeds the articles.
4. **Models.** In Buddy settings → **Model**, press **Refresh model list**. The default `gpt-5.4-mini` should show as usable. Set the fallback chain as the Owner wants.

## 9. Final verification (as the Boss, on production)

Ask Buddy these questions, and check each answer is grounded with source chips:
- "What does our SOP say about approving sample requests?" (SOP search)
- "How do I apply for leave?" (the app guide; the Boss is told he reviews leave rather than applying)
- "How did <a real brand> do last month?" (report and data tools; numbers cite [D#])
- "What's my salary?" (answered for the Boss)
- Buddy settings → **Usage** shows the spend from these questions.
- Minimise the panel mid-answer: Buddy shows the happy face and a badge when it's done.

Then report:
- what shipped;
- the migration list applied;
- the functions deployed;
- the ingestion counts and cost;
- any deviations.

## 10. Rollback

- **Frontend:** redeploy the `stable-pre-buddy-<date>` tag to Vercel production.
- **Buddy off without a redeploy:** `update ai_assistant_config set enabled = false;` or keep `allowed_roles = '{boss}'`.
- **Stop ingestion:** empty `app_config.ai_ingest_url` and `ai_crawl_url` (see the runbook).
- **Migrations are additive** (new tables, columns, functions and policies). Don't drop them in a panic. The Owner-decision migrations (390–393) change live behaviour; reverting them needs a new migration that restores the previous policies from `supabase/migrations/` history. ⛔ The Owner decides.

## Reference: what's where

| Thing | Where |
|---|---|
| Buddy migrations | `supabase/migrations/367…397` (app repo) |
| Owner-decision migrations | `supabase/migrations/390…393` |
| Functions | `supabase/functions/{assistant,ai-ingest,tts-crawl}`, shared `supabase/functions/_shared/ai/` |
| UI | `src/contexts/BuddyContext.jsx`, `src/components/buddy/`, `src/pages/buddy/`, `src/lib/buddy*.js`, `src/styles/buddy.css`, `public/mascot/` |
| Design, decisions, runbook | `wurx-buddy/*.md` (`plan`, `architecture`, `phases`, `ui-design`, `persona`, `runbook-ingestion`, `PROGRESS`, `TEAM`) |
| App how-to guides (knowledge) | `wurx-buddy/app-guides/*.md` (`REVIEW.md` = the Owner's decisions) |
| Tests | `wurx-buddy/tests/`, `wurx-buddy/scripts/sql/`, `wurx-buddy/scripts/test-*.mjs` (all dev-only), and `npm run test:buddy` in the app |
| QA reports | `wurx-buddy/qa/` (the security gate: 172 turns across 8 roles, 0 leaks) |
