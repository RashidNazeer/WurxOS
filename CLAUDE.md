# WurxOS-V2 — Project Context for Claude

This file is auto-loaded by Claude Code on every session. Read it first before
making any non-trivial change. Other context files live in `.claude/memory/` —
those are project-knowledge memories accumulated across sessions; read them
when relevant to the task.

---

## What this is

**WurxOS** is a production-grade ops platform for **Wurx Media**, a TikTok Shop
affiliate marketing agency. It runs the day-to-day for ~30 employees: brand
management, weekly/bi-weekly/monthly client reports, attendance, leave,
performance, salaries, incentives, agenda meetings, push notifications, client
portals — everything an agency needs.

**Tech stack:**
- Vite + React 19 + React Router v6 + TanStack Query
- Supabase (Postgres + RLS + Realtime + Edge Functions + Auth)
- Vercel for hosting (Production deploys via `npx vercel --prod --yes`)
- Bootstrap 5 + custom design tokens (`src/styles/tokens.css`) — never hardcode hex
- Pakistan-locked timezone (`Asia/Karachi`) at the DB level — see mig 095
- Most users are on flaky Pakistan ISPs — code defensively against transient
  network failures (autosave, retry on first profile-load, etc.)

---

## Working with this codebase — non-obvious things

### Branches & deploys
- **Repo:** the GitHub remote is `RashidNazeer/WurxOS` (private) = `origin`;
  all commits push there. The "WurxOS-V2" name is only the local folder /
  internal project name (this is the v2 rewrite) — there is **no** separate
  "v2" repo on GitHub. A fresh clone lands on `main`; active work lives on
  feature branches, so check `git branch -r` after cloning.
- Read **`.claude/memory/git-workflow.md`** for the full policy.
- TL;DR: atomic commits to `main` by default; branch only when a change spans
  multiple commits OR is risky. Merge with `--no-ff`. NEVER `reset --hard` on
  shared history. Tag a `stable-*` before load-bearing changes.
- Vercel deploys from whichever branch you happen to be checked out on at the
  time of `vercel --prod --yes`. So **deploying = "ship the local working
  tree."** If you're on a feature branch, you deploy the feature branch.

### Migrations
- Live in `supabase/migrations/*.sql`. Naming: `NNN_short_name.sql`. Currently
  at **195** (next available is 196).
- Apply via `supabase db push --include-all`. The CLI is already linked to the
  WurxOS-V2 project (ref `xoaaidgvblondjpvxjqp`).
- Triggers do NOT fire retroactively. If you ship a trigger to keep some
  invariant in sync, also write a one-shot backfill script to fix existing rows.
  We learned this the hard way with `cascade_brand_owner_to_apcs` (mig 190).

### Edge Functions
- In `supabase/functions/*/index.ts` (Deno). Deploy via
  `supabase functions deploy <name>`.
- Active functions: `create-user`, `delete-user`, `wipe-data`, `send-push`,
  `snooze-notification`, `mark-notification-read`, `euka-sync`.
- `create-user` and `delete-user` are Boss-only admin endpoints. Always route
  user-account mutations through them — don't do `supabase.auth.admin.deleteUser`
  by hand (it leaves data inconsistent — see the Mushammir Qamar incident
  recovered in mig 190).

### RLS
- Every table that touches user data has RLS enabled. Read the latest migration
  for the policy you care about — early migrations get superseded.
- Common helpers: `public.is_boss(uid)`, `public.can_view_brand(...)`,
  `public.can_edit_brand(...)`, `public.can_eval_perf(...)`.
- The `profiles.permissions` jsonb column has per-user override flags:
  `canAddAPC`, `canAddBrand`, `canManageIncentives`, **`canViewAllBrands`** (added mig 192 for Subhan).
  Use this pattern for new role-bypass features rather than hardcoding UIDs.

### Realtime
- Supabase Realtime channels are used across the app — incentives, profiles,
  notifications, brands. Each subscribes to `postgres_changes` on its table.
- When a table needs realtime, the migration adds it to `supabase_realtime`
  publication via `alter publication supabase_realtime add table public.<t>`.
