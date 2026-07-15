-- ============================================================
-- WurxOS v2 — Migration 257: composite is not computed until the OL has
-- VERIFIED the incentive plan.
--
-- WHY (Boss decision 2026-07-15): an employee's own incentive progress
-- (self-reported item completion / the ≥90% auto-complete) feeds the
-- performance composite's incentives pillar the instant it flips — BEFORE any
-- OL check. So a person could nudge their own composite up. The decision: the
-- composite performance score should only be CALCULATED once the OL has verified
-- that person's incentive plan (whoever edited it). Until then the surfaces show
-- a "Not yet verified by OL" badge instead of a number.
--
-- WHAT: get_performance_composite returns composite_score = NULL and
-- level = 'pending_verification' whenever the person HAS an incentive plan
-- (a row with >= 1 item) that is NOT verified. People with NO plan have nothing
-- to verify and are unaffected. An unrated person still reads 'not_rated' (that
-- gate takes precedence — there is no score to gate yet). The four pillar values
-- are still returned for the breakdown panel; only the composite number is held
-- back. get_performance_overview inherits this automatically (it cross-joins this
-- function and selects its composite_score/level).
--
-- The frontend PerformancePage computes its own composite in JS and carries the
-- identical gate (incPending); the AI assistant reads THIS function's level, so
-- both agree. scripts/composite-parity.mjs mirrors the gate and still proves
-- SQL == page. Recreated from mig 256 changing ONLY the composite/level gate.
-- Idempotent.
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
  v_uid       uuid := auth.uid();
  v_svc       boolean := coalesce(
                 nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
               ) = 'service_role'
               or session_user in ('postgres', 'supabase_admin');
  v_can_see   boolean;
  v_cfg       public.performance_config%rowtype;
  v_perf_raw  numeric;
  v_perf      numeric;
  v_inc       numeric;
  v_att       numeric;
  v_flg       numeric;
  v_has_inc   boolean := false;
  v_verified  boolean;
  v_pending   boolean := false;
  v_num       numeric := 0;
  v_den       numeric := 0;
  v_composite numeric;
  v_level     text;
  v_warnings  int;
begin
  v_can_see := v_svc
    or public.is_boss(v_uid)
    or v_uid = p_user
    or exists (
         select 1 from public.profiles p
          where p.id = v_uid and p.role in ('ol', 'developer')
            and p.is_active = true and p.deleted_at is null
       )
    or exists (
         select 1 from public.profiles t
          where t.id = p_user and t.reports_to = v_uid
       );
  if (v_uid is null and not v_svc) or not v_can_see then
    return;
  end if;

  select * into v_cfg from public.performance_config where id = 1;

  select pr.overall_score into v_perf_raw
    from public.performance_ratings pr
   where pr.user_id = p_user and pr.month = p_month;
  if v_perf_raw is null then
    v_perf := null;
  else
    v_perf := least(100, greatest(0, round(v_perf_raw)));
  end if;

  -- Incentive plan presence + verification (one row per user/month, mig 033).
  select
    (coalesce(jsonb_array_length(i.incentives), 0)
   + coalesce(jsonb_array_length(i.bonuses), 0)) >= 1,
    coalesce(i.verified, false)
    into v_has_inc, v_verified
    from public.incentives i
   where i.user_id = p_user and i.month = p_month;
  v_has_inc := coalesce(v_has_inc, false);
  -- Pending = there IS a plan and the OL has NOT verified it. No plan => nothing
  -- to verify => not pending (composite computes normally).
  v_pending := v_has_inc and not coalesce(v_verified, false);

  if v_has_inc then
    v_inc := least(100, greatest(0, coalesce(public.perf_incentives_score(p_user, p_month), 0)));
  else
    v_inc := null;
  end if;
  v_att := least(100, greatest(0, coalesce(public.perf_attendance_score(p_user, p_month), 0)));
  v_flg := least(100, greatest(0, coalesce(public.perf_flags_score(p_user, p_month), 0)));

  -- Composite gate:
  --   no rating       -> null / 'not_rated'          (takes precedence)
  --   plan unverified -> null / 'pending_verification'
  --   else            -> weighted mean over present pillars / perf_level
  if v_perf is null then
    v_composite := null;
    v_level := public.perf_level(null);          -- 'not_rated'
  elsif v_pending then
    v_composite := null;
    v_level := 'pending_verification';
  else
    v_num := v_perf * v_cfg.weight_performance;
    v_den := v_cfg.weight_performance;
    if v_inc is not null then
      v_num := v_num + v_inc * v_cfg.weight_incentives;
      v_den := v_den + v_cfg.weight_incentives;
    end if;
    v_num := v_num + v_att * v_cfg.weight_attendance;
    v_den := v_den + v_cfg.weight_attendance;
    v_num := v_num + v_flg * v_cfg.weight_flags;
    v_den := v_den + v_cfg.weight_flags;
    if v_den > 0 then
      v_composite := round(least(100, greatest(0, v_num / v_den)));
    else
      v_composite := 0;
    end if;
    v_level := public.perf_level(v_composite);
  end if;

  select count(*) into v_warnings
    from public.performance_warnings pw
   where pw.user_id = p_user;

  return query select
    p_user, p_month, v_perf, v_inc, v_att, v_flg, v_composite, v_level, v_warnings;
end;
$$;

revoke execute on function public.get_performance_composite(uuid, text) from public, anon;
grant  execute on function public.get_performance_composite(uuid, text) to authenticated, service_role;
