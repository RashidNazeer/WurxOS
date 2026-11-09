-- ============================================================
-- WurxOS v2 — Migration 444: an APC's month stays open until every performance field is filled.
--
-- The APC performance pillar is 0.6 x the OL's weekly rating + 0.4 x the TL's report stars
-- (and return docks). The month used to be frozen after its grace period even when an OL had
-- not rated a week or a TL had not starred a verified report, pinning a score to half-entered
-- data. Now:
--   * apc_perf_pending(apc, month)  - how many weekly ratings (OL) and report stars (TL) are
--     still missing, for the breakdown modal and the APC card warning.
--   * list_apc_pending(month)       - the same for every APC the caller manages (one call per page).
--   * perf_lock_month               - skips an APC with anything pending. Skipped people are
--     retried by the nightly autolock, so the month closes the night after the last field lands.
--
-- Pending = a meeting the APC presented in that is already past with no weekly rating, plus a
-- report verified in that month with no TL star. Both only count from weekly_apc_ratings_since,
-- so July and earlier (rated the old way) never block.
-- Idempotent.
-- ============================================================

-- Ungated count for the lock job. Not callable by clients.
create or replace function public.apc_perf_pending_raw(p_apc uuid, p_month text)
returns table(unrated_meetings integer, unstarred_reports integer)
language sql
stable
security definer
set search_path = public
as $fn$
  with cfg as (
    select coalesce(weekly_apc_ratings_since, date '2026-08-01') as since
      from public.performance_config where id = 1
  ),
  w as (
    select (p_month || '-01')::date as s, ((p_month || '-01')::date + interval '1 month')::date as e
  )
  select
    (select count(distinct m.id)::int
       from public.agenda_presentations ap
       join public.agenda_meetings m on m.id = ap.meeting_id, cfg, w
      where ap.apc_id = p_apc
        and m.meeting_date >= greatest(w.s, cfg.since) and m.meeting_date < w.e
        and m.meeting_date < (now() at time zone 'Asia/Karachi')::date
        and not exists (select 1 from public.weekly_performance_ratings r
                         where r.meeting_id = m.id and r.apc_id = p_apc)),
    (select count(*)::int
       from public.reports r, cfg, w
      where r.author_id = p_apc and r.apc_stars is null
        and r.verified_at >= (greatest(w.s, cfg.since)::timestamp at time zone 'Asia/Karachi')
        and r.verified_at <  (w.e::timestamp at time zone 'Asia/Karachi'));
$fn$;
revoke all on function public.apc_perf_pending_raw(uuid, text) from public, anon, authenticated;
grant execute on function public.apc_perf_pending_raw(uuid, text) to service_role;

-- Same visibility as apc_perf_preview: the APC, the Boss, an OL, or the APC's manager.
create or replace function public.apc_perf_pending(p_apc uuid, p_month text)
returns table(unrated_meetings integer, unstarred_reports integer)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare v_uid uuid := auth.uid();
begin
  if not (public.is_boss(v_uid) or v_uid = p_apc
          or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = p_apc and t.reports_to = v_uid)) then
    return;
  end if;
  return query select * from public.apc_perf_pending_raw(p_apc, p_month);
end;
$fn$;
revoke all on function public.apc_perf_pending(uuid, text) from public, anon;
grant execute on function public.apc_perf_pending(uuid, text) to authenticated;

-- Every APC the caller manages (Boss/OL: all active APCs; a TL/PCTL: their direct reports).
create or replace function public.list_apc_pending(p_month text)
returns table(apc_id uuid, unrated_meetings integer, unstarred_reports integer)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_all boolean;
begin
  v_all := public.is_boss(v_uid)
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true);
  return query
  select a.id, x.unrated_meetings, x.unstarred_reports
    from public.profiles a
    cross join lateral public.apc_perf_pending_raw(a.id, p_month) x
   where a.role = 'apc' and a.is_active = true and a.deleted_at is null
     and (v_all or a.reports_to = v_uid)
     and (x.unrated_meetings > 0 or x.unstarred_reports > 0);
end;
$fn$;
revoke all on function public.list_apc_pending(text) from public, anon;
grant execute on function public.list_apc_pending(text) to authenticated;

-- ── perf_lock_month: verbatim from mig 426 plus the pending skip ──
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

      -- An APC is not finalised while a weekly OL rating or a TL report star is still
      -- missing (mig 444). Counted as skipped, so a later night's run picks them up.
      if r.role = 'apc' and (select p.unrated_meetings + p.unstarred_reports
                               from public.apc_perf_pending_raw(r.id, p_month) p) > 0 then
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
