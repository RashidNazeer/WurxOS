-- ============================================================
-- WurxOS v2 — Migration 446: the chance of APC / TL of the Month no longer waits for a rating.
--
-- Mig 445 hid the percentage for anyone with no performance rating yet this month. They now get
-- an estimate from the pillars that exist (incentives if filled, attendance, flags), blended with
-- their history as before, and the number is flagged provisional until the rating lands.
-- Incentives not filled never blocked it (that pillar is simply left out).
--
-- achievement_odds(month, inc_pct) returns ONE row: the caller's own chance, rank and the
-- pillar to work on. An APC cannot read other people's scores (RLS), so the maths runs
-- here, server side, and only the caller's own numbers leave the function.
--
--   S (projected score) = e * current composite + (1 - e) * average of the last 3 finalised
--                         months; e = share of the month elapsed (floor 0.25, 1 once it ended).
--                         Only one of the two present -> that one. Neither -> not eligible.
--   P(i) = exp(S_i / T) / sum_j exp(S_j / T) over the caller's pool (APCs or TLs),
--                         T = 5 * (1 + (1 - e)): flat early in the month, decisive at the end.
--
-- The composite is the official get_performance_composite, with one difference: a person whose
-- incentive plan is not verified yet still counts (provisionally) at their current goal
-- completion, otherwise the whole field would be invisible until the OL verifies.
-- p_inc_pct is the what-if: "if my goals completed were X%", applied to the CALLER only.
-- Fewer than 3 scored people -> no probability is shown.
--
-- Also: the API layer rejects an UPDATE or DELETE without a WHERE clause (pg_safeupdate), which
-- is what broke mig 445 for every real login ("UPDATE requires a WHERE clause"). Every UPDATE
-- below now carries one, and the daily notifier's DELETE is fixed the same way.
-- Idempotent.
-- ============================================================
create or replace function public.achievement_odds(p_month text, p_inc_pct numeric default null)
returns table(pool text, month text, eligible boolean, reason text, score numeric, probability numeric,
              rank integer, pool_size integer, provisional boolean, focus_pillar text, focus_gap numeric)
language plpgsql
volatile
security definer
set search_path = public
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_role    text;
  v_now_m   text := to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM');
  v_today   date := (now() at time zone 'Asia/Karachi')::date;
  v_e       numeric;
  v_t       numeric;
  v_wp numeric; v_wi numeric; v_wa numeric; v_wf numeric;
  v_orig    text := coalesce(current_setting('request.jwt.claims', true), '');
  v_n       int;
  v_sum     numeric;
  v_max     numeric;
  v_s       numeric;
  v_prob    numeric;
  v_rank    int;
  v_prov    boolean;
  v_reason  text;
  v_focus   text;
  v_gap     numeric;
  v_inc_pct numeric := case when p_inc_pct is null then null else least(100, greatest(0, p_inc_pct)) end;
