-- ============================================================
-- WurxOS v2 — Migration 426: freeze the drill-down too.
--
-- Mig 424 froze the composite and its four pillars, but tl_perf_preview and
-- apc_perf_preview — the breakdown the UI shows when you open a person — still
-- recomputed on every read. So a finalised month could show a frozen headline
-- of 71 next to a team score that keeps moving as reports get edited, which is
-- precisely the contradiction the lock exists to remove.
--
-- The lock now stores each person's whole preview payload under
-- breakdown->'preview', and both preview functions serve that when the month is
-- frozen.
--
-- August and September are re-locked (p_relock) so their rows gain the preview.
-- That recomputes their composites, which is safe and is asserted below: the
-- month-correct ownership/roster from 424 is in place, and the last
-- score-bearing edit to any September report was 6 Oct — before the 12 Oct
-- restructure — so the numbers must come back identical. The verification
-- fails the migration if they do not.
--
-- Idempotent.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. perf_lock_month: also capture the preview payload.
-- Same contract and same ordering as 424 (non-TLs first, then TLs).
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
  v_prev    jsonb;
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

  -- pass 1 = non-TLs, pass 2 = TLs. A TL's team pillar averages its APCs'
  -- composites through get_performance_composite, which by pass 2 serves those
  -- APCs from their frozen rows — so a TL is pinned to the same APC values a
  -- reader sees, and re-running cannot drift.
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

      -- The drill-down, frozen alongside the headline (mig 426). Computed with
      -- the row deleted, so it reflects this month and not a stale copy.
      v_prev := null;
      if r.role = 'tl' then
        select to_jsonb(t) into v_prev from public.tl_perf_preview(r.id, p_month) t;
      elsif r.role = 'apc' then
        select to_jsonb(t) into v_prev from public.apc_perf_preview(r.id, p_month) t;
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
          'preview', v_prev,
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
-- 2. tl_perf_preview: serve the frozen payload for a finalised month.
-- The short-circuit sits AFTER the permission check, as in 424.
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
  v_prev   jsonb;
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

  -- FROZEN MONTH (mig 426)
  select s.breakdown -> 'preview' into v_prev
    from public.performance_month_snapshots s
   where s.user_id = p_tl and s.month = p_month;
  if v_prev is not null and jsonb_typeof(v_prev) = 'object' then
    return query select (v_prev ->> 'team_score')::numeric, (v_prev ->> 'reporting_score')::numeric,
                        (v_prev ->> 'reports_n')::int, (v_prev ->> 'deductions')::numeric,
                        (v_prev ->> 'blended')::numeric, (v_prev ->> 'star_avg')::numeric,
                        (v_prev ->> 'star_score')::numeric, (v_prev ->> 'accountability')::numeric;
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
-- 3. apc_perf_preview: same short-circuit. Its own inputs are already
-- immutable (author_id, stored metrics), but it must still stop moving once a
-- month is frozen, or a late star rating would shift the drill-down under a
-- fixed headline.
-- ─────────────────────────────────────────────────────────────
create or replace function public.apc_perf_preview(p_apc uuid, p_month text)
returns table(checkpoint_score numeric, report_score numeric, reports_n integer, deductions numeric,
              blended numeric, star_avg numeric, star_score numeric, accountability numeric)
language plpgsql
stable security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_svc    boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                      or session_user in ('postgres', 'supabase_admin');
  v_prev   jsonb;
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

  -- FROZEN MONTH (mig 426)
  select s.breakdown -> 'preview' into v_prev
    from public.performance_month_snapshots s
   where s.user_id = p_apc and s.month = p_month;
  if v_prev is not null and jsonb_typeof(v_prev) = 'object' then
    return query select (v_prev ->> 'checkpoint_score')::numeric, (v_prev ->> 'report_score')::numeric,
                        (v_prev ->> 'reports_n')::int, (v_prev ->> 'deductions')::numeric,
                        (v_prev ->> 'blended')::numeric, (v_prev ->> 'star_avg')::numeric,
                        (v_prev ->> 'star_score')::numeric, (v_prev ->> 'accountability')::numeric;
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
$fn$;

-- ─────────────────────────────────────────────────────────────
-- 4. Re-lock the closed months so their rows carry the preview.
-- ─────────────────────────────────────────────────────────────
do $relock$
declare
  v_before jsonb;
  v_after  jsonb;
  m        text;
  v_res    record;
begin
  -- remember every frozen composite so we can prove the re-lock changed nothing
  select jsonb_object_agg(user_id::text || '|' || month, composite_score)
    into v_before from public.performance_month_snapshots;

  foreach m in array array['2026-08', '2026-09'] loop
    select * into v_res from public.perf_lock_month(m, true);
    raise notice 'mig 426 relock % -> locked=% skipped=% already=%',
      m, v_res.locked, v_res.skipped, v_res.already;
  end loop;

  select jsonb_object_agg(user_id::text || '|' || month, composite_score)
    into v_after from public.performance_month_snapshots;

  if v_before is distinct from v_after then
    raise exception 'mig 426: re-locking changed a frozen composite — before=% after=%',
      v_before, v_after;
  end if;
  raise notice 'mig 426: re-lock reproduced every composite exactly';
end $relock$;

-- ---- verification ----------------------------------------------------------
do $verify$
declare
  n   int;
  v_t numeric;
begin
  -- every frozen TL and APC row now carries a preview
  select count(*) into n
    from public.performance_month_snapshots s
    join public.profiles p on p.id = s.user_id
   where p.role in ('tl', 'apc')
     and jsonb_typeof(s.breakdown -> 'preview') is distinct from 'object';
  if n > 0 then raise exception 'mig 426: % frozen TL/APC rows have no preview', n; end if;

  -- and the preview function serves it
  select t.team_score into v_t
    from public.profiles p
    cross join lateral public.tl_perf_preview(p.id, '2026-09') t
   where p.display_name = 'Ali Hamza';
  if v_t is null then raise exception 'mig 426: frozen tl_perf_preview returned no team score'; end if;
  raise notice 'mig 426: Ali Hamza September frozen team score = %', v_t;

  raise notice '426 verified: the drill-down is frozen with the headline.';
end $verify$;
