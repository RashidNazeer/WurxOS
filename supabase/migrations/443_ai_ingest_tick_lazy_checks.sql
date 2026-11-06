-- ============================================================
-- WurxOS v2 — Migration 443: ai_ingest_tick() does the cheap checks first.
--
-- mig 437 fixed ai_bulk_open(), but the tick still evaluated every check
-- (ai_bulk_open, ai_vector_ready x2, ai_space_sources x2, ...) in its DECLARE
-- block, before the quiet-hours return: ~3,200 block reads and 5+ s every
-- 5 minutes, even in quiet hours with nothing to do. Same behaviour, but the
-- expensive checks now run only once the cheap ones say there may be work:
--   quiet hours -> return; no queue work and backfill not allowed -> return
--   (v_urgent required v_allowed already).
-- ============================================================

create or replace function public.ai_ingest_tick()
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'net'
as $function$
declare
  v_url    text;
  v_secret text;
  v_main   text[];
  v_alt    text[];
  v_always boolean;
  v_ready_m boolean;
  v_ready_a boolean;
  v_allowed boolean;
  v_bulk    boolean;
  v_urgent  boolean;
  v_queue   boolean;
begin
  -- Ingestion rests in the evening (mig 407): no worker is woken.
  if public.ai_ingest_quiet_now() then return; end if;

  v_queue := exists (select 1 from public.ai_ingest_queue
                      where (status = 'pending' and not_before <= now())
                         or (status = 'processing' and locked_at < now() - interval '10 minutes'));

  if not v_queue then
    v_allowed := public.ai_vector_backfill_allowed();
    if not v_allowed then return; end if;

    v_main    := public.ai_space_sources('main');
    v_alt     := public.ai_space_sources('alt');
    v_always  := coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), true);
    v_ready_m := public.ai_vector_ready('main');
    v_ready_a := public.ai_vector_ready('alt') and public.ai_alt_budget() > 0;
    if not v_ready_m and not v_ready_a then return; end if;
    v_bulk    := public.ai_bulk_open();

    -- Waiting vectors that may be written now: urgent ones always, bulk ones only when ai_bulk_open().
    v_urgent := exists (
      select 1 from public.ai_chunks c
        join public.ai_documents d on d.id = c.document_id and d.status = 'active'
       where ((c.embedding is null and c.source_type = any(v_main) and v_ready_m)
           or (c.embedding_alt is null and c.source_type = any(v_alt) and (c.vector_pending or v_always) and v_ready_a))
         and (v_bulk or not public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at)));

    if not v_urgent then return; end if;

    -- A big bulk backlog trickles: at most one run per 10 minutes while nothing urgent waits.
    if v_bulk and not exists (
         select 1 from public.ai_chunks c
           join public.ai_documents d on d.id = c.document_id and d.status = 'active'
          where ((c.embedding is null and c.source_type = any(v_main) and v_ready_m)
              or (c.embedding_alt is null and c.source_type = any(v_alt) and (c.vector_pending or v_always) and v_ready_a))
            and not public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at))
       and exists (select 1 from public.ai_ingest_runs where started_at > now() - interval '10 minutes') then
      return;
    end if;
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
$function$;
