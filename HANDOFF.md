# WurxOS v2 — Session Handoff

Last updated: 2026-05-13. Use this to resume work in a fresh Claude session on another machine without losing context.

---

## TL;DR — Where We Are Right Now

- **App is live and stable** at https://wurxos.vercel.app.
- **30+ active users across 7 roles**: boss, ol, tl, pctl, apc, ipc, developer.
- **Tech stack**: Vite + React 19 + Supabase (Postgres with RLS, Auth, Realtime, Storage, Edge Functions) + TanStack Query + Vercel.
- **Deploy flow**: `git commit` → `npx vercel --prod --yes` from `a:\Projects\wurxos-v2\`. Migrations: `supabase db push`.
- **v1 (Firebase / wurxos.web.app)** still runs in parallel; v2 is the active path. Hourly v1→v2 sync via Windows scheduled task. **Never run sync-all.js manually unless the user explicitly asks** — see [feedback_no_auto_sync](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\feedback_no_auto_sync.md).
- **Currency is PKR** for all internal money (suffix style: `60,000 PKR`). GMV Max specifically is USD. See [user_currency](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\user_currency.md).
- **Working directory** for v2 changes: `a:\Projects\wurxos-v2\`. Do NOT edit `a:\Projects\tiktok-shop-manager\` — that's v1. See [feedback_working_directory](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\feedback_working_directory.md).

---

## Recent Sessions (Last 2 Weeks of Work)

Reverse chronological. Each entry: what shipped, what file(s) touched, what migration if any.

### 2026-05-13

1. **Push notification error reporting** — `enablePush()` now maps DOMException.name → actionable hint (Windows Notifications off, browser blocked, guest mode, stale subscription, network, bad VAPID). Logs `push.subscribe_failed` to `app_events` so we can correlate failures.
   - Files: [src/lib/pushApi.js](src/lib/pushApi.js)
   - Pending: actual root cause of Fharkhan's "reg failed push service error" on his laptop. The improved messages should pin it down on next attempt.

2. **Dark-mode sweep** — Performance Score Breakdown, Notifications page tab pills, empty-state cards across Bugs / Incentives / Change Management / Requests / Resources. Replaced hardcoded `#fff` / `#dee2e6` / `#f8f9fa` / `text-dark` with theme tokens. Added bi-icons to notification category chips.
   - Files: [src/pages/notifications/NotificationsPage.jsx](src/pages/notifications/NotificationsPage.jsx), [src/components/performance/PerformancePage.jsx](src/components/performance/PerformancePage.jsx), [src/pages/bugs/BugsPage.jsx](src/pages/bugs/BugsPage.jsx), [src/components/incentives/MyIncentivesPage.jsx](src/components/incentives/MyIncentivesPage.jsx), [src/components/incentives/OLIncentivesPage.jsx](src/components/incentives/OLIncentivesPage.jsx), [src/pages/incentives/IncentivesPage.jsx](src/pages/incentives/IncentivesPage.jsx), [src/components/changes/ChangeManagementPage.jsx](src/components/changes/ChangeManagementPage.jsx), [src/components/leave/LeaveRequestPage.jsx](src/components/leave/LeaveRequestPage.jsx), [src/components/resources/AllResourcesPage.jsx](src/components/resources/AllResourcesPage.jsx)

3. **Rename "Tasks Processing" → "Efficiency"** — label only; underlying field key `tasksProcessing` unchanged so existing ratings carry over.
   - Files: [src/components/performance/PerformancePage.jsx](src/components/performance/PerformancePage.jsx)

4. **Weekly report extras rendered as StatCards with prev-week + sparklines** — both built-in section extras (Overall Performance, Top Creators, etc.) AND custom table sections now use the same hero-grid StatCard layout. Numeric/currency get comparison + sparkline. Removed the standalone "Additional fields" grouped card.
   - Files: [src/components/reporting/WeeklyReportView.jsx](src/components/reporting/WeeklyReportView.jsx), [src/components/reports/ReportView.jsx](src/components/reports/ReportView.jsx)

