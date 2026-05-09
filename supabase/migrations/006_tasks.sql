-- ============================================================
-- WurxOS v2 — Migration 006: tasks + recurring resets + reset schedules
--
-- Creates:
--   * profiles.reset_schedule jsonb (per-user reset preferences)
--   * tasks table (brand task OR personal task via brand_id = null)
--   * compute_next_reset(uid, category) — reads assignee schedule
--   * RLS policies per role
--   * pg_cron job that resets done-recurring tasks whose time has come
--
-- Pre-req (one-time, via dashboard or SQL): enable pg_cron extension.
--   create extension if not exists pg_cron with schema extensions;
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Per-user reset schedule
--    Shape: { daily: { time: 'HH:MM' },
--             weekly: { dayOfWeek: 0..6 (0=Sun), time: 'HH:MM' },
--             monthly: { dayOfMonth: 1..31, time: 'HH:MM' } }
-- --------------------------------------------------------------
alter table public.profiles
  add column if not exists reset_schedule jsonb
    not null default '{"daily":{"time":"00:00"},"weekly":{"dayOfWeek":1,"time":"00:00"},"monthly":{"dayOfMonth":1,"time":"00:00"}}'::jsonb;

-- --------------------------------------------------------------
-- 2. tasks table
-- --------------------------------------------------------------
create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid references public.brands(id)   on delete cascade,    -- null = personal / no-brand
  assignee_id    uuid not null references public.profiles(id) on delete cascade,
  title          text not null,
  description    text,
  status         text not null default 'todo'
                   check (status in ('todo', 'in_progress', 'done')),
  priority       text not null default 'medium'
                   check (priority in ('low', 'medium', 'high')),
  category       text not null default 'general'
                   check (category in ('general', 'daily', 'weekly', 'monthly')),
  due_date       date,
  link           text,
  created_by     uuid references public.profiles(id) on delete set null,
  next_reset_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists tasks_assignee_idx       on public.tasks(assignee_id);
create index if not exists tasks_brand_idx          on public.tasks(brand_id);
create index if not exists tasks_status_idx         on public.tasks(status);
create index if not exists tasks_created_by_idx     on public.tasks(created_by);
create index if not exists tasks_next_reset_idx     on public.tasks(next_reset_at)
  where category in ('daily','weekly','monthly') and status = 'done';

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- 3. compute_next_reset(uid, category)
--    Returns the next timestamptz when a user's recurring task of the
--    given category should next be re-opened, based on their schedule.
--    Returns NULL for 'general'.
-- --------------------------------------------------------------
create or replace function public.compute_next_reset(uid uuid, cat text)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_schedule jsonb;
  v_time text;
  v_dow  int;   -- 0..6 (0=Sun)
  v_dom  int;
  v_hh   int;
  v_mm   int;
  v_today_at_time timestamp;
  v_candidate timestamp;
  v_days_ahead int;
