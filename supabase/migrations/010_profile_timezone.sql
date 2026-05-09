-- ============================================================
-- WurxOS v2 — Migration 010: per-user timezone for reset schedules
--
-- Adds profiles.timezone (IANA name, e.g. 'Asia/Karachi'),
-- rewrites compute_next_reset to interpret HH:MM as LOCAL time
-- in the user's timezone, and expands the recompute trigger to
-- also react when timezone changes.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. timezone column
-- --------------------------------------------------------------
alter table public.profiles
  add column if not exists timezone text not null default 'UTC';

-- --------------------------------------------------------------
-- 2. compute_next_reset — timezone-aware
--    Interprets the stored HH:MM as local time in the user's zone,
--    then returns the resulting timestamptz (which Postgres stores
--    as UTC under the hood).
-- --------------------------------------------------------------
create or replace function public.compute_next_reset(uid uuid, cat text)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
declare
  v_schedule   jsonb;
  v_tz         text;
  v_time       text;
  v_dow        int;
  v_dom        int;
  v_hh         int;
  v_mm         int;
  v_now_local  timestamp;
  v_candidate  timestamp;
  v_days_ahead int;
begin
  if cat = 'general' then return null; end if;

  select reset_schedule,
         coalesce(nullif(timezone, ''), 'UTC')
    into v_schedule, v_tz
  from public.profiles
  where id = uid;

  if v_schedule is null then
    v_schedule := '{"daily":{"time":"00:00"},"weekly":{"dayOfWeek":1,"time":"00:00"},"monthly":{"dayOfMonth":1,"time":"00:00"}}'::jsonb;
  end if;

  -- Current wall-clock time in the user's zone (timestamp WITHOUT tz)
  v_now_local := (now() at time zone v_tz);

  if cat = 'daily' then
    v_time := coalesce(v_schedule->'daily'->>'time', '00:00');
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_candidate := date_trunc('day', v_now_local) + make_interval(hours => v_hh, mins => v_mm);
    if v_candidate <= v_now_local then
      v_candidate := v_candidate + interval '1 day';
    end if;
    -- Interpret the local timestamp as being in the user's zone, return as UTC
    return v_candidate at time zone v_tz;
  end if;

  if cat = 'weekly' then
    v_time := coalesce(v_schedule->'weekly'->>'time', '00:00');
    v_dow  := coalesce((v_schedule->'weekly'->>'dayOfWeek')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_days_ahead := (v_dow - extract(dow from v_now_local)::int + 7) % 7;
    v_candidate := date_trunc('day', v_now_local)
                   + make_interval(days => v_days_ahead, hours => v_hh, mins => v_mm);
    if v_candidate <= v_now_local then v_candidate := v_candidate + interval '7 days'; end if;
    return v_candidate at time zone v_tz;
  end if;

  if cat = 'monthly' then
    v_time := coalesce(v_schedule->'monthly'->>'time', '00:00');
    v_dom  := coalesce((v_schedule->'monthly'->>'dayOfMonth')::int, 1);
    v_hh := split_part(v_time, ':', 1)::int;
    v_mm := split_part(v_time, ':', 2)::int;
    v_candidate := date_trunc('month', v_now_local)
                   + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    if v_candidate <= v_now_local then
      v_candidate := (date_trunc('month', v_now_local) + interval '1 month')
                     + make_interval(days => v_dom - 1, hours => v_hh, mins => v_mm);
    end if;
    return v_candidate at time zone v_tz;
  end if;

  return null;
end;
$$;

-- --------------------------------------------------------------
-- 3. Recompute on timezone change too (not just schedule)
-- --------------------------------------------------------------
create or replace function public.recompute_tasks_after_schedule_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.reset_schedule::text, '') is distinct from coalesce(new.reset_schedule::text, '')
     or coalesce(old.timezone, '') is distinct from coalesce(new.timezone, '') then
    update public.tasks t
    set next_reset_at = public.compute_next_reset(new.id, t.category)
    where t.assignee_id = new.id
      and t.category in ('daily', 'weekly', 'monthly');
  end if;
  return new;
end;
$$;

-- Extend the trigger columns to watch timezone too
drop trigger if exists profiles_recompute_task_resets on public.profiles;
create trigger profiles_recompute_task_resets
  after update of reset_schedule, timezone on public.profiles
  for each row execute function public.recompute_tasks_after_schedule_change();