5. **Save-on-Draft was stripping brand extras** — root cause: filter kept only entries whose ID was in `customFieldDefs` (user-level only). Brand-defined entries got silently dropped. Fixed by preserving anything with `kind: 'long_text' / 'table' / 'builtin_extra'` or `source: 'brand'`.
   - Files: [src/components/reporting/WeeklyReportForm.jsx](src/components/reporting/WeeklyReportForm.jsx)

6. **Inline "+ Add field" + "+ Add custom section" inside the weekly form** — author can add fields/sections directly while creating/editing a report; persists to brand template so future weeks inherit. Added Currency type. Inline layout matches built-in `Field` flex-wrap rows.
   - Files: [src/lib/brandReportSectionsApi.js](src/lib/brandReportSectionsApi.js), [src/components/reporting/WeeklyReportForm.jsx](src/components/reporting/WeeklyReportForm.jsx), [src/components/reporting/WeeklyReportView.jsx](src/components/reporting/WeeklyReportView.jsx), [src/components/brands/BrandReportSectionsPanel.jsx](src/components/brands/BrandReportSectionsPanel.jsx)
   - Migration: [supabase/migrations/161_brand_report_section_extras.sql](supabase/migrations/161_brand_report_section_extras.sql) — adds `brand_report_sections.extras jsonb`.

7. **APC → TL attendance read RLS** — APCs always saw "Your TL is not clocked in" because `att_select` policy from mig 030 only allowed TL→APC reads. Added symmetric APC→TL read so the ClockWidget banner works.
   - Migration: [supabase/migrations/162_attendance_apc_can_read_tl.sql](supabase/migrations/162_attendance_apc_can_read_tl.sql)

8. **Brand detail page restyle** — top header + horizontal tabs + KPI tiles (only the ones we have data for). Visual only; no new data, no new functionality.
   - Files: [src/pages/brands/BrandDetailPage.jsx](src/pages/brands/BrandDetailPage.jsx), [src/styles/brandDetail.css](src/styles/brandDetail.css)

9. **Tasks page filters** — Assignee / Brand / Priority / Category / Due. Options derived from visible row set. "Clear N filters" pill. Search expanded to match priority/category.
   - Files: [src/pages/tasks/TasksPage.jsx](src/pages/tasks/TasksPage.jsx), [src/styles/tasks.css](src/styles/tasks.css)

### Earlier in this session

- **Sticky toolbar** on Weekly/BiWeekly/Monthly report editors. [src/components/reporting/WeeklyReportForm.jsx](src/components/reporting/WeeklyReportForm.jsx) + BiWeekly + Monthly.
- **HTML comment stripping** in RichContent + RichTextEditor paste (kills `<!--EndFragment-->` Word/Docs leak). [src/components/common/RichContent.jsx](src/components/common/RichContent.jsx), [src/components/common/RichTextEditor.jsx](src/components/common/RichTextEditor.jsx).
- **Stale-deploy auto-reload** + chunk retry-once-before-reload. [src/contexts/ErrorReporterContext.jsx](src/contexts/ErrorReporterContext.jsx), [src/components/common/RouteErrorBoundary.jsx](src/components/common/RouteErrorBoundary.jsx), [src/lib/lazyWithRetry.js](src/lib/lazyWithRetry.js).
- **Auth bootstrap resilience** — `.catch` on getSession, 15s timeout on `loadProfile`, profile realtime `setProfile((prev) => ({...prev, ...payload.new}))` instead of replace. [src/contexts/AuthContext.jsx](src/contexts/AuthContext.jsx).
- **`signOut({ scope: 'local' })`** — was defaulting to global, killing all device sessions. [src/contexts/AuthContext.jsx](src/contexts/AuthContext.jsx).
- **Info-icon tooltips** on Performance metrics. Anchored left, viewport-clamped. [src/components/performance/PerformancePage.jsx](src/components/performance/PerformancePage.jsx).
- **Task status dropdown flip-up** when no room below. [src/components/tasks/TaskRow.jsx](src/components/tasks/TaskRow.jsx).
- **Cleaned up Azan Khan's tasks** — deleted 4 leftover Magic Tap tasks created by Ali Hamza (former TL). One-off via [migration/delete_azan_magictap_tasks.mjs](migration/delete_azan_magictap_tasks.mjs).
- **Synced one v1 KB article** ("Example Projection - Penetrex") to v2 via [migration/sync_one_kb.mjs](migration/sync_one_kb.mjs).

