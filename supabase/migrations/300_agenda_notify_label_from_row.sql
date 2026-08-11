-- ============================================================
-- WurxOS v2 — Migration 300: agenda_notify_week must ANNOUNCE the
-- meeting it actually stored, not the schedule it read.
--
-- Each team sets its OWN meeting day + time on the recurring schedule, so a
-- week can be a mix (e.g. three teams Wednesday, one Tuesday). Notify
-- materialises + pings each team's meeting.
--
-- The bug: notify built the notification label from the SCHEDULE
-- (v_date / v_sched.meeting_time), but its ON CONFLICT only refreshes
-- notified_at — it has (by design, since mig 178/250) never moved an
-- existing meeting's stored date/time. Those two facts are fine on a first,
-- fresh notify (row == schedule). But on a RE-notify AFTER an OL edited a
-- team's day/time WITHOUT choosing "Apply to this week too":
--   * the ping announced the NEW day/time (from the schedule), while
--   * the meeting row — and therefore the Upcoming card — kept the OLD one.
-- The recipient was told Wednesday 9 PM and saw Tuesday 8 PM.
--
-- Fix (label honesty only — NO change to what gets stored): the label is now
-- built from the row's ACTUAL meeting_date / meeting_time, read back via
-- RETURNING. On a fresh insert that's the schedule's values (unchanged); on a
-- re-notify it's whatever the row genuinely holds — so the notification can
-- never disagree with the Upcoming section again. Moving a meeting to a new
-- day/time still goes through its one intended path ("Apply to this week too"
-- → agenda_resync_week), which preserves the OL's per-week decision.
--
-- Everything else (guest snapshot + guest/APC/TL notifications from mig 250)
-- is preserved verbatim. Idempotent.
-- ============================================================

create or replace function public.agenda_notify_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_sched   record;
  v_date    date;
  v_time    time;
  v_id      uuid;
  v_count   int := 0;
  v_apc     record;
  v_guest   record;
  v_label   text;
  v_tl_name text;
  v_guests  text[];
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

    -- guest_teams (and, on an existing row, date/time) belong to that week —
    -- notify never clobbers them (mig 250). Read the STORED day/time/guests
    -- back so the notifications below announce exactly what the row holds.
    insert into public.agenda_meetings (tl_id, week_start, meeting_date, meeting_time, status, notified_at, guest_teams)
    values (v_sched.tl_id, p_week_start, v_date, v_sched.meeting_time, 'upcoming', now(), v_sched.guest_teams)
    on conflict (tl_id, week_start) do update
      set notified_at = now()
    returning id, meeting_date, meeting_time, guest_teams into v_id, v_date, v_time, v_guests;

    -- Label from the ACTUAL stored row (not the schedule) — this is the fix.
    v_label := to_char(v_date, 'FMDay, FMDD FMMon') || ' at ' || to_char(v_time, 'FMHH12:MI AM');
    select display_name into v_tl_name from public.profiles where id = v_sched.tl_id;

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

    -- Guests of the meeting as it actually stands. Skip anyone already on
    -- this team — they were told above, as a member.
    for v_guest in
      select gm.user_id, gm.labels
        from public._agenda_guest_members(v_guests) gm
        join public.profiles p on p.id = gm.user_id
       where gm.user_id <> v_sched.tl_id
         and p.reports_to is distinct from v_sched.tl_id
    loop
      perform public.emit_notification(
        v_guest.user_id, v_uid, 'agenda', 'agenda.meeting_scheduled',
        coalesce(v_tl_name, 'Team') || '''s agenda meeting',
        'You''re attending as ' || v_guest.labels || ' — ' || v_label || '.',
        'agenda_meeting', v_id, '/agenda/upcoming');
    end loop;

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('notified', v_count);
end;
$$;
grant execute on function public.agenda_notify_week(date) to authenticated;
