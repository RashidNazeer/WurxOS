-- ============================================================
-- WurxOS v2 — Migration 425: finalise last month by itself.
--
-- Mig 424 added the freeze and backfilled August + September, but nothing
-- closes a month going forward — October would stay live for ever and drift
-- exactly the way September did.
--
-- ── WHY A GRACE PERIOD AND NOT MIDNIGHT ON THE 1st ─────────────────────────
-- A month is not finished when it ends. September's brand metrics and incentive
-- plans were still being written on 3 Oct (legitimately — the APCs enter their
-- closing GMV figures then), and attendance corrections land later still: this
-- very month we hand-marked three forgotten clock-ins for Hamza Babar. Freezing
-- on the 1st would pin scores to half-entered data, which is a worse bug than
-- the one 424 fixed.
--
-- So the lock waits `perf_lock_grace_days` after the month ends. The default is
-- 7, which clears the observed 1–3 Oct close window with room to spare, and the
-- Boss can change it without a deploy.
--
-- Re-running is safe and useful: perf_lock_month(month, false) adds only the
-- people who have no frozen row yet, so anyone skipped for being unrated or
-- pending-verification is picked up by a later night's run.
--
-- Idempotent.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. The grace window, Boss-tunable.
-- ─────────────────────────────────────────────────────────────
alter table public.performance_config
  add column if not exists perf_lock_grace_days integer not null default 7;

alter table public.performance_config
  drop constraint if exists performance_config_lock_grace_sane;
alter table public.performance_config
  add constraint performance_config_lock_grace_sane
  check (perf_lock_grace_days between 0 and 60);

-- ─────────────────────────────────────────────────────────────
-- 2. Lock every month that is past its grace window.
--
-- Walks from the first month the TL/weekly method applies to (tl_perf_since,
-- floor 2026-08) up to last month. A month locks once
--   now(Karachi) >= month_end + grace_days.
-- Months already fully frozen cost one cheap `already` pass.
--
-- Returns one row per month it touched so the cron log says what happened.
-- ─────────────────────────────────────────────────────────────
create or replace function public.perf_autolock_due()
returns table(month text, locked integer, skipped integer, already integer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grace  int;
  v_since  date;
  v_now    timestamptz := now() at time zone 'utc';
  v_now_m  date := date_trunc('month', (now() at time zone 'Asia/Karachi'))::date;
  m        date;
  v_end    timestamptz;
  v_res    record;
begin
  select coalesce(perf_lock_grace_days, 7),
         coalesce(tl_perf_since, date '2026-08-01')
    into v_grace, v_since
    from public.performance_config where id = 1;
  v_grace := coalesce(v_grace, 7);
  v_since := coalesce(date_trunc('month', v_since)::date, date '2026-08-01');

  m := v_since;
  while m < v_now_m loop
    -- end of month m, in Karachi terms, then the grace window on top
    v_end := ((m + interval '1 month')::date)::timestamp at time zone 'Asia/Karachi';
    if v_now >= v_end + make_interval(days => v_grace) then
      select * into v_res from public.perf_lock_month(to_char(m, 'YYYY-MM'), false);
      -- only report months where there was something to do
      if v_res.locked > 0 or v_res.skipped > 0 then
        return query select to_char(m, 'YYYY-MM'), v_res.locked, v_res.skipped, v_res.already;
      end if;
    end if;
    m := (m + interval '1 month')::date;
  end loop;
end;
$fn$;
revoke all on function public.perf_autolock_due() from public;
grant execute on function public.perf_autolock_due() to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 3. Nightly. 22:40 UTC = 03:40 Asia/Karachi, matching how the other jobs in
-- cron.job express their schedules (they are all UTC).
-- ─────────────────────────────────────────────────────────────
do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'perf-autolock-months') then
    perform cron.unschedule('perf-autolock-months');
  end if;
  perform cron.schedule(
    'perf-autolock-months',
    '40 22 * * *',
    $job$ select public.perf_autolock_due(); $job$
  );
end $sched$;

-- ---- verification ----------------------------------------------------------
do $verify$
declare
  n       int;
  v_grace int;
begin
  select perf_lock_grace_days into v_grace from public.performance_config where id = 1;
  if v_grace is null then raise exception 'mig 425: grace window not set'; end if;
  raise notice 'mig 425: grace window = % days', v_grace;

  select count(*) into n from cron.job where jobname = 'perf-autolock-months' and active;
  if n <> 1 then raise exception 'mig 425: expected 1 active autolock job, found %', n; end if;

  -- The function must run clean and must NOT touch the current month. August
  -- and September are already frozen by 424, so a call now should report
  -- nothing to do for them.
  perform * from public.perf_autolock_due();

  if exists (select 1 from public.performance_month_snapshots
              where month >= to_char(now() at time zone 'Asia/Karachi', 'YYYY-MM')) then
    raise exception 'mig 425: autolock froze the current (or a future) month';
  end if;

  raise notice '425 verified: nightly autolock scheduled, current month left open.';
end $verify$;
