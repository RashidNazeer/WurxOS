-- ============================================================
-- WurxOS v2 — Migration 451: the weekly agenda treats an APC as a member of EVERY team they work under.
--
-- Until now a team's agenda roster was "the APCs whose reports_to is that TL" (mig 175). Since mig 428 an APC
-- can work under several TLs (their reports_to + the owner of each brand they hold, view apc_team_leads), but
-- the agenda never followed: Mian Hassan reports to Haider Ali and holds Muhammad Azam's brands, yet he was never
-- listed in Team Azam's meetings and could not present there (agenda_start_presenting refused him).
--
-- Every place that decided "is this APC on this team's meeting" now also accepts membership through
-- apc_team_leads: who may view a meeting (policy + agenda_can_view_meeting), who is notified when it starts or is
-- announced, who can present, and who counts as a guest (a team member is never invited as a guest).
-- reports_to still counts exactly as before, so single-team APCs and every other role are unchanged.
-- Each function below is the live definition with only those predicates widened.
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.agenda_can_view_meeting(p_meeting uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.agenda_meetings m
    where m.id = p_meeting and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or m.tl_id = auth.uid()
      or m.tl_id = (select reports_to from public.profiles where id = auth.uid())
      or m.tl_id in (select tl_id from public.apc_team_leads where apc_id = auth.uid())
      or public.agenda_meeting_visible(m.status, m.guest_teams, m.legacy_guest_visible)
    )
  );
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
      'Agenda meeting started', 'Your team''s agenda meeting has started.',
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

CREATE OR REPLACE FUNCTION public.agenda_set_meeting_guests(p_meeting uuid, p_slugs text[])
 RETURNS agenda_meetings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_m       public.agenda_meetings;
  v_old     text[];
  v_guest   record;
  v_label   text;
  v_tl_name text;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can change meeting guests';
  end if;

  select guest_teams into v_old from public.agenda_meetings where id = p_meeting;
  if not found then
    raise exception 'meeting not found';
  end if;

  update public.agenda_meetings
     set guest_teams = coalesce(p_slugs, '{}'), updated_at = now()
   where id = p_meeting
   returning * into v_m;

  if v_m.status = 'completed' then
    return v_m;   -- archive visibility fix; nobody needs telling
  end if;

  select display_name into v_tl_name from public.profiles where id = v_m.tl_id;
  v_label := to_char(v_m.meeting_date, 'FMDay, FMDD FMMon')
             || ' at ' || to_char(v_m.meeting_time, 'FMHH12:MI AM');

  for v_guest in
    select gm.user_id, gm.labels
      from public._agenda_guest_members(v_m.guest_teams) gm
      join public.profiles p on p.id = gm.user_id
     where gm.user_id <> v_m.tl_id
       and p.reports_to is distinct from v_m.tl_id
       and p.id not in (select apc_id from public.apc_team_leads where tl_id = v_m.tl_id)
       and gm.user_id not in (select user_id from public._agenda_guest_members(coalesce(v_old, '{}')))
  loop
    perform public.emit_notification(
      v_guest.user_id, v_uid, 'agenda', 'agenda.meeting_scheduled',
      coalesce(v_tl_name, 'Team') || '''s agenda meeting',
      'You''re attending as ' || v_guest.labels || ' — ' || v_label || '.',
      'agenda_meeting', v_m.id, '/agenda/upcoming');
  end loop;

  return v_m;
end;
$function$;

CREATE OR REPLACE FUNCTION public.agenda_resync_week(p_week_start date, p_tl_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- null = every team (the old behaviour). A list = only what the OL
      -- edited, so an unrelated team's per-week guest override survives.
      and (p_tl_ids is null or s.tl_id = any(p_tl_ids))
  loop
    v_date := p_week_start + public._agenda_day_offset(v_sched.meeting_day);

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
           and p.id not in (select apc_id from public.apc_team_leads where tl_id = v_sched.tl_id)
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
$function$;

CREATE OR REPLACE FUNCTION public.agenda_add_guest_member(p_slug text, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_label text;
  v_m     record;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can change guest teams';
  end if;

  select label into v_label from public.agenda_guest_teams where slug = p_slug;
  if v_label is null then
    raise exception 'unknown guest team %', p_slug;
  end if;

  insert into public.agenda_guest_team_members (team_slug, user_id, added_by)
  values (p_slug, p_user, v_uid)
  on conflict (team_slug, user_id) do nothing;
  if not found then
    return;   -- already a member; they've already been told
  end if;

  -- Everything this membership just let them into, so they don't have to go
  -- looking for it. Their own team's meeting is not news to them.
  for v_m in
    select m.id, m.meeting_date, m.meeting_time, p.display_name as tl_name
      from public.agenda_meetings m
      join public.profiles p on p.id = m.tl_id
     where m.status in ('upcoming','ongoing','paused')
       and p_slug = any(m.guest_teams)
       and m.tl_id <> p_user
       and m.tl_id is distinct from (select reports_to from public.profiles where id = p_user)
       and m.tl_id not in (select tl_id from public.apc_team_leads where apc_id = p_user)
  loop
    perform public.emit_notification(
      p_user, v_uid, 'agenda', 'agenda.meeting_scheduled',
      coalesce(v_m.tl_name, 'Team') || '''s agenda meeting',
      'You''re attending as ' || v_label || ' — '
        || to_char(v_m.meeting_date, 'FMDay, FMDD FMMon')
        || ' at ' || to_char(v_m.meeting_time, 'FMHH12:MI AM') || '.',
      'agenda_meeting', v_m.id, '/agenda/upcoming');
  end loop;
