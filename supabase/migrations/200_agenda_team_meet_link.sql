-- ============================================================
-- WurxOS v2 — Migration 200: per-team agenda Google Meet link.
--
-- Each TL-team has its own PERMANENT Google Meet link. The OL sets it
-- per team in Settings → Schedules (alongside that team's meeting day
-- + time). When a meeting is live, the "Join Meeting" button in the
-- Ongoing room resolves the link for that meeting's team (by tl_id),
-- so every team — and the OL switching between parallel rooms — opens
-- the correct team's link. Falls back to the single global link
-- (agenda_settings.google_meet_link) when a team has none set.
--
-- Reads/writes go through the existing agenda_team_schedules RLS +
-- upsertAgendaTeamSchedule path, so no new policies are needed.
-- Idempotent.
-- ============================================================

alter table public.agenda_team_schedules
  add column if not exists meet_link text not null default '';
