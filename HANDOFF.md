# WurxOS v2 — Session Handoff

Last updated: **2026-08-11**. Written to resume work in a fresh Claude Code
session on another machine without losing context. Read this, then `CLAUDE.md`,
then `.claude/memory/`.

> **Paste this as your first message in a new session:**
> *"Read HANDOFF.md, CLAUDE.md and .claude/memory/ before doing anything, then
> tell me what state the project is in and what's pending. I'm continuing work
> from another machine."*

---

## TL;DR — where things stand

- **Live** at https://wurxos.vercel.app (Vercel project `wurxos`). ~30 users.
- **Repo** `RashidNazeer/WurxOS` (private). **`main` IS the production code** as
  of 2026-08-11 — `feature/brand-linked-incentives` (54 commits that had been
  running in prod while main sat behind) was merged in. Revert point: tag
  `stable-pre-main-merge-2026-08-11`.
- **Supabase** project ref `xoaaidgvblondjpvxjqp`. Migrations at **318**.
- **Stack**: Vite + React 19 + Supabase (Postgres/RLS/Realtime/Edge Functions) +
  TanStack Query + Vercel. Money is PKR; brand GMV figures are per-brand currency
  ($ mostly, £ for Longevity Box).
- **Deploy** = ship the working tree: `npm run build` then
  `npx vercel --prod --yes`. **Vercel deploys whatever branch is checked out.**
  Migrations: `supabase db push --include-all`.

---

## What shipped most recently (2026-08-10/11)

Five commits, all in prod. Each has a long commit message with the reasoning —
`git log` is the real record; this is the index.

1. **`ed29887` — Euka: Apothecary linked, Cutler restored.** Apothecary is an
   own-key Euka brand (secret `EUKA_API_KEY_APOTHECARY`, mig 314). Cutler was
   broken because a *dead dedicated key* shadowed the working shared one —
   `eukaKeyForSlug()` prefers `EUKA_API_KEY_<SLUG>` over the shared key, so
   unsetting the stale secret fixed it. **Lesson: when a brand moves shared↔own,
   the secret set is the switch; the DB rows barely matter.**
2. **`25bfbd3` — Euka API drift repaired.** Euka changed their API under us and
   both failures were SILENT (swallowed by `.catch()`):
   `/dashboard/top-products-by-video-revenue` was removed (→
   `products-performance`), and `/data-export` now needs `brand_id` **as well as**
   `store_id` — and brand_id is what actually *scopes* the rows, so a mismatched
   pair silently returns another brand's data. The pairing is now stored in
   `euka_stores.euka_brand_id` (mig 315) and injected server-side.
   **Their published OpenAPI spec is stale — verify params against the live API.**
3. **`a28370e` — the Ads Manager role** (mig 316). Replaces the pile of
   special-cases one person was carried on. `ads_manager_brands` is OL-curated in
   Settings and does double duty: it's the person's entire brand *visibility*
   (one clause in `can_view_brand`) AND the brand groups of their incentive plan.
   Deliberately NOT `brand_assignments`, which means "coordinates this brand" and
   would have pulled ads managers into reports/checkpoints/video-reviews queries.
4. **`171a2ac` — GMV-Max achieved is derived, not typed** (mig 317). Per-brand
   "Total Revenue in GMV Max" items now take their achieved from
   `brand_monthly_metrics.gmv_achieved` — the figure an APC enters at clock-in —
   via `source:'gmv_max'`. Third derived source after attendance and ol_brands,
   same pattern: fill at read time, strip before save, freeze at payout.
5. **`a3eb026` — PCTLs can read Brand Analytics** for every brand (mig 318),
   read-only.

---

## Invariants you can break by accident

- **Derived incentive items** (`source` = `attendance` | `ol_brands` |
  `gmv_max`) are filled at READ time and must never be persisted. Every save
  path goes through `stripAttendanceForSave`; every read path through
  `applyDerivedAutofill`. **Any new derived source must be frozen in BOTH
  `inc_clear_payout` AND `inc_reset_and_roll`** — missing the second one
  underpaid someone once (mig 294).
- `gmv_max` differs from the other two: it derives **achievedValue only**.
  Completion stays a human tick, so no month-closed money gate.
