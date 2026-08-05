-- ============================================================
-- WurxOS v2 — Migration 304: APC performance blend (perf restructure #2).
--
-- Boss-confirmed 2026-08-05. The APC PERFORMANCE PILLAR moves from "average of 5
-- OL sliders" to a two-factor blend around the two report types, mirroring the
-- TL method (mig 271/276):
--
--   APC performance = 0.6 × checkpointScore  +  0.4 × externalReportScore
--     • checkpointScore     = the OL's WEEKLY slider rating (now 4 metrics — the
--                             "reporting" slider is retired), monthly avg. This is
--                             the "internal / weekly checkpoint" factor.
--     • externalReportScore = 0.6 × (TL star-avg × 20)  +  0.4 × ((N − D)/N × 100)
--         TL rates each of the APC's reports 0–5★ at VERIFY (mig 303, reports.apc_stars).
--         N = the APC's reports verified this month; D = Σ report-return docks on
--         them (apc_reporting_deductions kind='report', all cadences). This is the
--         "external reporting" factor.
--     null-collapse per factor (whichever exists; null ⇒ Not Rated), clamp 0–100.
--
-- Retires the mig 274/278 reporting SPLIT: the OL's 0–90 `reportingOl` slider and
-- the ±5 report/checkpoint return CHUNKS folded into metrics.reporting are gone.
-- The weekly rating now carries only the 4 checkpoint metrics; external reporting
-- is scored entirely through the per-report TL star + return accountability above.
--
-- MONEY-SAFETY: gated by the SAME weekly-APC switch + floor (weekly_apc_ratings_
-- since = 2026-08-01) that the current method uses, so July and earlier are
-- untouched (they keep the old OL-hand-rated overall_score via the else branch).
-- The generated overall_score columns are NOT altered — apc_checkpoint_score
-- reads the 4 checkpoint keys directly, so no closed-month stored value moves.
-- Computed on-read like the TL blend; composite-parity.mjs must keep holding.
--
-- Safe to re-run.
-- ============================================================

-- ── 0. restructure go-live anchor ─────────────────────────────────────
-- The existing August apc_reporting_deductions rows were recorded under the OLD
-- reporting-SPLIT meaning (a 0–5 CHUNK-point dock, mig 274), NOT the new
-- "one whole report removed from accountability" meaning. Counting them under the
-- new (N−D)/N would over-penalise APCs ~50× retroactively. So the accountability
-- window only counts docks created AT/AFTER this anchor. Defaults to the migration
-- apply moment (all pre-existing rows predate it); the switch to the new dock
-- meaning happens with this deploy, so nothing legitimate is excluded.
alter table public.performance_config
  add column if not exists apc_report_since timestamptz not null default now();

