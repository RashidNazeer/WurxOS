-- ============================================================
-- 375 — Assistant v2: ingest scheduling. NOT APPLIED: needs its own Owner go.
-- Apply after 379 (the sweep functions), once the ai-ingest edge function is
-- deployed and the two app_config values are set (runbook-ingestion.md).
--
--   app_config  ai_ingest_url     https://<ref>.supabase.co/functions/v1/ai-ingest
--               ai_ingest_secret  = the function's AI_INGEST_SECRET
--               Both are inserted EMPTY here (secrets never live in a
--               migration); an empty URL makes the tick a no-op.
--   ai_ingest_tick()   posts {mode:'drain'} to the worker only when claimable
--                      work exists, so an idle queue costs 0 function calls
--                      (P2-11). Same pattern as notifications_dispatch_push (mig 027).
--   ai_housekeeping()  retention: done queue rows 14 d, runs 30 d, request
--                      log 180 d. Failed queue rows are kept for the panel.
--
-- Jobs. pg_cron runs in GMT on this project (cron.timezone = 'GMT', checked on
-- dev 2026-09-29); PKT = GMT+5, no DST.
--   ai-ingest-tick    * * * * *    every minute: drain the queue (no-op when empty)
--   ai-ingest-sweep   5 * * * *    hourly check, :05 GMT = :05 PKT: sweep (reconcile +
--                                  backfill) only if no successful sweep started in
--                                  the last 12 h (ai_ingest_sweep_if_due, mig 379).
--                                  Rolling: a manual ai_run_ingestion() resets the clock.
--   ai-housekeeping   30 22 * * *  03:30 PKT nightly
-- The nightly 'ai-reconcile' job of the earlier draft is gone: reconcile is
-- part of the sweep.
-- Pause:    select cron.unschedule('ai-ingest-sweep');   (and/or 'ai-ingest-tick')
-- Rollback: unschedule all three.
-- Design: Assistant/architecture.md §9.5, §9.11.  Idempotent.
-- ============================================================

insert into public.app_config (key, value) values ('ai_ingest_url', ''), ('ai_ingest_secret', '')
on conflict (key) do nothing;

create or replace function public.ai_ingest_tick()
returns void
language plpgsql security definer
set search_path = public, net
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- Mirrors ai_ingest_claim's claimable set (mig 372): due pending rows, or
  -- processing rows whose worker died (lock older than 10 minutes).
  if not exists (select 1 from public.ai_ingest_queue
                  where (status = 'pending' and not_before <= now())
                     or (status = 'processing' and locked_at < now() - interval '10 minutes')) then
    return;
  end if;
  select value into v_url    from public.app_config where key = 'ai_ingest_url';
  select value into v_secret from public.app_config where key = 'ai_ingest_secret';
  if coalesce(v_url, '') = '' then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', coalesce(v_secret, '')),
    body := '{"mode":"drain"}'::jsonb,
    timeout_milliseconds := 150000);
exception when others then
  raise warning 'ai_ingest_tick failed: %', sqlerrm;
end;
$$;
revoke execute on function public.ai_ingest_tick() from public, anon, authenticated;

create or replace function public.ai_housekeeping()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_q int; v_r int; v_l int;
begin
  delete from public.ai_ingest_queue where status = 'done' and done_at < now() - interval '14 days';
  get diagnostics v_q = row_count;
  delete from public.ai_ingest_runs where started_at < now() - interval '30 days';
  get diagnostics v_r = row_count;
  delete from public.ai_request_log where created_at < now() - interval '180 days';
  get diagnostics v_l = row_count;
  return jsonb_build_object('queue', v_q, 'runs', v_r, 'request_log', v_l);
end;
$$;
revoke execute on function public.ai_housekeeping() from public, anon, authenticated;

-- cron.schedule(name, …) replaces a job of the same name, so re-running is safe.
select cron.unschedule(jobid) from cron.job where jobname = 'ai-reconcile';
select cron.schedule('ai-ingest-tick',  '* * * * *',   'select public.ai_ingest_tick()');
select cron.schedule('ai-ingest-sweep', '5 * * * *',   'select public.ai_ingest_sweep_if_due()');
select cron.schedule('ai-housekeeping', '30 22 * * *', 'select public.ai_housekeeping()');
