-- ============================================================
-- Store health (replaces hold_state.sql, obsolete since the first ingestion
-- on 2026-09-29). Read-only; the runner rolls back.
--   node scripts/db-dev.mjs sql tests/sql/store_health.sql
-- FAIL = something is broken now. WARN = expected right after a deploy /
-- before the first sweep, but must clear within a sweep or two.
-- State-aware: the 375 / 380 / 381 checks run only when those are applied.
-- ============================================================
create temp table hres (n serial, test text, result text, detail text) on commit drop;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into hres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
create function pg_temp.warn(t text, cond boolean, d text default null) returns void language sql as $$
  insert into hres (test, result, detail) values (t, case when cond then 'ok' else 'WARN' end, d);
$$;

do $$
declare n bigint; m bigint; s text; j jsonb;
begin
  -- ── store
  select count(*) into n from ai_documents where status = 'active';
  perform pg_temp.ok('store: active documents > 1,500 (1,927 after the first ingestion)', n > 1500, n::text);
  select count(*) into n from ai_chunks;
  perform pg_temp.ok('store: chunks > 10,000 (11,556 after the first ingestion)', n > 10000, n::text);
  select count(*) into n from ai_chunks where embedding is null;
  perform pg_temp.ok('store: 0 chunks without a vector', n = 0, n::text);
  select count(*) into n from ai_chunks c where c.embedding_model is distinct from ai_embed_model();
  perform pg_temp.ok('store: every chunk embedded with the current model', n = 0, n::text);
  select count(*) into n from ai_chunks c where not exists (select 1 from ai_documents d where d.id = c.document_id);
  perform pg_temp.ok('store: 0 orphan chunks', n = 0, n::text);
  select count(*) into n from ai_documents d
   where d.status = 'active' and d.chunk_count is distinct from (select count(*) from ai_chunks c where c.document_id = d.id);
  perform pg_temp.ok('store: chunk_count = real chunk rows for every active document', n = 0, n::text);
  select count(*) into n from ai_documents d where d.status = 'active' and d.chunk_count = 0;
  perform pg_temp.ok('store: no active document without chunks', n = 0, n::text);
  select count(*) into n from ai_documents
   where status = 'active' and (pipeline_version is distinct from ai_pipeline_version() or embed_model is distinct from ai_embed_model());
  perform pg_temp.ok('store: 0 active documents on another pipeline / model', n = 0, n::text);
  select string_agg(source_type, ',') into s from (select distinct source_type from ai_documents) x
   where not (source_type = any(array['kb_article','ai_doc','app_guide','tts_article','report','incentive']));
  perform pg_temp.ok('store: no document of an unknown source type', s is null, s);
  select count(*) into n from ai_documents d where d.status = 'active' and d.source_type = 'report'
     and not exists (select 1 from reports r where r.id::text = d.source_id and r.status = 'approved');
  perform pg_temp.warn('store: every active report document is an approved report (else the next sweep fixes it)', n = 0, n::text);

  -- ── queue and runs
  select count(*) into n from ai_ingest_queue where status = 'failed';
  perform pg_temp.ok('queue: 0 failed items', n = 0, n::text);
  select count(*) into n from ai_ingest_queue where status = 'processing' and locked_at < now() - interval '10 minutes';
  perform pg_temp.ok('queue: 0 stuck processing (> 10 min)', n = 0, n::text);
  select count(*) into n from ai_ingest_queue where status = 'pending' and enqueued_at < now() - interval '30 minutes';
  perform pg_temp.ok('queue: 0 pending older than 30 min (else the tick / function is not running)', n = 0, n::text);
  select count(*) into n from ai_ingest_queue where status = 'pending' and attempts > 0;
  perform pg_temp.warn('queue: 0 items in retry', n = 0, n::text);
  select string_agg(id || ':' || kind || ':' || left(error, 80), ' | ') into s from ai_ingest_runs
   where error is not null and started_at > now() - interval '24 hours';
  perform pg_temp.ok('runs: no run with an error in the last 24 h', s is null, s);
  select count(*) into n from ai_ingest_runs where kind <> 'sweep' and finished_at is null and started_at < now() - interval '15 minutes';
  perform pg_temp.warn('runs: no worker run left unfinished (> 15 min)', n = 0, n::text);

  -- ── 379: sweep clock and source names
  if to_regprocedure('public.ai_last_sweep_at()') is not null then
    perform pg_temp.ok('379: ai_ignored_sources() is empty (no typo in ingest_sources)', ai_ignored_sources() = '{}', ai_ignored_sources()::text);
    perform pg_temp.warn('379: a successful sweep started in the last 13 h', ai_last_sweep_at() > now() - interval '13 hours', coalesce(ai_last_sweep_at()::text, 'never'));
  end if;

  -- ── 380: exclusions and crawl
  if to_regclass('public.ai_excluded_documents') is not null then
    select string_agg(d.source_type || ':' || d.source_id, ', ') into s
      from ai_documents d join ai_excluded_documents e using (source_type, source_id) where d.status = 'active';
    perform pg_temp.warn('380: no excluded document still active in the store (the first sweep soft-deletes the testing doc)', s is null, s);
    select status || ' crawl ' || crawl_no || coalesce(' err ' || left(last_error, 80), '') || coalesce(' retire_skipped=' || (stats->>'retire_skipped'), '') into s
      from ai_crawl_state where id = 1;
    perform pg_temp.ok('380: crawl state row exists', s is not null, s);
    perform pg_temp.warn('380: the last crawl (if any) retired nothing by mistake: retire_skipped null, failed pages <= 5 %',
      (select (stats->>'retire_skipped') is null and coalesce((stats->>'failed')::int, 0) <= 0.05 * greatest(coalesce((stats->>'pages')::int, 0), 1)
         from ai_crawl_state where id = 1), s);
    perform pg_temp.warn('380: no crawl stuck (running and started > 3 h ago)',
      not exists (select 1 from ai_crawl_state where status <> 'idle' and started_at < now() - interval '3 hours'), s);
  end if;
  select count(*), count(*) filter (where is_active) into n, m from tts_articles;
  perform pg_temp.ok('tts: > 1,000 articles, > 95 % active', n > 1000 and m > 0.95 * n, m || ' active of ' || n);

  -- ── 375 / 381: jobs and wiring
  if to_regprocedure('public.ai_ingest_tick()') is not null then
    select string_agg(jobname, ',' order by jobname) into s from cron.job where jobname like 'ai-%' and active;
    perform pg_temp.ok('375: ai-ingest-tick, ai-ingest-sweep, ai-housekeeping scheduled and active',
      s ~ 'ai-housekeeping' and s ~ 'ai-ingest-sweep' and s ~ 'ai-ingest-tick', s);
    perform pg_temp.warn('375: app_config ai_ingest_url and ai_ingest_secret set (else the tick does nothing)',
      (select count(*) from app_config where key in ('ai_ingest_url','ai_ingest_secret') and coalesce(value, '') <> '') = 2);
    select string_agg(d.status || ' ' || coalesce(left(d.return_message, 60), ''), ' | ') into s
      from (select * from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'ai-%')
             and start_time > now() - interval '1 hour' and status <> 'succeeded' order by start_time desc limit 5) d;
    -- An isolated 'job startup timeout' happens while a migration holds a lock (seen 2026-09-30 during 382): WARN; a pattern: FAIL.
    perform pg_temp.warn('375/381: no failed ai-* cron run in the last hour', s is null, s);
    perform pg_temp.ok('375/381: at most 2 failed ai-* cron runs in the last hour',
      (select count(*) from cron.job_run_details where jobid in (select jobid from cron.job where jobname like 'ai-%')
          and start_time > now() - interval '1 hour' and status <> 'succeeded' and status <> 'running') <= 2);
  end if;
  if to_regprocedure('public.ai_crawl_tick()') is not null and exists (select 1 from app_config where key = 'ai_crawl_url') then
    perform pg_temp.warn('381: app_config ai_crawl_url set', (select coalesce(value, '') <> '' from app_config where key = 'ai_crawl_url'));
  end if;
  if exists (select 1 from pg_namespace where nspname = 'net') then
    select string_agg(coalesce(status_code::text, 'no status') || ' ' || coalesce(left(error_msg, 60), left(content, 60), ''), ' | ') into s
      from (select * from net._http_response where created > now() - interval '1 hour'
               and (status_code is null or status_code >= 400) order by id desc limit 5) r;
    perform pg_temp.warn('pg_net: no failed HTTP response in the last hour (401 = secret mismatch, 500 = function secrets missing)', s is null, s);
  end if;
end $$;

select n, result, test, detail from hres order by n;
select case when count(*) filter (where result = 'FAIL') > 0 then 'STORE: UNHEALTHY'
            when count(*) filter (where result = 'WARN') > 0 then 'STORE: HEALTHY WITH WARNINGS' else 'STORE: HEALTHY' end as verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'WARN') warn, count(*) filter (where result = 'FAIL') failed from hres;
