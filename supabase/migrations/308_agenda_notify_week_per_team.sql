-- ============================================================
-- WurxOS v2 — Migration 308: notify a SINGLE team (or all) for the week.
--
-- Ops need (2026-08-06): "Notify Teams" always materialised + pinged EVERY
-- configured team's meeting for the week. The OL wants to notify one team at a
-- time too — e.g. a team added/rescheduled after the rest were already
-- notified — without re-pinging everyone.
--
-- agenda_notify_week gains an optional p_tl_ids uuid[] scope:
--   * null  → every active team (unchanged behaviour = "Notify all teams").
--   * [ids] → only those teams' schedules are materialised + notified.
-- Everything else (mig 300's label-honesty from the stored row + the guest /
-- APC / TL notifications) is preserved verbatim.
--
-- The old single-arg agenda_notify_week(date) is dropped so the new
-- agenda_notify_week(date, uuid[]) (p_tl_ids defaulted) is unambiguous —
-- notifyWeek(weekStart) still resolves to it with p_tl_ids = null.
--
-- Idempotent.
-- ============================================================

drop function if exists public.agenda_notify_week(date);

create or replace function public.agenda_notify_week(p_week_start date, p_tl_ids uuid[] default null)
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
      and (p_tl_ids is null or s.tl_id = any(p_tl_ids))
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

    -- Label from the ACTUAL stored row (not the schedule) — mig 300.
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
grant execute on function public.agenda_notify_week(date, uuid[]) to authenticated;
