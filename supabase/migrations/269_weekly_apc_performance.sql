-- ============================================================
-- WurxOS v2 — Migration 269: weekly APC performance ratings.
--
-- Shifts APC performance rating from once-a-month to WEEKLY: the OL rates the
-- SAME 5 metrics (0–100 each) after the APC presents in the agenda meeting. The
-- month's performance pillar = the AVERAGE of that month's weekly ratings.
--
-- SAFETY / lowest blast radius: the Performance page computes the composite in
-- JS from the monthly `performance_ratings` row (the SQL RPC only feeds the AI
-- assistant). So weekly ratings ROLL UP into that existing monthly row — the
-- audited composite formula, weights, incentive-verify gate (mig 257), AI
-- assistant and salary are ALL untouched. Only the *source* of the performance
-- pillar changes, and only for APCs. TLs are unaffected.
--
-- TRIAL SWITCH: no dev env, must demo "live" to seniors. While the Boss switch
-- is OFF, weekly ratings are collected and previewed CLIENT-SIDE but never touch
-- the official score (the rollup no-ops). Flipping ON backfills + makes it
-- official. Deploy with the switch OFF = live-to-demo, safe on money.
--
-- Bucketing: a rating counts toward the month the meeting was HELD (meeting_date
-- month). Averaging self-normalizes to 0–100, so 4 or 5 meetings/month both work
-- with no cap/spill.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. config: trial switch + launch floor ───────────────────────────
alter table public.performance_config
  add column if not exists weekly_apc_ratings_enabled boolean not null default false,
  add column if not exists weekly_apc_ratings_since    date    not null default date '2026-08-01';

-- ── 2. mark monthly ratings as manual vs weekly-derived ───────────────
-- 'manual' = hand-entered monthly (TLs, legacy); 'weekly' = rolled up from the
-- weekly ratings below. The composite/overview functions ignore this column —
-- it exists so the UI can show "rated weekly" and never hand-edit a derived row.
alter table public.performance_ratings
  add column if not exists source text not null default 'manual';

-- ── 3. weekly ratings table (one row per APC per meeting = per week) ──
create table if not exists public.weekly_performance_ratings (
  id            uuid primary key default gen_random_uuid(),
  apc_id        uuid not null references public.profiles(id) on delete cascade,
  meeting_id    uuid not null references public.agenda_meetings(id) on delete cascade,
  week_start    date,                                   -- filled from the meeting (below)
  month         text,                                   -- 'YYYY-MM' = meeting_date's month (bucket)
  metrics       jsonb not null default '{}'::jsonb,
  -- same 5-key average as performance_ratings.overall_score (mig 243)
  overall_score numeric generated always as (
    ( coalesce((metrics ->> 'dailyTasksQuality')::numeric, 0)
    + coalesce((metrics ->> 'reporting')::numeric, 0)
    + coalesce((metrics ->> 'overallWorkflow')::numeric, 0)
    + coalesce((metrics ->> 'responseTime')::numeric, 0)
    + coalesce((metrics ->> 'tasksProcessing')::numeric, 0)
    ) / 5.0
  ) stored,
  rated_by      uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (apc_id, meeting_id)
);
create index if not exists wpr_apc_month_idx  on public.weekly_performance_ratings(apc_id, month);
create index if not exists wpr_meeting_idx     on public.weekly_performance_ratings(meeting_id);

-- Fill week_start + month FROM the meeting so the client can't get them wrong.
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
drop trigger if exists wpr_fill_from_meeting_trg on public.weekly_performance_ratings;
create trigger wpr_fill_from_meeting_trg
  before insert or update on public.weekly_performance_ratings
  for each row execute function public.wpr_fill_from_meeting();

-- ── 4. RLS ────────────────────────────────────────────────────────────
alter table public.weekly_performance_ratings enable row level security;

-- SELECT: boss / active ol|developer / the APC themselves / the APC's manager.
drop policy if exists "wpr_select" on public.weekly_performance_ratings;
create policy "wpr_select" on public.weekly_performance_ratings for select using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  or apc_id = auth.uid()
  or exists (select 1 from public.profiles t where t.id = weekly_performance_ratings.apc_id and t.reports_to = auth.uid())
);

-- WRITE: only Boss / active ol|developer (OL rates; TL does NOT score performance).
drop policy if exists "wpr_write" on public.weekly_performance_ratings;
create policy "wpr_write" on public.weekly_performance_ratings for all using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
) with check (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
);

