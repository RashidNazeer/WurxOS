-- ============================================================
-- Migration 060 — Performance composite: rescale null pillars
--
-- v1 behaviour: when a pillar score is unavailable (e.g. the user
-- hasn't been rated yet for the month), the composite is computed
-- over the pillars we DO have, with weights rescaled so the result
-- is still on a 0-100 scale. v2 previously returned NULL whenever
-- performance_score was missing; that hid incentive/attendance
-- progress behind a static "not rated" state.
--
-- New rule: if ANY pillar has a value, compute composite from the
-- available pillars using `sum(score*weight) / sum(weights_used)`.
-- If all pillars are null/zero-less, composite = null.
--
-- Performance score remains NULL when there's no rating yet — but
-- we no longer collapse the whole composite. The level classifier
-- still returns 'not_rated' only when composite itself is null.
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
  v_num       numeric := 0;  -- weighted sum
  v_den       numeric := 0;  -- sum of weights used
  v_composite numeric;
  v_warnings  int;
  v_has_inc   bool := false;
  v_has_att   bool := false;
begin
  select * into v_cfg from public.performance_config where id = 1;

  -- Performance pillar: normalize 0–10 rating to 0–100; null when unrated
  select round((overall_score * 10)::numeric, 1)
    into v_perf
    from public.performance_ratings
    where user_id = p_user and month = p_month;

  v_inc := public.perf_incentives_score(p_user, p_month);
  v_att := public.perf_attendance_score(p_user, p_month);
  v_flg := public.perf_flags_score(p_user, p_month);

  -- Was there any incentive row / attendance row this month? If not,
  -- treat that pillar as "no signal yet" so it doesn't drag the
  -- composite to zero for users with no plan/no attendance obligations.
  select exists (select 1 from public.incentives where user_id = p_user and month = p_month) into v_has_inc;
  select exists (
    select 1 from public.attendance
     where user_id = p_user
       and date >= (p_month || '-01')::date
       and date <  (p_month || '-01')::date + interval '1 month'
  ) into v_has_att;
  -- Also count the month as "having attendance signal" if the user
  -- had any approved leave in the month (so the attendance pillar
  -- captures 0 or near-0 when they never showed up).
  if not v_has_att then
    select exists (
      select 1 from public.leave_requests
       where requester_id = p_user
         and status = 'approved'
         and start_date <  ((p_month || '-01')::date + interval '1 month')
         and end_date   >= (p_month || '-01')::date
    ) into v_has_att;
  end if;

  -- Accumulate weighted sum over available pillars
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
  -- Flags pillar always contributes; base is 70, so it's never truly absent
  v_num := v_num + coalesce(v_flg, 70) * v_cfg.weight_flags;
  v_den := v_den + v_cfg.weight_flags;

  if v_den > 0 then
    v_composite := round(v_num / v_den, 1);
  else
    v_composite := null;
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
