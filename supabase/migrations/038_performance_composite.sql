-- ============================================================
-- WurxOS v2 — Migration 038: Performance composite & config
--
-- Extends migration 032 to match v1's 4-pillar composite model:
--   * performance_config singleton (Boss-editable weights, thresholds,
--     min attendance days, flag point values)
--   * get_performance_composite(user, month) -> 4 pillar scores +
--     composite score + level classification
--   * get_performance_overview(month, role_filter) -> list for team view
--   * notifications: fire when a rating / flag / warning is issued
-- ============================================================

-- ------------------------------------------------------------
-- 1. Config singleton
-- ------------------------------------------------------------
create table if not exists public.performance_config (
  id                    int primary key default 1,
  -- pillar weights (must sum to 100; UI enforces)
  weight_performance    numeric not null default 40,
  weight_incentives     numeric not null default 25,
  weight_attendance     numeric not null default 20,
  weight_flags          numeric not null default 15,
  -- attendance baseline
  min_attendance_days   int not null default 22,
  -- level thresholds (composite 0-100)
  threshold_promotion   numeric not null default 90,
  threshold_good        numeric not null default 70,
  threshold_warning     numeric not null default 50,
  -- flag point values (added/subtracted from flags pillar base 70)
  flag_pts_low          numeric not null default 3,
  flag_pts_medium       numeric not null default 5,
  flag_pts_high         numeric not null default 8,
  flag_pts_critical     numeric not null default 12,
  updated_by            uuid references public.profiles(id) on delete set null,
  updated_at            timestamptz not null default now(),
  constraint performance_config_single_row check (id = 1)
);

insert into public.performance_config (id) values (1) on conflict (id) do nothing;

alter table public.performance_config enable row level security;

drop policy if exists "perf_config_select" on public.performance_config;
create policy "perf_config_select"
  on public.performance_config for select
  using (auth.uid() is not null);

drop policy if exists "perf_config_write" on public.performance_config;
create policy "perf_config_write"
  on public.performance_config for update
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

-- ------------------------------------------------------------
-- 2. Pillar computations
-- ------------------------------------------------------------

-- Incentives pillar: % of items marked completed (incentives + bonuses).
-- If no items, returns 0 (matches v1 behaviour).
create or replace function public.perf_incentives_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_done int := 0;
  v_total int := 0;
  v_row public.incentives%rowtype;
begin
  select * into v_row from public.incentives where user_id = p_user and month = p_month;
  if not found then return 0; end if;

  select
    coalesce(
      (select count(*) from jsonb_array_elements(v_row.incentives) x where (x->>'completed')::bool),
      0
    ) +
    coalesce(
      (select count(*) from jsonb_array_elements(v_row.bonuses) x where (x->>'completed')::bool),
      0
    )
  into v_done;

  v_total := coalesce(jsonb_array_length(v_row.incentives), 0)
           + coalesce(jsonb_array_length(v_row.bonuses), 0);

  if v_total = 0 then return 0; end if;
  return round((v_done::numeric / v_total) * 100, 1);
end;
$$;
grant execute on function public.perf_incentives_score(uuid, text) to authenticated;

-- Attendance pillar: daysPresent / minAttendanceDays * 100 (capped 100).
-- "Present" = attendance row for the user/month that reached status
-- clocked-out or is still active (counts partial day). Auto-closed days count.
create or replace function public.perf_attendance_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_min int;
  v_days int;
  v_start date := (p_month || '-01')::date;
  v_end   date := (p_month || '-01')::date + interval '1 month';
begin
  select min_attendance_days into v_min from public.performance_config where id = 1;
  if v_min is null or v_min = 0 then v_min := 22; end if;

  select count(distinct date) into v_days
    from public.attendance
   where user_id = p_user
     and date >= v_start and date < v_end;

  return least(100, round((v_days::numeric / v_min) * 100, 1));
end;
$$;
grant execute on function public.perf_attendance_score(uuid, text) to authenticated;

-- Flags pillar: base 70 + green pts - red pts, clamped to 0-100.
-- Only flags created in the target month are counted.
create or replace function public.perf_flags_score(p_user uuid, p_month text)
returns numeric
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_low      numeric;
  v_med      numeric;
  v_high     numeric;
  v_crit     numeric;
  v_green    numeric := 0;
  v_red      numeric := 0;
  v_start    timestamptz := (p_month || '-01')::timestamptz;
  v_end      timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
  r          record;
