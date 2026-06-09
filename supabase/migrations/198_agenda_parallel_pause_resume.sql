-- ============================================================
-- 198 — Weekly Agenda Meetings: OL full flexibility.
--
-- The meeting flow was a strict pipeline: exactly one meeting could be
-- 'ongoing' at a time, you could only start from 'upcoming', and you
-- could only move forward (upcoming -> ongoing -> completed). Real
-- meetings don't always run that way, so the OL now gets:
--   * PARALLEL meetings        — drop the one-ongoing-at-a-time rule.
--   * PAUSE / RESUME           — new 'paused' status + agenda_pause_meeting.
--   * REOPEN a completed one   — agenda_start_meeting accepts paused/completed.
--
-- Idempotent: create-or-replace RPCs; guarded CHECK swap.
-- ============================================================

-- 1. Allow the new 'paused' status on agenda_meetings.
alter table public.agenda_meetings
  drop constraint if exists agenda_meetings_status_check;
do $$
begin
  alter table public.agenda_meetings
    add constraint agenda_meetings_status_check
    check (status in ('upcoming','ongoing','paused','completed'));
exception when duplicate_object then null;  -- constraint already present under another name
end $$;

-- 2. agenda_start_meeting — now serves START + RESUME + REOPEN.
--    No more one-ongoing guard (parallel allowed). Transitions to
--    'ongoing' from upcoming/paused/completed. started_at/by are kept
--    from the original start; finished_at/by cleared so a reopened
--    meeting is genuinely live again. Existing presentations are left
--    as-is (a reopened meeting continues from where it stopped).
create or replace function public.agenda_start_meeting(p_meeting uuid)
returns public.agenda_meetings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.agenda_meetings;
  v_apc record;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can start meetings';
  end if;

  update public.agenda_meetings
     set status      = 'ongoing',
         started_at  = coalesce(started_at, now()),
         started_by  = coalesce(started_by, v_uid),
         finished_at = null,
         finished_by = null,
         updated_at  = now()
   where id = p_meeting and status in ('upcoming','paused','completed')
   returning * into v_m;
  if not found then
    raise exception 'meeting not found or cannot be started from its current state';
  end if;

  perform public.emit_notification(
    v_m.tl_id, v_uid, 'agenda', 'agenda.meeting_started',
    'Agenda meeting started', 'Your team''s agenda meeting has started.',
    'agenda_meeting', v_m.id, '/agenda/ongoing');
  for v_apc in
    select id from public.profiles
    where reports_to = v_m.tl_id and role = 'apc' and is_active = true
  loop
    perform public.emit_notification(
      v_apc.id, v_uid, 'agenda', 'agenda.meeting_started',
      'Agenda meeting started', 'Your team''s agenda meeting has started.',
      'agenda_meeting', v_m.id, '/agenda/ongoing');
  end loop;

  return v_m;
end;
$$;
grant execute on function public.agenda_start_meeting(uuid) to authenticated;

-- 3. agenda_pause_meeting — ongoing -> paused. The live presentation is
--    intentionally left untouched (a frozen presenter resumes mid-flow).
create or replace function public.agenda_pause_meeting(p_meeting uuid)
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
    raise exception 'only OL/Boss can pause meetings';
  end if;

  update public.agenda_meetings
     set status = 'paused', updated_at = now()
   where id = p_meeting and status = 'ongoing'
   returning * into v_m;
  if not found then
    raise exception 'meeting not found or not in an ongoing state';
  end if;

  return v_m;
end;
$$;
grant execute on function public.agenda_pause_meeting(uuid) to authenticated;

-- 4. agenda_finish_meeting — recreate (mig 182 body) widening the guard to
--    allow finishing from 'ongoing' OR 'paused'. Closes the live
--    presentation and marks present-but-didn't-present APCs as 'done'.
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
   where id = p_meeting and status in ('ongoing','paused')
   returning * into v_m;
  if not found then
    raise exception 'meeting not found or not in an ongoing/paused state';
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