-- ── 5. rollup: weekly rows → the monthly performance_ratings row ──────
-- Averages each metric across the month's weekly rows for one APC and upserts
-- the monthly row with source='weekly'. NO-OP while the trial switch is OFF, so
-- collecting/previewing weekly ratings never moves an official score. Zero
-- weekly rows for the month → the derived monthly row is removed.
create or replace function public.wpr_recompute_month(p_apc uuid, p_month text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_metrics jsonb;
  v_rater   uuid;
  v_count   int;
begin
  if p_apc is null or p_month is null then return; end if;

  select weekly_apc_ratings_enabled into v_enabled from public.performance_config where id = 1;
  if not coalesce(v_enabled, false) then return; end if;   -- trial: never touch official scores

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

  insert into public.performance_ratings (user_id, month, metrics, evaluated_by, source, updated_at)
  values (p_apc, p_month, v_metrics, v_rater, 'weekly', now())
  on conflict (user_id, month) do update
    set metrics      = excluded.metrics,
        evaluated_by = excluded.evaluated_by,
        source       = 'weekly',
        updated_at   = now();
end;
$$;
grant execute on function public.wpr_recompute_month(uuid, text) to authenticated, service_role;

create or replace function public.wpr_after_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    perform public.wpr_recompute_month(old.apc_id, old.month);
    return old;
  end if;
  perform public.wpr_recompute_month(new.apc_id, new.month);
  -- a rare edit that moves the row across months/APCs must refresh the old bucket too
  if tg_op = 'UPDATE' and (old.month is distinct from new.month or old.apc_id is distinct from new.apc_id) then
    perform public.wpr_recompute_month(old.apc_id, old.month);
  end if;
  return new;
end;
$$;
drop trigger if exists wpr_after_change_trg on public.weekly_performance_ratings;
create trigger wpr_after_change_trg
  after insert or update or delete on public.weekly_performance_ratings
  for each row execute function public.wpr_after_change();

-- ── 6. Boss trial switch RPC (backfills on turn-on) ──────────────────
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

  -- Turning ON = go live: roll up every (apc, month) that already has weekly
  -- rows so the trial data becomes the official score. Turning OFF only stops
  -- the rollup — existing derived rows are LEFT IN PLACE (never nuke salary data).
  if p_enabled then
    for v_row in
      select distinct apc_id, month from public.weekly_performance_ratings
       where apc_id is not null and month is not null
    loop
      perform public.wpr_recompute_month(v_row.apc_id, v_row.month);
    end loop;
  end if;

  return p_enabled;
end;
$$;
grant execute on function public.set_weekly_apc_ratings_enabled(boolean) to authenticated;

-- ── 7. missed-meeting: pending list (OL/boss) + daily cron notice ─────
-- Team APCs (reports_to = meeting.tl_id, role apc) with a meeting >= 2 days old
-- and no weekly rating yet. Floored at weekly_apc_ratings_since so pre-launch
-- meetings are never flagged. current_date is Asia/Karachi (DB is PK-locked).
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
    from public.agenda_meetings m
    join public.profiles tl on tl.id = m.tl_id
    join public.profiles a  on a.reports_to = m.tl_id
                           and a.role = 'apc' and a.is_active = true and a.deleted_at is null
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

-- Daily: on the day a meeting hits the 2-day mark, tell each active OL how many
-- APC ratings from it still need scoring (one notice per OL, not per APC).
create or replace function public.notify_pending_apc_ratings()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_row   record;
  v_since date;
begin
  select weekly_apc_ratings_since into v_since from public.performance_config where id = 1;
  for v_row in
    select o.id as ol_id, count(*) as n
      from public.profiles o
      cross join public.agenda_meetings m
      join public.profiles a on a.reports_to = m.tl_id
                            and a.role = 'apc' and a.is_active = true and a.deleted_at is null
     where o.role = 'ol' and o.is_active = true
       and m.meeting_date = (current_date - interval '2 days')::date
       and m.meeting_date >= coalesce(v_since, date '2026-08-01')
       and not exists (
         select 1 from public.weekly_performance_ratings w
          where w.meeting_id = m.id and w.apc_id = a.id
       )
     group by o.id
  loop
    perform public.emit_notification(
      v_row.ol_id, null, 'agenda', 'weekly_rating.pending',
      'APC performance ratings pending',
      v_row.n || ' APC performance rating' || case when v_row.n = 1 then '' else 's' end
        || ' from a meeting 2 days ago still need your score.',
      'weekly_performance', null, '/performance');
  end loop;
end;
$$;
grant execute on function public.notify_pending_apc_ratings() to service_role;

-- Schedule it daily at 04:00 UTC = 09:00 Asia/Karachi. Unschedule any prior copy.
do $$
begin
  perform cron.unschedule('notify-pending-apc-ratings');
exception when others then null;
end $$;
select cron.schedule('notify-pending-apc-ratings', '0 4 * * *',
  $$select public.notify_pending_apc_ratings();$$);

-- ── 8. realtime (live meeting panel refresh) ─────────────────────────
do $$ begin
  alter publication supabase_realtime add table public.weekly_performance_ratings;
exception when duplicate_object then null;
end $$;
