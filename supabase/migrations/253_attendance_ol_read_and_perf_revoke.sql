-- ============================================================
-- WurxOS v2 — Migration 253: OL attendance read + close perf-RPC anon leak
--
-- Split out of mig 252 on purpose: 252 is ONLY the attendance-% formula, and
-- neither change below affects any attendance number. These are two pre-existing
-- permission gaps, grouped here so they can be reviewed and rolled back on their
-- own without touching the money path.
--
--   1. An active OL may SELECT attendance rows. The OL owns the Roster tab and
--      can already bulk-mark ANY employee present, yet mig 162 never granted
--      them SELECT — so today an OL's Roster shows near-zero Present, blank hours
--      and RED health for anyone who doesn't report directly to them. After 252
--      the coverage numbers are correct (SECURITY DEFINER), which makes the
--      missing hours/calendars look even more wrong. leave_select (mig 055)
--      already grants ol + developer exactly this way.
--
--   2. get_performance_composite / get_performance_overview were EXECUTE-able by
--      PUBLIC (Postgres' default), so anon holding only the publishable key could
--      read any employee's composite/ratings by UUID. Revoke first, then grant to
--      authenticated + service_role.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. RLS — an active OL may read attendance rows.
--
-- Copied VERBATIM from mig 162 (the last redefinition of att_select) with ONE
-- extra OR clause appended. Nothing is removed: dropping a clause here silently
-- breaks the APC's "is my TL clocked in?" banner or a TL's view of their reports.
-- ------------------------------------------------------------
drop policy if exists "att_select" on public.attendance;
create policy "att_select"
  on public.attendance for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'developer' and p.is_active = true
    )
    or exists (
      -- TL → their direct reports (mig 030).
      select 1 from public.profiles p
      where p.id = attendance.user_id and p.reports_to = auth.uid()
    )
    or exists (
      -- APC/IPC → their own TL (mig 162).
      select 1 from public.profiles me
      where me.id = auth.uid()
        and me.role in ('apc','ipc')
        and me.reports_to = attendance.user_id
    )
    or exists (
      -- NEW (mig 253): an active OL may read every attendance row.
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'ol'
        and p.is_active = true
        and p.deleted_at is null
    )
  );

-- ------------------------------------------------------------
-- 2. Close the anon leak on the performance RPCs.
--
-- Postgres grants EXECUTE to PUBLIC by default, so `grant … to authenticated`
-- was never a gate: anon could call these with the publishable key and read any
-- employee's score/composite by UUID. Revoke first, then grant.
-- ------------------------------------------------------------
revoke execute on function public.get_performance_composite(uuid, text) from public;
revoke execute on function public.get_performance_composite(uuid, text) from anon;
grant  execute on function public.get_performance_composite(uuid, text) to authenticated, service_role;

-- get_performance_overview (migs 038 / 040) leaks the SAME way: anon holding
-- only the publishable key could read every employee's composite/ratings.
revoke execute on function public.get_performance_overview(text) from public;
revoke execute on function public.get_performance_overview(text) from anon;
grant  execute on function public.get_performance_overview(text) to authenticated, service_role;