-- ── 1. APC external-report score = 0.6 star + 0.4 accountability ──────
-- Subjective: the TL's 0–5 stars on the APC's reports this month → 0–100.
create or replace function public.apc_report_stars_score(p_apc uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare
  v_avg   numeric;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select avg(r.apc_stars) into v_avg
    from public.reports r
   where r.author_id = p_apc and r.apc_stars is not null
     and r.verified_at >= v_start and r.verified_at < v_end;
  if v_avg is null then return null; end if;
  return least(100, greatest(0, v_avg * 20));   -- 0–5 stars → 0–100
end;
$$;
revoke execute on function public.apc_report_stars_score(uuid, text) from public, anon, authenticated;
grant  execute on function public.apc_report_stars_score(uuid, text) to service_role;

-- Objective: (N verified − D report-return docks) ÷ N × 100 over the APC's own
-- reports. D joins docks → reports on the report's LIVE verified_at window so a
-- re-verified report carries its penalty with it (mirrors TL mig 273 H2). Only
-- kind='report' counts — the checkpoint dock is retired (mig 305).
create or replace function public.apc_report_accountability(p_apc uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare
  v_n     int;
  v_d     numeric;
  v_since timestamptz;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select apc_report_since into v_since from public.performance_config where id = 1;
  select count(*) into v_n
    from public.reports r
   where r.author_id = p_apc and r.verified_at >= v_start and r.verified_at < v_end;
  if coalesce(v_n, 0) = 0 then return null; end if;
  -- Only docks recorded under the NEW per-report meaning (created >= the restructure
  -- anchor) count; pre-restructure chunk-point docks are excluded (see section 0).
  select coalesce(sum(d.amount), 0) into v_d
    from public.apc_reporting_deductions d
    join public.reports r on r.id = d.report_id
   where d.apc_id = p_apc and d.kind = 'report'
     and d.created_at >= coalesce(v_since, '2026-08-05'::timestamptz)
     and r.verified_at >= v_start and r.verified_at < v_end;
  return greatest(0, (v_n::numeric - coalesce(v_d, 0))) / v_n * 100;
end;
$$;
revoke execute on function public.apc_report_accountability(uuid, text) from public, anon, authenticated;
grant  execute on function public.apc_report_accountability(uuid, text) to service_role;

-- The external-report blend (0.6 star + 0.4 accountability, null-collapse).
create or replace function public.apc_report_score(p_apc uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare v_star numeric; v_acct numeric;
begin
  v_star := public.apc_report_stars_score(p_apc, p_month);
  v_acct := public.apc_report_accountability(p_apc, p_month);
  if v_star is not null and v_acct is not null then return 0.6 * v_star + 0.4 * v_acct;
  elsif v_star is not null then return v_star;
  elsif v_acct is not null then return v_acct;
  else return null; end if;
end;
$$;
revoke execute on function public.apc_report_score(uuid, text) from public, anon, authenticated;
grant  execute on function public.apc_report_score(uuid, text) to service_role;

-- ── 2. APC checkpoint score = 4-metric monthly avg (reporting excluded) ─
-- Reads the monthly performance_ratings row (weekly-rolled or manual) and averages
-- the 4 CHECKPOINT keys, ignoring any legacy 'reporting' key. round(sum/4) matches
-- the JS calcCheckpointAvg (integer-hundredths) for parity. Null if no rating row.
create or replace function public.apc_checkpoint_score(p_apc uuid, p_month text)
returns numeric language plpgsql security definer set search_path = public stable as $$
declare v_m jsonb;
begin
  select metrics into v_m from public.performance_ratings
   where user_id = p_apc and month = p_month;
  if v_m is null then return null; end if;
  return round((
      coalesce((v_m ->> 'dailyTasksQuality')::numeric, 0)
    + coalesce((v_m ->> 'overallWorkflow')::numeric, 0)
    + coalesce((v_m ->> 'responseTime')::numeric, 0)
    + coalesce((v_m ->> 'tasksProcessing')::numeric, 0)
  ) / 4.0);
end;
$$;
revoke execute on function public.apc_checkpoint_score(uuid, text) from public, anon, authenticated;
grant  execute on function public.apc_checkpoint_score(uuid, text) to service_role;

-- ── 3. APC preview (breakdown modal + JS self-view), visibility-gated ──
create or replace function public.apc_perf_preview(p_apc uuid, p_month text)
returns table (checkpoint_score numeric, report_score numeric, reports_n int, deductions numeric,
               blended numeric, star_avg numeric, star_score numeric, accountability numeric)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid    uuid := auth.uid();
  v_svc    boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                      or session_user in ('postgres', 'supabase_admin');
  v_chk    numeric;
  v_report numeric;
  v_n      int;
  v_d      numeric;
  v_blend  numeric;
  v_savg   numeric;
  v_sscore numeric;
  v_acct   numeric;
  v_start  timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  if not (v_svc or public.is_boss(v_uid) or v_uid = p_apc
          or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = p_apc and t.reports_to = v_uid)) then
    return;
  end if;

  v_chk    := public.apc_checkpoint_score(p_apc, p_month);
  v_report := public.apc_report_score(p_apc, p_month);

  select count(*) into v_n from public.reports r
   where r.author_id = p_apc and r.verified_at >= v_start and r.verified_at < v_end;
  select coalesce(sum(d.amount), 0) into v_d
    from public.apc_reporting_deductions d
    join public.reports r on r.id = d.report_id
   where d.apc_id = p_apc and d.kind = 'report'
     and d.created_at >= coalesce((select apc_report_since from public.performance_config where id = 1), '2026-08-05'::timestamptz)
     and r.verified_at >= v_start and r.verified_at < v_end;

  select avg(r.apc_stars) into v_savg from public.reports r
   where r.author_id = p_apc and r.apc_stars is not null
     and r.verified_at >= v_start and r.verified_at < v_end;
  v_sscore := public.apc_report_stars_score(p_apc, p_month);
  v_acct   := public.apc_report_accountability(p_apc, p_month);

  if v_chk is not null and v_report is not null then v_blend := round(0.6 * v_chk + 0.4 * v_report);
  elsif v_chk is not null then v_blend := round(v_chk);
  elsif v_report is not null then v_blend := round(v_report);
  else v_blend := null; end if;

  return query select v_chk, v_report, v_n, coalesce(v_d, 0), v_blend, v_savg, v_sscore, v_acct;
end;
$$;
revoke execute on function public.apc_perf_preview(uuid, text) from public, anon;
grant  execute on function public.apc_perf_preview(uuid, text) to authenticated, service_role;

-- Bulk APC reporting for the Performance page's APC rows (mirror list_tl_reporting):
-- boss/ol/dev see every active APC; a TL/PCTL sees the APCs reporting to them; an
-- APC caller sees nothing (they use apc_perf_preview for their own self-view). The
-- page combines report_score here with a JS checkpoint avg into the APC blend.
create or replace function public.list_apc_reporting(p_month text)
returns table (apc_id uuid, reports_n int, deductions numeric, star_score numeric,
               accountability numeric, report_score numeric)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid uuid := auth.uid();
  v_svc boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                   or session_user in ('postgres', 'supabase_admin');
  v_is_mgr boolean;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  v_is_mgr := v_svc or public.is_boss(v_uid)
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true);
  return query
  select a.id,
         (select count(*)::int from public.reports r
           where r.author_id = a.id and r.verified_at >= v_start and r.verified_at < v_end),
         coalesce((select sum(d.amount) from public.apc_reporting_deductions d
                    join public.reports r on r.id = d.report_id
                    where d.apc_id = a.id and d.kind = 'report'
                      and d.created_at >= coalesce((select apc_report_since from public.performance_config where id = 1), '2026-08-05'::timestamptz)
                      and r.verified_at >= v_start and r.verified_at < v_end), 0),
         public.apc_report_stars_score(a.id, p_month),
         public.apc_report_accountability(a.id, p_month),
         public.apc_report_score(a.id, p_month)
    from public.profiles a
   where a.role = 'apc' and a.is_active = true and a.deleted_at is null
     and (v_is_mgr or a.reports_to = v_uid);
end;
$$;
revoke execute on function public.list_apc_reporting(text) from public, anon;
grant  execute on function public.list_apc_reporting(text) to authenticated, service_role;

-- ── 4. re-point the TL preview's raw star_avg to reports.tl_stars ─────
-- The SCORE already moved to reports.tl_stars (mig 303 re-pointed
-- tl_report_stars_score); the preview's displayed star_avg must match, else the
-- modal shows the old agenda-meeting average next to the new score.
create or replace function public.tl_perf_preview(p_tl uuid, p_month text)
returns table (team_score numeric, reporting_score numeric, reports_n int, deductions numeric,
               blended numeric, star_avg numeric, star_score numeric, accountability numeric)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid    uuid := auth.uid();
  v_svc    boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                      or session_user in ('postgres', 'supabase_admin');
  v_team   numeric;
  v_report numeric;
  v_n      int;
  v_d      numeric;
  v_blend  numeric;
  v_savg   numeric;
  v_sscore numeric;
  v_acct   numeric;
  v_start  timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  if not (v_svc or public.is_boss(v_uid) or v_uid = p_tl
          or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = p_tl and t.reports_to = v_uid)) then
    return;
  end if;

  select avg(c.composite_score) into v_team
    from public.profiles a
    cross join lateral public.get_performance_composite(a.id, p_month) c
   where a.reports_to = p_tl and a.role = 'apc' and a.is_active = true and a.deleted_at is null
     and c.composite_score is not null;

  select count(*) into v_n
    from public.reports r join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;
  select coalesce(sum(d.amount), 0) into v_d
    from public.tl_reporting_deductions d
    join public.reports r on r.id = d.report_id
    join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end;

  select avg(r.tl_stars) into v_savg
    from public.reports r join public.brands b on b.id = r.brand_id
   where b.owner_id = p_tl and r.tl_stars is not null
     and r.verified_at >= v_start and r.verified_at < v_end;
  v_sscore := public.tl_report_stars_score(p_tl, p_month);
  v_acct   := public.tl_report_accountability(p_tl, p_month);
  v_report := public.tl_reporting_score(p_tl, p_month);

  if v_team is not null and v_report is not null then v_blend := round(0.6 * v_team + 0.4 * v_report);
  elsif v_team is not null then v_blend := round(v_team);
  elsif v_report is not null then v_blend := round(v_report);
  else v_blend := null; end if;

  return query select v_team, v_report, v_n, coalesce(v_d, 0), v_blend, v_savg, v_sscore, v_acct;
