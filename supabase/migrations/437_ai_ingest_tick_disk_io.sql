-- ============================================================
-- WurxOS v2 — Migration 437: stop ai_ingest_tick() hammering the disk.
--
-- Supabase Disk IO budget warning, 2026-11-04. pg_stat_statements showed
-- ai_ingest_tick() (cron job 34, every minute) as the top block reader by a
-- wide margin: ~1M blocks read in 1,100 calls, ~970 per call. Each call counts
-- the whole bulk backlog (ai_bulk_open) and then scans ai_chunks for waiting
-- vectors, with ai_chunk_is_bulk() evaluated per row; 4,300 bulk/other chunks
-- legitimately wait (tts_article, incentive), so the scan finds nothing every
-- time (mig 434 gates the WORK, not the looking).
--
--   1. ai_bulk_open(): weekend short-circuits; otherwise the count stops at 301.
--   2. Small partial indexes over the waiting rows, so the probe never walks
--      the 94 MB heap.
--   3. Tick every 5 minutes instead of every minute.
--   4. Purge cron.job_run_details older than 7 days nightly (1.7M rows, 399 MB,
--      oldest April, nothing ever pruned it).
-- Idempotent.
-- ============================================================

create index if not exists ai_chunks_main_waiting_idx
  on public.ai_chunks (document_id) where embedding is null;

create index if not exists ai_chunks_alt_waiting_idx
  on public.ai_chunks (document_id) where embedding_alt is null;

create or replace function public.ai_bulk_open()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select case
    when extract(isodow from now() at time zone 'Asia/Karachi') in (6, 7) then true
    else (select count(*) from (
            select 1 from public.ai_chunks c
              join public.ai_documents d on d.id = c.document_id and d.status = 'active'
             where c.embedding is null
               and public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at)
             limit 301) s) <= 300
  end;
$$;

select cron.alter_job(
  job_id   := (select jobid from cron.job where command ilike '%ai_ingest_tick%' limit 1),
  schedule := '*/5 * * * *');

do $$
begin
  perform cron.unschedule('purge-cron-history');
exception when others then null;
end $$;

select cron.schedule('purge-cron-history', '23 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
