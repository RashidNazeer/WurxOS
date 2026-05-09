# Test Later

Pending implementations/flows to verify. When the user asks, read this file
and list them back.

## Migration / deploy state

All migrations `019` → `044` have been applied. Edge functions `create-user`
and `send-push` are deployed. **Don't re-prompt the user to run past migrations**
— when I ship a new migration, only flag that one.

## Deferred / declined

- **AI insights on reports** — v1 had a "generate with AI" button on reports.
  Declined for v2; not on roadmap.

---

## M7.1 — Paid Collab foundation (2026-04-15)

Prereqs: migration 017 run, dev server restarted.

**Boss side**
- Create a brand with Paid Collab Status = "Managed internally" (or Hybrid / Managed by brand).
- Settings → Leave Defaults → edit values and save; confirm they persist.

**PCTL side**
- Sidebar shows "Paid Collab" group (Brands, Creators, Videos, IPCs).
- Paid Collab → Brands → Pick brands → select one → appears on the list.
- Paid Collab → IPCs → Add IPC → create with credentials; leave quota pre-fills from global defaults.
- Edit IPC → rename, toggle active/inactive, change leave quota, toggle brand assignments (uses currently-selected brands).

**IPC side**
- Sidebar shows "My Brands".
- `/brands` lists brands their PCTL assigned them to.
- Still appears as assignable in task creation (PCTL → creates task for their IPC).

---

## M7.2 — Creators + Videos (2026-04-15)

No migrations. Pure frontend: pulls from `https://wurx-base.netlify.app/api/all` with 10-min client cache.

**Creators page** (`/paid-collab/creators`, Boss/OL/PCTL/Developer)
- Loads creator roster. Header shows count + total deal $.
- Filters work: search (name/product/hired-by), brand dropdown, month dropdown, payment chips, video chips.
- Row click expands to show hired-by, hiring date, deal, product, TikTok link, video count.
- Refresh button forces a fresh fetch (bypasses cache).

**Videos page** (`/paid-collab/videos`)
- Left: video stage with embedded TikTok iframe + ad code.
- Right: scrollable video list (one per delivered video across all creators).
- Click a list item → loads in the stage.
- Search/brand filter narrow the list.
- If a video URL can't be parsed, falls back to "Open on TikTok" link.
- On mobile (<900px) the list moves under the stage.

**Gotchas to watch**
- If wurx-base API is down, you'll see a red error banner — expected.
- TikTok embed iframes may be blocked by some strict privacy extensions.
- First load after 10 min of inactivity re-fetches from API (cache TTL).

---

## M8 — Client Portal (2026-04-15)

Prereqs: migration 018 run, dev server restarted.

**Author / Boss side**
- Open an **approved** report card → new "Share" pill in the footer.
- Modal: pick optional expiry date → "New link" → copy the URL.
- Existing links list shows state (Active / Expired / Revoked), view count, copy and revoke buttons.
- Revoking invalidates the link instantly.

**Client side (anonymous)**
- Open a copied share URL in an **incognito** window (no login).
- Should render the report read-only: brand name, period, "Approved" badge, all sections.
- Every open bumps the view_count on the share row.

**Failure modes to verify**
- A revoked link → "This link has been revoked."
- An expired link → "This link has expired."
- Link whose report was demoted from Approved (e.g. re-opened to draft) → "The report is no longer approved and cannot be shared."
- Random / invalid token → "This link is invalid."

---

## M-Leave (2026-04-15)

Prereqs: migration 019 run, dev server restarted.

**Everyone — `/leave`**
- Balance cards: 3 cards (WFH / Medical / Emergency) show `remaining / total` with a progress bar of days used. Profile quota + approved-leave consumption.
- "Request leave" modal: pick type + dates + reason. The modal warns if request exceeds remaining days but still submits.
- My list: every request with dates, reason, days, status pill. Cancel button while pending.
- After submit → approver gets an in-app + push notification.
- After decision → requester gets a notification.

**Approvers — `/leave/approvals`** (Boss, TL, PCTL)
- Pending tab shows requests where `leave_approver(requester) = you`.
- Recent tab shows decisions from the last 60 days.
- Approve = one click. Reject = prompts for an optional note, shown back to requester.
- Each row shows requester's annual quota for the requested type.

