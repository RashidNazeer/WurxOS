-- ============================================================
-- WurxOS v2 — Migration 040: Fix ambiguous column refs in
-- get_performance_composite / get_performance_overview.
--
-- The functions in 038 use `RETURNS TABLE (user_id uuid, month text, ...)`,
-- which makes those names in-scope variables inside the function body.
-- PL/pgSQL then can't tell whether `where user_id = p_user` means the
-- OUT parameter or the column on performance_ratings/performance_warnings,
-- which raises:
--   ERROR: column reference "user_id" is ambiguous
--
-- The `#variable_conflict use_column` directive tells PL/pgSQL to prefer
-- the column when a name is shared by both a column and a variable —
-- which is what we want here.
-- ============================================================

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
#variable_conflict use_column
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
#variable_conflict use_column
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
