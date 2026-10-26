-- ============================================================
-- WurxOS v2 — Migration 424: freeze a month's performance scores.
--
-- ── THE INCIDENT ────────────────────────────────────────────────────────────
-- A TL's SEPTEMBER composite fell to 69 ("warning") during OCTOBER, with
-- nothing in September touched. September's incentive plans and brand metrics
-- were last written 3 Oct; the restructure happened 12 Oct. The score moved
-- because it was never stored — get_performance_composite recomputes it from
-- scratch on every page load, and three of its inputs are read as "what is
-- true right now" rather than "what was true that month":
--
--   1. TL reporting pillar (40% of the TL perf pillar)
--      tl_report_stars_score / tl_report_accountability joined
--      `brands b on b.owner_id = p_tl` — CURRENT ownership. Every brand was
--      reassigned at 2026-10-12 21:28, so each TL's September reporting score
--      silently re-pointed at the portfolio they hold today. Ali Hamza lost
--      Klassy + Biostime to Haider Ali and gained Mustafa Jan's four brands:
--      September reports he never owned now score him, and ones he did own
--      no longer do.
--
--   2. TL team pillar (60%)
--      the team average filtered `a.is_active and a.deleted_at is null` —
--      CURRENT roster. Nine APCs were deactivated 2026-10-12, so they dropped
--      out of their TL's SEPTEMBER team average: Ali Hamza 13 reports -> 3,
--      Haider Ali 7 -> 3, Muhammad Azam 4 -> 2.
--
--   3. gmv_max incentive lines (mig 339/340/366)
--      completion is derived live from brand_monthly_metrics, against a target
--      that follows the brand's CURRENT monthly goal. Editing a closed month's
--      goal retroactively rewrites that month's incentive pillar.
--
-- Reports are still edited constantly too (3,969 audited `reports` updates
-- through 26 Oct) and tl_stars / apc_stars / verified_at all feed the score.
-- So a closed month was never actually closed.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────
-- A. Makes the two roster/ownership inputs MONTH-CORRECT instead of "today":
--    brand_owner_as_of() replays audit_log to recover who owned a brand at a
--    point in time, and the team average now asks "was this APC employed that
--    month", not "is this APC employed now".
-- B. Adds performance_month_snapshots and reads it through
--    get_performance_composite, so a locked month returns stored numbers and
--    stops recomputing entirely.
-- C. perf_lock_month() / perf_unlock_month() to finalise and (Boss-only) reopen.
-- D. Backfills August + September, which now compute correctly because of (A).
--
-- (A) MUST land before (D) or we would freeze the damaged 69 forever.
--
-- Idempotent. Safe to re-run.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- A1. Who owned a brand at a given moment.
--
-- audit_log is the only ownership history we have (entity_type='brands',
-- before/after jsonb, from 2026-08-02). Walk FORWARD from p_at: the first
-- recorded change at/after that instant carries the owner as it was just
-- before it, which is the owner at p_at. No such change => never reassigned
-- since, so today's owner is correct.
--
-- Before audit_log starts this degrades to today's owner. July and earlier sit
-- below tl_perf_since (2026-08-01) and are scored by the old method anyway.
-- ─────────────────────────────────────────────────────────────
create or replace function public.brand_owner_as_of(p_brand uuid, p_at timestamptz)
returns uuid
language sql
security definer
set search_path = public
stable
as $fn$
  select coalesce(
    (select nullif(a.before ->> 'owner_id', '')::uuid
       from public.audit_log a
      where a.entity_type in ('brands', 'brand')
        and a.entity_id = p_brand
        and a.created_at >= p_at
        and (a.before ->> 'owner_id') is distinct from (a.after ->> 'owner_id')
      order by a.created_at asc
      limit 1),
    (select b.owner_id from public.brands b where b.id = p_brand)
  );
