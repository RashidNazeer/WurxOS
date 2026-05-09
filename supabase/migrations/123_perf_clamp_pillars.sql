-- ============================================================
-- Migration 123 — Defensively clamp every performance pillar to
-- 0–100, including the per-row composite math.
--
-- Bug seen in production: cards rendered with Performance pillar
-- of 1000.0 and a composite of 564.3 / 100. Root cause: legacy
-- rows in performance_ratings.metrics had values in the 0-100
-- range (probably hand-typed or from an earlier sync), so
-- overall_score (avg of metrics) sat at ~100. The composite
-- function then multiplied by 10 to "normalise to 0-100" and
-- produced 1000.
--
-- The UI slider is 0-10, so any new save will be sane. But the
-- math has no defence against bad stored data, so a single
-- legacy row poisoned the whole leaderboard. Wrap the raw
-- pillar values in least(100, greatest(0, …)) on the way out
-- of get_performance_composite. The composite weighted-average
-- is also clamped for the same reason.
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

  -- Performance pillar: normalise the 0-10 average rating to a 0-100
  -- score, then clamp so a stale row with metrics already in the
  -- 0-100 range can't blow past the cap.
  select round((coalesce(overall_score, 0) * 10)::numeric, 1)
    into v_perf_raw
    from public.performance_ratings
   where user_id = p_user and month = p_month;
  v_perf := least(100, greatest(0, coalesce(v_perf_raw, 0)));
  -- Preserve "no rating yet" semantics — null performance still
  -- collapses the composite to null below.
  if v_perf_raw is null then v_perf := null; end if;

  v_inc := least(100, greatest(0, coalesce(public.perf_incentives_score(p_user, p_month), 0)));
  v_att := least(100, greatest(0, coalesce(public.perf_attendance_score(p_user, p_month), 0)));
  v_flg := least(100, greatest(0, coalesce(public.perf_flags_score(p_user, p_month), 0)));

  -- Detect whether each pillar has data; matches migration 060's
  -- "no signal yet" rescaling so users without an incentive plan
  -- or attendance obligation aren't dragged to zero.
  select exists (select 1 from public.incentives where user_id = p_user and month = p_month) into v_has_inc;
  select exists (
    select 1 from public.attendance
     where user_id = p_user and date::text like p_month || '%'
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
    -- No real signal yet — flags-only composite is misleading.
    v_composite := null;
  elsif v_den > 0 then
    v_composite := round(least(100, greatest(0, v_num / v_den)), 1);
  else
    v_composite := null;
  end if;

  select count(*) into v_warnings
    from public.performance_warnings where user_id = p_user;

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