begin
  if v_uid is null then return; end if;
  select p.role into v_role from public.profiles p
   where p.id = v_uid and p.is_active = true and p.deleted_at is null;
  if v_role is null or v_role not in ('apc', 'tl') then return; end if;
  if p_month !~ '^[0-9]{4}-[0-9]{2}$' or p_month > v_now_m then return; end if;

  v_e := case when p_month < v_now_m then 1
              else greatest(0.25, extract(day from v_today)::numeric
                   / extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'))::numeric) end;
  v_t := 5 * (1 + (1 - v_e));

  select w.weight_performance, w.weight_incentives, w.weight_attendance, w.weight_flags
    into v_wp, v_wi, v_wa, v_wf from public.perf_weights_for_month(p_month) w;
  if v_wp is null then
    select c.weight_performance, c.weight_incentives, c.weight_attendance, c.weight_flags
      into v_wp, v_wi, v_wa, v_wf from public.performance_config c where c.id = 1;
  end if;

  create temporary table if not exists _odds (
    uid uuid, perf numeric, inc numeric, att numeric, flg numeric, cur numeric, hist numeric, s numeric, w numeric
  ) on commit drop;
  truncate _odds;

  -- Everyone's pillars come from the official composite, which only answers for people the
  -- caller may see. The switch below lasts this call (set_config is transaction-local) and is
  -- undone before returning; the function returns nothing but the caller's own row.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  insert into _odds (uid, perf, inc, att, flg)
  select p.id, c.performance_score, c.incentives_score, c.attendance_score, c.flags_score
    from public.profiles p
    cross join lateral public.get_performance_composite(p.id, p_month) c
   where p.role = v_role and p.is_active = true and p.deleted_at is null;
  perform set_config('request.jwt.claims', v_orig, true);

  if v_inc_pct is not null then update _odds set inc = v_inc_pct where uid = v_uid; end if;

  -- No performance rating yet this month: estimate from the pillars that exist (incentives
  -- if filled, attendance, flags) instead of hiding the chance. Counted as provisional.
  update _odds set cur = round(least(100, greatest(0,
        (coalesce(perf * v_wp, 0) + coalesce(inc * v_wi, 0) + coalesce(att, 0) * v_wa + coalesce(flg, 0) * v_wf)
        / (case when perf is not null then v_wp else 0 end + case when inc is not null then v_wi else 0 end + v_wa + v_wf))))
   where true;

  update _odds od set hist = (
    select avg(h.composite_score) from (
      select s.composite_score from public.performance_month_snapshots s
       where s.user_id = od.uid and s.month < p_month and s.composite_score is not null
       order by s.month desc limit 3) h)
   where true;

  update _odds set s = case
      when cur is not null and hist is not null then v_e * cur + (1 - v_e) * hist
      when cur is not null then cur
      else hist end
   where true;

  select count(*), max(s) into v_n, v_max from _odds where s is not null;
  select x.s into v_s from _odds x where x.uid = v_uid;

  -- caller's goals not yet verified (or a what-if is applied) -> flag the number as provisional
  v_prov := v_inc_pct is not null or (select x.perf from _odds x where x.uid = v_uid) is null or exists (
    select 1 from public.incentives i
     where i.user_id = v_uid and i.month = p_month and coalesce(i.verified, false) = false
       and (coalesce(jsonb_array_length(i.incentives), 0) + coalesce(jsonb_array_length(i.bonuses), 0)) >= 1);

  if v_s is null then
    v_reason := 'Not rated yet this month, so there is nothing to project from.';
  elsif v_n < 3 then
    v_reason := 'Needs at least 3 rated people before a chance can be shown.';
  end if;

  if v_reason is null then
    update _odds set w = exp((s - v_max) / v_t) where s is not null;
    select sum(w) into v_sum from _odds;
    select round(x.w / v_sum * 100, 1) into v_prob from _odds x where x.uid = v_uid;
    select 1 + count(*)::int into v_rank from _odds x where x.s > v_s;

    -- the pillar where the caller is furthest below the top 3 average, weighted by its share
    select f.k, f.g into v_focus, v_gap from (
      select k, (top3 - own) * wt as g, round(top3 - own) as gap_pts from (
        select 'performance' k, v_wp wt, (select avg(p) from (select perf p from _odds where perf is not null order by perf desc limit 3) a) top3, (select perf from _odds where uid = v_uid) own
        union all select 'incentives', v_wi, (select avg(p) from (select inc p from _odds where inc is not null order by inc desc limit 3) a), (select inc from _odds where uid = v_uid)
        union all select 'attendance', v_wa, (select avg(p) from (select att p from _odds where att is not null order by att desc limit 3) a), (select att from _odds where uid = v_uid)
        union all select 'flags', v_wf, (select avg(p) from (select flg p from _odds where flg is not null order by flg desc limit 3) a), (select flg from _odds where uid = v_uid)
      ) z where own is not null and top3 is not null and top3 > own
    ) f order by f.g desc limit 1;
    if v_focus is not null then
      select round(top3 - own) into v_gap from (
        select case v_focus
                 when 'performance' then (select avg(p) from (select perf p from _odds where perf is not null order by perf desc limit 3) a)
                 when 'incentives'  then (select avg(p) from (select inc p from _odds where inc is not null order by inc desc limit 3) a)
                 when 'attendance'  then (select avg(p) from (select att p from _odds where att is not null order by att desc limit 3) a)
                 else (select avg(p) from (select flg p from _odds where flg is not null order by flg desc limit 3) a) end top3,
               case v_focus when 'performance' then x.perf when 'incentives' then x.inc when 'attendance' then x.att else x.flg end own
          from _odds x where x.uid = v_uid) q;
    end if;
  end if;

  return query select v_role, p_month, (v_reason is null), v_reason,
                      case when v_s is null then null else round(v_s, 1) end,
                      v_prob, v_rank, v_n, v_prov, v_focus, v_gap;
end;
$fn$;
revoke all on function public.achievement_odds(text, numeric) from public, anon;
grant execute on function public.achievement_odds(text, numeric) to authenticated;

-- Daily notifier (mig 444) with a WHERE on its DELETE.
create or replace function public.notify_incomplete_apc_performance()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_month text := to_char(date_trunc('month', now() at time zone 'Asia/Karachi') - interval '1 month', 'YYYY-MM');
  v_label text := to_char(date_trunc('month', now() at time zone 'Asia/Karachi') - interval '1 month', 'FMMonth YYYY');
  v_apcs int; v_rat int; v_star int;
  r record;
begin
  create temporary table if not exists _apc_pend (apc_id uuid, tl_id uuid, rat int, star int) on commit drop;
  delete from _apc_pend where true;
  insert into _apc_pend
  select a.id, a.reports_to, x.unrated_meetings, x.unstarred_reports
    from public.profiles a
    cross join lateral public.apc_perf_pending_raw(a.id, v_month) x
   where a.role = 'apc' and a.is_active = true and a.deleted_at is null
     and (x.unrated_meetings > 0 or x.unstarred_reports > 0)
     and not exists (select 1 from public.performance_month_snapshots s
                      where s.user_id = a.id and s.month = v_month);

  select count(*), coalesce(sum(rat), 0), coalesce(sum(star), 0) into v_apcs, v_rat, v_star from _apc_pend;
  if v_apcs = 0 then return; end if;

  for r in select id from public.profiles where role = 'ol' and is_active = true and deleted_at is null loop
    perform public.emit_notification(
      r.id, null, 'agenda', 'perf_month.incomplete',
      v_label || ' performance is incomplete',
      v_apcs || ' APC' || case when v_apcs = 1 then '' else 's' end || ' not finalised: '
        || v_rat || ' weekly rating' || case when v_rat = 1 then '' else 's' end || ' to fill, '
        || v_star || ' report' || case when v_star = 1 then '' else 's' end || ' to star.',
      'performance_month', null, '/performance');
  end loop;

  for r in select tl_id, count(*) as apcs, sum(star) as stars
             from _apc_pend where star > 0 and tl_id is not null group by tl_id loop
    if exists (select 1 from public.profiles p where p.id = r.tl_id and p.role in ('tl','pctl') and p.is_active = true and p.deleted_at is null) then
      perform public.emit_notification(
        r.tl_id, null, 'agenda', 'perf_month.incomplete',
        v_label || ' performance is incomplete',
        r.stars || ' verified report' || case when r.stars = 1 then '' else 's' end
          || ' from ' || r.apcs || ' of your APC' || case when r.apcs = 1 then '' else 's' end
          || ' still need a star before the month can be finalised.',
        'performance_month', null, '/performance');
    end if;
  end loop;
end;
$fn$;
revoke all on function public.notify_incomplete_apc_performance() from public, anon, authenticated;
grant execute on function public.notify_incomplete_apc_performance() to service_role;
