-- ============================================================
-- WurxOS v2 — Migration 249: agenda meeting GUEST TEAMS.
--
-- Today, PCTL + every IPC (mig 211) and Abdul Subhan via the
-- canAttendAllMeetings flag (mig 204) can see and join EVERY team's agenda
-- meeting, and are notified about NONE of them. That's backwards on both
-- counts: they attend meetings nobody invited them to, and they find out a
-- meeting exists by going and looking.
--
-- New model: the OL decides, per team, which guest teams join that team's
-- meeting. A guest sees exactly the meetings they were invited to — no
-- invite, no room, and a truthful "No meeting in progress" — and gets a
-- notification naming the team, the day and the time, both when the week is
-- scheduled and when that meeting actually starts.
--
-- "Guest team" is a row, not a role, so a third one later is data, not a
-- migration. Membership is the UNION of two rules:
--   * by role      — Paid Collab = every pctl + ipc, automatically.
--   * by member row — Paid Media = an explicit list (Subhan today), managed
--                     from Agenda Settings. Paid Media is not a role yet;
--                     when it becomes one, add it to member_roles and the
--                     explicit rows become redundant, not wrong.
--
-- The invite lives in TWO places on purpose: guest_teams on the recurring
-- schedule is the OL's standing choice; guest_teams on the meeting is the
-- snapshot taken when the week is notified. That's what lets the OL override
-- a single week without editing the permanent schedule, and it's what keeps
-- history honest — who was invited to a meeting in May stays true in May
-- even after the standing choice changes.
--
-- canAttendAllMeetings is now referenced by nothing. The key is left in the
-- permissions bag (harmless) rather than stripped, so nothing that reads it
-- for display suddenly changes shape.
--
-- Idempotent.
-- ============================================================

-- 1. The guest teams themselves ------------------------------------------
create table if not exists public.agenda_guest_teams (
  slug         text primary key,
  label        text not null,
  member_roles text[] not null default '{}',   -- roles auto-included
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.agenda_guest_team_members (
  id         uuid primary key default gen_random_uuid(),
  team_slug  text not null references public.agenda_guest_teams(slug) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (team_slug, user_id)
);
create index if not exists agenda_guest_members_user_idx
  on public.agenda_guest_team_members(user_id);

insert into public.agenda_guest_teams (slug, label, member_roles, sort_order) values
  ('paid_collab', 'Paid Collab Team', array['pctl','ipc'], 1),
  ('paid_media',  'Paid Media Team',  array[]::text[],     2)
on conflict (slug) do nothing;

-- Seed Paid Media with its only member today. Matched by the flag mig 204
-- set rather than by hardcoded UID, so this stays correct if the flag was
-- ever granted to a second person by hand.
insert into public.agenda_guest_team_members (team_slug, user_id)
select 'paid_media', p.id
  from public.profiles p
 where coalesce((p.permissions->>'canAttendAllMeetings')::boolean, false)
   and p.is_active = true and p.deleted_at is null
on conflict (team_slug, user_id) do nothing;

-- 2. The invite ----------------------------------------------------------
alter table public.agenda_team_schedules
  add column if not exists guest_teams text[] not null default '{}';
alter table public.agenda_meetings
  add column if not exists guest_teams text[] not null default '{}';

-- History: PCTL/IPC/Subhan could see every past meeting before this
-- migration. Preserve exactly that — a completed meeting keeps them as
-- guests, so the Prior archive they had yesterday is the one they have
-- today. Upcoming/ongoing meetings start with NO guests: the OL opts each
-- team in deliberately, which is the whole point of the change.
update public.agenda_meetings
   set guest_teams = array['paid_collab','paid_media']
 where status = 'completed' and guest_teams = '{}';

-- 3. Membership ----------------------------------------------------------
-- The slugs a user is a guest of. Empty array for everyone else — and an
-- empty array overlaps nothing, so `&&` is a closed gate by default.
create or replace function public.agenda_guest_teams_for(p_uid uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(g.slug), '{}')
    from public.agenda_guest_teams g
   where exists (
     select 1 from public.profiles p
      where p.id = p_uid
        and p.is_active = true and p.deleted_at is null
        and (p.role = any(g.member_roles)
             or exists (select 1 from public.agenda_guest_team_members m
                         where m.team_slug = g.slug and m.user_id = p.id))
   );
$$;
grant execute on function public.agenda_guest_teams_for(uuid) to authenticated;

-- Everyone invited by a set of slugs, with the label(s) to name in their
-- notification ("You're attending as Paid Collab Team").
create or replace function public._agenda_guest_members(p_slugs text[])
returns table (user_id uuid, labels text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, string_agg(distinct g.label, ' + ')
    from public.profiles p
    join public.agenda_guest_teams g
      on g.slug = any(p_slugs)
     and (p.role = any(g.member_roles)
          or exists (select 1 from public.agenda_guest_team_members m
                      where m.team_slug = g.slug and m.user_id = p.id))
   where p.is_active = true and p.deleted_at is null
   group by p.id;
$$;

-- 4. RLS — "invited to THIS meeting" replaces "sees every meeting" --------
alter table public.agenda_guest_teams        enable row level security;
alter table public.agenda_guest_team_members enable row level security;

drop policy if exists "agenda_guest_teams_select" on public.agenda_guest_teams;
create policy "agenda_guest_teams_select"
  on public.agenda_guest_teams for select to authenticated using (true);

drop policy if exists "agenda_guest_teams_write" on public.agenda_guest_teams;
create policy "agenda_guest_teams_write"
  on public.agenda_guest_teams for all
  using (public._agenda_is_ol(auth.uid()))
  with check (public._agenda_is_ol(auth.uid()));

drop policy if exists "agenda_guest_members_select" on public.agenda_guest_team_members;
create policy "agenda_guest_members_select"
  on public.agenda_guest_team_members for select to authenticated using (true);

drop policy if exists "agenda_guest_members_write" on public.agenda_guest_team_members;
create policy "agenda_guest_members_write"
  on public.agenda_guest_team_members for all
  using (public._agenda_is_ol(auth.uid()))
  with check (public._agenda_is_ol(auth.uid()));

-- 4a. Meeting rows.
drop policy if exists "agenda_meetings_select" on public.agenda_meetings;
create policy "agenda_meetings_select"
  on public.agenda_meetings for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or tl_id = auth.uid()
    or tl_id = (select reports_to from public.profiles where id = auth.uid())
    or guest_teams && public.agenda_guest_teams_for(auth.uid())
  );

-- 4b. In-room data (attendance + presentations) chokepoint.
create or replace function public.agenda_can_view_meeting(p_meeting uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.agenda_meetings m
    where m.id = p_meeting and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or m.tl_id = auth.uid()
      or m.tl_id = (select reports_to from public.profiles where id = auth.uid())
      or m.guest_teams && public.agenda_guest_teams_for(auth.uid())
    )
  );