---

## What's Pending / Open Questions

### Pending fixes
- **Push notifications failing on Fharkhan's laptop** — improved error reporting deployed. Next step: have him click "Enable" again, read the specific message, fix accordingly. App_events has `push.subscribe_failed` rows for forensics.
- **Native `<select>` dropdown styling in dark mode** — the popup options menu (Due / All / Overdue / etc.) renders with browser defaults. Out of scope unless we swap to a custom popover component.

### Pending bigger items
- **Bi-weekly + Monthly report forms don't yet have the "Add field" / "Add custom section" feature** — only Weekly does. Same pattern, just needs the same wiring in [BiWeeklyReportForm.jsx](src/components/reporting/BiWeeklyReportForm.jsx) and [MonthlyReportForm.jsx](src/components/reporting/MonthlyReportForm.jsx).
- **Adding fields *inside* built-in sections of bi-weekly/monthly views** — same as above, view-side wiring.
- **Sparklines on more KPI tiles** — only the report view has them. Brand detail KPI tiles are static. Needs daily-snapshot storage for historical comparison.
- **Activity feed on brand detail page** — Boss/OL view. `audit_log` already has the entries; just needs a UI panel similar to v1's.
- **TypeScript migration** — discussed but not started. Highest-ROI long-term move. Gradual file-by-file.

### Pending discussion items
- **Whether to drop `recheckSession` on visibilitychange** — the user finds the periodic checking unnecessary. Tradeoff is stale-session detection latency. Discussion still in progress; no decision made.
- **Self-hosted server discussion** — concluded with "stay on Supabase". No action.
- **TanStack Router migration** — discussed as future improvement; not started.

---

## What I Tried That Did NOT Work / Required Course Correction

### The "Azan Khan tasks" investigation
- **First attempt**: queried v2 with `brands.is_active = true` filter. Returned 0 rows. I concluded "Solid Gold Pets doesn't exist in v2." **This was wrong** — the column is `status`, not `is_active`. Supabase silently returned `{error: column does not exist}` and I treated empty data as truth.
- **Lesson**: when a query returns suspiciously empty results, **always check `error` on the response**, not just `data`. Schema assumptions across v1 (Firebase-ish) and v2 (Supabase) differ.
- **Eventual fix**: deleted 4 specific tasks by id after re-running with correct columns.

### The "stuck loading spinner" investigation
- **First attempt**: another agent flagged 10+ "issues" in AuthContext. Most were theoretical. I almost shotgunned all of them.
- **What actually mattered**: only 3 fixes — `.catch` on getSession, 15s timeout on loadProfile, surface SessionExpiredModal when profile load fails. The other 7 were either red herrings (qc.clear on every sign-in is fine), low-frequency edge cases not worth complexity (recheckSession counter flapping), or features the user actually wants to keep (visibilitychange listener).
- **Lesson**: when handed a long list of "issues" by another agent, **rank them by user-visible impact first**, not by theoretical severity. Push back on items that aren't real complaints. The user explicitly asked for conservative fixes.

### The "brand-defined sections" feature
- **Wrong first interpretation**: built a brand-admin-side UI for defining sections (`BrandReportSectionsPanel`), thinking the user wanted admin-managed templates.
- **What was actually wanted**: inline-in-the-report-form "Add field" / "Add custom section" buttons that persist to the brand template silently.
- **Lesson**: when the user says "user can add new section while filling out a report", that's literally where the UI goes — IN the report form, not on a separate admin page. The admin page is still useful for cleanup but isn't the primary entry point.

### Stripping `customFields` on save
- After shipping the inline-add-field feature, **values disappeared on Save Draft**. Root cause: the save path filtered `customFields` against `customFieldDefs` (user-level only), silently dropping brand-defined entries.
- **Lesson**: when extending what gets stored in a jsonb field, audit all the places that read / write / clean that field. Lookahead: a similar trap exists in BiWeekly/Monthly forms — they have the same filter pattern and will need the same fix if we extend them.

### `WeeklyReportView` rendering custom values
- **Initial behavior**: rendered every custom-field entry as a `HighlightableContent` block (HTML-aware). Pure numeric values (e.g., "142") collapsed to empty after html-strip and got filtered out — visible *nowhere*.
- **Fix**: split into two paths — table/builtin_extra entries get grouped into a StatCard grid; legacy long-form entries keep the existing rich-text rendering.