$fn$;
grant execute on function public.brand_owner_as_of(uuid, timestamptz) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- A2. TL reporting pillar, scored against the month's OWN portfolio.
-- Both functions keep their shape; only the ownership test changes.
-- ─────────────────────────────────────────────────────────────
create or replace function public.tl_report_stars_score(p_tl uuid, p_month text)
returns numeric
language plpgsql
stable security definer
set search_path = public
as $fn$
declare
  v_avg   numeric;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  -- owner AS OF the month's end, not today's owner (mig 424).
  select avg(r.tl_stars) into v_avg
    from public.reports r
   where public.brand_owner_as_of(r.brand_id, v_end) = p_tl
     and r.tl_stars is not null
     and r.verified_at >= v_start and r.verified_at < v_end;
  if v_avg is null then return null; end if;
  return least(100, greatest(0, v_avg * 20));   -- 0–5 stars → 0–100
end;
$fn$;

create or replace function public.tl_report_accountability(p_tl uuid, p_month text)
returns numeric
language plpgsql
stable security definer
set search_path = public
as $fn$
declare
  v_n     int;
  v_d     numeric;
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  select count(*) into v_n
    from public.reports r
   where public.brand_owner_as_of(r.brand_id, v_end) = p_tl
     and r.verified_at >= v_start and r.verified_at < v_end;
  if coalesce(v_n, 0) = 0 then return null; end if;
  select coalesce(sum(d.amount), 0) into v_d
    from public.tl_reporting_deductions d
    join public.reports r on r.id = d.report_id
   where public.brand_owner_as_of(r.brand_id, v_end) = p_tl
     and r.verified_at >= v_start and r.verified_at < v_end;
  return greatest(0, (v_n::numeric - coalesce(v_d, 0))) / v_n * 100;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────
-- B1. The snapshot table.
--
-- One row per (user, month) once that month is finalised. `breakdown` keeps the
-- working so a frozen number can be explained a year later without re-deriving
-- it from data that has since moved on.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.performance_month_snapshots (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  month             text not null,
  performance_score numeric,
  incentives_score  numeric,
  attendance_score  numeric,
  flags_score       numeric,
  composite_score   numeric,
  level             text,
  warning_count     int,
  breakdown         jsonb not null default '{}'::jsonb,
  locked_at         timestamptz not null default now(),
  locked_by         uuid references public.profiles(id),
  primary key (user_id, month),
  constraint perf_month_snapshots_month_fmt check (month ~ '^[0-9]{4}-[0-9]{2}$')
);

create index if not exists perf_month_snapshots_month_idx
  on public.performance_month_snapshots (month);

alter table public.performance_month_snapshots enable row level security;

