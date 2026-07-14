-- ============================================================
-- WurxOS v2 — Migration 250: two invite bugs in mig 249.
--
-- (1) agenda_notify_week clobbered a per-week override.
--     "Notify Teams" upserted guest_teams from the schedule on EVERY run, so
--     an OL who overrode one week with the pencil and then re-notified (to
--     re-ping a team, say) silently lost the override. It was also
--     inconsistent with the meeting's own date and time, which notify has
--     never overwritten on an existing row.
--     Now guest_teams is set when the meeting is CREATED and left alone
--     after. Changing an existing week goes through the two paths built for
--     it: "Apply to this week too" on the Schedules save (resync), or the
--     per-week pencil (agenda_set_meeting_guests).
--
-- (2) agenda_resync_week invited guests without telling them.
--     Resync copies the schedule onto this week's upcoming meetings. It
--     updated guest_teams but emitted nothing, so a guest team added to a
--     team mid-week was added SILENTLY — the one outcome this whole feature
--     exists to prevent. Now resync notifies whoever the change newly
--     invites, and only them: an OL nudging a meeting time doesn't re-ping a
--     room full of people who already knew.
--
-- Idempotent.
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

    -- guest_teams is set at creation and never clobbered here; an existing
    -- week's invite list belongs to that week.
    insert into public.agenda_meetings (tl_id, week_start, meeting_date, meeting_time, status, notified_at, guest_teams)
    values (v_sched.tl_id, p_week_start, v_date, v_sched.meeting_time, 'upcoming', now(), v_sched.guest_teams)
    on conflict (tl_id, week_start) do update
      set notified_at = now()
    returning id, guest_teams into v_id, v_guests;

    v_label := to_char(v_date, 'FMDay, FMDD FMMon') || ' at ' || to_char(v_sched.meeting_time, 'FMHH12:MI AM');
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

-- Resync — carry the schedule onto this week, and TELL whoever it newly invites.
create or replace function public.agenda_resync_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_sched   record;
  v_m       record;
  v_date    date;
  v_count   int := 0;
  v_guest   record;
  v_label   text;
  v_tl_name text;
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

    -- Hold the OLD invite list so we can notify only the difference.
    select id, guest_teams into v_m
      from public.agenda_meetings
     where tl_id = v_sched.tl_id and week_start = p_week_start and status = 'upcoming';
    if not found then
      continue;
    end if;

    update public.agenda_meetings
       set meeting_date = v_date,
           meeting_time = v_sched.meeting_time,
           guest_teams  = v_sched.guest_teams,
           updated_at   = now()
     where id = v_m.id;
    v_count := v_count + 1;

    if v_sched.guest_teams is distinct from v_m.guest_teams then
      v_label := to_char(v_date, 'FMDay, FMDD FMMon') || ' at ' || to_char(v_sched.meeting_time, 'FMHH12:MI AM');
      select display_name into v_tl_name from public.profiles where id = v_sched.tl_id;

      for v_guest in
        select gm.user_id, gm.labels
          from public._agenda_guest_members(v_sched.guest_teams) gm
          join public.profiles p on p.id = gm.user_id
         where gm.user_id <> v_sched.tl_id
           and p.reports_to is distinct from v_sched.tl_id
           and gm.user_id not in (
             select user_id from public._agenda_guest_members(coalesce(v_m.guest_teams, '{}')))
      loop
        perform public.emit_notification(
          v_guest.user_id, v_uid, 'agenda', 'agenda.meeting_scheduled',
          coalesce(v_tl_name, 'Team') || '''s agenda meeting',
          'You''re attending as ' || v_guest.labels || ' — ' || v_label || '.',
          'agenda_meeting', v_m.id, '/agenda/upcoming');
      end loop;
    end if;
  end loop;

  return jsonb_build_object('updated', v_count);
end;
$$;
grant execute on function public.agenda_resync_week(date) to authenticated;