---

## Operating Principles for This Codebase

These have come up repeatedly across sessions. Follow them.

### 1. Stay in v2 (`a:\Projects\wurxos-v2\`) — never edit v1 (`a:\Projects\tiktok-shop-manager\`)
v1 is read-only at this point. v2 is the active path. The user has been explicit about this multiple times.

### 2. Discuss before implementing for non-trivial features
The user prefers a short discussion (scope, tradeoffs, options A/B/C) before code changes that touch multiple files or schema. Small fixes go straight to code. When in doubt, discuss.

### 3. Migrations are real and one-way
- New migrations land in `supabase/migrations/NNN_name.sql`. Sequential numbers.
- `supabase db push` applies to prod immediately. No staging environment.
- Always make migrations idempotent (`if not exists`, `drop policy if exists`, etc.).
- Never edit an already-applied migration; write a new one.

### 4. UI must hit a "modern and professional" bar
The user cares about visual polish. No rough sketches, no Bootstrap-default looks. Match the existing design language (theme tokens, `wx-card`, `wx-btn-*`, `task-tabs`, etc.). See [feedback_ui_standard](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\feedback_ui_standard.md).

### 5. Theme tokens, not hardcoded colors
- `var(--surface-1)`, `var(--surface-2)`, `var(--border-subtle)`, `var(--border-default)`, `var(--text-primary)`, `var(--text-secondary)`, `var(--text-muted)`, `var(--accent)`, `var(--accent-soft)`, `var(--danger)`, `var(--success)`, `var(--radius-md)`, `var(--radius-lg)`, `var(--shadow-sm)`, etc.
- Hardcoded `#fff` / `#dee2e6` / `text-dark` will break dark mode. The 2026-05-13 sweep fixed many of these but more probably exist.

### 6. Pakistan timezone (`Asia/Karachi`) is the only timezone that matters
- DB-level: migration 095 locks all timestamps to PKT.
- Display: always use `Intl.DateTimeFormat(..., { timeZone: 'Asia/Karachi' })`.
- Never auto-sync from the browser. Users may have wrong system clocks; that's their problem (see Fharkhan's case 2026-05-13).

### 7. No automatic data sync
v1→v2 sync runs on its own hourly schedule. **Never run `migration/sync-all.js`, `run.js`, or `close-open-shifts.js` manually.** Only one-off scripts (like deleting specific rows) at the user's explicit request.

### 8. Local git, branch per feature
- `wurxos-v2` uses local git only.
- New feature → new branch off main.
- Small bug fix → directly on main.
- See [feedback_git_branching](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\feedback_git_branching.md).

### 9. Don't break the happy path while fixing edge cases
The user wants conservative fixes. Add `.catch` instead of restructuring. Add timeout instead of replacing the fetch layer. New behavior should only fire when something is genuinely broken.

### 10. Realtime is a feature, not a hazard
WurxOS uses Postgres realtime for profile updates, tasks, notifications, attendance. When something doesn't refresh live, the answer is usually "wire up a realtime subscription" — not "add a refresh button".

### 11. Modal design standard
3-step stepper + icon-tile header + keyboard-hint footer for all non-trivial modals. See [feedback_modal_design](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\feedback_modal_design.md).

### 12. Card "Details" actions open popups, never inline expansion
See [feedback_inline_details](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\feedback_inline_details.md).

### 13. Discord webhooks for cross-app notifications
KB events post to Discord #wurxos via webhook stored in `app_config`. Pattern is reusable for other entities. See [project_discord_integration](C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\project_discord_integration.md).

### 14. Auto-memory exists at `C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\`
Persistent context that survives across conversations. The index is `MEMORY.md`. Save user preferences, project facts, feedback corrections there. Don't save anything ephemeral (current-task state, code patterns derivable from the repo).

---

## Useful Files / Locations

