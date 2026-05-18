-- ============================================================
-- WurxOS v2 — Migration 180: an APC cannot present twice.
--
-- agenda_start_presenting allowed an APC whose presentation was
-- already 'done' to start again (the upsert flipped 'done' back to
-- 'presenting'). Once an APC has finished presenting in a meeting
-- they are done — recreate the RPC to reject that.
--
-- Idempotent.
-- ============================================================

create or replace function public.agenda_start_presenting(p_meeting uuid)
returns public.agenda_presentations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.agenda_meetings;
  v_row public.agenda_presentations;
begin
  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;
  if v_m.status <> 'ongoing' then raise exception 'meeting is not ongoing'; end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_uid and p.role = 'apc' and p.reports_to = v_m.tl_id
  ) then
    raise exception 'only an APC of this team can present';
  end if;

  -- An APC presents once per meeting — no re-presenting after 'done'.
  if exists (
    select 1 from public.agenda_presentations
    where meeting_id = p_meeting and apc_id = v_uid and status = 'done'
  ) then
    raise exception 'you have already presented in this meeting';
  end if;

  if exists (
    select 1 from public.agenda_presentations
    where meeting_id = p_meeting and status = 'presenting' and apc_id <> v_uid
  ) then
    raise exception 'another APC is currently presenting';
  end if;

  insert into public.agenda_presentations (meeting_id, apc_id, status, started_at)
  values (p_meeting, v_uid, 'presenting', now())
  on conflict (meeting_id, apc_id) do update
    set status     = 'presenting',
        started_at = coalesce(public.agenda_presentations.started_at, now()),
        ended_at   = null,
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.agenda_start_presenting(uuid) to authenticated;