$$;
grant execute on function public.agenda_can_view_meeting(uuid) to authenticated;

-- 4c. Task reviews (the Prior Meetings archive).
drop policy if exists "agenda_rev_select" on public.agenda_task_reviews;
create policy "agenda_rev_select"
  on public.agenda_task_reviews for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or apc_id = auth.uid()
    or exists (select 1 from public.agenda_meetings m
               where m.id = meeting_id
                 and (m.tl_id = auth.uid()
                      or m.guest_teams && public.agenda_guest_teams_for(auth.uid())))
  );

-- 5. Notify the week — now also invites and notifies the guests -----------
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

    insert into public.agenda_meetings (tl_id, week_start, meeting_date, meeting_time, status, notified_at, guest_teams)
    values (v_sched.tl_id, p_week_start, v_date, v_sched.meeting_time, 'upcoming', now(), v_sched.guest_teams)
    on conflict (tl_id, week_start) do update
      set notified_at = now(),
          guest_teams = excluded.guest_teams
    returning id into v_id;

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

    -- Guests. Skip anyone who already belongs to this team — they were told
    -- above, as a member, and a second ping about the same meeting is noise.
    for v_guest in
      select gm.user_id, gm.labels
        from public._agenda_guest_members(v_sched.guest_teams) gm
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

-- 6. Resync — the OL edited schedules mid-week; carry guests across too ---
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
           guest_teams  = v_sched.guest_teams,
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

-- 7. Start — guests are told the room is live, same as the team -----------
create or replace function public.agenda_start_meeting(p_meeting uuid)
returns public.agenda_meetings
language plpgsql
security definer
set search_path = public
as $$
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
    where reports_to = v_m.tl_id and role = 'apc' and is_active = true
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
  loop
    perform public.emit_notification(
      v_guest.user_id, v_uid, 'agenda', 'agenda.meeting_started',
      coalesce(v_tl_name, 'Team') || '''s meeting has started',
      'Join now — you''re attending as ' || v_guest.labels || '.',
      'agenda_meeting', v_m.id, '/agenda/ongoing');
  end loop;

  return v_m;
end;
$$;
grant execute on function public.agenda_start_meeting(uuid) to authenticated;

-- 8. Per-week override — change one meeting's guests without touching the
--    standing schedule. Only guests who were NOT already invited get pinged,
--    so an OL fixing a typo doesn't re-notify the room.
create or replace function public.agenda_set_meeting_guests(p_meeting uuid, p_slugs text[])
returns public.agenda_meetings
language plpgsql
security definer
set search_path = public
as $$
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
$$;
grant execute on function public.agenda_set_meeting_guests(uuid, text[]) to authenticated;

-- 9. A guest-team member with no APCs of their own does not HOST a meeting.
--    Abdul Subhan is a TL only because Paid Media has no role yet; his empty
--    weekly slot has always materialised a meeting with nobody to present.
--    He attends other teams' meetings now, so drop the phantom. Completed
--    meetings are kept — history is history.
delete from public.agenda_meetings m
 using public.agenda_guest_team_members gm
 where m.tl_id = gm.user_id
   and m.status <> 'completed'
   and not exists (select 1 from public.profiles a
                    where a.reports_to = m.tl_id and a.role = 'apc'
                      and a.is_active = true and a.deleted_at is null);

delete from public.agenda_team_schedules s
 using public.agenda_guest_team_members gm
 where s.tl_id = gm.user_id
   and not exists (select 1 from public.profiles a
                    where a.reports_to = s.tl_id and a.role = 'apc'
                      and a.is_active = true and a.deleted_at is null);