### Code
- Main app: `a:\Projects\wurxos-v2\src\`
- Auth: `src\contexts\AuthContext.jsx`
- Brand sections API: `src\lib\brandReportSectionsApi.js`
- Push: `src\lib\pushApi.js`
- Attendance: `src\lib\attendanceApi.js`, `src\components\attendance\ClockWidget.jsx`
- Reports: `src\components\reporting\WeeklyReportForm.jsx`, `WeeklyReportView.jsx`
- Performance: `src\components\performance\PerformancePage.jsx`
- Tasks: `src\pages\tasks\TasksPage.jsx`, `src\components\tasks\TaskRow.jsx`

### Migrations
- Numbered sequentially in `supabase\migrations\`.
- Latest: 162.
- Recently relevant: 030 (attendance), 095 (PKT lock), 104 (brand_report_sections), 138 (brand-switch-tasks), 155 (app_events), 156 (audit_log Boss-only), 157 (perf indexes), 158 (team-move alignment), 159 (working-days leave calc), 160 (client column), 161 (brand_report_section_extras), 162 (APC→TL attendance read).

### One-off scripts (`migration/`)
- All have a probe-first / dry-run pattern.
- Recent: `check_azan_tasks.mjs`, `delete_azan_magictap_tasks.mjs`, `sync_one_kb.mjs`, `diff_kb.mjs`, `debug_rashid_tl.mjs`, `investigate_azan_v2.mjs`, `sample_task_fields.mjs`.

### External
- Prod URL: https://wurxos.vercel.app
- v1 URL: https://wurxos.web.app
- Repo: local only (no GitHub remote for v2)
- Supabase: project linked via CLI; `supabase db push` works without password prompts.

### Env (`.env.local`)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SERVICE_ROLL_KEY` (yes, "ROLL" not "ROLE" — original typo, don't fix)
- `VITE_VAPID_PUBLIC_KEY`

---

## Things to Watch Out For

- **Brand column gotcha**: `brands.status` not `brands.is_active`. Easy to miss; check `await sb.from('brands').select('*').limit(1)` first.
- **Tasks column gotcha**: there's no `tasks.recurrence` column. There's `category` (daily/weekly/monthly/general).
- **profiles table** has both `reports_to` and... that's it, no `current_tl_id`. The reporting hierarchy is pure `reports_to`.
- **Three "Rashid Nazeer" accounts** in profiles: dev, apc, tl — different emails. Always disambiguate by email when investigating.
- **Two views for weekly reports**: `WeeklyReportView` (active, used by all the reporting routes) and `ReportView` (legacy, used by `/reports?open=...` deep links). Both need to stay rendering the same data correctly.
- **Two forms for weekly reports**: `WeeklyReportForm` (active) and `ReportForm` (legacy). Same caveat.
- **WeeklyReportView is also used by BiWeekly + Monthly view pages** with a normalized `report` shape. Be careful when adding weekly-specific logic.

---

## Resuming Work in a New Session

1. Open `a:\Projects\wurxos-v2\` (or equivalent on the new machine).
2. Confirm git is on `main` and clean: `git status`.
3. Confirm Supabase CLI is linked: `supabase status` — should not prompt for credentials.
4. Read this file. Then check auto-memory at `C:\Users\RA_shid\.claude\projects\a--Projects-tiktok-shop-manager\memory\MEMORY.md` (or wherever Claude's memory dir lives on the new machine).
5. Pick a pending item or wait for the user's next ask.

Common first commands when resuming:
- `git log --oneline -20` — see what shipped recently.
- `ls supabase/migrations/ | tail -10` — see the most recent migrations.
- `npx vite build` — confirm the project still builds cleanly.

---

## Final Notes for the New Session

- **The user is TSRashid / Muhammad Rashid**, owner of WurxCrew (TikTok Shop agency in Pakistan). Email `mrrashid3255@gmail.com`. Senior React/Firebase dev, comfortable with technical depth. He values honesty over reassurance — push back on bad ideas, but always with reasoning.
- **He prefers discussion before implementation** for any task touching multiple files. For one-line fixes, just do it.
- **He commits and deploys after every meaningful change.** The pattern is: small change → build → commit → deploy. Don't pile up uncommitted work.
- **He calls out when I miss the point** (e.g., the "add field inside report" episode). Read his messages carefully; don't optimize for what I think he means.
- **Memory system** persists across sessions — it'll have his profile, preferences, and corrections from past work. Trust it.

Good luck on the new laptop.