-- Visibility mirrors get_performance_composite's own v_can_see test: yourself,
-- the Boss, an OL/developer, or your manager. Writes go only through
-- perf_lock_month / perf_unlock_month (security definer), so there are
-- deliberately NO insert/update/delete policies for authenticated.
drop policy if exists "perf_month_snapshots_select" on public.performance_month_snapshots;
create policy "perf_month_snapshots_select"
  on public.performance_month_snapshots for select
  using (
    public.is_boss(auth.uid())
    or auth.uid() = user_id
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('ol', 'developer')
                  and p.is_active = true and p.deleted_at is null)
    or exists (select 1 from public.profiles t
                where t.id = user_id and t.reports_to = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────
-- B2. get_performance_composite: serve the snapshot when one exists.
--
-- Unchanged from the previous definition except for (a) the snapshot
-- read-through, placed AFTER the permission check so a frozen month can't
-- leak, and (b) the month-correct team roster.
-- ─────────────────────────────────────────────────────────────
create or replace function public.get_performance_composite(p_user uuid, p_month text)
returns table(user_id uuid, month text, performance_score numeric, incentives_score numeric,
              attendance_score numeric, flags_score numeric, composite_score numeric,
              level text, warning_count integer)
language plpgsql
stable security definer
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_svc       boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                         or session_user in ('postgres', 'supabase_admin');
  v_can_see   boolean;
  v_snap      public.performance_month_snapshots%rowtype;
  v_cfg       public.performance_config%rowtype;
  v_w_perf    numeric;
  v_w_inc     numeric;
  v_w_att     numeric;
  v_w_flg     numeric;
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
  v_month_end timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  v_can_see := v_svc or public.is_boss(v_uid) or v_uid = p_user
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true and p.deleted_at is null)
    or exists (select 1 from public.profiles t where t.id = p_user and t.reports_to = v_uid);
  if (v_uid is null and not v_svc) or not v_can_see then return; end if;

  -- FROZEN MONTH (mig 424): a finalised month is served from its snapshot and
  -- never recomputed, so later brand reassignments, layoffs or goal edits can
  -- no longer rewrite history.
  select * into v_snap from public.performance_month_snapshots s
   where s.user_id = p_user and s.month = p_month;
  if found then
    return query select p_user, p_month, v_snap.performance_score, v_snap.incentives_score,
                        v_snap.attendance_score, v_snap.flags_score, v_snap.composite_score,
                        v_snap.level, v_snap.warning_count;
    return;
  end if;

  select * into v_cfg from public.performance_config where id = 1;
  -- Weights are DATED (mig 347): a month is scored with the weights in force
  -- when it was lived, not with today's. The *_since flags stay on the live row
  -- because they already date-scope themselves.
  select w.weight_performance, w.weight_incentives, w.weight_attendance, w.weight_flags
    into v_w_perf, v_w_inc, v_w_att, v_w_flg
    from public.perf_weights_for_month(p_month) w;
  v_w_perf := coalesce(v_w_perf, v_cfg.weight_performance);
  v_w_inc  := coalesce(v_w_inc,  v_cfg.weight_incentives);
  v_w_att  := coalesce(v_w_att,  v_cfg.weight_attendance);
  v_w_flg  := coalesce(v_w_flg,  v_cfg.weight_flags);
  select role into v_role from public.profiles where id = p_user;

  -- PERFORMANCE PILLAR
  if v_role = 'tl' and coalesce(v_cfg.tl_perf_method_enabled, false)
     and p_month >= to_char(coalesce(v_cfg.tl_perf_since, date '2026-08-01'), 'YYYY-MM') then
    -- team score = average of the TL's APCs' composites (skip unrated).
    -- Roster is WHO WORKED THAT MONTH (mig 424), not who is still employed:
    -- is_active/deleted_at are current-state, so the old filter silently
    -- dropped laid-off APCs out of closed months they had worked.
    select avg(c.composite_score) into v_team
      from public.profiles a
      cross join lateral public.get_performance_composite(a.id, p_month) c
     where a.reports_to = p_user and a.role = 'apc'
       and (a.deleted_at is null or a.deleted_at >= v_month_end)
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
    v_num := v_perf * v_w_perf; v_den := v_w_perf;
    if v_inc is not null then v_num := v_num + v_inc * v_w_inc; v_den := v_den + v_w_inc; end if;
    v_num := v_num + v_att * v_w_att; v_den := v_den + v_w_att;
    v_num := v_num + v_flg * v_w_flg; v_den := v_den + v_w_flg;
    if v_den > 0 then v_composite := round(least(100, greatest(0, v_num / v_den))); else v_composite := 0; end if;
    v_level := public.perf_level(v_composite);
  end if;

  select count(*) into v_warnings from public.performance_warnings pw where pw.user_id = p_user;

  return query select p_user, p_month, v_perf, v_inc, v_att, v_flg, v_composite, v_level, v_warnings;
end;
$fn$;

-- ─────────────────────────────────────────────────────────────
-- B3. tl_perf_preview: same month-correct roster and as-of ownership, so the
-- drill-down shown next to a frozen composite agrees with it instead of
-- contradicting it.
-- ─────────────────────────────────────────────────────────────
create or replace function public.tl_perf_preview(p_tl uuid, p_month text)
returns table(team_score numeric, reporting_score numeric, reports_n integer, deductions numeric,
              blended numeric, star_avg numeric, star_score numeric, accountability numeric)
