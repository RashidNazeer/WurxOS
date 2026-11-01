-- ============================================================
-- WurxOS v2 — Migration 429: one checkpoint score per WEEK, not per meeting.
--
-- An APC whose brands sit under 2+ Team Leads (mig 428) presents in each TL's
-- agenda meeting, and each meeting gets its own rating. The month rollup
-- averaged ratings rows, so that week counted twice and outweighed single-TL
-- weeks. A week's score is now the average of that week's ratings (one per
-- meeting), and the month is the average of the weeks.
--
-- Only the rollup changes; weekly_performance_ratings still holds one row per
-- (apc, meeting) so each TL's own score stays visible and editable.
-- ============================================================

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

  with wk as (
    select week_start,
           avg(coalesce((metrics ->> 'dailyTasksQuality')::numeric, 0)) as dtq,
           avg(coalesce((metrics ->> 'overallWorkflow')::numeric, 0))   as wf,
           avg(coalesce((metrics ->> 'responseTime')::numeric, 0))      as rt,
           avg(coalesce((metrics ->> 'tasksProcessing')::numeric, 0))   as tp
      from public.weekly_performance_ratings
     where apc_id = p_apc and month = p_month
     group by week_start
  )
  select jsonb_build_object(
           'dailyTasksQuality', round(avg(dtq), 2),
           'overallWorkflow',   round(avg(wf), 2),
           'responseTime',      round(avg(rt), 2),
           'tasksProcessing',   round(avg(tp), 2)),
         (select rated_by from public.weekly_performance_ratings
           where apc_id = p_apc and month = p_month
           order by updated_at desc nulls last limit 1)
    into v_metrics, v_rater
    from wk;

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

-- Triggers don't fire retroactively: re-roll every month that already has a
-- week with more than one rating.
do $$
declare r record;
begin
  for r in
    select distinct apc_id, month from (
      select apc_id, month, week_start from public.weekly_performance_ratings
       group by apc_id, month, week_start having count(*) > 1
    ) d
  loop
    perform public.wpr_recompute_month(r.apc_id, r.month);
  end loop;
end $$;
