-- ============================================================
-- 408 — Assistant v2: "waiting for vectors" means NO vector at all, and the
-- alt space can run on another provider (Owner, 2026-10-02).
--
-- 407 is left for Engineer 1's quiet-hours migration (in flight).
--
-- Why: on dev vector_pending was 31 while all 31 already had an NVIDIA vector
-- and were searchable by meaning. The flag meant "no main-key vector", which
-- reads as broken. Now:
--   ai_chunks.vector_pending   TRUE only when neither `embedding` nor
--                              `embedding_alt` has a vector: the chunk is
--                              findable by keywords only. A chunk covered by a
--                              fallback provider is DONE.
--   ai_ingest_stats            vector_pending = that count;
--                              vectors.main_missing = has alt, lacks the main key;
--                              vectors.by_space {main, alt, none}.
--   ai_assistant_config
--     embed_alt_provider       'nvidia' (default) | 'gemini'. ONE model per
--                              column still holds: switching is refused while
--                              the alt space holds another model's vectors.
--                              ai_vector_reset_alt() clears it so it can be rebuilt.
--   ai_embed_model_alt()       the label of the configured provider's model,
--                              recorded per chunk in embed_model_alt.
--   ai_vector_pending('alt')   drains the `none` bucket (and everything when
--                              embed_alt_always); 'primary' drains main_missing.
--                              Both return nothing during quiet hours.
--   ai_vector_backfill_allowed() false during quiet hours (Engineer 1's
--                              function, found by name; absent → allowed).
-- Idempotent.
-- ============================================================

-- ── the alt provider ─────────────────────────────────────────────────────
alter table public.ai_assistant_config add column if not exists embed_alt_provider text not null default 'nvidia';
alter table public.ai_assistant_config drop constraint if exists ai_assistant_config_embed_alt_provider_check;
alter table public.ai_assistant_config add constraint ai_assistant_config_embed_alt_provider_check
  check (embed_alt_provider in ('nvidia', 'gemini'));

create or replace function public.ai_alt_model_for(p_provider text) returns text
language sql immutable set search_path = public as $$
  select case p_provider
           when 'gemini' then 'gemini:gemini-embedding-001'
           else 'nvidia:llama-nemotron-embed-vl-1b-v2'
         end;
$$;
revoke execute on function public.ai_alt_model_for(text) from public, anon;
grant  execute on function public.ai_alt_model_for(text) to authenticated, service_role;

create or replace function public.ai_embed_model_alt() returns text
language sql stable set search_path = public as $$
  select public.ai_alt_model_for(coalesce((select c.embed_alt_provider from public.ai_assistant_config c where c.id = 1), 'nvidia'));
$$;
revoke execute on function public.ai_embed_model_alt() from public, anon;
grant  execute on function public.ai_embed_model_alt() to authenticated, service_role;

-- One model per column: refuse a switch while the alt space holds vectors from
-- another model. ai_vector_reset_alt() empties it first.
create or replace function public.ai_trg_config_alt_provider() returns trigger
language plpgsql set search_path = public as $$
declare v_n int; v_new text;
begin
  if tg_op = 'UPDATE' and new.embed_alt_provider is not distinct from old.embed_alt_provider then return new; end if;
  v_new := public.ai_alt_model_for(new.embed_alt_provider);
  select count(*) into v_n from public.ai_chunks c
   where c.embedding_alt is not null and c.embed_model_alt is distinct from v_new;
  if v_n > 0 then
    raise exception 'the alt vector space holds % chunk(s) from another model: run select public.ai_vector_reset_alt() first (it clears embedding_alt so it can be rebuilt)', v_n;
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_alt_provider() from public, anon, authenticated;
drop trigger if exists ai_assistant_config_alt_provider on public.ai_assistant_config;
create trigger ai_assistant_config_alt_provider
  before insert or update of embed_alt_provider on public.ai_assistant_config
  for each row execute function public.ai_trg_config_alt_provider();

