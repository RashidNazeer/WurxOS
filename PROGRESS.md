# WurxOS v2 — Project Progress & Context

> **Purpose**: Long-running notes for this project. Read this first when
> continuing v2 work so state, decisions, and deferred items aren't lost.
> **Do not confuse with** wurxcrew-web (v1) at `a:\Projects\wurxcrew-web`.

Last updated: **2026-04-14** (M5 Reports complete)

---

## Project identity

- **Folder**: `a:\Projects\wurxos-v2\`
- **Supabase project**: `https://xoaaidgvblondjpvxjqp.supabase.co`
- **Stack**: Vite + React 19 + React Router v6 + Supabase (Postgres + Auth + Edge Functions + RLS)
- **Why**: Fresh rewrite to escape v1 pain — Firebase 50K reads/day cap, Notifier Electron app (82MB), dark-mode color inconsistencies.
- **Strategy**: Feature-by-feature. No big-bang migration. Team moves to v2 only after it proves itself.

## Non-negotiable rules

1. **Every color references a token from [`src/styles/tokens.css`](src/styles/tokens.css)**. Never hardcode hex. This is the fix for v1's dark/light mode pain — don't re-introduce it.
2. **Do NOT touch [`a:\Projects\wurxcrew-web`](../wurxcrew-web/)** unless the user explicitly asks. That is v1, still in production.
3. **No data migration planned** — v2 starts empty. Users move over gradually.
4. **Never await Supabase DB calls inside `onAuthStateChange`**. It deadlocks the auth listener. See [AuthContext.jsx](src/contexts/AuthContext.jsx) — profile fetching lives in a separate effect that watches `session.user.id`.

## Current state

### Milestones

- [x] **M1 — Authentication**
  - Boss-bootstrap signup (first user → role 'boss', rest locked out via `boss_exists()` RPC)
  - Login, logout, protected routes
  - Light/dark theme with CSS tokens
- [x] **M5 — Weekly + Bi-weekly Reports** (matches v1 feature-for-feature)
  - Unified `reports` table discriminated by `type` (weekly|biweekly); one row per (brand × type × period_start)
  - `bi_weekly_anchors` — per-brand 14-day anchor, set once, immutable by non-admin
  - `user_report_custom_fields` — per-user report section templates
  - Status workflow: draft → submitted → verified → approved (+ rejection + reopen-to-any-stage)
  - Full audit trail: submitted_at/by, verified_at/by, approved_at/by, rejected_at/by/note, reopened_at/by
  - RLS: APC own+assigned brands, TL own brands, OL/Boss/dev everything; can_view_report()/can_edit_report() helpers
  - Notification triggers on status transitions → notify TL on submit, OLs on verify, author+TL on approve, next-stage owner on rejection/reopen
  - ReportForm: all v1 sections — Overall Performance, Top Creators/Videos, GMV Max, Product Highlights, Offsite, Current/Upcoming Campaigns, Operational Updates, Recommendations+ActionItems (merged), per-user Custom Fields
  - PeriodPicker: first-time calendar for anchor; subsequent reports auto-detect next period with option to pick any historical slot from grid
  - ReportsPage: type tabs (Weekly / Bi-weekly), month navigator, brand + status filters, card grid
  - Settings extension: manage your own report custom fields template (add/rename/delete)
  - **Deferred**: AI Insights generation (v1 has a generate-with-AI button), PDF export, client portal share links (M8)
