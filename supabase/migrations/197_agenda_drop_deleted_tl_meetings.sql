-- ============================================================
-- 197 — Agenda meetings must never reference a deleted/inactive TL.
--
-- Bug: users are SOFT-deleted (profiles.is_active=false, deleted_at set;
-- the row stays so FK-protected history survives). The ON DELETE CASCADE
-- on agenda_team_schedules.tl_id / agenda_meetings.tl_id therefore never
-- fires, so a deleted TL's schedule lingers and agenda_notify_week
-- re-materialises their weekly meeting card forever — showing the deleted
-- person (e.g. Mushammir Qamar) with "0 APCs" in Ongoing/Upcoming.
--
-- Fix:
--   1. agenda_notify_week / agenda_resync_week only consider schedules
--      whose TL is active and not soft-deleted (so a lingering schedule
--      can never materialise a meeting for a gone TL).
--   2. One-shot cleanup: drop orphaned schedules + upcoming/ongoing
--      meetings for already soft-deleted TLs. Completed meetings are
--      KEPT (historical record). Child rows (attendance / presentations /
--      task_reviews) cascade on the meeting delete (mig 179).
--
-- The delete-user Edge Function also removes these on future deletes, so
-- no orphaned schedule is left behind in the first place. Idempotent.
-- ============================================================

-- 1a. agenda_notify_week — materialise only for active, live TLs.
create or replace function public.agenda_notify_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_sched record;
  v_date  date;
  v_id    uuid;
  v_count int := 0;
  v_apc   record;
  v_label text;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can notify teams';
  end if;

  for v_sched in
    select s.* from public.agenda_team_schedules s
    join public.profiles p on p.id = s.tl_id
    where p.is_active = true and p.deleted_at is null
  loop
    v_date := p_week_start + public._agenda_day_offset(v_sched.meeting_day);

    insert into public.agenda_meetings (tl_id, week_start, meeting_date, meeting_time, status, notified_at)
    values (v_sched.tl_id, p_week_start, v_date, v_sched.meeting_time, 'upcoming', now())
    on conflict (tl_id, week_start) do update
      set notified_at = now()
    returning id into v_id;

    v_label := to_char(v_date, 'FMDay, FMDD FMMon') || ' at ' || to_char(v_sched.meeting_time, 'FMHH12:MI AM');

    perform public.emit_notification(
      v_sched.tl_id, v_uid, 'agenda', 'agenda.meeting_scheduled',
      'Agenda meeting scheduled',
      'Your team''s agenda meeting is on ' || v_label || '.',
      'agenda_meeting', v_id, '/agenda/upcoming');

    for v_apc in
      select id from public.profiles
      where reports_to = v_sched.tl_id and role = 'apc' and is_active = true
    loop
      perform public.emit_notification(
        v_apc.id, v_uid, 'agenda', 'agenda.meeting_scheduled',
        'Agenda meeting scheduled',
        'Your team''s agenda meeting is on ' || v_label || '.',
        'agenda_meeting', v_id, '/agenda/upcoming');
    end loop;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('notified', v_count);
end;
$$;
grant execute on function public.agenda_notify_week(date) to authenticated;

-- 1b. agenda_resync_week — same active/live TL guard.
create or replace function public.agenda_resync_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_sched record;
  v_date  date;
  v_count int := 0;
  v_n     int;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can update meeting schedules';
  end if;

  for v_sched in
    select s.* from public.agenda_team_schedules s
    join public.profiles p on p.id = s.tl_id
    where p.is_active = true and p.deleted_at is null
  loop
    v_date := p_week_start + public._agenda_day_offset(v_sched.meeting_day);
    update public.agenda_meetings
       set meeting_date = v_date,
           meeting_time = v_sched.meeting_time,
           updated_at   = now()
     where tl_id = v_sched.tl_id
       and week_start = p_week_start
       and status = 'upcoming';
    get diagnostics v_n = row_count;
    v_count := v_count + v_n;
  end loop;

  return jsonb_build_object('updated', v_count);
end;
$$;
grant execute on function public.agenda_resync_week(date) to authenticated;

-- 2. One-shot cleanup of orphaned agenda rows for already soft-deleted TLs.
--    Drop upcoming/ongoing meetings (child rows cascade) and the schedule;
--    completed meetings are kept as history.
delete from public.agenda_meetings m
using public.profiles p
where m.tl_id = p.id
  and (p.is_active = false or p.deleted_at is not null)
  and m.status in ('upcoming', 'ongoing');

delete from public.agenda_team_schedules s
using public.profiles p
where s.tl_id = p.id
  and (p.is_active = false or p.deleted_at is not null);
