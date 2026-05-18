-- ============================================================
-- WurxOS v2 — Migration 182: finishing a meeting closes out every
-- present APC.
--
-- When the OL finishes a meeting, any APC who was marked Present but
-- never presented is now marked as 'done' (presented, with no review
-- or remarks captured) — so a completed meeting has no APC stuck in
-- a 'pending' state. Absent / unmarked APCs are left untouched.
-- The UI warns the OL and asks for confirmation first.
--
-- Idempotent.
-- ============================================================

create or replace function public.agenda_finish_meeting(p_meeting uuid)
returns public.agenda_meetings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.agenda_meetings;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can finish meetings';
  end if;

  update public.agenda_meetings
     set status = 'completed', finished_at = now(), finished_by = v_uid, updated_at = now()
   where id = p_meeting and status = 'ongoing'
   returning * into v_m;
  if not found then
    raise exception 'meeting not found or not in an ongoing state';
  end if;

  -- Close any live presentation.
  update public.agenda_presentations
     set status = 'done', ended_at = coalesce(ended_at, now()), updated_at = now()
   where meeting_id = p_meeting and status = 'presenting';

  -- Present APCs who never presented are marked 'done' (no review),
  -- so the finished meeting has no dangling pending presenter.
  insert into public.agenda_presentations (meeting_id, apc_id, status)
  select p_meeting, att.apc_id, 'done'
    from public.agenda_meeting_attendance att
   where att.meeting_id = p_meeting and att.status = 'present'
  on conflict (meeting_id, apc_id) do update
     set status = 'done', updated_at = now()
   where public.agenda_presentations.status = 'pending';

  return v_m;
end;
$$;
grant execute on function public.agenda_finish_meeting(uuid) to authenticated;
