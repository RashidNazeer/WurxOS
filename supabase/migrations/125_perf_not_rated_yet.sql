-- ============================================================
-- Migration 125 — "Not Rated Yet": composite is null whenever
-- the OL/TL hasn't recorded a Performance Tracking rating for
-- the user/month, regardless of how many auto-calculated
-- pillars (incentives / attendance / flags) have data.
--
-- Rationale (mirrors v1 commit 540be81): the auto-calculated
-- pillars produce a "low partial composite" at the start of a
-- month before any human rating exists, which reads like an
-- evaluation. It isn't. Showing "Not Rated Yet" until OL rates
-- removes that misleading signal.
--
-- Auto-calc pillars (incentives, attendance, flags) keep flowing
-- through the return so managers can still watch trends; only
-- the composite collapses to null.
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
begin
  select * into v_cfg from public.performance_config where id = 1;

  -- Performance pillar — only present when an actual rating row
  -- exists for the user/month. Clamped 0-100 defensively against
  -- legacy data with metrics in the 0-100 range.
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

  -- Composite is null whenever the performance pillar itself is
  -- null. The auto-calc pillars are NOT enough to mint a composite
  -- on their own — that's the entire point of "Not Rated Yet".
  if v_perf is null then
    v_composite := null;
  else
    v_num := v_perf * v_cfg.weight_performance;
    v_den := v_cfg.weight_performance;
    v_num := v_num + v_inc * v_cfg.weight_incentives;  v_den := v_den + v_cfg.weight_incentives;
    v_num := v_num + v_att * v_cfg.weight_attendance;  v_den := v_den + v_cfg.weight_attendance;
    v_num := v_num + v_flg * v_cfg.weight_flags;       v_den := v_den + v_cfg.weight_flags;
    if v_den > 0 then
      v_composite := round(least(100, greatest(0, v_num / v_den)), 1);
    else
      v_composite := null;
    end if;
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
