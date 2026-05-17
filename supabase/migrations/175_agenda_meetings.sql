-- ============================================================
-- WurxOS v2 — Migration 175: Weekly Agenda Meetings (phase 1)
--
-- A separate operational module for the weekly (Tue) agenda
-- meeting. Phase 1 ships:
--   * agenda_settings  — OL-managed Meet link + meeting day
--   * agenda_tasks     — recurring per-APC meeting tasks, fully
--                        independent of the existing `tasks` table
--   * agenda_resources — brand-scoped resource foundation
--   * profiles.agenda_reset — per-user reset cadence for agenda tasks
--   * recurring auto-reset via pg_cron (mirrors mig 006/105)
--   * notifications on assign + status change ('agenda' category)
--   * brand_switch_apc extended so agenda tasks/resources follow a
--     brand to its new APC
--
-- Phase 2 (not here): Prior/Ongoing/Upcoming meeting records,
-- ratings/remarks/flags, attendance, analytics.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Per-user agenda reset cadence
--    Shape mirrors profiles.reset_schedule but adds a `cadence`
--    selector — agenda tasks have ONE cadence per user (all of a
--    user's agenda tasks reset together), unlike the main task
--    system where recurrence is per-task.
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists agenda_reset jsonb
    not null default '{"cadence":"weekly","daily":{"time":"00:00"},"weekly":{"dayOfWeek":1,"time":"00:00"},"monthly":{"dayOfMonth":1,"time":"00:00"}}'::jsonb;

-- ------------------------------------------------------------
-- 2. agenda_settings — single config row (id is pinned to 1)
-- ------------------------------------------------------------
create table if not exists public.agenda_settings (
  id               int          primary key default 1 check (id = 1),
  google_meet_link text         not null default '',
  meeting_day      text         not null default 'tuesday'
                     check (meeting_day in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
  updated_by       uuid         references public.profiles(id) on delete set null,
  updated_at       timestamptz  not null default now()
);
insert into public.agenda_settings (id) values (1) on conflict (id) do nothing;

alter table public.agenda_settings enable row level security;

drop policy if exists "agenda_settings_select" on public.agenda_settings;
create policy "agenda_settings_select"
  on public.agenda_settings for select
  using (auth.uid() is not null);

-- Only OL / Boss / Developer may change the meeting settings.
drop policy if exists "agenda_settings_update" on public.agenda_settings;
create policy "agenda_settings_update"
  on public.agenda_settings for update
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
-- 3. agenda_tasks — recurring meeting tasks
-- ------------------------------------------------------------
create table if not exists public.agenda_tasks (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid references public.brands(id)   on delete cascade,
  assignee_id   uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  details       text,
  status        text not null default 'todo'
                  check (status in ('todo','in_progress','completed')),
  due_date      date,
  link          text,
  created_by    uuid references public.profiles(id) on delete set null,
  next_reset_at timestamptz,
  notify        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists agenda_tasks_assignee_idx   on public.agenda_tasks(assignee_id);
create index if not exists agenda_tasks_brand_idx      on public.agenda_tasks(brand_id);
create index if not exists agenda_tasks_status_idx     on public.agenda_tasks(status);
create index if not exists agenda_tasks_created_by_idx on public.agenda_tasks(created_by);
create index if not exists agenda_tasks_next_reset_idx on public.agenda_tasks(next_reset_at);

drop trigger if exists agenda_tasks_touch_updated_at on public.agenda_tasks;
create trigger agenda_tasks_touch_updated_at
  before update on public.agenda_tasks
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 4. agenda_resources — brand-scoped resource foundation
-- ------------------------------------------------------------
create table if not exists public.agenda_resources (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid references public.brands(id) on delete cascade,
  type        text not null default 'link'
                check (type in ('link','image','video','file')),
  name        text not null,
  url         text not null,
  description text not null default '',
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists agenda_resources_brand_idx   on public.agenda_resources(brand_id);
create index if not exists agenda_resources_creator_idx on public.agenda_resources(created_by);

-- ------------------------------------------------------------
-- 5. compute_agenda_next_reset(uid) — next reset for a user's
--    agenda tasks, based on their personal agenda cadence.
--    Mirrors compute_next_reset (mig 006) but cadence-driven.
-- ------------------------------------------------------------
create or replace function public.compute_agenda_next_reset(uid uuid)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v         jsonb;
  v_cad     text;
  v_time    text;
  v_dow     int;
  v_dom     int;
  v_hh      int;
  v_mm      int;
  v_today   timestamp;
  v_cand    timestamp;
  v_days    int;
begin
  select agenda_reset into v from public.profiles where id = uid;
  if v is null then
    v := '{"cadence":"weekly","daily":{"time":"00:00"},"weekly":{"dayOfWeek":1,"time":"00:00"},"monthly":{"dayOfMonth":1,"time":"00:00"}}'::jsonb;
  end if;
  v_cad := coalesce(v->>'cadence', 'weekly');

  if v_cad = 'daily' then
    v_time := coalesce(v->'daily'->>'time', '00:00');
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_today := date_trunc('day', now())::timestamp + make_interval(hours => v_hh, mins => v_mm);
    if v_today <= now() then v_cand := v_today + interval '1 day'; else v_cand := v_today; end if;
    return v_cand at time zone 'UTC';

  elsif v_cad = 'monthly' then
    v_time := coalesce(v->'monthly'->>'time', '00:00');
    v_dom  := coalesce((v->'monthly'->>'dayOfMonth')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_cand := date_trunc('month', now())::timestamp + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    if v_cand <= now() then
      v_cand := (date_trunc('month', now()) + interval '1 month')::timestamp
                + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    end if;
    return v_cand at time zone 'UTC';

  else
    -- weekly (default)
    v_time := coalesce(v->'weekly'->>'time', '00:00');
    v_dow  := coalesce((v->'weekly'->>'dayOfWeek')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_days := (v_dow - extract(dow from now())::int + 7) % 7;
    v_cand := date_trunc('day', now())::timestamp
              + make_interval(days => v_days, hours => v_hh, mins => v_mm);
    if v_cand <= now() then v_cand := v_cand + interval '7 days'; end if;
    return v_cand at time zone 'UTC';
  end if;
end;
$$;
grant execute on function public.compute_agenda_next_reset(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. Trigger — auto-fill next_reset_at on insert / assignee change
-- ------------------------------------------------------------
create or replace function public.agenda_task_set_next_reset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or coalesce(old.assignee_id, '00000000-0000-0000-0000-000000000000'::uuid)
        is distinct from new.assignee_id
     or new.next_reset_at is null then
    new.next_reset_at := public.compute_agenda_next_reset(new.assignee_id);
  end if;
  return new;
end;
$$;

drop trigger if exists agenda_task_set_next_reset_bi on public.agenda_tasks;
create trigger agenda_task_set_next_reset_bi
  before insert on public.agenda_tasks
  for each row execute function public.agenda_task_set_next_reset();

drop trigger if exists agenda_task_set_next_reset_bu on public.agenda_tasks;
create trigger agenda_task_set_next_reset_bu
  before update of assignee_id on public.agenda_tasks
  for each row execute function public.agenda_task_set_next_reset();

-- ------------------------------------------------------------
-- 7. RLS — agenda_tasks
--    Read : Boss/OL/Dev, the assignee, the creator, or anyone who
--           can see the brand (covers the owning TL).
--    Write: assignee + creator + Boss/OL/Dev + brand owner.
--    Del  : creator + Boss/OL/Dev (APC can delete tasks they made;
--           a TL-assigned task they can't — they aren't the creator).
-- ------------------------------------------------------------
alter table public.agenda_tasks enable row level security;

drop policy if exists "agenda_tasks_select" on public.agenda_tasks;
create policy "agenda_tasks_select"
  on public.agenda_tasks for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or assignee_id = auth.uid()
    or created_by = auth.uid()
    or (brand_id is not null and exists (
        select 1 from public.brands b
        where b.id = agenda_tasks.brand_id
          and public.can_view_brand(b.owner_id, b.id, auth.uid())
    ))
  );

drop policy if exists "agenda_tasks_insert" on public.agenda_tasks;
create policy "agenda_tasks_insert"
  on public.agenda_tasks for insert
  with check (auth.uid() = created_by);

drop policy if exists "agenda_tasks_update" on public.agenda_tasks;
create policy "agenda_tasks_update"
  on public.agenda_tasks for update
  using (
    auth.uid() = assignee_id
    or auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
        select 1 from public.brands b
        where b.id = agenda_tasks.brand_id and b.owner_id = auth.uid()
    ))
  )
  with check (
    auth.uid() = assignee_id
    or auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
        select 1 from public.brands b
        where b.id = agenda_tasks.brand_id and b.owner_id = auth.uid()
    ))
  );

drop policy if exists "agenda_tasks_delete" on public.agenda_tasks;
create policy "agenda_tasks_delete"
  on public.agenda_tasks for delete
  using (
    auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- ------------------------------------------------------------
-- 8. RLS — agenda_resources (brand-scoped or general)
-- ------------------------------------------------------------
alter table public.agenda_resources enable row level security;

drop policy if exists "agenda_resources_select" on public.agenda_resources;
create policy "agenda_resources_select"
  on public.agenda_resources for select
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or brand_id is null
    or exists (
      select 1 from public.brands b
      where b.id = agenda_resources.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "agenda_resources_insert" on public.agenda_resources;
create policy "agenda_resources_insert"
  on public.agenda_resources for insert
  with check (created_by = auth.uid());

drop policy if exists "agenda_resources_update" on public.agenda_resources;
create policy "agenda_resources_update"
  on public.agenda_resources for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = agenda_resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
  );

drop policy if exists "agenda_resources_delete" on public.agenda_resources;
create policy "agenda_resources_delete"
  on public.agenda_resources for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
      select 1 from public.brands b
      where b.id = agenda_resources.brand_id and public.can_edit_brand(b.owner_id, auth.uid())
    ))
  );