end;
$function$;

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

CREATE OR REPLACE FUNCTION public.agenda_start_presenting(p_meeting uuid, p_apc uuid DEFAULT NULL::uuid)
 RETURNS agenda_presentations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid    uuid := auth.uid();
  v_target uuid := coalesce(p_apc, auth.uid());
  v_m      public.agenda_meetings;
  v_row    public.agenda_presentations;
  v_onbehalf boolean := coalesce(p_apc, auth.uid()) is distinct from auth.uid();
begin
  -- No caller identity means no authority, whatever else is true.
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;
  if v_m.status <> 'ongoing' then raise exception 'meeting is not ongoing'; end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_target and p.role = 'apc'
      and (p.reports_to = v_m.tl_id or p.id in (select apc_id from public.apc_team_leads where tl_id = v_m.tl_id))
  ) then
    raise exception 'that person is not an APC of this team';
  end if;

  if v_onbehalf then
    -- coalesce(): a NULL comparison must read as "no permission", never as
    -- "unknown, carry on". That was the bug in 324.
    if not coalesce(
         v_m.tl_id = v_uid
         or public.is_boss(v_uid)
         or exists (select 1 from public.profiles p
                    where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true),
         false) then
      raise exception 'only this team''s Team Lead, an Operations Lead or the Boss can start a presentation for someone else';
    end if;
  end if;

  if exists (select 1 from public.agenda_presentations
             where meeting_id = p_meeting and apc_id = v_target and status = 'done') then
    raise exception '% already presented in this meeting',
      case when v_onbehalf then 'that APC' else 'you have' end;
  end if;

  if exists (select 1 from public.agenda_presentations
             where meeting_id = p_meeting and status = 'presenting' and apc_id <> v_target) then
    raise exception 'another APC is currently presenting';
  end if;

  insert into public.agenda_presentations (meeting_id, apc_id, status, started_at, started_by)
  values (p_meeting, v_target, 'presenting', now(), v_uid)
  on conflict (meeting_id, apc_id) do update
    set status = 'presenting',
        started_at = coalesce(public.agenda_presentations.started_at, now()),
        started_by = v_uid, ended_at = null, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$function$;

drop policy if exists "agenda_meetings_select" on public.agenda_meetings;
create policy "agenda_meetings_select" on public.agenda_meetings for select using (
((is_boss(auth.uid()) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['ol'::text, 'developer'::text])) AND (p.is_active = true)))) OR (tl_id = auth.uid()) OR (tl_id = ( SELECT profiles.reports_to
   FROM profiles
  WHERE (profiles.id = auth.uid()))) OR agenda_meeting_visible(status, guest_teams, legacy_guest_visible))) OR (tl_id IN (SELECT apc_team_leads.tl_id FROM public.apc_team_leads WHERE apc_team_leads.apc_id = auth.uid()))
);
