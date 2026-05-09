-- ============================================================
-- WurxOS v2 — Migration 009: tighten pg_cron to every minute
--
-- Drops the 15-minute reset job and re-schedules it to run every
-- minute. The underlying query is an indexed partial-match UPDATE
-- that returns 0 rows on most ticks, so the added cost is trivial.
-- Max reset delay goes from 15 min → 60 sec.
--
-- Safe to re-run.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('reset-recurring-tasks')
      where exists (select 1 from cron.job where jobname = 'reset-recurring-tasks');
    perform cron.schedule(
      'reset-recurring-tasks',
      '* * * * *',
      $CRON$ select public.reset_recurring_tasks(); $CRON$
    );
  end if;
end;
$$;
