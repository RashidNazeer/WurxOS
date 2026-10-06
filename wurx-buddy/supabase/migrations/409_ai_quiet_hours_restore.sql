-- ============================================================
-- 409 — Wurx Buddy: put back the two quiet-hours pieces that 408 overwrote.
--
-- 407 (ingestion rests 18:00–02:00 Asia/Karachi) and 408 (vector counting)
-- were written at the same time and both redefine ai_ingest_tick and
-- ai_ingest_stats; 408 was applied second, from the pre-407 bodies, so the
-- minute drain lost its guard and the stats lost their quiet_hours block.
-- Both functions here are 408's current bodies plus those two pieces.
-- The backfill needs nothing: 408's ai_vector_backfill_allowed() finds
-- ai_ingest_quiet_now() by name and already stops while quiet.
-- Idempotent.
-- ============================================================

-- ── the minute drain: nothing is woken while quiet ───────────────────────
create or replace function public.ai_ingest_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
declare
  v_url    text;
  v_secret text;
begin
  -- Ingestion rests in the evening (mig 407): no worker is woken.
  if public.ai_ingest_quiet_now() then return; end if;
  if not exists (select 1 from public.ai_ingest_queue
                  where (status = 'pending' and not_before <= now())
                     or (status = 'processing' and locked_at < now() - interval '10 minutes'))
     and not (public.ai_vector_backfill_allowed()
              and exists (select 1 from public.ai_chunks c
                           where (c.vector_pending and public.ai_vector_ready('alt'))
                              or (c.embedding is null and public.ai_vector_ready('primary')))) then
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
revoke execute on function public.ai_ingest_tick() from public, anon, authenticated;
grant  execute on function public.ai_ingest_tick() to service_role;

-- ── the settings screen: when ingestion rests ────────────────────────────
create or replace function public.ai_ingest_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_last timestamptz;
begin
  if not (public.ai_is_service_or_admin() or public.ai_can_view_settings(auth.uid())) then raise exception 'not allowed'; end if;
  v_last := public.ai_last_sweep_at();
  return jsonb_build_object(
    -- When ingestion rests (mig 407), for the settings screen.
    'quiet_hours', jsonb_build_object(
      'enabled', (select c.ingest_quiet_enabled from public.ai_assistant_config c where c.id = 1),
      'start', to_char((select c.ingest_quiet_start from public.ai_assistant_config c where c.id = 1), 'HH24:MI'),
      'end', to_char((select c.ingest_quiet_end from public.ai_assistant_config c where c.id = 1), 'HH24:MI'),
      'tz', 'Asia/Karachi',
      'active_now', public.ai_ingest_quiet_now(),
      'next_allowed_at', public.ai_ingest_next_allowed_at()),
    'pipeline_version', public.ai_pipeline_version(),
    'embed_model', public.ai_embed_model(),
    'embed_model_alt', public.ai_embed_model_alt(),
    'ingest_sources', to_jsonb(public.ai_source_types()),
    'ignored_sources', to_jsonb(public.ai_ignored_sources()),
    'last_sweep_at', v_last,
    'next_sweep_due_at', coalesce(v_last + interval '12 hours', now()),
    'queue', coalesce((select jsonb_object_agg(status, n) from (
                select status, count(*) as n from public.ai_ingest_queue group by status) x), '{}'::jsonb),
    'pending_by_priority', coalesce((select jsonb_object_agg(priority::text, n) from (
                select priority, count(*) as n from public.ai_ingest_queue where status = 'pending' group by priority) x), '{}'::jsonb),
    'oldest_pending_seconds', (select extract(epoch from now() - min(enqueued_at))::int
                                 from public.ai_ingest_queue where status = 'pending'),
    'stuck_processing', (select count(*) from public.ai_ingest_queue
                          where status = 'processing' and locked_at < now() - interval '10 minutes'),
    'failed', coalesce((select jsonb_agg(to_jsonb(f)) from (
                select id, source_type, source_id, op, attempts, last_error, enqueued_at
                  from public.ai_ingest_queue where status = 'failed' order by enqueued_at desc limit 50) f), '[]'::jsonb),
    'documents', coalesce((select jsonb_object_agg(source_type, jsonb_build_object(
                    'active', active, 'soft_deleted', deleted, 'chunks', chunks, 'other_pipeline', other)) from (
                select d.source_type, count(*) filter (where d.status = 'active') as active,
                       count(*) filter (where d.status = 'deleted') as deleted,
                       sum(d.chunk_count) filter (where d.status = 'active') as chunks,
                       count(*) filter (where d.pipeline_version is distinct from public.ai_pipeline_version()
                                           or d.embed_model is distinct from public.ai_embed_model()) as other
                  from public.ai_documents d group by d.source_type) x), '{}'::jsonb),
    -- Chunks with NO vector in either space: keyword-only until one provider
    -- embeds them. A chunk covered by the fallback provider is not waiting.
    'vector_pending', (select count(*) from public.ai_chunks c where c.vector_pending),
    'vectors', (select jsonb_build_object(
       'alt_provider', coalesce((select x.embed_alt_provider from public.ai_assistant_config x where x.id = 1), 'nvidia'),
       'alt_model', public.ai_embed_model_alt(),
       'alt_always', coalesce((select x.embed_alt_always from public.ai_assistant_config x where x.id = 1), false),
       'backfill_allowed', public.ai_vector_backfill_allowed(),
       -- every chunk of an active document, by the space that can find it
       'by_space', jsonb_build_object(
          'main', count(*) filter (where c.embedding is not null),
          'alt',  count(*) filter (where c.embedding_alt is not null),
          'none', count(*) filter (where c.embedding is null and c.embedding_alt is null)),
       'main_missing', count(*) filter (where c.embedding is null and c.embedding_alt is not null),
       'alt_filled', count(*) filter (where c.embedding_alt is not null),
       'alt_models', coalesce(jsonb_agg(distinct c.embed_model_alt) filter (where c.embed_model_alt is not null), '[]'::jsonb),
       'pending_by_type', coalesce((select jsonb_object_agg(source_type, n) from (
                select k.source_type, count(*) as n from public.ai_chunks k where k.vector_pending group by 1) y), '{}'::jsonb),
       'state', coalesce((select jsonb_object_agg(s.space, jsonb_build_object('next_try_at', s.next_try_at, 'last_error', s.last_error))
                            from public.ai_vector_state s), '{}'::jsonb))
       from public.ai_chunks c join public.ai_documents d2 on d2.id = c.document_id and d2.status = 'active'),
    'freshness_p95_seconds_24h', (select percentile_cont(0.95) within group (order by extract(epoch from done_at - enqueued_at))
                                    from public.ai_ingest_queue
                                   where status = 'done' and done_at > now() - interval '24 hours'),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
                select id, kind, started_at, finished_at, claimed, succeeded, failed, skipped_unchanged,
                       embedded_chunks, embed_tokens, error, stats->>'trigger' as trigger
                  from public.ai_ingest_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$function$;
revoke execute on function public.ai_ingest_stats() from public, anon;
grant  execute on function public.ai_ingest_stats() to authenticated, service_role;
