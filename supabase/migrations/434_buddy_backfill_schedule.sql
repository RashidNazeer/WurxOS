-- ============================================================
-- WurxOS v2 — Migration 434: urgent-first, weekend-throttled vector backfill.
--
-- A big backlog (thousands of TikTok articles and old reports) embedded at full speed on a
-- weekday hammers the database disk (Supabase Disk IO warning, 2026-11-03). Waiting chunks are
-- now split by urgency:
--
--   urgent  kb_article, ai_doc, app_guide, incentive, any other source, and reports from the
--           last 60 days: embedded at once, every tick.
--   bulk    tts_article and reports older than 60 days: only once the bulk backlog is small
--           (<= 300 chunks), otherwise ONLY on Saturday/Sunday (Asia/Karachi), in small batches
--           (32 per call) and no more often than every 10 minutes.
--
-- Search never waits for this: a chunk without a vector is still found by keyword.
-- Quiet hours (18:00-02:00) still apply on top. Idempotent.
-- ============================================================

create or replace function public.ai_chunk_is_bulk(p_source text, p_period_end date, p_source_updated timestamptz)
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $$
  select p_source = 'tts_article'
      or (p_source = 'report'
          and coalesce(p_period_end::timestamp, p_source_updated at time zone 'Asia/Karachi', '-infinity'::timestamp)
              < (now() at time zone 'Asia/Karachi') - interval '60 days');
$$;

-- True when bulk (non-urgent) vectors may be written right now.
create or replace function public.ai_bulk_open()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select (select count(*) from public.ai_chunks c
            join public.ai_documents d on d.id = c.document_id and d.status = 'active'
           where c.embedding is null
             and public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at)) <= 300
      or extract(isodow from now() at time zone 'Asia/Karachi') in (6, 7);
$$;

create or replace function public.ai_vector_pending(p_space text, p_limit integer DEFAULT 64)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with cfg as (
    select coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), true) as always_,
           public.ai_space_sources('main') as main_,
           public.ai_space_sources('alt') as alt_,
           public.ai_vector_backfill_allowed() as allowed_,
           public.ai_alt_budget() as alt_budget_,
           public.ai_bulk_open() as bulk_
  ),
  pick as (
    select c.id, c.content_hash, c.embed_text, c.source_type, c.vector_pending, c.updated_at,
           public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at) as is_bulk
      from public.ai_chunks c
      join public.ai_documents d on d.id = c.document_id and d.status = 'active'
      cross join cfg
     where cfg.allowed_
       and case p_space
             when 'main' then c.embedding is null and c.source_type = any(cfg.main_)
             when 'alt' then c.embedding_alt is null and c.source_type = any(cfg.alt_)
                             and (c.vector_pending or cfg.always_)
             else false end
       and (cfg.bulk_ or not public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at))
  ),
  ranked as (
    select p.*, row_number() over (order by p.is_bulk, p.vector_pending desc,
                                   case when p.source_type in ('kb_article', 'ai_doc', 'app_guide') then 0
                                        when p.source_type = 'report' then 1 else 2 end, p.updated_at, p.id) as rn
      from pick p
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'content_hash', x.content_hash, 'embed_text', x.embed_text,
                                               'source_type', x.source_type) order by x.rn), '[]'::jsonb)
    from ranked x
   where x.rn <= case when p_space = 'alt' then greatest(0, least(coalesce(p_limit, 64), 500, (select alt_budget_ from cfg)))
                      else greatest(1, least(coalesce(p_limit, 64), 500)) end
     and x.rn <= case when x.is_bulk then 32 else 500 end + (select count(*) from ranked r where not r.is_bulk);
$function$;

create or replace function public.ai_ingest_tick()
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'net'
as $function$
declare
  v_url    text;
  v_secret text;
  v_main   text[] := public.ai_space_sources('main');
  v_alt    text[] := public.ai_space_sources('alt');
  v_always boolean := coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), true);
  v_ready_m boolean := public.ai_vector_ready('main');
  v_ready_a boolean := public.ai_vector_ready('alt') and public.ai_alt_budget() > 0;
  v_allowed boolean := public.ai_vector_backfill_allowed();
  v_bulk    boolean := public.ai_bulk_open();
  v_urgent  boolean;
  v_queue   boolean;
begin
  -- Ingestion rests in the evening (mig 407): no worker is woken.
  if public.ai_ingest_quiet_now() then return; end if;

  v_queue := exists (select 1 from public.ai_ingest_queue
                      where (status = 'pending' and not_before <= now())
                         or (status = 'processing' and locked_at < now() - interval '10 minutes'));

  -- Waiting vectors that may be written now: urgent ones always, bulk ones only when ai_bulk_open().
  v_urgent := v_allowed and exists (
    select 1 from public.ai_chunks c
      join public.ai_documents d on d.id = c.document_id and d.status = 'active'
     where ((c.embedding is null and c.source_type = any(v_main) and v_ready_m)
         or (c.embedding_alt is null and c.source_type = any(v_alt) and (c.vector_pending or v_always) and v_ready_a))
       and (v_bulk or not public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at)));

  if not v_queue and not v_urgent then return; end if;

  -- A big bulk backlog trickles: at most one run per 10 minutes while nothing urgent waits.
  if not v_queue and v_bulk and not exists (
       select 1 from public.ai_chunks c
         join public.ai_documents d on d.id = c.document_id and d.status = 'active'
        where ((c.embedding is null and c.source_type = any(v_main) and v_ready_m)
            or (c.embedding_alt is null and c.source_type = any(v_alt) and (c.vector_pending or v_always) and v_ready_a))
          and not public.ai_chunk_is_bulk(c.source_type, d.period_end, d.source_updated_at))
     and exists (select 1 from public.ai_ingest_runs where started_at > now() - interval '10 minutes') then
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
$function$;

do $verify$
begin
  if not public.ai_chunk_is_bulk('tts_article', null, now()) then raise exception 'mig 434: tts_article must be bulk'; end if;
  if public.ai_chunk_is_bulk('kb_article', null, now() - interval '5 years') then raise exception 'mig 434: kb_article must be urgent'; end if;
  if public.ai_chunk_is_bulk('report', null, now() - interval '5 days') then raise exception 'mig 434: a recent report must be urgent'; end if;
  if not public.ai_chunk_is_bulk('report', null, now() - interval '90 days') then raise exception 'mig 434: an old report must be bulk'; end if;
end;
$verify$;
