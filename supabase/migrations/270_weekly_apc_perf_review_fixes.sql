-- ============================================================
-- WurxOS v2 — Migration 270: weekly-APC-performance review fixes.
--
-- Adversarial review of mig 269 confirmed 6 DB defects (money-critical ones must
-- land before the Boss ever flips the switch ON). All fixed here:
--
--  F2  rollup/backfill weren't floored at weekly_apc_ratings_since → pre-launch
--      (trial) rows could roll up and OVERWRITE closed/paid months. Floor
--      wpr_recompute_month at `since` (covers the trigger path AND the backfill).
--  F4  the upsert converted a hand-entered source='manual' row to 'weekly' and
--      replaced its metrics (irreversible). Guard the upsert to only touch
--      source='weekly' rows (symmetric with the delete-when-zero guard).
--  F1/F5 turn-ON backfill only revisited (apc,month) that still had weekly rows,
--      so a derived source='weekly' row whose weekly rows were all deleted while
--      OFF was left feeding salary with nothing behind it. Reconcile the UNION
--      of weekly rows AND existing source='weekly' monthly rows on enable.
--  F3  the rollup upsert re-fired perf_notify_rating (evaluated_by=OL ≠ APC) →
--      a "rated you X/10" notification per weekly rollup + a storm on turn-ON.
--      Suppress the notification for source='weekly' rows.
--  F6  the pending list / breakdown keyed on CURRENT reports_to with no link to
--      who actually attended → a transferred-in APC was nagged for their new
--      team's pre-transfer meetings. Key off agenda_presentations (real
--      participation) instead.
--  F7  wpr_recompute_month was granted to `authenticated` though every caller is
--      SECURITY DEFINER. Revoke it (service_role only).
--
-- Safe to re-run.
-- ============================================================

-- ── F2 + F4: floor the rollup at `since`; never clobber a manual row ──
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
  if not coalesce(v_enabled, false) then return; end if;                 -- trial: never touch official scores
  if p_month < to_char(coalesce(v_since, date '2026-08-01'), 'YYYY-MM') then return; end if; -- F2: pre-launch months are off-limits

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
      'reporting',         round(avg(coalesce((metrics ->> 'reporting')::numeric, 0)), 2),
      'overallWorkflow',   round(avg(coalesce((metrics ->> 'overallWorkflow')::numeric, 0)), 2),
      'responseTime',      round(avg(coalesce((metrics ->> 'responseTime')::numeric, 0)), 2),
      'tasksProcessing',   round(avg(coalesce((metrics ->> 'tasksProcessing')::numeric, 0)), 2)
    ),
    (array_agg(rated_by order by updated_at desc nulls last))[1]
    into v_metrics, v_rater
    from public.weekly_performance_ratings
   where apc_id = p_apc and month = p_month;

  -- F4: only ever create or refresh a source='weekly' row. A pre-existing
  -- hand-entered 'manual' row is left untouched (the WHERE makes DO UPDATE a
  -- no-op) so a manual salary-feeding rating can never be silently destroyed.
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
revoke execute on function public.wpr_recompute_month(uuid, text) from public, anon, authenticated;  -- F7
grant  execute on function public.wpr_recompute_month(uuid, text) to service_role;