**Failure modes to verify**
- Non-approver can't see someone else's request (RLS).
- Requester can only cancel while status = pending.
- Approved request's days show up in the requester's balance card next time they load `/leave`.
- If a user has no `reports_to`, Boss approves them by default.

---

## PDF export on shared report (2026-04-15)

No migration. Pure frontend.

- Open any shared report via its portal URL.
- Top-right shows a new "Save / Print as PDF" button.
- Click → browser print dialog → choose "Save as PDF" (or a real printer).
- The toolbar button hides in print; cards render on a clean white background
  regardless of light/dark theme; cards avoid splitting across pages.
- Verify in both Chrome and Edge. Test that links inside the report stay legible
  when printed in grayscale.

---

## Task comments (2026-04-15)

Prereqs: migration 020 run, dev server restarted.

**Basic flow**
- Open an existing task (Edit). Scroll — there's a new "Comments" section under
  the form fields.
- Type a comment, click Post. It appears immediately as your message bubble
  (accent background on the right).
- Open the same task in a second browser — realtime: new comments appear
  without refresh.

**Notifications**
- Comment on a task someone else created/assigned → they get an in-app +
  push notification with title "New comment on your task".
- Commenter never notifies themselves.

**Permissions**
- Only users who can *view* the task can see the thread (RLS mirrors
  `can_view_task`).
- Only the comment author (or a Boss) can delete a comment.
- Deleted comment disappears in realtime on other open tabs.

---

## Kanban view for tasks (2026-04-16)

No migration. Pure frontend.

- On `/tasks`, toolbar has a new List / Kanban toggle.
- Kanban shows 3 columns (To do / In progress / Done), each with a count.
- Drag a card to another column — status updates instantly (optimistic) + hits DB.
- Only people who can change a task's status can drag it; others see it
  locked (no drag cursor).
- Column cards reuse brand, assignee and priority chips.
- Existing filters (tab + search + status chips) still apply; status chip +
  Kanban column reflect the same data.
- Realtime still updates: status change in another browser moves the card.
- On mobile (<900px) columns stack vertically.

---

## Brand-coverage auto-reassignment (2026-04-16)

Prereqs: migrations 020 (optional) + **021** run, dev server restarted.

**Setup for the test**
- Pick a brand that has at least TWO users of the same role assigned (e.g. two APCs).
- Assign a non-done task on that brand to one of them (user A).

**Approval → coverage**
- Log in as A, request leave covering today. Submit.
- Log in as the approver, open `/leave/approvals`, Approve.
- Open `/tasks` as anyone with visibility — A's brand-task should now be
  assigned to the OTHER APC, with a yellow **Coverage** chip.
- Task comments, status, notifications keep working under the covering user.

**Revert paths**
1. Approver (or Boss) flips the leave to `rejected`  → task returns to A immediately.
2. A cancels the leave while still marked approved (Boss/OL) → reverts.
3. Leave's `end_date` passes → the daily cron at 00:15 UTC reverts automatically.
   (To verify without waiting: run `select public.auto_revert_expired_coverages();` in SQL editor.)

**Edge cases to watch**
- If the brand has no other same-role user, the task stays with A (no crash).
- Personal (no-brand) tasks are never reassigned.
- Tasks already marked done are skipped.

---

## APC/IPC task-permission gate (2026-04-16)

Prereqs: migration 022 + redeploy `create-user` edge function + restart dev server.

**Create / edit user flow (Boss, PCTL)**
- Open Create/Edit for an APC or IPC → new "Can create tasks" toggle appears
  in the role-extras block.

**As an APC/IPC without the flag**
- `/tasks` → Add task → modal opens in **personal-only** mode (brand/assignee
  inputs hidden). Submitting a personal task works.
- Trying to create a brand task directly (e.g. via dev tools) is blocked by
  the new RLS policy (`tasks_insert`).

**As an APC/IPC with the flag**
- Create modal behaves like TL: brand picker + assignee picker visible.

**Regression checks**
- Boss / OL / TL / PCTL / Developer still create tasks freely.
- Personal tasks always work for every role.
- Existing tasks remain unaffected.

---

## Custom responsibilities (2026-04-16)

