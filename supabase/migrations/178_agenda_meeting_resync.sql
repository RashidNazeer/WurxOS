-- ============================================================
-- WurxOS v2 — Migration 178: agenda_meetings = one per team per
-- week, plus a schedule re-sync for the current week.
--
-- Two fixes:
--  1. Uniqueness moves from (tl_id, meeting_date) to
--     (tl_id, week_start). A meeting is "a team's meeting that
--     week" — so if the OL changes the team's meeting day, the
--     same row is updated instead of a stale duplicate appearing.
--  2. agenda_resync_week() — when the OL edits schedules after a
--     week was already notified, this silently applies the new
--     day/time to that week's still-upcoming meetings (the UI
--     asks the OL whether to include the current week).
--
-- agenda_notify_week is recreated: a re-notify now only refreshes
-- notified_at; it no longer rewrites date/time of existing rows.
--
-- Idempotent.
-- ============================================================

-- 1. Switch the unique key to (tl_id, week_start).
alter table public.agenda_meetings
  drop constraint if exists agenda_meetings_tl_id_meeting_date_key;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agenda_meetings_tl_week_key') then
    alter table public.agenda_meetings
      add constraint agenda_meetings_tl_week_key unique (tl_id, week_start);
  end if;
end;
$$;

-- 2. agenda_notify_week — upsert on (tl_id, week_start); a re-notify
--    just refreshes notified_at.
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

  for v_sched in select * from public.agenda_team_schedules loop
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

-- 3. agenda_resync_week — apply the current schedules' day/time to a
--    week's still-upcoming meetings. Silent: no notifications.
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

  for v_sched in select * from public.agenda_team_schedules loop
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