- **Incentive item brand links** (`brandId`) must survive every
  save/reconstruct path. Dropping one is a recurring bug class.
- **Editing your own incentive = Achieved only, never Target.** Managers set
  targets.
- **Never hard-delete a user** from the Supabase dashboard — `profiles.id →
  auth.users` cascades. Use the `delete-user` edge function (soft delete).
- **Adding a role**: the `profiles.role` CHECK was created inline in mig 001, so
  its name is Postgres-chosen — drop it by *shape*, not name (see mig 316). And
  `getMenuForRole` falls back to the APC menu for an unknown role, so a new role
  without a `MENUS` entry silently inherits the APC sidebar.

---

## Local environment gotchas

- **`.env.local` is NOT in the repo** (correctly). You need it before
  `npm run dev` works — at minimum `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`. Copy it from the other machine over a private
  channel. It also holds the service-role key used by `scripts/*.mjs` and the
  Euka API keys.
- **Toolchain PATH**: on the Windows box, `git` / `node` / `supabase` / `vercel`
  are installed and on the persistent PATH, but a running VS Code session holds
  a stale PATH snapshot. Inject per command:
  `$env:Path = "C:\Program Files\Git\cmd;C:\Program Files\nodejs;$env:USERPROFILE\scoop\shims;$env:APPDATA\npm;" + $env:Path`
- **Supabase + Vercel CLI auth** are per-user and interactive — run
  `supabase login` and `vercel login` once on the new machine, then
  `supabase link --project-ref xoaaidgvblondjpvxjqp` and `vercel link`
  (project `wurxos`, NOT `wurxossupabase`).
- **Flaky ISP**: transient `fetch failed` / connect timeouts are normal. Retry
  before diagnosing.

---

## Open items (nothing is blocked, these are choices)

- **`IncentiveForm` doesn't prefill Basic Salary** from
  `employee_compensation` when an OL creates a plan by hand, so hand-made plans
  start at 0. Mig 199 set the invariant but only enforces it on a salary change
  and at rollover. Offered, not shipped.
- **Three APCs have no `employee_compensation` row at all**, so their salary
  snapshots are 0 with nothing to sync from.
- **`EUKA_SHARED_BRANDS` has two dead entries** (`louisveillejerky`,
  `transformation`) — those stores no longer exist on the shared Euka account.
  They show as dead options in the Boss brand dropdown.
- **Ads Managers are absent from the Team Hierarchy org chart** (it builds
  OL → TL/PCTL → APC/IPC) and from `/performance` (role filter). Both are
  intentional today; both are additive if wanted.
- The older running log of investigated issues is `Pending fixes -IMP.md`.

---

## Where things live

| What | Where |
|---|---|
| App code | `src/` — pages in `src/pages/`, shared UI in `src/components/`, data access in `src/lib/*Api.js` |
| Incentives (the most intricate area) | `src/components/incentives/` + `src/lib/incentivesApi.js` |
| Migrations | `supabase/migrations/NNN_name.sql` — read the LATEST one touching a policy; early ones get superseded |
| Edge functions | `supabase/functions/*/index.ts` (Deno) — deploy individually |
| One-off / parity scripts | `scripts/*.mjs`, `migration/*.mjs` (read `.env.local` for a service-role client) |
| Design tokens | `src/styles/tokens.css` — never hardcode hex |
| Project memories (partial, in-repo) | `.claude/memory/` |

---

## The context that does NOT travel with a git clone

Claude Code keeps per-project memories **outside** the repo, at
`C:\Users\<you>\.claude\projects\<project-path-mangled>\memory\`. On the origin
machine that is `d--Milestone-WurxOS-V2` and it holds **~62 files** — far more
than the 6 committed under `.claude/memory/`. A clone does **not** bring them.

To carry them over: copy that whole `memory` folder into the same location on
the new machine. The folder name is the project directory path with every
non-alphanumeric character replaced by `-`, so **cloning to the same path
(`d:\Milestone\WurxOS V2\Wurxos-V2`, opened with the parent as the working
directory) makes the name match exactly** and everything just resolves.

They are deliberately not committed: they contain internal personnel and payroll
detail, and this repo is shared with outside collaborators.
