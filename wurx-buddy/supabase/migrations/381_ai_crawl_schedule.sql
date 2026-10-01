-- ============================================================
-- 381 — Assistant v2: the weekly TikTok Shop Academy re-crawl schedule.
-- Kept apart from 375 so the crawler can be switched on (or left off) on its own.
-- Needs 380 (ai_crawl_start, ai_crawl_tick) and the tts-crawl edge function,
-- deployed with the same AI_INGEST_SECRET as ai-ingest.
--
--   app_config  ai_crawl_url  https://<ref>.supabase.co/functions/v1/tts-crawl
--               Inserted EMPTY (set it after deploying); empty → the tick is a no-op.
--               The tick reuses app_config.ai_ingest_secret (mig 375).
--
-- Jobs (pg_cron runs in GMT; PKT = GMT+5):
--   ai-tts-crawl-start  0 23 * * 6   Saturday 23:00 GMT = Sunday 04:00 PKT: start a crawl
--                                    (a crawl still running is left alone).
--   ai-tts-crawl-tick   * * * * *    while a crawl runs, post {mode:'continue'} to the
--                                    function; idle → no call. About 1,030 pages at
--                                    ~3 s each: a crawl takes roughly 40–60 minutes.
-- The next ingest sweep (every 12 h, or ai_run_ingestion()) embeds only the
-- articles the crawl changed; retired ones are soft-deleted.
-- Pause:    select cron.unschedule('ai-tts-crawl-start');
-- Stop now: update public.ai_crawl_state set status = 'idle' where id = 1;
-- Rollback: unschedule both jobs.  Idempotent.
-- ============================================================

insert into public.app_config (key, value) values ('ai_crawl_url', '')
on conflict (key) do nothing;

select cron.schedule('ai-tts-crawl-start', '0 23 * * 6', 'select public.ai_crawl_start()');
select cron.schedule('ai-tts-crawl-tick',  '* * * * *',  'select public.ai_crawl_tick()');
