-- ============================================================
-- WurxOS v2 — Migration 179: Ongoing Meetings (phase 3).
--
-- The live meeting room: attendance, the single-presenter lock,
-- the OL's per-task reviews + per-APC overall summary, and TL
-- remarks. Everything is realtime-published so participants never
-- need to refresh.
--
-- Adds:
--   * agenda_meeting_attendance — per-APC Present/Absent (TL writes)
--   * agenda_presentations      — per-APC presentation state, with a
--                                 DB-enforced one-presenter-at-a-time
--   * agenda_task_reviews       — OL per-task rating + notes
--   * agenda_meetings.tl_rating / tl_remark / tl_reviewed_by
--   * RPCs: agenda_start_presenting / agenda_stop_presenting
--   * agenda_start_meeting — only one ongoing meeting at a time
--   * agenda_finish_meeting — closes any live presentation
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 0. TL remark columns on the meeting
-- ------------------------------------------------------------
alter table public.agenda_meetings
  add column if not exists tl_rating      text,
  add column if not exists tl_remark      text,
  add column if not exists tl_reviewed_by uuid references public.profiles(id) on delete set null;

-- ------------------------------------------------------------
-- 1. Visibility helper — OL/Boss, the team's TL, or the team's APCs.
-- ------------------------------------------------------------
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
    )
  );