- [x] **M6.1 — In-app Notifications** (Realtime-driven, no push yet)
  - `notifications` table + RLS (recipient sees/updates own only, inserts via SECURITY DEFINER helper)
  - `emit_notification()` helper that powers all event emitters
  - Task-event triggers: created, reassigned (both sides), status_changed
  - Realtime subscription per logged-in user → instant updates
  - NotificationBell (topbar): badge + dropdown, click to navigate + mark read
  - Per-category sidebar dots (Tasks item pulses when there's an unread task event)
  - NotificationsPage (`/notifications`) — tabs (All / Unread), category filter, mark-all-read
- [x] **M6.2 — Web Push** (system-level popups, kills Notifier)
  - `push_subscriptions` table + RLS (user CRUDs own)
  - Private `app_config` table (send_push_url + send_push_secret)
  - Trigger AFTER INSERT on notifications → `pg_net.http_post` to Edge Function
  - Edge Function `send-push` (Deno + `web-push` npm, VAPID-signed, shared-secret auth, prunes 404/410 subs)
  - Service worker `public/sw.js` — push + click-to-focus/navigate
  - `src/lib/pushApi.js` — enablePush / disablePush / getCurrentSubscription
  - Settings → Notifications section (per-device toggle)
  - Setup: `npx web-push generate-vapid-keys`, set secrets, deploy function, update app_config
- [x] **M4 — Tasks + recurring resets**
  - Single `tasks` table, `brand_id` nullable (personal = brand_id null + assignee = creator)
  - Status flow: todo → in_progress → done → todo (cycle)
  - Categories: general / daily / weekly / monthly
  - **Per-user reset schedule** (`profiles.reset_schedule` jsonb) — settings page lets user pick time + day-of-week + day-of-month for each cadence
  - `compute_next_reset(uid, category)` reads assignee schedule, returns next timestamptz
  - Trigger auto-fills `next_reset_at` on insert / category or assignee change
  - **pg_cron** every 15 min calls `reset_recurring_tasks()` → done recurring tasks past reset time go back to todo
  - **Group task** (TL-only): brand multi-select → fans out as one task per brand × assigned APC
  - **Create task modal** shows assignee's reset hint ("Resets daily at 09:00") when daily/weekly/monthly picked
  - RLS via `can_view_task()` — assignee, creator, Boss/OL/dev, or brand owner
  - **Deferred**: task comments/attachments, kanban view, brand-coverage auto-reassignment (needs leave system), notifications on task events (→ M6)
- [x] **M3 — Brands**
  - `brands` table + `brand_assignments` join table
  - Boss/OL full CRUD; TL edits own brands; APC read-only on assigned brands
  - **Brand Switcher** (Boss-only): reassign TL, default keeps APC assignments, optional drop toggle
  - **Logo upload** (optional): Supabase Storage bucket `brand-logos`, 2MB image limit, public read
  - BrandAvatar: deterministic initials + color fallback when no logo
  - RLS helpers: `can_view_brand()`, `can_edit_brand()`
  - **Deferred**: tier/gmv analytics sources, paid_collab_status (M7), custom fields, coverage mode, OL→Boss switch-approval workflow (Boss direct-switches for now)
- [x] **M2 — User Management**
  - Boss-only admin page per role: TLs, PCTLs, OLs, APCs, IPCs, Developers
  - Direct-create-with-password flow (Boss types or auto-generates password, shares with user)
  - Edit: rename, change role, deactivate (never delete — historical references preserved)
  - **Role-specific extras (M2.1)**:
    - TL permissions: `canAddAPC`, `canAddBrand`, `canManageIncentives`
    - PCTL permissions: `canAddIPC`, `canAddBrand`
    - APC must report to a TL (required dropdown)
    - IPC must report to a PCTL (required dropdown)
    - OL, Developer: no extras
  - RLS: Boss SELECT/UPDATE all profiles via `is_boss()` helper; others self-only
  - Edge Function `create-user` (service-role admin.createUser, Boss-JWT-gated)

### What's built (by file)

**Database** (`supabase/migrations/`)
- `001_profiles.sql` — profiles table, `handle_new_user` trigger, self-read RLS, `boss_exists()` RPC
- `002_profiles_admin.sql` — `is_active`, `created_by`, `is_boss()` helper, Boss-admin RLS
- `003_profiles_relationships.sql` — `reports_to`, `permissions` jsonb, trigger reads them from metadata
- `004_brands.sql` — brands, brand_assignments, can_view_brand/can_edit_brand helpers, brand-logos storage bucket
- `005_brand_metrics.sql` — brands.gmv numeric column
- `006_tasks.sql` — tasks table, profiles.reset_schedule, compute_next_reset(), trigger auto-fill, pg_cron reset-recurring-tasks job
- `007_profiles_team_visibility.sql` — loosened profiles SELECT to any authenticated user (needed for team joins)
- `008_schedule_change_recompute.sql` — trigger recomputes next_reset_at when user changes reset_schedule
- `009_cron_every_minute.sql` — tighten pg_cron to run every minute (≤60s reset lag)
- `010_profile_timezone.sql` — profiles.timezone + timezone-aware compute_next_reset; trigger also reacts to tz change
- `011_notifications.sql` — notifications table + RLS + task-event triggers + Realtime publication
- `012_reports.sql` — reports, bi_weekly_anchors, user_report_custom_fields + RLS + report-event notification triggers

**Edge Functions** (`supabase/functions/`)
- `create-user` — Boss-only, validates `reports_to` points to correct parent role (APC→TL, IPC→PCTL)

**Frontend**
- `src/App.jsx` — routes, role-aware dashboard router, route guards
- `src/contexts/{Auth,Theme}Context.jsx` — both providers
- `src/components/layout/{AppShell,Sidebar,Topbar}.jsx` — shell
- `src/components/layout/menu.js` — per-role sidebar menu config
- `src/components/auth/{LoginPage,SignupPage,ProtectedRoute,RoleGuard,AuthShell}.jsx`
- `src/components/boss/{CreateUserModal,EditUserModal,RoleExtraFields}.jsx`
- `src/pages/boss/BossDashboard.jsx` — stat cards
- `src/pages/boss/manage/{TLs,PCTLs,OLs,APCs,IPCs,Developers}Page.jsx` — thin wrappers around shared `UserListPage.jsx`
- `src/pages/brands/BrandsPage.jsx` — role-aware list/grid (uses RLS for filtering)
- `src/components/brands/{BrandAvatar,BrandCard,BrandForm,BrandSwitcherModal,LogoPicker}.jsx`
- `src/components/tasks/{CreateTaskModal,GroupTaskModal,TaskRow}.jsx`
- `src/pages/tasks/TasksPage.jsx` — tabs (All / Assigned to me / Personal), filters, status cycle
- `src/pages/settings/SettingsPage.jsx` — per-user reset schedule editor
- `src/contexts/NotificationsContext.jsx` — Realtime subscription + unread state, per-category counts
- `src/components/layout/{NotificationBell,UnreadDot}.jsx` — topbar bell + sidebar dots
- `src/pages/notifications/NotificationsPage.jsx` — full list + filters + mark-all-read
- `src/components/reports/{ReportForm,PeriodPicker}.jsx`
- `src/pages/reports/ReportsPage.jsx` — role-aware list, month navigator, create flow
- `src/lib/{supabase,roles,adminApi,brandsApi,tasksApi,notificationsApi,reportsApi}.js`
- `src/styles/{tokens,global,auth,shell,table,brands,tasks,notifications,reports}.css`

## Explicitly deferred (do NOT build yet — wait for the owning milestone)

These fields exist in v1 but are tied to features we haven't built. Revisit when the parent feature arrives:

| Deferred item             | Needs milestone         | Reason |
|---------------------------|-------------------------|--------|
| Brand assignment to users | M3 Brands               | No brands table yet |
| APC task-permissions (`canManageResources`, `canManageTasks`) | M4 Tasks | No tasks feature yet |
| IPC task-assignments (`creative_briefs`, `channel_communication`) | M4 Tasks | No tasks feature yet |
| Leave quotas              | M-Leave (TBD)           | No leave system yet |
| Custom responsibilities   | Anytime — low priority  | Text array; can ship with any milestone |
| `teamUsers` dual-collection pattern from v1 | Never | Firebase-era denormalization; Postgres doesn't need it — use FK joins |

## Important implementation notes

- **Supabase client import**: always from `../lib/supabase`. Env vars in `.env.local` (gitignored).
- **RLS helper `is_boss(uid)`** is `SECURITY DEFINER` so it bypasses RLS internally — no recursion risk.
- **Trigger `handle_new_user`** is the ONLY path that inserts into `profiles`. Direct INSERT is blocked by RLS (`profiles_insert_block`).
- **First-ever signup always becomes Boss**, regardless of metadata. Signup UI shows "Signups disabled" after Boss exists (gated by `boss_exists()` RPC).
- **Bootstrap order matters**: APCs need a TL to exist first; IPCs need a PCTL. The create modal shows an empty-state message ("No active TLs exist yet") when appropriate.
- **Edge Function deploy**: done via dashboard paste (current state) or `supabase functions deploy create-user` via CLI. See README.

## Roadmap (next)

- [ ] **M3 — Brands**
  - Brands table, assignment to TL/PCTL as owner, APC/IPC assignees via join table
  - Boss brand list, create/edit, brand-switcher (reassign ownership)
- [ ] **M4 — Tasks + Recurring tasks**
  - Tasks table, assignment, due dates, status
  - `pg_cron` for recurring task generation (daily/weekly/monthly)
- [ ] **M5 — Weekly / Bi-weekly Reports**
  - Workflow: draft → submitted → verified → approved
  - Per-brand bi-weekly anchor
- [ ] **M6 — Notifications** (kills the Notifier Electron app)
  - `notifications` table + Supabase Realtime (in-app)
  - Web Push via service worker + VAPID (system notifications)
  - `pg_cron` for scheduled reminders
- [ ] **M7 — Paid Collab**
- [ ] **M8 — Client Portal** (unified, approved-only reports + paid collab)

## Quick commands

```bash
cd a:/Projects/wurxos-v2
npm run dev            # dev server → http://localhost:3000
npm run build          # production build
supabase functions deploy create-user  # deploy edge function (after CLI setup)
```
