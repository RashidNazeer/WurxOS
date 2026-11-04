-- Wurx Buddy ingestion runs every day 04:00-17:00 Asia/Karachi, slowly, and rests overnight.
-- Before: it rested 18:00-02:00 and bulk backfill opened on weekends only (mig 434). Bulk still trickles:
-- ai_ingest_tick allows at most one bulk run per 10 minutes while nothing urgent waits (32 chunks a call).
update public.ai_assistant_config
   set ingest_quiet_enabled = true, ingest_quiet_start = '17:00', ingest_quiet_end = '04:00'
 where id = 1;

-- The quiet window now bounds the work, so bulk is open whenever ingestion is.
create or replace function public.ai_bulk_open() returns boolean
language sql stable security definer set search_path = public as $$ select true $$;

-- Jobs that do nothing most minutes no longer need a cron history row every minute (disk IO).
-- Kept at 1 minute because people see their timing: fire-due-reminders, dispatch-scheduled-broadcasts,
-- refire-snoozed-notifications.
select cron.alter_job((select jobid from cron.job where jobname = 'db-backup-tick'),             schedule := '*/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'ai-tts-crawl-tick'),          schedule := '*/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'reset-recurring-tasks'),      schedule := '*/5 * * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'auto-clock-out-overdue'),     schedule := '*/5 * * * *');
