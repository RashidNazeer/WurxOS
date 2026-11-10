-- ============================================================
-- WurxOS v2 — Migration 452: an APC under two TLs can tell which team's meeting a notification is about.
--
-- Mig 451 made the "meeting scheduled" and "meeting started" notifications reach an APC for EVERY team he
-- works under. Both teams' messages read "Your team's agenda meeting ...", so an APC under two TLs got two
-- identical-looking notifications and could not tell whose meeting each was (or thought one was missing).
-- For APCs with more than one TL (apc_team_leads) the text now names the Team Lead: "<TL>'s team agenda
-- meeting is on ...". A single-team APC, the TLs and the guests keep the exact wording they had.
-- Each function is the live definition with only that text changed.
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.agenda_notify_week(p_week_start date, p_tl_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      where role = 'apc' and is_active = true
        and (reports_to = v_sched.tl_id or id in (select apc_id from public.apc_team_leads where tl_id = v_sched.tl_id))
    loop
      perform public.emit_notification(
        v_apc.id, v_uid, 'agenda', 'agenda.meeting_scheduled',
        'Agenda meeting scheduled',
        case when (select count(*) from public.apc_team_leads x where x.apc_id = v_apc.id) > 1 then coalesce(v_tl_name, 'Your') || '''s team agenda meeting is on ' || v_label || '.'
             else 'Your team''s agenda meeting is on ' || v_label || '.' end,
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
         and p.id not in (select apc_id from public.apc_team_leads where tl_id = v_sched.tl_id)
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
$function$;

CREATE OR REPLACE FUNCTION public.agenda_start_meeting(p_meeting uuid)
 RETURNS agenda_meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_m       public.agenda_meetings;
  v_apc     record;
  v_guest   record;
  v_tl_name text;
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

  select display_name into v_tl_name from public.profiles where id = v_m.tl_id;

  perform public.emit_notification(
    v_m.tl_id, v_uid, 'agenda', 'agenda.meeting_started',
    'Agenda meeting started', 'Your team''s agenda meeting has started.',
    'agenda_meeting', v_m.id, '/agenda/ongoing');
  for v_apc in
    select id from public.profiles
    where role = 'apc' and is_active = true
      and (reports_to = v_m.tl_id or id in (select apc_id from public.apc_team_leads where tl_id = v_m.tl_id))
  loop
    perform public.emit_notification(
      v_apc.id, v_uid, 'agenda', 'agenda.meeting_started',
      'Agenda meeting started',
      case when (select count(*) from public.apc_team_leads x where x.apc_id = v_apc.id) > 1 then coalesce(v_tl_name, 'Your') || '''s team agenda meeting has started.'
           else 'Your team''s agenda meeting has started.' end,
      'agenda_meeting', v_m.id, '/agenda/ongoing');
  end loop;

  for v_guest in
    select gm.user_id, gm.labels
      from public._agenda_guest_members(v_m.guest_teams) gm
      join public.profiles p on p.id = gm.user_id
     where gm.user_id <> v_m.tl_id
       and p.reports_to is distinct from v_m.tl_id
       and p.id not in (select apc_id from public.apc_team_leads where tl_id = v_m.tl_id)
  loop
    perform public.emit_notification(
      v_guest.user_id, v_uid, 'agenda', 'agenda.meeting_started',
      coalesce(v_tl_name, 'Team') || '''s meeting has started',
      'Join now — you''re attending as ' || v_guest.labels || '.',
      'agenda_meeting', v_m.id, '/agenda/ongoing');
  end loop;

  return v_m;
end;
$function$;

