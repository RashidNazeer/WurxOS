-- ============================================================
-- Migration 065 — Fix ambiguous user_id in get_performance_composite
--
-- Migration 060 rewrote get_performance_composite() but the warnings
-- count query reads `user_id` unqualified. The RETURNS TABLE in the
-- same function also declares a column called `user_id`, so Postgres
-- raises "column reference 'user_id' is ambiguous" when the function
-- is called.
--
-- Fix: qualify the column as `public.performance_warnings.user_id`.
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
declare
  v_cfg public.performance_config%rowtype;
  v_perf      numeric;
  v_inc       numeric;
  v_att       numeric;
  v_flg       numeric;
  v_num       numeric := 0;
  v_den       numeric := 0;
  v_composite numeric;
  v_warnings  int;
  v_has_inc   bool := false;
  v_has_att   bool := false;
begin
  select * into v_cfg from public.performance_config where id = 1;

  select round((pr.overall_score * 10)::numeric, 1)
    into v_perf
    from public.performance_ratings pr
    where pr.user_id = p_user and pr.month = p_month;

  v_inc := public.perf_incentives_score(p_user, p_month);
  v_att := public.perf_attendance_score(p_user, p_month);
  v_flg := public.perf_flags_score(p_user, p_month);

  select exists (
    select 1 from public.incentives i
     where i.user_id = p_user and i.month = p_month
  ) into v_has_inc;

  select exists (
    select 1 from public.attendance a
     where a.user_id = p_user
       and a.date >= (p_month || '-01')::date
       and a.date <  (p_month || '-01')::date + interval '1 month'
  ) into v_has_att;

  if not v_has_att then
    select exists (
      select 1 from public.leave_requests lr
       where lr.requester_id = p_user
         and lr.status = 'approved'
         and lr.start_date <  ((p_month || '-01')::date + interval '1 month')
         and lr.end_date   >= (p_month || '-01')::date
    ) into v_has_att;
  end if;

  if v_perf is not null then
    v_num := v_num + v_perf * v_cfg.weight_performance;
    v_den := v_den + v_cfg.weight_performance;
  end if;
  if v_has_inc then
    v_num := v_num + coalesce(v_inc, 0) * v_cfg.weight_incentives;
    v_den := v_den + v_cfg.weight_incentives;
  end if;
  if v_has_att then
    v_num := v_num + coalesce(v_att, 0) * v_cfg.weight_attendance;
    v_den := v_den + v_cfg.weight_attendance;
  end if;
  v_num := v_num + coalesce(v_flg, 70) * v_cfg.weight_flags;
  v_den := v_den + v_cfg.weight_flags;

  if v_den > 0 then
    v_composite := round(v_num / v_den, 1);
  else
    v_composite := null;
  end if;

  -- Qualify performance_warnings.user_id so it doesn't collide with the
  -- RETURNS TABLE `user_id` output column.
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