language plpgsql
stable security definer
set search_path = public
as $fn$
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

  -- Month-correct roster + as-of ownership (mig 424), matching the composite.
  select avg(c.composite_score) into v_team
    from public.profiles a
    cross join lateral public.get_performance_composite(a.id, p_month) c
   where a.reports_to = p_tl and a.role = 'apc'
     and (a.deleted_at is null or a.deleted_at >= v_end)
     and c.composite_score is not null;

  select count(*) into v_n
    from public.reports r
   where public.brand_owner_as_of(r.brand_id, v_end) = p_tl
     and r.verified_at >= v_start and r.verified_at < v_end;
  select coalesce(sum(d.amount), 0) into v_d
    from public.tl_reporting_deductions d
    join public.reports r on r.id = d.report_id
   where public.brand_owner_as_of(r.brand_id, v_end) = p_tl
     and r.verified_at >= v_start and r.verified_at < v_end;

  select avg(r.tl_stars) into v_savg
    from public.reports r
   where public.brand_owner_as_of(r.brand_id, v_end) = p_tl
     and r.tl_stars is not null
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
$fn$;

-- ─────────────────────────────────────────────────────────────
-- B4. get_performance_overview: a finalised month must still list the people
-- who lived it. The scope filtered `p.is_active`, so after the 12 Oct layoff
-- September's overview silently lost nine APCs.
-- ─────────────────────────────────────────────────────────────
create or replace function public.get_performance_overview(p_month text)
returns table(user_id uuid, display_name text, role text, avatar_url text,
              performance_score numeric, incentives_score numeric, attendance_score numeric,
              flags_score numeric, composite_score numeric, level text,
              green_flags integer, red_flags integer, warning_count integer)
language plpgsql
stable security definer
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_caller uuid := auth.uid();
  v_svc    boolean := coalesce(
               nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
             ) = 'service_role'
             or session_user in ('postgres', 'supabase_admin');
  v_is_mgr bool := public.is_boss(v_caller)
                  or exists (select 1 from public.profiles p where p.id = v_caller and p.role in ('ol','developer','tl','pctl') and p.is_active);
  v_start  timestamptz := (p_month || '-01')::timestamptz;
  v_end    timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamptz;
begin
  if (v_caller is null and not v_svc) or not (v_svc or v_is_mgr) then
    return;
  end if;

  return query
  with scope as (
    select p.id, p.display_name, p.role, p.avatar_url
      from public.profiles p
     where (
         p.is_active = true
         -- mig 424: keep a frozen month's roster intact after people leave.
         or exists (select 1 from public.performance_month_snapshots s
                     where s.user_id = p.id and s.month = p_month)
       )
       and (
         v_svc
         or public.is_boss(v_caller)
         or exists (select 1 from public.profiles me where me.id = v_caller and me.role in ('ol','developer'))
         or p.reports_to = v_caller
       )
  ),
  comp as (
    select s.id, s.display_name, s.role, s.avatar_url,
           c.performance_score, c.incentives_score, c.attendance_score,
           c.flags_score, c.composite_score, c.level, c.warning_count
      from scope s
      cross join lateral public.get_performance_composite(s.id, p_month) c
  )
  select
    c.id, c.display_name, c.role, c.avatar_url,
    c.performance_score, c.incentives_score, c.attendance_score,
    c.flags_score, c.composite_score, c.level,
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
$fn$;

-- ─────────────────────────────────────────────────────────────
-- C1. Is a month frozen? Cheap helper the client can call.
-- ─────────────────────────────────────────────────────────────
create or replace function public.perf_month_is_locked(p_month text)
returns boolean
language sql
security definer
set search_path = public
stable
as $fn$
  select exists (select 1 from public.performance_month_snapshots s where s.month = p_month);