begin
  if cat = 'general' then return null; end if;

  select reset_schedule into v_schedule from public.profiles where id = uid;
  if v_schedule is null then
    v_schedule := '{"daily":{"time":"00:00"},"weekly":{"dayOfWeek":1,"time":"00:00"},"monthly":{"dayOfMonth":1,"time":"00:00"}}'::jsonb;
  end if;

  if cat = 'daily' then
    v_time := coalesce(v_schedule->'daily'->>'time', '00:00');
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_today_at_time := date_trunc('day', now())::timestamp + make_interval(hours => v_hh, mins => v_mm);
    if v_today_at_time <= now() then
      v_candidate := v_today_at_time + interval '1 day';
    else
      v_candidate := v_today_at_time;
    end if;
    return v_candidate at time zone 'UTC';
  end if;

  if cat = 'weekly' then
    v_time := coalesce(v_schedule->'weekly'->>'time', '00:00');
    v_dow  := coalesce((v_schedule->'weekly'->>'dayOfWeek')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    -- Postgres extract(dow) → 0..6 (0=Sun). Match.
    v_days_ahead := (v_dow - extract(dow from now())::int + 7) % 7;
    v_candidate := date_trunc('day', now())::timestamp
                   + make_interval(days => v_days_ahead, hours => v_hh, mins => v_mm);
    if v_candidate <= now() then v_candidate := v_candidate + interval '7 days'; end if;
    return v_candidate at time zone 'UTC';
  end if;

  if cat = 'monthly' then
    v_time := coalesce(v_schedule->'monthly'->>'time', '00:00');
    v_dom  := coalesce((v_schedule->'monthly'->>'dayOfMonth')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_candidate := date_trunc('month', now())::timestamp
                   + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    if v_candidate <= now() then
      v_candidate := (date_trunc('month', now()) + interval '1 month')::timestamp
                     + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    end if;
    return v_candidate at time zone 'UTC';
  end if;

  return null;
end;
$$;
grant execute on function public.compute_next_reset(uuid, text) to authenticated;

-- --------------------------------------------------------------
-- 4. Trigger to auto-fill next_reset_at on insert / category change
-- --------------------------------------------------------------
create or replace function public.tasks_set_next_reset()
returns trigger
language plpgsql
as $$
begin
  if new.category = 'general' then
    new.next_reset_at := null;
  else
    if tg_op = 'INSERT'
       or coalesce(old.category, '') is distinct from new.category
       or coalesce(old.assignee_id, '00000000-0000-0000-0000-000000000000'::uuid) is distinct from new.assignee_id
       or new.next_reset_at is null then
      new.next_reset_at := public.compute_next_reset(new.assignee_id, new.category);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_set_next_reset_bi on public.tasks;
create trigger tasks_set_next_reset_bi
  before insert on public.tasks
  for each row execute function public.tasks_set_next_reset();

drop trigger if exists tasks_set_next_reset_bu on public.tasks;
create trigger tasks_set_next_reset_bu
  before update of category, assignee_id on public.tasks
  for each row execute function public.tasks_set_next_reset();

-- --------------------------------------------------------------
-- 5. RLS helpers for task access
--
--  Read:
--   - personal task (brand_id null, assignee = creator = uid) → visible to self only
--   - brand task → visible to brand owner (TL), brand members (APCs), Boss/OL
--   - non-personal no-brand task → visible to creator and assignee (and Boss/OL)
--
--  Create:
--   - personal task → anyone for themselves
--   - brand task → Boss/OL always; TL only on their own brands
--   - no-brand non-personal task → Boss/OL/TL/PCTL (TL/PCTL to their team members)
--
--  Update:
--   - Assignee can update status only (enforced by an app-layer check; DB
--     policy simply allows the assignee to update — we'll tighten later).
--   - Creator + Boss/OL + brand owner TL can fully update.
-- --------------------------------------------------------------
create or replace function public.can_view_task(b_id uuid, a_id uuid, c_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (select 1 from public.profiles p
               where p.id = uid and p.role in ('ol','developer') and p.is_active = true)
    or a_id = uid
    or c_id = uid
    or (b_id is not null and exists (
        select 1 from public.brands b
        where b.id = b_id and public.can_view_brand(b.owner_id, b.id, uid)
    ));
$$;
grant execute on function public.can_view_task(uuid, uuid, uuid, uuid) to authenticated;

-- --------------------------------------------------------------
-- 6. RLS — tasks
-- --------------------------------------------------------------
alter table public.tasks enable row level security;

drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select"
  on public.tasks for select
  using (public.can_view_task(brand_id, assignee_id, created_by, auth.uid()));

-- Everyone authenticated can INSERT tasks where they are the creator.
-- Role-specific restrictions (e.g. TL can't assign to random APC) are
-- enforced in the app + can be tightened later here if needed.
drop policy if exists "tasks_insert" on public.tasks;
create policy "tasks_insert"
  on public.tasks for insert
  with check (auth.uid() = created_by);

-- Updates allowed for: assignee, creator, Boss/OL/developer, brand owner.
drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update"
  on public.tasks for update
  using (
    auth.uid() = assignee_id
    or auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
        select 1 from public.brands b
        where b.id = brand_id and b.owner_id = auth.uid()
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
        where b.id = brand_id and b.owner_id = auth.uid()
    ))
  );

-- Delete allowed for Boss/OL and the creator.
drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete"
  on public.tasks for delete
  using (
    auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- --------------------------------------------------------------
-- 7. pg_cron — auto-reset done recurring tasks every 15 minutes
--    (Requires pg_cron extension. Enable via Supabase Dashboard →
--     Database → Extensions → pg_cron → Enable.)
-- --------------------------------------------------------------
create or replace function public.reset_recurring_tasks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks t
  set status = 'todo',
      next_reset_at = public.compute_next_reset(t.assignee_id, t.category),
      updated_at = now()
  where t.category in ('daily','weekly','monthly')
    and t.status = 'done'
    and t.next_reset_at is not null
    and t.next_reset_at <= now();
end;
$$;

-- Schedule via pg_cron (idempotent). If pg_cron isn't enabled yet, skip
-- this block — app still works, recurring tasks just won't auto-reset.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('reset-recurring-tasks')
      where exists (select 1 from cron.job where jobname = 'reset-recurring-tasks');
    perform cron.schedule(
      'reset-recurring-tasks',
      '*/15 * * * *',
      $CRON$ select public.reset_recurring_tasks(); $CRON$
    );
  end if;
end;
$$;