-- ── F1/F5: reconcile orphaned derived rows on turn-ON ────────────────
create or replace function public.set_weekly_apc_ratings_enabled(p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_row record;
begin
  if not public.is_boss(auth.uid()) then
    raise exception 'only the Boss can change the weekly-ratings mode';
  end if;

  update public.performance_config
     set weekly_apc_ratings_enabled = p_enabled, updated_by = auth.uid(), updated_at = now()
   where id = 1;

  -- Turning ON = go live. Recompute the UNION of (apc, month) that have weekly
  -- rows AND (user, month) that already carry a derived source='weekly' row —
  -- the latter so a derived row whose weekly rows were deleted during the OFF
  -- window (when the rollup no-ops) is reconciled to zero and removed, instead
  -- of lingering as an unbacked official score. Turning OFF leaves rows as-is.
  if p_enabled then
    for v_row in
      select apc_id as uid, month from public.weekly_performance_ratings
       where apc_id is not null and month is not null
      union
      select user_id as uid, month from public.performance_ratings
       where source = 'weekly'
    loop
      perform public.wpr_recompute_month(v_row.uid, v_row.month);
    end loop;
  end if;

  return p_enabled;
end;
$$;
grant execute on function public.set_weekly_apc_ratings_enabled(boolean) to authenticated;

-- ── F3: don't notify the APC on a weekly-derived rollup ──────────────
-- Recreated verbatim from mig 038 plus a single guard: a source='weekly' row is
-- a machine rollup of the OL's weekly scores, not a fresh manual rating, so it
-- must not emit the "rated you X/10" notification (which would fire on every
-- weekly save and storm on the turn-ON backfill).
create or replace function public.perf_notify_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor_name text;
  v_score numeric := coalesce(new.overall_score, 0);
begin
  if coalesce(new.source, 'manual') = 'weekly' then
    return new;
  end if;
  if new.evaluated_by is null or new.evaluated_by = new.user_id then
    return new;
  end if;
  v_actor_name := public.profile_display_name(new.evaluated_by);
  perform public.emit_notification(
    new.user_id, new.evaluated_by, 'system', 'performance.rating',
    'Performance rating',
    v_actor_name || ' rated you ' || to_char(v_score, 'FM9D0') || '/10 for ' || new.month,
    'performance', new.id, '/performance'
  );
  return new;
end;
$$;

-- ── F6: pending list + notify key off actual participation ───────────
create or replace function public.list_pending_apc_ratings(p_month text default null)
returns table (
  meeting_id   uuid,
  apc_id       uuid,
  apc_name     text,
  tl_id        uuid,
  tl_name      text,
  week_start   date,
  meeting_date date,
  month        text
)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid   uuid := auth.uid();
  v_is_ol boolean;
  v_since date;
begin
  v_is_ol := public.is_boss(v_uid)
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true);
  if not v_is_ol then return; end if;

  select weekly_apc_ratings_since into v_since from public.performance_config where id = 1;

  return query
  select m.id, a.id, a.display_name, m.tl_id, tl.display_name,
         m.week_start, m.meeting_date, to_char(m.meeting_date, 'YYYY-MM')
    from public.agenda_presentations ap
    join public.agenda_meetings m on m.id = ap.meeting_id
    join public.profiles a  on a.id = ap.apc_id and a.role = 'apc' and a.is_active = true and a.deleted_at is null
    join public.profiles tl on tl.id = m.tl_id
   where m.meeting_date <= (current_date - interval '2 days')
     and m.meeting_date >= coalesce(v_since, date '2026-08-01')
     and (p_month is null or to_char(m.meeting_date, 'YYYY-MM') = p_month)
     and not exists (
       select 1 from public.weekly_performance_ratings w
        where w.meeting_id = m.id and w.apc_id = a.id
     )
   order by m.meeting_date desc, a.display_name;
end;
$$;
grant execute on function public.list_pending_apc_ratings(text) to authenticated, service_role;

create or replace function public.notify_pending_apc_ratings()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row   record;
  v_since date;
  v_n     int;
begin
  select weekly_apc_ratings_since into v_since from public.performance_config where id = 1;

  select count(*) into v_n
    from public.agenda_presentations ap
    join public.agenda_meetings m on m.id = ap.meeting_id
    join public.profiles a on a.id = ap.apc_id and a.role = 'apc' and a.is_active = true and a.deleted_at is null
   where m.meeting_date = (current_date - interval '2 days')::date
     and m.meeting_date >= coalesce(v_since, date '2026-08-01')
     and not exists (
       select 1 from public.weekly_performance_ratings w
        where w.meeting_id = m.id and w.apc_id = a.id
     );

  if coalesce(v_n, 0) = 0 then return; end if;

  for v_row in select id from public.profiles where role = 'ol' and is_active = true loop
    perform public.emit_notification(
      v_row.id, null, 'agenda', 'weekly_rating.pending',
      'APC performance ratings pending',
      v_n || ' APC performance rating' || case when v_n = 1 then '' else 's' end
        || ' from a meeting 2 days ago still need your score.',
      'weekly_performance', null, '/performance');
  end loop;
end;
$$;
grant execute on function public.notify_pending_apc_ratings() to service_role;