end;
$$;
revoke execute on function public.tl_perf_preview(uuid, text) from public, anon;
grant  execute on function public.tl_perf_preview(uuid, text) to authenticated, service_role;

-- ── 5. retire the reporting SPLIT fold on the weekly rating ───────────
-- wpr_fill_from_meeting reverts to the mig-269 body (fill week_start/month only —
-- no reportingOl + chunk fold). The weekly UI stops sending reportingOl.
create or replace function public.wpr_fill_from_meeting()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ws date; v_md date;
begin
  select week_start, meeting_date into v_ws, v_md
    from public.agenda_meetings where id = new.meeting_id;
  new.week_start := v_ws;
  new.month := to_char(coalesce(v_md, v_ws, current_date), 'YYYY-MM');
  new.updated_at := now();
  return new;
end;
$$;

-- rollup drops the 'reporting' key (mig 270 body, reporting line removed). The 4
-- checkpoint metrics still average exactly as before.
create or replace function public.wpr_recompute_month(p_apc uuid, p_month text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_since   date;
  v_metrics jsonb;
  v_rater   uuid;
  v_count   int;
begin
  if p_apc is null or p_month is null then return; end if;

  select weekly_apc_ratings_enabled, weekly_apc_ratings_since
    into v_enabled, v_since from public.performance_config where id = 1;
  if not coalesce(v_enabled, false) then return; end if;
  if p_month < to_char(coalesce(v_since, date '2026-08-01'), 'YYYY-MM') then return; end if;

  select count(*) into v_count
    from public.weekly_performance_ratings where apc_id = p_apc and month = p_month;

  if v_count = 0 then
    delete from public.performance_ratings
     where user_id = p_apc and month = p_month and source = 'weekly';
    return;
  end if;

  select
    jsonb_build_object(
      'dailyTasksQuality', round(avg(coalesce((metrics ->> 'dailyTasksQuality')::numeric, 0)), 2),
      'overallWorkflow',   round(avg(coalesce((metrics ->> 'overallWorkflow')::numeric, 0)), 2),
      'responseTime',      round(avg(coalesce((metrics ->> 'responseTime')::numeric, 0)), 2),
      'tasksProcessing',   round(avg(coalesce((metrics ->> 'tasksProcessing')::numeric, 0)), 2)
    ),
    (array_agg(rated_by order by updated_at desc nulls last))[1]
    into v_metrics, v_rater
    from public.weekly_performance_ratings
   where apc_id = p_apc and month = p_month;

  insert into public.performance_ratings (user_id, month, metrics, evaluated_by, source, updated_at)
  values (p_apc, p_month, v_metrics, v_rater, 'weekly', now())
  on conflict (user_id, month) do update
    set metrics      = excluded.metrics,
        evaluated_by = excluded.evaluated_by,
        source       = 'weekly',
        updated_at   = now()
   where public.performance_ratings.source = 'weekly';
end;
$$;
revoke execute on function public.wpr_recompute_month(uuid, text) from public, anon, authenticated;
grant  execute on function public.wpr_recompute_month(uuid, text) to service_role;

-- the refold trigger (mig 275) only existed to re-run the retired chunk fold. Drop it.
drop trigger if exists apc_ded_refold_trg on public.apc_reporting_deductions;
drop function if exists public.apc_ded_refold();

-- ── 6. the composite: add the APC blend branch (gated + floored) ──────
-- Recreated verbatim from mig 271, adding ONE elsif branch: for an APC, when the
-- weekly switch is ON and the month >= the floor, v_perf is the checkpoint/report
-- blend; otherwise (and for everyone else) it stays overall_score, exactly as before.
create or replace function public.get_performance_composite(p_user uuid, p_month text)
returns table (
  user_id uuid, month text, performance_score numeric, incentives_score numeric,
  attendance_score numeric, flags_score numeric, composite_score numeric, level text, warning_count int
)
language plpgsql security definer set search_path = public stable as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_svc       boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                         or session_user in ('postgres', 'supabase_admin');
  v_can_see   boolean;
  v_cfg       public.performance_config%rowtype;
  v_role      text;
  v_team      numeric;
  v_checkpoint numeric;
  v_report    numeric;
  v_perf_raw  numeric;
  v_src       text;
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
  v_can_see := v_svc or public.is_boss(v_uid) or v_uid = p_user
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true and p.deleted_at is null)
    or exists (select 1 from public.profiles t where t.id = p_user and t.reports_to = v_uid);
  if (v_uid is null and not v_svc) or not v_can_see then return; end if;

  select * into v_cfg from public.performance_config where id = 1;
  select role into v_role from public.profiles where id = p_user;

  -- PERFORMANCE PILLAR
  if v_role = 'tl' and coalesce(v_cfg.tl_perf_method_enabled, false)
     and p_month >= to_char(coalesce(v_cfg.tl_perf_since, date '2026-08-01'), 'YYYY-MM') then
    -- team score = average of the TL's APCs' composites (skip unrated)
    select avg(c.composite_score) into v_team
      from public.profiles a
      cross join lateral public.get_performance_composite(a.id, p_month) c
     where a.reports_to = p_user and a.role = 'apc' and a.is_active = true and a.deleted_at is null
       and c.composite_score is not null;
    v_report := public.tl_reporting_score(p_user, p_month);
    if v_team is not null and v_report is not null then v_perf := round(0.6 * v_team + 0.4 * v_report);
    elsif v_team is not null then v_perf := round(v_team);
    elsif v_report is not null then v_perf := round(v_report);
    else v_perf := null; end if;
    if v_perf is not null then v_perf := least(100, greatest(0, v_perf)); end if;
  elsif v_role = 'apc' and coalesce(v_cfg.weekly_apc_ratings_enabled, false)
     and p_month >= to_char(coalesce(v_cfg.weekly_apc_ratings_since, date '2026-08-01'), 'YYYY-MM') then
    -- APC blend: 0.6 checkpoint (4-metric OL weekly avg) + 0.4 external report score
    v_checkpoint := public.apc_checkpoint_score(p_user, p_month);
    v_report     := public.apc_report_score(p_user, p_month);
    if v_checkpoint is not null and v_report is not null then v_perf := round(0.6 * v_checkpoint + 0.4 * v_report);
    elsif v_checkpoint is not null then v_perf := round(v_checkpoint);
    elsif v_report is not null then v_perf := round(v_report);
    else v_perf := null; end if;
    if v_perf is not null then v_perf := least(100, greatest(0, v_perf)); end if;
  else
    select pr.overall_score, pr.source into v_perf_raw, v_src from public.performance_ratings pr
     where pr.user_id = p_user and pr.month = p_month;
    -- Switch-off safety: a source='weekly' APC row (month >= floor) holds only the 4
    -- checkpoint keys, so its generated overall_score (÷5, 'reporting' absent→0)
    -- would deflate ~20% if read here. Use the 4-key checkpoint avg instead so
    -- turning the weekly switch OFF can't silently deflate an Aug+ APC score. July
    -- and earlier have no source='weekly' rows (the rollup floored them), so this
    -- never touches a closed-month score.
    if v_role = 'apc' and v_src = 'weekly'
       and p_month >= to_char(coalesce(v_cfg.weekly_apc_ratings_since, date '2026-08-01'), 'YYYY-MM') then
      v_perf_raw := public.apc_checkpoint_score(p_user, p_month);
    end if;
    if v_perf_raw is null then v_perf := null; else v_perf := least(100, greatest(0, round(v_perf_raw))); end if;
  end if;

  select
    (coalesce(jsonb_array_length(i.incentives), 0) + coalesce(jsonb_array_length(i.bonuses), 0)) >= 1,
    coalesce(i.verified, false)
    into v_has_inc, v_verified
    from public.incentives i where i.user_id = p_user and i.month = p_month;
  v_has_inc := coalesce(v_has_inc, false);
  v_pending := v_has_inc and not coalesce(v_verified, false);

  if v_has_inc then v_inc := least(100, greatest(0, coalesce(public.perf_incentives_score(p_user, p_month), 0)));
  else v_inc := null; end if;
  v_att := least(100, greatest(0, coalesce(public.perf_attendance_score(p_user, p_month), 0)));
  v_flg := least(100, greatest(0, coalesce(public.perf_flags_score(p_user, p_month), 0)));

  if v_perf is null then
    v_composite := null; v_level := public.perf_level(null);
  elsif v_pending then
    v_composite := null; v_level := 'pending_verification';
  else
    v_num := v_perf * v_cfg.weight_performance; v_den := v_cfg.weight_performance;
    if v_inc is not null then v_num := v_num + v_inc * v_cfg.weight_incentives; v_den := v_den + v_cfg.weight_incentives; end if;
    v_num := v_num + v_att * v_cfg.weight_attendance; v_den := v_den + v_cfg.weight_attendance;
    v_num := v_num + v_flg * v_cfg.weight_flags;      v_den := v_den + v_cfg.weight_flags;
    if v_den > 0 then v_composite := round(least(100, greatest(0, v_num / v_den))); else v_composite := 0; end if;
    v_level := public.perf_level(v_composite);
  end if;

  select count(*) into v_warnings from public.performance_warnings pw where pw.user_id = p_user;

  return query select p_user, p_month, v_perf, v_inc, v_att, v_flg, v_composite, v_level, v_warnings;
end;
$$;
revoke execute on function public.get_performance_composite(uuid, text) from public, anon;
grant  execute on function public.get_performance_composite(uuid, text) to authenticated, service_role;
