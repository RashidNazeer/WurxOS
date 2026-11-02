# WurxOS v2 — Session Handoff

Last updated: **2026-11-02**. Written so a fresh Claude Code session (or a new
machine) can pick up any feature without losing context. Read this, then
`CLAUDE.md`, then `.claude/memory/`.

> **Paste this as your first message in a new session:**
> *"Read HANDOFF.md, CLAUDE.md and .claude/memory/ before doing anything, then
> tell me what state the project is in and what's pending. I'm continuing work."*

---

## TL;DR — where things stand

- **Live** at https://wurxos.vercel.app (Vercel project `wurxos`). ~30 users.
- **Repo** `RashidNazeer/WurxOS` (private). `main` is the production code and is
  **protected: changes only land through a pull request** (a direct push is
  rejected with GH013). Workflow: branch → push → `gh pr create` → `gh pr merge --merge`.
- **Deploys**: Vercel builds `main` automatically from GitHub when a PR merges
  (`Production – wurxos`). The `wurxosdev` Vercel project is a second, preview
  one. `npx vercel --prod --yes` currently fails from this machine ("Not
  authorized") — don't rely on it; merge the PR instead. Check a deploy with
  `gh api repos/RashidNazeer/WurxOS/deployments --jq '.[0:3][]|{environment,created_at,sha}'`.
- **Supabase** project ref `xoaaidgvblondjpvxjqp`. Highest migration file: **429**.
- **Stack**: Vite + React 19 + Supabase (Postgres/RLS/Realtime/Edge Functions) +
  TanStack Query + Vercel. Money is PKR; brand GMV figures are per-brand currency.

## ⚠ Do these first

1. **Migration 429 is merged but NOT applied to production.**
   `supabase/migrations/429_weekly_rating_one_score_per_week.sql` makes the
   monthly checkpoint average per WEEK (an APC under 2+ TLs is rated once per TL
   meeting, which counted that week twice). Until applied, the weekly popup shows
   the averaged score but the stored monthly score still double-counts. It was
   tested in a rolled-back transaction on real data (3 APCs change by ±1 point).
   It also re-rolls every affected month, so it is safe to apply at any time.
2. **The migration ledger has gaps.** Production's
   `supabase_migrations.schema_migrations` does not list 402, 415–418 or 421–427,
   although the objects from 421–427 ARE live (applied outside the CLI). So
   `supabase db push --include-all` would try to re-run them. Before using the
   CLI, run `supabase migration repair --status applied <versions…>` for the
   ones that are really live, or keep applying files directly (see below) and
   insert the ledger row yourself (`insert into supabase_migrations.schema_migrations(version,name) …`).
3. **Rotate secrets** that were handled in plain sight during earlier sessions:
   the Supabase personal access token (in `.env.production`), and the Euka and
   Reacher API keys.
4. **Muhammad Asad Aman's password** was reset in the database by hand on
   2026-10-30 (the app has no reset flow). Ask him to change it; the app has no
   change-password screen yet — that is a real gap worth building.

## How to apply a migration (what has actually worked)

The Supabase CLI is not linked on this machine. The path used: POST the SQL to
`https://api.supabase.com/v1/projects/xoaaidgvblondjpvxjqp/database/query` with
the PAT from `.env.production` (`SUPABASE_ACCESS_TOKEN`), then insert the ledger
row. **Test first, inside a single request that ends in `raise exception`** so
it rolls back and the message carries your before/after snapshot. For RLS tests
use `set local role authenticated` + `set local request.jwt.claims`. The Claude
Code auto-mode classifier blocks writing to production unless you explicitly say
so in the request ("apply 429 to production").

Always check for number collisions before pushing:
`ls supabase/migrations | cut -c1-3 | sort | uniq -d` (must print nothing).

---

## What shipped since the last handoff (Aug → Nov 2026)

`git log --merges origin/main` is the real record; this is the index. Newest first.

| When | What | Migration |
|---|---|---|
| Nov 2 | **OL "Fetch achieved from workbook"** (Incentives → APC tab) + **"Download <last month> salaries" CSV** | – |
| Nov 1 | One averaged checkpoint score per week for APCs under several TLs | 429 (not applied) |
| Oct 29 | Amazon Halo "Download all sheets" zip button; Lake City office removed from clock-in choices | – |
| Oct 28–29 | **APCs across several Team Leads**: teams derived from brand assignments; one leave/WFH request approved by every affected TL | 428 |
| Oct 27 | Reacher + Euka fixes; lint gate; **performance month lock** + autolock + lock previews | 424–427 |
| Oct 21–26 | Incentive workbook link (goals read from the OL's Google Sheet), APC incentive options (max 5), brand handler chip, brand goals bulk CSV, Euka checkpoint/dashboard fixes | 422, 423 |
| Oct 12 | Ex-employees (OL can retire an APC/TL, access cut), Wurx Buddy web search, hide inactive brands | 415–417, 421 |
| Oct 3–9 | Brand temp cover, glass UI polish, approvals mark-read, Boss acknowledgements, IPC sees paid-collab brands | 414, 418–420 |

### The three features from the last two sessions, in detail

**APCs across several TLs (mig 428)** — see the section in `CLAUDE.md`. The
`apc_team_leads` view derives membership; nothing is stored, so nothing drifts.
Leave/WFH for an APC whose live brands span 2+ TLs gets one
`leave_request_approvers` row per TL (snapshot at submit, never recalculated);
`leave_decide` flips the request once when ALL approve, any rejection is final,
the Boss can always decide. Never derive a brand's TL from the APC's `reports_to`.

**Incentive workbook, goal vs achieved** — the OL's Google Sheet
(`app_config.incentive_workbook_url`) has one tab per brand. Each month is a
column PAIR: LEFT = goal (`Oct 26`), RIGHT = achieved (`Oct 1-31`).
`src/lib/incentiveWorkbook.js` reads goals; `src/lib/incentiveAchieved.js` reads
achieved; `src/lib/incentiveWorkbookLoad.js` fetches + parses (shared by both
modals); `FetchAchievedModal.jsx` previews and writes. Video Authorized
achieved = authorized count ÷ Total Videos Made × 100. A missing/blank achieved
cell is skipped, never zeroed, so a sheet that gains its next column is picked up
on the next click. GMV-Max / attendance / OL-brand lines are never filled from the
sheet (they have a derived source). Paid plans are skipped; verified plans are
flagged but **editing one does not reset its verification** — open decision.
Reality check: against the Oct downloaded copy only 3 of 90 tabs could produce an
October Video Authorized figure (the rest lack a header row, an achieved column,
or have year-less headers). The preview lists each skip with its reason; fixing
the sheet's headers is the lever. Tests: `node scripts/test-incentive-achieved.mjs`
(41) and `node scripts/incentive-workbook-tests.mjs` (23).
Known pre-existing quirks left alone: the target resolver assumes the current
calendar year for year-less headers (7 tabs likely a year off) and reads
"March 1 - March 31" as 2031.

**Salary CSV** — `src/lib/salaryCsv.js`. Calculated salary = basic + earned
incentives + earned bonuses from the stored plan of the previous Karachi month
(`previousMonth()`); Boss excluded; people with no plan listed with a note;
unverified plans marked. UTF-8 BOM so Excel reads it.

---

## Invariants you can break by accident

- **Derived incentive items** (`source` = `attendance` | `ol_brands` | `gmv_max`)
  are filled at READ time and never persisted. Saves go through
  `stripAttendanceForSave`; reads through `applyDerivedAutofill`. Any new derived
  source must be frozen in BOTH `inc_clear_payout` AND `inc_reset_and_roll`.
- **A composite performance score is withheld until the OL verifies the person's
  incentive plan** (mig 257, Boss decision 2026-07-15, anti self-inflation:
  `level = 'pending_verification'`). A TL's "Team score" is the average of their
  APCs' composites, so while APC plans are unverified every TL's team score reads
  "—". This is by design, not a bug. Verifying plans is what unblocks it.
- **Month-end locks** (mig 424–426): closed months are snapshotted in
  `performance_month_snapshots`; recomputes must not rewrite a locked month.
- **Incentive item brand links** (`brandId`) must survive every save/reconstruct
  path. **Editing your own incentive = Achieved only, never Target.**
- **Never hard-delete a user** from the Supabase dashboard — use the
  `delete-user` edge function (soft delete). **Adding a role**: drop the
  `profiles.role` CHECK by shape, not name (mig 316), and give it a `MENUS` entry.
- **Triggers don't fire retroactively** — ship a backfill with any invariant trigger.
- **Never reuse a migration number**, even on another branch (CLAUDE.md).
- **Never a bare `window.location.reload()`** — `requestAppReload()` only.

---

## Environment (current machine)

- Project path `C:\Users\Umar Wurx\Wurx Stuff\Wurx Stuff\WurxOS`. Claude's
  per-project memory lives OUTSIDE the repo at
  `C:\Users\Umar Wurx\.claude\projects\c--Users-Umar-Wurx-Wurx-Stuff-Wurx-Stuff-WurxOS\memory\`
  (the folder name is the project path with every non-alphanumeric character
  replaced by `-`). It is not in git: copy it to carry it over; cloning to the
  same path makes the name match. It holds payroll/personnel detail, so it is
  deliberately uncommitted.
- Env files (never committed): `.env.local` (anon key + service role for
  `scripts/*.mjs`), `.env.production` (holds the Supabase PAT). Copy over a private channel.
- Local-only, untracked, on purpose: `DEPENDENCIES.md`, `GMV MAX Intel/`, and local
  edits to `.claude/settings.local.json`.
- Flaky ISP: transient `fetch failed` / timeouts are normal. Retry before diagnosing.
- Verification before a PR: `npx eslint src` (0 errors; ~147 pre-existing warnings),
  `npm test` (503 pass; a "failing tests" block listing `GAP:` todo tests is pre-existing),
  `npm run build`.

---

## Open items (choices, not blockers)

- **Apply migration 429** (above) and repair the ledger gaps.
- **Verification reset**: should editing a verified incentive plan reset
  `verified`? Today it doesn't, and nothing server-side blocks the edit.
- **Team score before verification**: decide whether TLs should get a team score
  from APC performance pillars while composites are withheld (policy change).
- **Romail's Oct 26–27** was recorded as approved leave (1 paid, 1 unpaid
  by quota) after a Boss approval given outside the app; flip via the Boss paid
  override if wrong. Row id `a19d5234-a50e-43ca-8f10-b035c2f8bc7f`.
- **Stale tab clocking in at Lake City**: the DB check still allows `lakecity`
  (history needs it); only the UI choices were removed.
- **No change-password / forgot-password screen** exists.
- **Workbook tabs** need header fixes before most brands can fetch achieved
  (see above). Year-less / "March 1 - March 31" resolver quirks are unfixed.
- Older items still open from the previous handoff: `IncentiveForm` doesn't
  prefill basic salary from `employee_compensation`; three APCs have no
  `employee_compensation` row; two dead `EUKA_SHARED_BRANDS` entries; Ads
  Managers absent from the org chart and `/performance`. The longer running log
  of investigated issues is `Pending fixes -IMP.md`; mobile work is in
  `PENDING_FEATURES.md`.
- Unmerged old branches on origin (`chore/merge-all-local`, `feat/owner-decisions`,
  etc.) were not touched; check before deleting.

---

## Where things live

| What | Where |
|---|---|
| App code | `src/` — pages `src/pages/`, shared UI `src/components/`, data access `src/lib/*Api.js` |
| Incentives (the most intricate area) | `src/components/incentives/` + `src/lib/incentivesApi.js`, `incentiveWorkbook*.js`, `incentiveAchieved.js`, `salaryCsv.js` |
| Performance | `src/components/performance/`, `src/lib/weeklyRatingsApi.js`, `performanceApi.js`, `tlPerfApi.js` |
| Team / leave | `src/lib/teamApi.js`, `brandsApi.js`, `leaveApi.js`, `src/components/leave/` |
| Migrations | `supabase/migrations/NNN_name.sql` — read the LATEST one touching a policy; early ones get superseded |
| Edge functions | `supabase/functions/*/index.ts` (Deno) — deploy individually |
| Scripts | `scripts/*.mjs`, `migration/*.mjs` |
| Design tokens | `src/styles/tokens.css` — never hardcode hex |
| Project memories (partial, in repo) | `.claude/memory/` |