$fn$;
grant execute on function public.perf_month_is_locked(text) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- C2. Finalise a month.
--
-- Order matters: everyone who is NOT a TL is snapshotted first, then TLs. A
-- TL's team pillar averages its APCs' composites through
-- get_performance_composite, which by then serves those APCs from their frozen
-- rows — so a TL's number is pinned to the same APC values a reader sees, and
-- re-running can never drift.
--
-- Skipped (and retried by a later run):
--   * composite_score is null      — not rated yet
--   * level = pending_verification — incentives plan still unverified
-- A month is only lockable once it is over, in Karachi time. Re-running tops up
-- whoever was skipped and leaves existing rows alone unless p_relock.
-- ─────────────────────────────────────────────────────────────
create or replace function public.perf_lock_month(p_month text, p_relock boolean default false)
returns table(locked integer, skipped integer, already integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_svc     boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                       or session_user in ('postgres', 'supabase_admin');
  v_locked  int := 0;
  v_skipped int := 0;
  v_already int := 0;
  v_now_m   text := to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM');
  v_end     timestamptz;
  r         record;
  v_c       record;
  v_pass    int;
begin
  if not (v_svc or public.is_boss(v_uid)
          or exists (select 1 from public.profiles p
                      where p.id = v_uid and p.role in ('ol', 'developer')
                        and p.is_active = true and p.deleted_at is null)) then
    raise exception 'Only the Boss or an Operation Lead can finalise a month';
  end if;
  if p_month !~ '^[0-9]{4}-[0-9]{2}$' then
    raise exception 'month must look like YYYY-MM, got %', p_month;
  end if;
  if p_month >= v_now_m then
    raise exception 'Cannot finalise % — it is not over yet (current month is %)', p_month, v_now_m;
  end if;

  v_end := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';

  -- pass 1 = non-TLs, pass 2 = TLs (see note above)
  for v_pass in 1..2 loop
    for r in
      select p.id, p.role
        from public.profiles p
       where (p.role = 'tl') = (v_pass = 2)
         and p.role is not null
         -- anyone employed during that month, whether or not they still are
         and (p.deleted_at is null or p.deleted_at >= v_end)
    loop
      if exists (select 1 from public.performance_month_snapshots s
                  where s.user_id = r.id and s.month = p_month) then
        if not p_relock then
          v_already := v_already + 1;
          continue;
        end if;
        delete from public.performance_month_snapshots s
         where s.user_id = r.id and s.month = p_month;
      end if;

      select * into v_c from public.get_performance_composite(r.id, p_month);

      if v_c.composite_score is null or v_c.level = 'pending_verification' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      insert into public.performance_month_snapshots (
        user_id, month, performance_score, incentives_score, attendance_score,
        flags_score, composite_score, level, warning_count, breakdown, locked_by)
      values (
        r.id, p_month, v_c.performance_score, v_c.incentives_score, v_c.attendance_score,
        v_c.flags_score, v_c.composite_score, v_c.level, v_c.warning_count,
        jsonb_strip_nulls(jsonb_build_object(
          'role', r.role,
          'weights', (select to_jsonb(w) from public.perf_weights_for_month(p_month) w),
          'team_score',      case when r.role = 'tl' then (
              select round(avg(c2.composite_score), 4) from public.profiles a
                cross join lateral public.get_performance_composite(a.id, p_month) c2
               where a.reports_to = r.id and a.role = 'apc'
                 and (a.deleted_at is null or a.deleted_at >= v_end)
                 and c2.composite_score is not null) end,
          'reporting_score', case when r.role = 'tl'
              then public.tl_reporting_score(r.id, p_month) end,
          'team_member_ids', case when r.role = 'tl' then (
              select jsonb_agg(a.id order by a.id) from public.profiles a
               where a.reports_to = r.id and a.role = 'apc'
                 and (a.deleted_at is null or a.deleted_at >= v_end)) end,
          'brand_ids_as_of', case when r.role = 'tl' then (
              select jsonb_agg(distinct b.id) from public.brands b
               where public.brand_owner_as_of(b.id, v_end) = r.id) end,
          'locked_from', 'perf_lock_month'
        )),
        v_uid);
      v_locked := v_locked + 1;
    end loop;
  end loop;

  return query select v_locked, v_skipped, v_already;
end;
$fn$;
revoke all on function public.perf_lock_month(text, boolean) from public;
grant execute on function public.perf_lock_month(text, boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- C3. Reopen a month. Boss only — this is the undo for a premature lock, and
-- it puts the month back on live recomputation, so it is deliberately harder
-- to reach than locking.
-- ─────────────────────────────────────────────────────────────
create or replace function public.perf_unlock_month(p_month text)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_svc boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                   or session_user in ('postgres', 'supabase_admin');
  v_n   int;
begin
  if not (v_svc or public.is_boss(v_uid)) then
    raise exception 'Only the Boss can reopen a finalised month';
  end if;
  delete from public.performance_month_snapshots s where s.month = p_month;
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;
revoke all on function public.perf_unlock_month(text) from public;
grant execute on function public.perf_unlock_month(text) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- D. Backfill the already-closed months.
--
-- tl_perf_since is 2026-08-01, so August is the first month scored by the
-- method this migration repairs. Everything from then to last month gets
-- frozen at its month-correct value. Running as the migration (superuser) so
-- the service_role branch of perf_lock_month's authz applies.
-- ─────────────────────────────────────────────────────────────
do $backfill$
declare
  m        text;
  v_from   date := date '2026-08-01';
  v_to     date := date_trunc('month', (now() at time zone 'Asia/Karachi'))::date;
  v_res    record;
begin
  for m in
    select to_char(d, 'YYYY-MM')
      from generate_series(v_from, v_to - interval '1 month', interval '1 month') d
  loop
    select * into v_res from public.perf_lock_month(m, true);
    raise notice 'mig 424 backfill % -> locked=% skipped=% already=%',
      m, v_res.locked, v_res.skipped, v_res.already;
  end loop;
end $backfill$;

-- ---- verification ----------------------------------------------------------
do $verify$
declare
  n          int;
  v_sep_ali  numeric;
  v_sep_haid numeric;
  v_guard_ok boolean := false;
begin
  -- the snapshot table exists and the backfill put September in it
  select count(*) into n from public.performance_month_snapshots where month = '2026-09';
  if n = 0 then raise exception 'mig 424: September was not frozen'; end if;
  raise notice 'mig 424: % September snapshots', n;

  -- the two TLs the incident was reported on must now read above the warning
  -- threshold, i.e. the month-correct value rather than the post-layoff 69.
  select composite_score into v_sep_ali
    from public.performance_month_snapshots s
    join public.profiles p on p.id = s.user_id
   where s.month = '2026-09' and p.display_name = 'Ali Hamza';
  select composite_score into v_sep_haid
    from public.performance_month_snapshots s
    join public.profiles p on p.id = s.user_id
   where s.month = '2026-09' and p.display_name = 'Haider Ali';
  raise notice 'mig 424: Sept frozen composites — Ali Hamza=%, Haider Ali=%', v_sep_ali, v_sep_haid;
  if coalesce(v_sep_ali, 0) < 70 then
    raise exception 'mig 424: Ali Hamza September still below the good threshold (%) — the as-of fix did not take', v_sep_ali;
  end if;

  -- read-through must be serving the frozen row, not recomputing
  if not public.perf_month_is_locked('2026-09') then
    raise exception 'mig 424: perf_month_is_locked says September is open';
  end if;

  -- The current month must NOT be lockable. The guard raises before any insert,
  -- so this probe cannot leave rows behind. Record the outcome in a flag and
  -- assert outside the block — raising inside it would be caught by its own
  -- handler and the check would silently always pass.
  begin
    perform * from public.perf_lock_month(to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM'));
  exception when others then
    v_guard_ok := true;   -- expected: "not over yet"
  end;
  if not v_guard_ok then
    raise exception 'mig 424: the current month was lockable and should not be';
  end if;

  raise notice '424 verified: closed months frozen, ownership and roster are month-correct.';
end $verify$;