create or replace function public.ai_vector_reset_alt() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.ai_chunks set embedding_alt = null, embed_model_alt = null, updated_at = now()
   where embedding_alt is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.ai_vector_reset_alt() from public, anon, authenticated;
grant  execute on function public.ai_vector_reset_alt() to service_role;

-- ── "waiting" = no vector in either space ────────────────────────────────
create or replace function public.ai_chunks_vector_pending() returns trigger
language plpgsql set search_path = public as $$
begin
  new.vector_pending := new.embedding is null and new.embedding_alt is null;
  if new.embedding_alt is null then new.embed_model_alt := null; end if;
  return new;
end $$;
revoke execute on function public.ai_chunks_vector_pending() from public, anon, authenticated;

update public.ai_chunks
   set vector_pending = (embedding is null and embedding_alt is null)
 where vector_pending is distinct from (embedding is null and embedding_alt is null);

-- Keeps ai_vector_pending('primary') cheap once the main key is behind.
create index if not exists ai_chunks_main_missing_idx on public.ai_chunks (source_type) where embedding is null;

-- ── quiet hours (Engineer 1's, by name; absent → allowed) ────────────────
create or replace function public.ai_vector_backfill_allowed() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_fn text; v_quiet boolean;
begin
  select p.oid::regprocedure::text into v_fn
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname like 'ai\_%quiet%' and p.pronargs = 0 and p.prorettype = 'boolean'::regtype
   order by p.proname limit 1;
  if v_fn is null then return true; end if;
  execute 'select ' || v_fn into v_quiet;
  return not coalesce(v_quiet, false);
exception when others then return true;   -- never let this block the backfill
end;
$$;
revoke execute on function public.ai_vector_backfill_allowed() from public, anon, authenticated;
grant  execute on function public.ai_vector_backfill_allowed() to service_role;

-- ── what to embed next ───────────────────────────────────────────────────
-- 'primary': chunks with no main-key vector (main_missing), so the main key
--            catches up. 'alt': the `none` bucket first, so "waiting" reaches
--            zero even while OpenAI is down; everything when embed_alt_always.
create or replace function public.ai_vector_pending(p_space text, p_limit int default 64)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  with cfg as (
    select coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), false) as always_,
           coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1), '{}') as free_,
           public.ai_vector_backfill_allowed() as allowed_
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'content_hash', x.content_hash, 'embed_text', x.embed_text,
                                               'source_type', x.source_type)), '[]'::jsonb)
    from (select c.id, c.content_hash, c.embed_text, c.source_type
            from public.ai_chunks c
            join public.ai_documents d on d.id = c.document_id and d.status = 'active'
            cross join cfg
           where cfg.allowed_
             and case p_space
                   when 'primary' then c.embedding is null
                   when 'alt' then c.embedding_alt is null and c.source_type = any(cfg.free_)
                                   and (c.vector_pending or cfg.always_)
                   else false end
           order by c.vector_pending desc,                       -- the `none` bucket first
                    case when c.source_type in ('kb_article', 'ai_doc', 'app_guide') then 0
                         when c.source_type = 'report' then 1 else 2 end, c.updated_at, c.id
           limit greatest(1, least(coalesce(p_limit, 64), 500))) x;
$$;
revoke execute on function public.ai_vector_pending(text, int) from public, anon, authenticated;
grant  execute on function public.ai_vector_pending(text, int) to service_role;

-- ── ingest stats: the new counting. Otherwise as mig 406. ───────────────
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

-- ── the tick: wake for chunks with no vector, or a main key behind ───────
create or replace function public.ai_ingest_tick()
returns void
language plpgsql security definer
set search_path = public, net
as $$
declare
  v_url    text;
  v_secret text;
begin
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
$$;
revoke execute on function public.ai_ingest_tick() from public, anon, authenticated;
