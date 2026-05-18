-- ============================================================
-- WurxOS v2 — Migration 177: Agenda Meetings — schedules + the
-- weekly meeting lifecycle (phase 2).
--
-- Adds:
--   * agenda_team_schedules — OL-set recurring slot per TL-team
--     (a weekday + time). A team with no row is "unconfigured".
--   * agenda_meetings — a team's meeting instance for a given week,
--     moving upcoming -> ongoing -> completed.
--   * agenda_notify_week()  — materialise + notify a week's meetings
--   * agenda_start_meeting() / agenda_finish_meeting()
--
-- Phase 3 (not here): Prior Meetings, in-meeting ratings/remarks.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. agenda_team_schedules — one recurring slot per TL-team
-- ------------------------------------------------------------
create table if not exists public.agenda_team_schedules (
  id           uuid primary key default gen_random_uuid(),
  tl_id        uuid not null unique references public.profiles(id) on delete cascade,
  meeting_day  text not null
                 check (meeting_day in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
  meeting_time time not null,
  updated_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists agenda_team_schedules_touch on public.agenda_team_schedules;
create trigger agenda_team_schedules_touch
  before update on public.agenda_team_schedules
  for each row execute function public.touch_updated_at();

alter table public.agenda_team_schedules enable row level security;

drop policy if exists "agenda_sched_select" on public.agenda_team_schedules;
create policy "agenda_sched_select"
  on public.agenda_team_schedules for select
  using (auth.uid() is not null);

drop policy if exists "agenda_sched_write" on public.agenda_team_schedules;
create policy "agenda_sched_write"
  on public.agenda_team_schedules for all
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  )
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- ------------------------------------------------------------
-- 2. agenda_meetings — per-team meeting instances
-- ------------------------------------------------------------
create table if not exists public.agenda_meetings (
  id           uuid primary key default gen_random_uuid(),
  tl_id        uuid not null references public.profiles(id) on delete cascade,
  week_start   date not null,                 -- Monday of the meeting's week
  meeting_date date not null,
  meeting_time time,
  status       text not null default 'upcoming'
                 check (status in ('upcoming','ongoing','completed')),
  notified_at  timestamptz,
  started_at   timestamptz,
  started_by   uuid references public.profiles(id) on delete set null,
  finished_at  timestamptz,
  finished_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tl_id, meeting_date)
);

create index if not exists agenda_meetings_week_idx   on public.agenda_meetings(week_start);
create index if not exists agenda_meetings_tl_idx     on public.agenda_meetings(tl_id);
create index if not exists agenda_meetings_status_idx on public.agenda_meetings(status);

drop trigger if exists agenda_meetings_touch on public.agenda_meetings;
create trigger agenda_meetings_touch
  before update on public.agenda_meetings
  for each row execute function public.touch_updated_at();

alter table public.agenda_meetings enable row level security;

-- Read: OL/Boss/Dev see all; a TL sees their own team's meetings;
-- an APC sees the meetings of the team they report to.
drop policy if exists "agenda_meetings_select" on public.agenda_meetings;
create policy "agenda_meetings_select"
  on public.agenda_meetings for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or tl_id = auth.uid()
    or tl_id = (select reports_to from public.profiles where id = auth.uid())
  );

-- Writes go through the security-definer RPCs below; still gate the
-- table to OL/Boss/Dev as a backstop.
drop policy if exists "agenda_meetings_write" on public.agenda_meetings;
create policy "agenda_meetings_write"
  on public.agenda_meetings for all
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  )
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- ------------------------------------------------------------
-- 3. Helpers
-- ------------------------------------------------------------
-- Day name -> offset from Monday (0..6).
create or replace function public._agenda_day_offset(p_day text)
returns int
language sql
immutable
as $$
  select case lower(p_day)
    when 'monday'    then 0
    when 'tuesday'   then 1
    when 'wednesday' then 2
    when 'thursday'  then 3
    when 'friday'    then 4
    when 'saturday'  then 5
    when 'sunday'    then 6
    else 1
  end;
$$;

create or replace function public._agenda_is_ol(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_boss(uid)
    or exists (select 1 from public.profiles p
               where p.id = uid and p.role in ('ol','developer') and p.is_active = true);
$$;
grant execute on function public._agenda_is_ol(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. agenda_notify_week — materialise + notify a week's meetings.
--    For every configured team, computes the meeting date in the
--    given week, upserts the meeting row (status preserved if it
--    already exists) and notifies the TL + every APC on the team.
--    p_week_start must be a Monday.
-- ------------------------------------------------------------
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
  v_label   text;
begin
  if not public._agenda_is_ol(v_uid) then
    raise exception 'only OL/Boss can notify teams';
  end if;

  for v_sched in select * from public.agenda_team_schedules loop
    v_date := p_week_start + public._agenda_day_offset(v_sched.meeting_day);

    insert into public.agenda_meetings (tl_id, week_start, meeting_date, meeting_time, status, notified_at)
    values (v_sched.tl_id, p_week_start, v_date, v_sched.meeting_time, 'upcoming', now())
    on conflict (tl_id, meeting_date) do update
      set notified_at  = now(),
          week_start   = excluded.week_start,
          meeting_time = excluded.meeting_time
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

-- ------------------------------------------------------------
-- 5. agenda_start_meeting — upcoming -> ongoing, notify the team.
-- ------------------------------------------------------------
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
     set status = 'ongoing', started_at = now(), started_by = v_uid, updated_at = now()
   where id = p_meeting and status = 'upcoming'
   returning * into v_m;
  if not found then
    raise exception 'meeting not found or not in an upcoming state';
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

-- ------------------------------------------------------------
-- 6. agenda_finish_meeting — ongoing -> completed.
-- ------------------------------------------------------------
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

  return v_m;
end;
$$;
grant execute on function public.agenda_finish_meeting(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7. Realtime — agenda_meetings
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present — skipping';
    return;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'agenda_meetings'
  ) then
    execute 'alter publication supabase_realtime add table public.agenda_meetings';
    raise notice 'Added agenda_meetings to supabase_realtime';
  end if;
  execute 'alter table public.agenda_meetings replica identity full';
  begin
    execute 'grant select on public.agenda_meetings to supabase_realtime_admin';
  exception when undefined_object then
    null;
  end;
end;
$$;
