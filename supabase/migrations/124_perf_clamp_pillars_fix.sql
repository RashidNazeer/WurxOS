-- ============================================================
-- Migration 124 — Fix the ambiguous-column regression introduced
-- by migration 123.
--
-- Migration 123 added pillar clamping but referenced unqualified
-- `user_id` and `month` inside SQL bodies that share those names
-- with the function's RETURNS TABLE columns — Postgres raised
-- "column reference 'user_id' is ambiguous" on every call. This
-- recreates the function with the same `#variable_conflict
-- use_column` pragma migration 040 / 065 used, plus alias-qualified
-- table references so PL/pgSQL parameters can't collide with the
-- output columns either.
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
  v_perf_raw numeric;
  v_perf numeric;
  v_inc  numeric;
  v_att  numeric;
  v_flg  numeric;
  v_num  numeric := 0;
  v_den  numeric := 0;
  v_composite numeric;
  v_warnings  int;
  v_has_inc bool := false;
  v_has_att bool := false;
begin
  select * into v_cfg from public.performance_config where id = 1;

  -- Performance pillar: 0-10 average → 0-100, clamped so a stale
  -- row with metrics already in 0-100 can't blow past the cap.
  select round((coalesce(pr.overall_score, 0) * 10)::numeric, 1)
    into v_perf_raw
    from public.performance_ratings pr
   where pr.user_id = p_user and pr.month = p_month;
  if v_perf_raw is null then
    v_perf := null;
  else
    v_perf := least(100, greatest(0, v_perf_raw));
  end if;

  v_inc := least(100, greatest(0, coalesce(public.perf_incentives_score(p_user, p_month), 0)));
  v_att := least(100, greatest(0, coalesce(public.perf_attendance_score(p_user, p_month), 0)));
  v_flg := least(100, greatest(0, coalesce(public.perf_flags_score(p_user, p_month), 0)));

  select exists (
    select 1 from public.incentives i
     where i.user_id = p_user and i.month = p_month
  ) into v_has_inc;
  select exists (
    select 1 from public.attendance a
     where a.user_id = p_user
       and a.date::text like p_month || '%'
  ) into v_has_att;

  if v_perf is not null then
    v_num := v_num + v_perf * v_cfg.weight_performance;
    v_den := v_den + v_cfg.weight_performance;
  end if;
  if v_has_inc then
    v_num := v_num + v_inc * v_cfg.weight_incentives;
    v_den := v_den + v_cfg.weight_incentives;
  end if;
  if v_has_att then
    v_num := v_num + v_att * v_cfg.weight_attendance;
    v_den := v_den + v_cfg.weight_attendance;
  end if;
  -- Flags pillar always contributes (base 70 in perf_flags_score).
  v_num := v_num + v_flg * v_cfg.weight_flags;
  v_den := v_den + v_cfg.weight_flags;

  if v_perf is null and not v_has_inc and not v_has_att then
    v_composite := null;
  elsif v_den > 0 then
    v_composite := round(least(100, greatest(0, v_num / v_den)), 1);
  else
    v_composite := null;
  end if;

  select count(*) into v_warnings
    from public.performance_warnings pw
    where pw.user_id = p_user;

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