begin
  select flag_pts_low, flag_pts_medium, flag_pts_high, flag_pts_critical
    into v_low, v_med, v_high, v_crit
    from public.performance_config where id = 1;

  for r in
    select type, severity, count(*) as n
      from public.performance_flags
     where user_id = p_user
       and created_at >= v_start and created_at < v_end
     group by type, severity
  loop
    declare v_pts numeric;
    begin
      v_pts := case r.severity
        when 'low'      then coalesce(v_low, 3)
        when 'medium'   then coalesce(v_med, 5)
        when 'high'     then coalesce(v_high, 8)
        when 'critical' then coalesce(v_crit, 12)
        else 0
      end;
      if r.type = 'green' then
        v_green := v_green + v_pts * r.n;
      else
        v_red := v_red + v_pts * r.n;
      end if;
    end;
  end loop;

  return greatest(0, least(100, 70 + v_green - v_red));
end;
$$;
grant execute on function public.perf_flags_score(uuid, text) to authenticated;

-- Classify composite into a level label
create or replace function public.perf_level(p_score numeric)
returns text
language sql
stable
as $$
  select case
    when p_score is null then 'not_rated'
    when p_score >= (select threshold_promotion from public.performance_config where id = 1) then 'promotion'
    when p_score >= (select threshold_good      from public.performance_config where id = 1) then 'good'
    when p_score >= (select threshold_warning   from public.performance_config where id = 1) then 'warning'
    else 'termination'
  end;
$$;
grant execute on function public.perf_level(numeric) to authenticated;