- Profile UPDATEs are listened to by AuthContext to force-logout on
  `deleted_at` / `is_active=false`. Don't break that flow.

### Notifications
- Single source of truth: `public.notifications` table. Client-side INSERT is
  blocked by RLS. The ONLY way to create one is via SQL trigger calling
  `public.emit_notification(recipient, actor, category, action, title, body, entity_type, entity_id, link)`.
- Push delivery dispatch trigger reads each user's `profiles.notification_prefs`.
  When adding a new category, also add it to `NotificationBell.jsx`,
  `NotificationsPage.jsx`, and `NotificationPrefsSection.jsx`.

### Auth resilience (CRITICAL)
- Read **`.claude/memory/refresh-state-loss.md`** before touching anything in
  `src/contexts/AuthContext.jsx` or `src/lib/appUpdate.js`.
- NEVER add a bare `window.location.reload()`. Always route through
  `requestAppReload()` so dirty forms aren't destroyed.
- `loadProfile()` has two modes: initial-load nulls profile on failure;
  refresh-mode preserves the existing profile. Don't combine those — both have
  defensible callers.

### Reports
- Three types: `weekly`, `biweekly`, `monthly` (stored in `reports.type`).
- Bi-Weekly reports are rendered by `WeeklyReportView` with `reportType='biweekly'`
  passed in (same component, different prop).
- "Previous report" for diff/MoM math is resolved by `findPreviousReport()` /
  `findPreviousMonthlyReport()` in `src/lib/reportsApi.js`. They compare by
  `weekStart`/`periodStart`/`monthKey`, NOT by `createdAt`. If you write any
  new "previous" lookup, use these helpers — out-of-order creation (OL backfills)
  must not affect history.

### Salaries
- Read **`.claude/memory/salary-management.md`**. Boss role has NO salary —
  exclude from every salary surface.
- Source of truth: `public.employee_compensation` (1 row per user).
  `public.salary_history` is append-only.
- `incentives.basic_salary` remains as a per-month snapshot for the existing
  incentive UI. It's synced forward by `inc_reset_and_roll` (which reads from
  `employee_compensation` at rollover — see mig 189).

### Other persistent memories (read when relevant)
- `.claude/memory/agenda-meetings.md` — weekly Tue agenda module
- `.claude/memory/euka-integration.md` — TikTok Shop metrics sync via MCP
- `.claude/memory/MEMORY.md` — index of all memories with one-line hooks

---

## How users see broken things

Most error reports look like a single user hitting a UI symptom. The actual
root cause is often:
- Stale/cached data on one client (React Query never refetched)
- RLS rejecting a write the UI optimistically thought would succeed (typically
  surfaces as HTTP 406 `.single()` mismatch — see mig 195 for an example)
- A `reports_to` chain that has NULL in it (TLs in this org effectively report
  to ALL OLs; mig 193+194 work around the single-column `reports_to`)
- Browser extension noise (MetaMask) caught by the unhandled-rejection
  reporter — `ErrorReporterContext.jsx` filters these out

Always probe the DB state for the affected user/row BEFORE assuming it's a UI
bug. The DB is usually right and the UI is usually stale.

---

## Pending work — open items

See `Pending fixes -IMP.md` at the repo root — the running log of investigated
issues. As of **2026-06-08** the report-editor state-loss campaign is
**complete**: P1–P5 done, plus the auth/route grace windows, with **no open
items**. Read that file before re-investigating any "editor refreshes / state
lost" symptom — every known mechanism is already mapped there, so a recurrence
means a brand-new mechanism, not one of the known ones.

---

## Style

- Concise code, sparse comments. Only comment the WHY when it's non-obvious or
  the WHY is a past incident the next reader couldn't guess from the code.
- Don't add error handling for cases that can't happen. Trust the framework.
  Validate only at boundaries (user input, network).
- Currency is hardcoded **PKR**; the org doesn't have non-PKR payroll today.
  If that changes, add a currency column — don't generalize speculatively.
- Print money 2-decimal exact (e.g. `$859.95`), not rounded — matches the
  top-card style throughout.