$$;
grant execute on function public.agenda_can_view_meeting(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. agenda_meeting_attendance — per-APC Present/Absent
-- ------------------------------------------------------------
create table if not exists public.agenda_meeting_attendance (
  id         uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.agenda_meetings(id) on delete cascade,
  apc_id     uuid not null references public.profiles(id) on delete cascade,
  status     text check (status in ('present','absent')),
  marked_by  uuid references public.profiles(id) on delete set null,
  marked_at  timestamptz,
  unique (meeting_id, apc_id)
);
create index if not exists agenda_attendance_meeting_idx on public.agenda_meeting_attendance(meeting_id);

alter table public.agenda_meeting_attendance enable row level security;

drop policy if exists "agenda_att_select" on public.agenda_meeting_attendance;
create policy "agenda_att_select"
  on public.agenda_meeting_attendance for select
  using (public.agenda_can_view_meeting(meeting_id));

-- Only the meeting's Team Lead may mark attendance.
drop policy if exists "agenda_att_write" on public.agenda_meeting_attendance;
create policy "agenda_att_write"
  on public.agenda_meeting_attendance for all
  using (exists (select 1 from public.agenda_meetings m where m.id = meeting_id and m.tl_id = auth.uid()))
  with check (exists (select 1 from public.agenda_meetings m where m.id = meeting_id and m.tl_id = auth.uid()));

-- ------------------------------------------------------------
-- 3. agenda_presentations — per-APC presentation state
-- ------------------------------------------------------------
create table if not exists public.agenda_presentations (
  id              uuid primary key default gen_random_uuid(),
  meeting_id      uuid not null references public.agenda_meetings(id) on delete cascade,
  apc_id          uuid not null references public.profiles(id) on delete cascade,
  status          text not null default 'pending'
                    check (status in ('pending','presenting','done')),
  started_at      timestamptz,
  ended_at        timestamptz,
  overall_rating  text,
  overall_summary text,
  reviewed_by     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (meeting_id, apc_id)
);
create index if not exists agenda_pres_meeting_idx on public.agenda_presentations(meeting_id);

-- At most one APC presenting per meeting (the lock, enforced in DB).
create unique index if not exists agenda_pres_one_presenter
  on public.agenda_presentations(meeting_id)
  where status = 'presenting';

drop trigger if exists agenda_presentations_touch on public.agenda_presentations;
create trigger agenda_presentations_touch
  before update on public.agenda_presentations
  for each row execute function public.touch_updated_at();

alter table public.agenda_presentations enable row level security;

drop policy if exists "agenda_pres_select" on public.agenda_presentations;
create policy "agenda_pres_select"
  on public.agenda_presentations for select
  using (public.agenda_can_view_meeting(meeting_id));

-- Direct writes (overall rating/summary) are OL/Boss only; the
-- presenting state is changed through the security-definer RPCs.
drop policy if exists "agenda_pres_write" on public.agenda_presentations;
create policy "agenda_pres_write"
  on public.agenda_presentations for all
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
-- 4. agenda_task_reviews — OL per-task rating + notes
-- ------------------------------------------------------------
create table if not exists public.agenda_task_reviews (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.agenda_meetings(id) on delete cascade,
  apc_id      uuid not null references public.profiles(id) on delete cascade,
  task_id     uuid not null references public.agenda_tasks(id) on delete cascade,
  rating      text,
  notes       text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (meeting_id, task_id)
);
create index if not exists agenda_reviews_meeting_idx on public.agenda_task_reviews(meeting_id);

drop trigger if exists agenda_task_reviews_touch on public.agenda_task_reviews;
create trigger agenda_task_reviews_touch
  before update on public.agenda_task_reviews
  for each row execute function public.touch_updated_at();

alter table public.agenda_task_reviews enable row level security;

-- Reviews are OL-private until the post-meeting phase ships.
drop policy if exists "agenda_rev_select" on public.agenda_task_reviews;
create policy "agenda_rev_select"
  on public.agenda_task_reviews for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

drop policy if exists "agenda_rev_write" on public.agenda_task_reviews;
create policy "agenda_rev_write"
  on public.agenda_task_reviews for all
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
-- 5. agenda_start_meeting — recreate with the one-ongoing rule.
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

  -- Sequential rule: only one ongoing meeting across all teams.
  if exists (select 1 from public.agenda_meetings where status = 'ongoing' and id <> p_meeting) then
    raise exception 'finish the current ongoing meeting before starting another';
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
-- 6. agenda_finish_meeting — recreate; closes any live presentation.
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

  update public.agenda_presentations
     set status = 'done', ended_at = coalesce(ended_at, now()), updated_at = now()
   where meeting_id = p_meeting and status = 'presenting';

  return v_m;
end;
$$;
grant execute on function public.agenda_finish_meeting(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7. agenda_start_presenting — the presenter lock.
-- ------------------------------------------------------------
create or replace function public.agenda_start_presenting(p_meeting uuid)
returns public.agenda_presentations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.agenda_meetings;
  v_row public.agenda_presentations;
begin
  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;
  if v_m.status <> 'ongoing' then raise exception 'meeting is not ongoing'; end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_uid and p.role = 'apc' and p.reports_to = v_m.tl_id
  ) then
    raise exception 'only an APC of this team can present';
  end if;

  if exists (
    select 1 from public.agenda_presentations
    where meeting_id = p_meeting and status = 'presenting' and apc_id <> v_uid
  ) then
    raise exception 'another APC is currently presenting';
  end if;

  insert into public.agenda_presentations (meeting_id, apc_id, status, started_at)
  values (p_meeting, v_uid, 'presenting', now())
  on conflict (meeting_id, apc_id) do update
    set status     = 'presenting',
        started_at = coalesce(public.agenda_presentations.started_at, now()),
        ended_at   = null,
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.agenda_start_presenting(uuid) to authenticated;

-- ------------------------------------------------------------
-- 8. agenda_stop_presenting — the presenting APC or any OL/Boss.
-- ------------------------------------------------------------
create or replace function public.agenda_stop_presenting(p_meeting uuid, p_apc uuid)
returns public.agenda_presentations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.agenda_presentations;
begin
  if not (v_uid = p_apc or public._agenda_is_ol(v_uid)) then
    raise exception 'not allowed to stop this presentation';
  end if;

  update public.agenda_presentations
     set status = 'done', ended_at = now(), updated_at = now()
   where meeting_id = p_meeting and apc_id = p_apc and status = 'presenting'
   returning * into v_row;
  if not found then
    raise exception 'no active presentation to stop';
  end if;

  return v_row;
end;
$$;
grant execute on function public.agenda_stop_presenting(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 9. Realtime — attendance + presentations
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present — skipping';
    return;
  end if;
  for t in select unnest(array['agenda_meeting_attendance', 'agenda_presentations'])
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'Added % to supabase_realtime', t;
    end if;
    execute format('alter table public.%I replica identity full', t);
    begin
      execute format('grant select on public.%I to supabase_realtime_admin', t);
    exception when undefined_object then
      null;
    end;
  end loop;
end;
$$;