Prereqs: migration 023 + redeploy `create-user` edge function + restart dev server.

- **Create user**: new "Responsibilities" tag input below permissions.
  Type a tag → press Enter / click Add → chip appears. X removes.
- **Edit user**: Boss can edit responsibilities for any non-Boss user. Self can
  edit their own too (the block isn't hidden for self-edit anymore).
- **User list**: each row shows up to 4 responsibility chips under name/permissions,
  with `+N` overflow if longer.
- **Persistence**: tags round-trip through `handle_new_user` from metadata for
  new signups and direct-column UPDATE for edits. Duplicates (case-insensitive)
  are silently ignored. Max 20 enforced server-side.

---

## Brand custom fields (2026-04-16)

Prereqs: migration 024 run, dev server restarted.

- **Open an existing brand's Edit modal** — scrolls a new "Custom fields" panel
  at the bottom.
- As Boss / OL / owner-TL: can add key/value rows, click the pencil to edit a
  value inline, X to delete.
- Key must be unique per brand (DB unique constraint). Trying to add the same
  key twice returns an RLS-surfaced error in the alert strip.
- As a viewer (APC/IPC on an assigned brand, or PCTL with the brand selected):
  fields are visible read-only; no Add/Edit controls rendered.
- Deletion cascades if the brand itself is deleted.

---

## Brand tier / GMV analytics (2026-04-16)

No migration. Pure frontend.

- New sidebar entry **"Brand analytics"** for Boss + OL (under Brands).
- Page shows: 4 stat cards (active brands, total 30d GMV, average GMV,
  tier buckets) → tier breakdown bar chart (GMV share per tier) → top 10
  brands by GMV with per-brand progress bar.
- Click any top-brand row → navigates to `/brands` (for editing).
- `$` amounts abbreviate to `k` / `M` at thresholds.
- Untiered brands bucket as "Untiered" in the tier breakdown.
- RLS: only active brands shown (`status = 'active'`); RLS already gates who
  sees what — Boss/OL see all, others can't reach the page.

---

## OL brand-switch approval workflow (2026-04-16)

Prereqs: migration 025 run, dev server restarted.

**As OL**
- Open any brand's Switch modal → new form (not the direct Boss switcher).
  Pick a new TL + reason → Submit.
- Opens the request as pending. OL can cancel it from the new
  "Brand switches" page while status = pending.
- Directly editing a brand's owner_id (e.g. DB console) **fails** with
  `"Only Boss can reassign a brand's TL. Submit a switch request instead."`

**As Boss**
- Receives an in-app + push notification on each submitted request.
- "Brand switches" sidebar item → pending tab shows every request across all OLs.
- Approve → the brand's owner flips automatically (via trigger) + requester
  gets a confirmation notification.
- Reject → optional note → requester sees "Your switch request for ... was rejected".
- Boss's direct switcher still works unchanged; the guard bypasses for Boss.

**Edge cases**
- If the target TL becomes inactive between submit and approve, the insert
  check already required an active TL; approval just flips owner regardless
  (Boss re-checks manually).
- Cancelled/rejected requests stay in the Recent tab for audit.

---

## Role-aware dashboards (2026-04-16)

No migration. Pure frontend.

- Everyone except Boss now sees a live dashboard at `/dashboard` instead of
  the placeholder. Boss still sees `BossDashboard` (unchanged).
- Top stat cards (click to navigate): open tasks + overdue/today hint,
  unread notifications, pending leaves, leaves-to-approve (for TL/PCTL/Boss),
  Boss/OL extras (active brands, active users, pending switch requests).
- Panels (role-dependent):
  * **Tasks** — 6 most-soon-due open tasks, with brand/priority + due pill.
  * **Your brands** — up to 6 brands visible to the user (via RLS), with
    GMV abbreviation and Paid Collab chip when set.
  * **Reports in flight** — drafts / submitted / rejected, newest first.
  * **Your IPCs** (PCTL only).
  * **Paid Collab** quick link (PCTL only).
- Greeting switches on time of day.

---

## Global search (2026-04-16)

No migration. Pure frontend.

- Topbar has a new search trigger with a **⌘K / Ctrl+K** shortcut.
- Opens a floating panel that queries brands, people, tasks, reports in
  parallel (debounced 180ms). Groups results by type with icons.
- Click any result → navigates to the right page (brands / manage users /
  tasks / reports). Panel closes and clears the query.
- Esc closes; click outside closes.
- RLS silently filters what each role can see (APC searching will only get
  their assigned brands / own tasks / etc.).
- Mobile (<720px) shrinks the trigger to an icon-only button.

---

## Task attachments (2026-04-16)

Prereqs: migration 026 run + Storage bucket `task-attachments` confirmed in
dashboard (migration creates it) + restart dev server.

- Open an existing task (Edit) — new **Attachments** section above comments.
- Click Upload → picks any file ≤ 10 MB. Upload progress shown in the button.
- File name link opens the file in a new tab via a signed URL (5-min expiry).
- Uploader or Boss can delete; deletes remove the blob from Storage too.
- Visibility mirrors the task (same `can_view_task` predicate) — APCs on the
  brand can see/download, others can't.

---

## Notification preferences (2026-04-16)

Prereqs: migration 027 run, dev server restarted.

- Settings → new **Notification Preferences** section (below Notifications).
- Toggle push for each category: Tasks, Reports, Brands, Leave, Paid Collab, System.
- In-app delivery is unaffected — bell + dropdown always show everything.
- The DB push trigger reads `profiles.notification_prefs` before calling the
  Edge Function. Turn off "Tasks" → no more system popup for task events,
  while the bell still pings.
- Test: toggle "Tasks" off, save, then have someone assign you a task →
  in-app notification appears, system popup does **not**.

---

## Audit log (2026-04-16)

Prereqs: migration 028 run, dev server restarted.

- Boss / OL / Developer see new sidebar item **"Audit log"** → `/audit`.
- Page shows last 250 changes across brands, tasks, reports, leaves, switch
  requests. Filter by entity type or action (insert/update/delete). Search
  across actor name or payload.
- Each row: timestamp, actor (name + role), colored action pill, short
  summary with up to 3 changed field names, entity type.
- Writes always happen through the SECURITY DEFINER trigger — clients
  cannot insert directly (`audit_insert_block` policy).

---

## Bulk task actions (2026-04-16)

No migration.

- On `/tasks` (List view), each task you can edit now has a checkbox on the
  far left.
- Select ≥ 1 → an accent toolbar appears at the top of the list with:
  **Mark to-do / in progress / done / Delete / Clear**.
- Actions hit `.in('id', ids)` in one round trip. Rows update in place; no
  page reload.
- RLS still applies — can't bulk-edit tasks you don't have rights to. Unselectable tasks show no checkbox.

---

## User avatar uploads (2026-04-16)

Prereqs: migration 029 run, dev server restarted.

- Settings → Account → new "Profile photo" row at the top of the Profile card.
- Click **Change** → pick PNG/JPG ≤ 2 MB → uploads to Storage (`avatars` bucket)
  and sets `profiles.avatar_url` → Topbar updates instantly.
- **Remove** clears `avatar_url` back to initials.
- Topbar avatar and UserListPage rows show the uploaded image when available,
  fallback to initials bubble otherwise.

---

## Keyboard shortcuts (2026-04-16)

No migration.

- Press `?` anywhere (except inside inputs) to toggle a help modal listing all shortcuts.
- **⌘K / Ctrl+K** opens global search (already shipped).
- Navigation: press `g` then a letter — `d`=Dashboard, `b`=Brands, `t`=Tasks,
  `r`=Reports, `l`=Leave, `n`=Notifications, `s`=Settings.
- A small peach badge appears bottom-right after pressing `g` to prompt the
  second key; it disappears after 1.2s or on a valid choice.
- Shortcuts are ignored while focus is inside any input/textarea/select.

---

## Brand activity feed (2026-04-16)

No migration.

- Open an existing brand's Edit modal — new **"Recent activity"** panel at the
  bottom shows up to 12 most-recent task + report updates on that brand.
- Icons distinguish tasks vs. reports; each row shows title / period, status
  or assignee, and relative time.
- Pulled live from Supabase (RLS-filtered), so APCs only see what they're
  allowed to see.

---

## Attendance (2026-04-16)

Prereqs: migration 030 run, pg_cron confirmed, dev server restarted.

**Everyone — `/attendance`**
- Clock widget: pick location (wfh / bahria / lakecity / office), Clock in.
- Start break / End break toggles status between on-break and clocked-in.
- Clock out behaviour depends on role:
  * APC / IPC → status becomes `pending-approval`; their `reports_to` (TL/PCTL)
    gets an in-app + push notification to approve.
  * Everyone else (TL, PCTL, OL, Boss, Developer) → clocks out directly.
- Auto-capped at 8h: a pg_cron job runs every 5 minutes (`auto_clock_out_overdue_shifts()`)
  and closes any open shift older than 8 hours with `auto_closed=true`.
- Elapsed time updates every 30s while the page is open.

**Approvers / Boss / OL**
- Same page shows a **Pending clock-out approvals** card + **Today** roster
  with live status pills and per-person totals.
- Approve button writes `clock_out=now()`, computes `total_work_ms`.
- Reject returns the user to `clocked-in`.

**Data shape**
- `attendance` unique by (user_id, date). Each break appended to `breaks`
  jsonb. `total_work_ms` subtracts `total_break_ms` on clock-out.

---

## Resources — full v1 parity (2026-04-17)

Prereqs: migrations 031 + **039** run, dev server restarted. Migration 039
adds `updated_at`, an auto-touch trigger, and the notification trigger.

**`/resources` — main page (every role)**
- **Stats strip** at top: Total / Links / Images / Videos / Files. Click any
  tile to set the type filter (active tile fills with accent).
- **View toggle** (Grid / List). Grid is the default; List is a denser table.
- **Filter bar**: search (name/url/desc/brand), brand dropdown, scope chips
  (All / Brand / General), type chips.
- **Smart source detection** from the URL — every card / row shows a label:
  `Google Docs`, `Google Sheets`, `Google Slides`, `Google Drive`,
  `YouTube`, `Vimeo`, `TikTok`, `Figma`, `Notion`, `Dropbox`, plus the
  generic `Image`, `Video`, `File`, `Link` fallbacks.
- **Thumbnails**: image resources show inline previews, YouTube videos
  show the auto-fetched thumbnail with a centered ▶ overlay. Other types
  show a labelled tile.
- **Add modal** has full v1 scope/visibility:
  * **Scope**: Brand (with brand picker) or General.
  * **General visibility**: Only me · Specific user (user picker) · Roles
    (multi-select role chips: Boss / OL / TL / PCTL / APC / IPC / Developer)
    · Everyone.
  * Detected type / source label shown live as you type the URL.
- **Edit modal** uses the same form (pencil icon on each card / row).
- **Delete** allowed for creator, Boss/OL/Developer, or brand owner (TL).

**Brand detail panel — `BrandResourcesPanel`** (mirrors v1 ResourcesTab)
- Renders inside the brand edit modal in the `BrandForm`.
- Compact list view with 52×52 thumbnails.
- Filters: search, "Added by" dropdown (creators visible in this brand),
  date range (Any / Today / This week / This month / Custom from-to).
- Type chips with live counts.
- Add / Edit modals are pre-locked to the current brand (scope toggle hidden).

**Notifications**
- Insert / content-update on `resources` triggers in-app notifications via
  `emit_notification(category='resource', action='resource.added' or
  'resource.updated')`. Push respects the user's prefs as usual.
  * Brand-scoped → brand owner + every assigned APC/IPC (skipping the actor).
  * General · `user` → the targeted user only.
  * General · `group` → every active user with one of the targeted roles.
  * General · `private` / `office` → no notifications (private has nobody
    to notify; office would be too noisy).

**RLS sanity** (already in 031, unchanged)
- Brand resources visible to anyone who can view the brand.
- General resources follow `private` / `user` / `group` / `office` visibility.
- Creator + Boss/OL/Developer can edit/delete; brand owner (TL) can delete
  brand-scoped resources too.

---

## Performance (2026-04-16)

Prereqs: migration 032 run, dev server restarted.

**Everyone — `/performance`**
- "Your rating for YYYY-MM" card: 6-metric breakdown with per-metric bars +
  overall score. Empty state if nothing logged.

**Managers (Boss / OL / TL / PCTL / Developer)**
- Team list for the selected month, sorted by overall score.
- **Rate** → modal with 6 sliders (0–10), upserts `performance_ratings`.
- **Flags / warnings** → modal to add green/red flags with severity and
  formal warnings. 3+ warnings show a **TERMINATION RISK** badge.
- Self-view and team-view respect `can_eval_perf(target, actor)` — TL rates
  their direct reports only; Boss/OL rates anyone.

---

## Bonus & Incentives (2026-04-16)

Prereqs: migration 033 run, dev server restarted.

**Everyone — `/incentives`**
- Your plan card: basic salary + completed incentives + completed bonuses =
  earned total. Inline line items with progress bars.
- **Update progress** button opens editor with achieved-value inputs (can't
  edit targets or amounts).
- Auto-complete rule: `achieved / target ≥ 0.9` flips `completed: true` on
  save (client computes, trigger keeps verified / payout_cleared / basic_salary
  admin-only).

**Boss / OL / Developer**
- Team plans table — edit plan opens the full editor (add/remove items,
  change amounts/targets, verify, clear payout).
- RLS ensures non-admins can only edit their own progress. Attempts to
  flip verified/payout/salary raise `'only admin can …'`.

---

## Broadcasts (2026-04-16)

Prereqs: migration 034 run, dev server restarted.

**Boss / OL / Developer — `/broadcasts`**
- New broadcast modal: title, body, target (Everyone / By role), optional
  schedule (datetime-local). Submit fans out to matching active users via
  `emit_notification` and marks `sent_at` + `sent_count`.
- Scheduled ones wait in the table; pg_cron (`dispatch-scheduled-broadcasts`)
  fires every minute.
- Everyone can read their own broadcast rows + the notifications they
  received (bell / page).

---

## Reminders (2026-04-16)

Prereqs: migration 035 run, dev server restarted.

**Everyone — `/reminders`**
- New reminder modal: title, optional note, datetime. Creates a row for `auth.uid()`.
- Upcoming + Past sections.
- pg_cron (`fire-due-reminders`) runs every minute, inserts a `reminder`
  notification directly (bypasses the emit-self-skip rule), and marks sent_at.
- Delete removes a pending reminder.

---

## Knowledge base (2026-04-16)

Prereqs: migration 036 run, dev server restarted.

**Everyone — `/kb`**
- Card grid of articles grouped by category, with search + tag chips.
- New article modal: title, category, free-form body (markdown-ish), tags,
  visibility (office / private).
- Click a card to open the read view; pencil edits, X deletes.
- Creator + Boss/OL/Developer can edit/delete; others read-only per visibility.

---

## Chat — professional UI rebuild (2026-04-17)

Prereqs: migrations 037 + **041** run, dev server restarted.
v1-style realtime chat with avatars, sections, unread badges, message
clustering, date separators, auto-grow compose and a polished new-chat modal.

**Channel rail (left)**
- Header with conversation count + search input that filters the rail.
- Rows show: avatar (or 2-stack for groups), title (other member's name
  for DMs / group name), last-message preview (`You: …` if you sent it,
  truncated to 60 chars), relative time (`now` / `5m` / `3h` / `2d` /
  `Mar 12`), and an unread pill (accent-coloured, capped at `99+`).
- Sections: **Direct** then **Groups** when both exist.
- Active row highlighted in `--accent-soft`. Empty state has an
  illustration tile + "Start one with New chat above".

**Thread (right)**
- Header shows the avatar (or stacked group avatars), title, and
  subtitle (member count for groups, role for DMs).
- Date separators ("Today" / "Yesterday" / weekday / `Mar 12`)
  between days.
- Messages cluster: consecutive messages from the same author within
  5 minutes share a single avatar + author + timestamp header.
- Mine = right-aligned, accent-soft bubble. Theirs = left-aligned,
  surface-2 bubble. Bubble corners adjust to look like a stack.
- Hover a bubble to reveal a small action pill (copy; delete only on
  your own messages).
- Empty thread shows a friendly first-message prompt
  ("Say hi to {name}" or "Welcome to {group}").
- Auto-scrolls to the latest message on send / on new arrivals.

**Compose**
- Auto-growing `<textarea>` (caps at 160px). Placeholder is
  `Message {channel title}…`.
- **Enter** to send · **Shift + Enter** for a newline.
- Send button disabled when the input is empty; spinner while sending.

**New chat modal**
- People list shows avatar + name + role/email.
- **One click** on a person starts a DM via `chat_open_dm`. **Two or
  more selected** flips the modal into "New group chat" mode: a group
  name field appears, the primary CTA changes to `Create group (n)`,
  and clicking rows toggles selection (no longer instant-DM).
- Search filters by name, email or role; auto-focuses on open.

**Read state & unread**
- Opening a channel calls `chat_mark_read(p_channel)`; the rail's
  unread pill clears immediately.
- New messages from others bump the rail (last message + unread count
  refreshed) and the active thread (when the insert is for it).
- Realtime fan-out uses one shared `chat-live-{uid}` subscription
  listening to `chat_messages` INSERT/DELETE.

**RPCs (migration 041)**
- `chat_list_my_channels()` — single round-trip listing of channels
  with members, last message and unread count (avoids per-channel
  queries; ordered by last-activity desc).
- `chat_mark_read(p_channel uuid)` — bumps the caller's
  `chat_members.last_read_at` to `now()`.

**Notifications** (already in 037, unchanged)
- Every new message still pings the other members via
  `emit_notification(category='system', action='chat.message')`. Push
  respects user prefs.

---

## Performance — composite, levels & Boss config (2026-04-16)

Prereqs: migrations 032 + 033 (incentives) + 038 run, dev server restarted.
The 4-pillar model now matches v1: Performance 40 / Incentives 25 /
Attendance 20 / Flags 15 (all Boss-configurable).

**My page (any role) — `/performance`**
- Composite card at top shows:
  * composite score 0-100 + level badge (Promotion ≥ 90, Good ≥ 70,
    Warning ≥ 50, else Termination; "Not rated" if no rating this month).
  * 4 pillar bars with pillar % weight label.
  * Collapsible "Metric breakdown" with the 6 metric sliders (0-10 each).
- Flashes a red "Termination risk" banner when the user has ≥ 3 formal
  warnings across time.

**Manager grid (Boss / OL / TL / PCTL / Developer)**
- Team overview grid: role sub-tabs (All / OLs / TLs / PCTLs / APCs /
  IPCs / Developers), level filter dropdown, name search.
- Each card: composite + level badge + 4 pillar mini-bars + green/red
  flag counts for the selected month + cumulative warning count.
- Rate button opens the metric slider modal; Flags & warnings button
  opens the list/add modal.
- Ordering: composite desc, "Not rated" last.

**Boss config (Boss only)**
- Header "Config" button opens the scoring config modal:
  * Pillar weights (performance/incentives/attendance/flags) — must sum
    to 100 or Save is disabled; server also rejects with a clear error.
  * Minimum attendance days per month (attendance pillar baseline;
    default 22).
  * Level thresholds (promotion / good / warning) — must be
    strictly decreasing and ≥ 0.
  * Flag point values per severity (low / medium / high / critical) —
    added for green flags, subtracted for red flags from the 70 base.
- Saving hits `update_performance_config` RPC and triggers a reload
  which immediately re-weights everyone's composite.

**Computation checks**
- Normalization: a 7/10 average on metrics → 70 on the performance
  pillar (matches v1's 0-100 scale).
- Incentives: if the user has no incentives row for the month, or has
  a row with 0 items, the pillar is 0 (v1 parity).
- Attendance: counts distinct `attendance.date` rows in the month;
  capped at 100. Auto-closed shifts still count as a day.
- Flags: base 70, with flags created *in the selected month* moving
  the score up/down by severity-based points.

**Notifications**
- `performance_ratings` insert/update → target receives a notification
  (`performance.rating`, category `system`) unless self-rating.
- `performance_flags` insert → target receives "Green flag" or
  "Red flag (severity)".
- `performance_warnings` insert → target receives "Formal warning
  issued" (appends "— termination risk" when count hits 3+).
- All links navigate to `/performance`.

**RLS sanity**
- APC/IPC can view only their own composite and their own flags/warnings.
- TL sees direct reports in the overview (not everyone).
- PCTL sees their IPCs.
- OL/Boss/Developer see everyone.
- Only Boss can open the Config modal; server enforces on the RPC.
