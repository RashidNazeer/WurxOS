---
name: agenda-meetings
description: "Weekly Agenda Meetings module — phase 1 shipped, phase 2 scope"
metadata: 
  node_type: memory
  type: project
  originSessionId: bcc0fa68-83c2-4ad6-b487-ce2665be9ba7
---

The Weekly Agenda Meetings module is a separate top-level menu item for the
office's weekly (Tue) agenda meeting, kept fully independent of the main task
system.

**Phase 1 — shipped & deployed 2026-05-17** (branch `feat/agenda-meetings`,
migrations 175 + 176):
- `agenda_settings` (OL/Boss-managed Meet link + meeting day)
- `agenda_tasks` (recurring per-APC tasks: todo/in_progress/completed; per-user
  reset cadence in `profiles.agenda_reset`; pg_cron `reset-agenda-tasks`)
- `agenda_resources` (brand-scoped foundation)
- `brand_switch_apc` extended (mig 176) so agenda tasks/resources follow a brand
- Menu group "Agenda Meetings" for Boss/OL/TL/APC; routes `/agenda/{tasks,resources,settings}`
- `src/lib/agendaApi.js`, pages in `src/pages/agenda/`, components in `src/components/agenda/`
- `agenda` notification category

**Phase 2 — shipped & deployed 2026-05-18** (branch `feat/agenda-meetings-phase2`,
migration 177):
- Settings is now tabbed: General + Schedules
- `agenda_team_schedules` — OL sets each TL-team a recurring meeting day + time
- `agenda_meetings` — per-team meeting instances (upcoming/ongoing/completed)
- RPCs `agenda_notify_week`, `agenda_start_meeting`, `agenda_finish_meeting`
- Upcoming Meetings page (month grid of week cards; only current week live;
  OL Notify Teams + per-team Start) and Ongoing Meetings page (Finish button)
- Week cards = the default-meeting-day occurrences in the current calendar month
- Schedule model is recurring day+time per team (not per-week dates)

**Phase 3 — shipped & deployed 2026-05-18** (branch `feat/agenda-ongoing-meetings`,
migration 179): the live Ongoing Meetings room.
- `agenda_meeting_attendance` (TL marks Present/Absent), `agenda_presentations`
  (per-APC state, DB-enforced one-presenter lock, OL overall rating/summary),
  `agenda_task_reviews` (OL per-task rating+notes, OL-private)
- `agenda_meetings.tl_rating`/`tl_remark`; RPCs `agenda_start_presenting`/
  `agenda_stop_presenting`; one-ongoing-meeting-at-a-time enforced
- Fully realtime via `subscribeAgendaRoom`; OL evaluation panel + TL remarks
- All evaluation inputs autosave; Finish Meeting clears the room live

**Phase 4 — shipped & deployed 2026-05-18** (branch `feat/agenda-prior-meetings`,
migration 181): Prior Meetings history archive.
- migration 181 loosened `agenda_task_reviews` RLS (reviewed APC + team TL can read)
- `/agenda/prior` route + menu item; `AgendaPriorPage` (month navigator, completed
  meetings grouped by week) + `AgendaPriorDetail` (role-based record: meeting info,
  attendance, per-APC evaluation accordions, TL remarks, presentation timeline)
- No new tables — built on phase 2-3 data; realtime via `subscribeAgendaMeetings`

**Phase 5 — NOT built yet:** cross-meeting analytics/trends (attendance %,
week-over-week performance, frequent absentees), exports, filters, search,
performance charts, comparison reports; meeting recording.

Decided during build: agenda task status uses `completed` (not `done`);
Settings accessible to OL + Boss + developer (Boss is superadmin); a team =
a TL plus the APCs whose `reports_to` is that TL.
