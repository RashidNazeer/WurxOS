-- ============================================================
-- WurxOS v2 — Migration 211: let ALL Paid-Collab Team Leads (pctl) and
-- Influencer Program Coordinators (ipc) see & join every team's agenda
-- meeting — same effect as the per-user canAttendAllMeetings flag (mig 204,
-- granted to Abdul Subhan), but by role for the whole pctl/ipc population.
--
-- Same three SELECT gates widened; every write / lifecycle RPC
-- (start/pause/finish/notify/present) stays OL-only (observers, not runners).
-- Idempotent.
-- ============================================================

-- 1. Meeting rows visibility ---------------------------------------------
drop policy if exists "agenda_meetings_select" on public.agenda_meetings;
create policy "agenda_meetings_select"
  on public.agenda_meetings for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or tl_id = auth.uid()
    or tl_id = (select reports_to from public.profiles where id = auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.is_active = true
                 and (p.role in ('pctl','ipc')
                      or coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false)))
  );

-- 2. In-room data (attendance + presentations) chokepoint ----------------
create or replace function public.agenda_can_view_meeting(p_meeting uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agenda_meetings m
    where m.id = p_meeting and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or m.tl_id = auth.uid()
      or m.tl_id = (select reports_to from public.profiles where id = auth.uid())
      or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.is_active = true
                   and (p.role in ('pctl','ipc')
                        or coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false)))
    )
  );
$$;
grant execute on function public.agenda_can_view_meeting(uuid) to authenticated;

-- 3. Task reviews (Prior Meetings history) -------------------------------
drop policy if exists "agenda_rev_select" on public.agenda_task_reviews;
create policy "agenda_rev_select"
  on public.agenda_task_reviews for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or apc_id = auth.uid()
    or exists (select 1 from public.agenda_meetings m
               where m.id = meeting_id and m.tl_id = auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.is_active = true
                 and (p.role in ('pctl','ipc')
                      or coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false)))
  );