-- ------------------------------------------------------------
-- 9. Notification triggers
--    Assign  : assignee notified when a different user assigns
--              them an agenda task (always).
--    Status  : the counterpart is notified on a status change,
--              opt-in via the transient `notify` flag.
-- ------------------------------------------------------------
create or replace function public.agenda_task_notify_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_actor text;
begin
  if new.assignee_id is not null
     and new.created_by is not null
     and new.assignee_id <> new.created_by then
    v_actor := public.profile_display_name(new.created_by);
    perform public.emit_notification(
      new.assignee_id, new.created_by, 'agenda', 'agenda.task_assigned',
      'New agenda task',
      v_actor || ' assigned you an agenda task: ' || new.title,
      'agenda_task', new.id, '/agenda/tasks'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists agenda_task_notify_insert_ai on public.agenda_tasks;
create trigger agenda_task_notify_insert_ai
  after insert on public.agenda_tasks
  for each row execute function public.agenda_task_notify_insert();

create or replace function public.agenda_task_notify_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id  uuid := auth.uid();
  v_actor     text;
  v_recipient uuid;
  v_label     text;
begin
  if new.status is not distinct from old.status then return new; end if;
  if not coalesce(new.notify, false) then return new; end if;

  -- Notify the counterpart: assignee changes it -> tell the creator;
  -- anyone else changes it -> tell the assignee.
  if v_actor_id = new.assignee_id then
    v_recipient := new.created_by;
  else
    v_recipient := new.assignee_id;
  end if;
  if v_recipient is null or v_recipient = v_actor_id then return new; end if;

  v_actor := public.profile_display_name(v_actor_id);
  v_label := case new.status
               when 'todo'        then 'To Do'
               when 'in_progress' then 'In Progress'
               when 'completed'   then 'Completed'
               else new.status
             end;
  perform public.emit_notification(
    v_recipient, v_actor_id, 'agenda', 'agenda.task_status',
    'Agenda task updated',
    v_actor || ' moved "' || new.title || '" to ' || v_label,
    'agenda_task', new.id, '/agenda/tasks'
  );
  return new;
end;
$$;

drop trigger if exists agenda_task_notify_status_au on public.agenda_tasks;
create trigger agenda_task_notify_status_au
  after update of status on public.agenda_tasks
  for each row execute function public.agenda_task_notify_status();

-- ------------------------------------------------------------
-- 10. Recurring auto-reset — pg_cron every 15 minutes.
--     All of a user's agenda tasks reset together to 'todo';
--     next_reset_at + due_date advance to the next cycle.
--     Tasks on inactive (frozen) brands are skipped.
-- ------------------------------------------------------------
create or replace function public.reset_agenda_tasks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.agenda_tasks t
     set status        = 'todo',
         next_reset_at  = public.compute_agenda_next_reset(t.assignee_id),
         due_date       = public.compute_agenda_next_reset(t.assignee_id)::date,
         updated_at     = now()
   where t.next_reset_at is not null
     and t.next_reset_at <= now()
     and (t.brand_id is null or exists (
       select 1 from public.brands b where b.id = t.brand_id and b.status = 'active'
     ));
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('reset-agenda-tasks')
      where exists (select 1 from cron.job where jobname = 'reset-agenda-tasks');
    perform cron.schedule(
      'reset-agenda-tasks',
      '*/15 * * * *',
      $CRON$ select public.reset_agenda_tasks(); $CRON$
    );
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 11. Realtime — agenda_tasks + agenda_resources
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present — skipping';
    return;
  end if;
  for t in select unnest(array['agenda_tasks', 'agenda_resources'])
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