-- ------------------------------------------------------------
-- 3. Composite RPC (per-user, per-month)
-- ------------------------------------------------------------
create or replace function public.get_performance_composite(p_user uuid, p_month text)
returns table (
  user_id           uuid,
  month             text,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  warning_count     int
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_cfg public.performance_config%rowtype;
  v_perf numeric;
  v_inc numeric;
  v_att numeric;
  v_flg numeric;
  v_composite numeric;
  v_warnings int;
begin
  select * into v_cfg from public.performance_config where id = 1;

  -- Performance pillar: normalize 0-10 rating to 0-100
  select round((coalesce(overall_score, 0) * 10)::numeric, 1)
    into v_perf
    from public.performance_ratings
    where user_id = p_user and month = p_month;

  v_inc := public.perf_incentives_score(p_user, p_month);
  v_att := public.perf_attendance_score(p_user, p_month);
  v_flg := public.perf_flags_score(p_user, p_month);

  if v_perf is null then
    v_composite := null;
  else
    v_composite := round((
      v_perf * v_cfg.weight_performance
      + coalesce(v_inc, 0) * v_cfg.weight_incentives
      + coalesce(v_att, 0) * v_cfg.weight_attendance
      + coalesce(v_flg, 0) * v_cfg.weight_flags
    ) / nullif(
      v_cfg.weight_performance + v_cfg.weight_incentives
      + v_cfg.weight_attendance + v_cfg.weight_flags, 0
    ), 1);
  end if;

  select count(*) into v_warnings from public.performance_warnings where user_id = p_user;

  return query select
    p_user,
    p_month,
    v_perf,
    v_inc,
    v_att,
    v_flg,
    v_composite,
    public.perf_level(v_composite),
    v_warnings;
end;
$$;
grant execute on function public.get_performance_composite(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Team overview RPC (for manager dashboards)
-- Returns one row per active profile visible to the caller, with
-- composite pillars & level for the requested month.
-- ------------------------------------------------------------
create or replace function public.get_performance_overview(p_month text)
returns table (
  user_id           uuid,
  display_name      text,
  role              text,
  avatar_url        text,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  green_flags       int,
  red_flags         int,
  warning_count     int
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller uuid := auth.uid();
  v_is_mgr bool := public.is_boss(v_caller)
                  or exists (select 1 from public.profiles p where p.id = v_caller and p.role in ('ol','developer','tl','pctl') and p.is_active);
  v_start  timestamptz := (p_month || '-01')::timestamptz;
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
begin
  if v_caller is null or not v_is_mgr then
    return;
  end if;

  return query
  with scope as (
    select p.id, p.display_name, p.role, p.avatar_url
      from public.profiles p
     where p.is_active = true
       and (
         public.is_boss(v_caller)
         or exists (select 1 from public.profiles me where me.id = v_caller and me.role in ('ol','developer'))
         or p.reports_to = v_caller
       )
  ),
  comp as (
    select s.id,
           s.display_name,
           s.role,
           s.avatar_url,
           c.performance_score,
           c.incentives_score,
           c.attendance_score,
           c.flags_score,
           c.composite_score,
           c.level,
           c.warning_count
      from scope s
      cross join lateral public.get_performance_composite(s.id, p_month) c
  )
  select
    c.id,
    c.display_name,
    c.role,
    c.avatar_url,
    c.performance_score,
    c.incentives_score,
    c.attendance_score,
    c.flags_score,
    c.composite_score,
    c.level,
    coalesce((select count(*)::int from public.performance_flags f
              where f.user_id = c.id and f.type = 'green'
                and f.created_at >= v_start and f.created_at < v_end), 0),
    coalesce((select count(*)::int from public.performance_flags f
              where f.user_id = c.id and f.type = 'red'
                and f.created_at >= v_start and f.created_at < v_end), 0),
    c.warning_count
  from comp c
  order by
    (c.composite_score is null),
    c.composite_score desc,
    c.display_name asc;
end;
$$;
grant execute on function public.get_performance_overview(text) to authenticated;

-- ------------------------------------------------------------
-- 5. Boss-only config updater
-- ------------------------------------------------------------
create or replace function public.update_performance_config(
  p_weight_performance  numeric,
  p_weight_incentives   numeric,
  p_weight_attendance   numeric,
  p_weight_flags        numeric,
  p_min_attendance_days int,
  p_threshold_promotion numeric,
  p_threshold_good      numeric,
  p_threshold_warning   numeric,
  p_flag_pts_low        numeric,
  p_flag_pts_medium     numeric,
  p_flag_pts_high       numeric,
  p_flag_pts_critical   numeric
)
returns public.performance_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.performance_config;
  v_sum numeric := p_weight_performance + p_weight_incentives
                 + p_weight_attendance + p_weight_flags;
begin
  if not public.is_boss(auth.uid()) then
    raise exception 'only boss can update performance config';
  end if;
  if abs(v_sum - 100) > 0.01 then
    raise exception 'weights must sum to 100 (got %)', v_sum;
  end if;
  if p_threshold_promotion <= p_threshold_good
     or p_threshold_good <= p_threshold_warning
     or p_threshold_warning < 0 then
    raise exception 'thresholds must be promotion > good > warning >= 0';
  end if;

  update public.performance_config set
    weight_performance  = p_weight_performance,
    weight_incentives   = p_weight_incentives,
    weight_attendance   = p_weight_attendance,
    weight_flags        = p_weight_flags,
    min_attendance_days = p_min_attendance_days,
    threshold_promotion = p_threshold_promotion,
    threshold_good      = p_threshold_good,
    threshold_warning   = p_threshold_warning,
    flag_pts_low        = p_flag_pts_low,
    flag_pts_medium     = p_flag_pts_medium,
    flag_pts_high       = p_flag_pts_high,
    flag_pts_critical   = p_flag_pts_critical,
    updated_by          = auth.uid(),
    updated_at          = now()
  where id = 1
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.update_performance_config(
  numeric, numeric, numeric, numeric, int,
  numeric, numeric, numeric,
  numeric, numeric, numeric, numeric
) to authenticated;

-- ------------------------------------------------------------
-- 6. Notifications: rating saved, flag added, warning issued
-- ------------------------------------------------------------
create or replace function public.perf_notify_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
  v_score numeric := coalesce(new.overall_score, 0);
begin
  if new.evaluated_by is null or new.evaluated_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.evaluated_by);
  perform public.emit_notification(
    new.user_id, new.evaluated_by, 'system', 'performance.rating',
    'Performance rating',
    v_actor_name || ' rated you ' || to_char(v_score, 'FM9D0') || '/10 for ' || new.month,
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

drop trigger if exists perf_notify_rating on public.performance_ratings;
create trigger perf_notify_rating
  after insert or update on public.performance_ratings
  for each row execute function public.perf_notify_rating();

create or replace function public.perf_notify_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
  v_title text;
begin
  if new.created_by is null or new.created_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.created_by);
  v_title := case when new.type = 'green' then 'Green flag' else 'Red flag' end;
  perform public.emit_notification(
    new.user_id, new.created_by, 'system', 'performance.flag',
    v_title || ' (' || new.severity || ')',
    v_actor_name || ': ' || left(new.reason, 140),
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

drop trigger if exists perf_notify_flag on public.performance_flags;
create trigger perf_notify_flag
  after insert on public.performance_flags
  for each row execute function public.perf_notify_flag();

create or replace function public.perf_notify_warning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_name text;
  v_count int;
begin
  if new.created_by is null or new.created_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.created_by);
  select count(*) into v_count from public.performance_warnings where user_id = new.user_id;
  perform public.emit_notification(
    new.user_id, new.created_by, 'system', 'performance.warning',
    'Formal warning issued' ||
      (case when v_count >= 3 then ' — termination risk' else '' end),
    v_actor_name || ': ' || left(new.reason, 140),
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

drop trigger if exists perf_notify_warning on public.performance_warnings;
create trigger perf_notify_warning
  after insert on public.performance_warnings
  for each row execute function public.perf_notify_warning();
