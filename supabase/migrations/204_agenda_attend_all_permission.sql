-- ============================================================
-- WurxOS v2 — Migration 204: per-user "attend all agenda meetings"
-- permission flag.
--
-- Abdul Subhan is a TL with 0 APCs who actually leads the Paid Media
-- team (a role not yet modelled in the app). He needs to SEE and JOIN
-- every team's agenda meeting — but NOT run them. This mirrors the
-- view-only canViewAllBrands precedent (mig 192): a profiles.permissions
-- jsonb flag ORed into the existing SELECT gates, leaving every write /
-- lifecycle RPC (start/pause/finish/notify/present) untouched and
-- OL-only.
--
-- Flag: permissions->>'canAttendAllMeetings'. Read in SQL as
--   coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false)
-- (identical pattern to canViewAllBrands).
--
-- Three SELECT gates are widened:
--   1. agenda_meetings_select      (mig 177) — see every meeting row
--   2. agenda_can_view_meeting()   (mig 179) — read attendance + presentations
--   3. agenda_rev_select           (mig 181) — read task reviews (Prior history)
--
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
                 and coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false))
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
                   and coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false))
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
                 and coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false))
  );

-- 4. Grant the flag to Abdul Subhan (TL, Paid Media lead) -----------------
--    jsonb MERGE (||) so existing flags (e.g. canViewAllBrands) survive.
update public.profiles
   set permissions = coalesce(permissions, '{}'::jsonb)
                     || jsonb_build_object('canAttendAllMeetings', true)
 where id = 'f7ee4fd4-d422-5329-a658-fdc7a530b812';   -- Abdul Subhan
