-- ============================================================
-- 406 — Assistant v2: ingestion keeps working when OpenAI has no credits
-- (Owner, 2026-10-01). Was the parked wip-402; the alt space is NVIDIA now.
--
--   ai_chunks.vector_pending   true while the chunk has no OpenAI vector
--                              (`embedding` NULL). Kept by a trigger. The
--                              keyword arm finds such chunks at once; the
--                              semantic arms skip them; the worker backfills them.
--   ai_chunks.embedding_alt    a SECOND vector space (NVIDIA llama-nemotron-embed-vl-1b-v2,
--              embed_model_alt  1536 dims), never mixed with
--                              `embedding`. Partial HNSW per corpus as mig 382.
--   ai_assistant_config
--     embed_alt_always         fill the alt space even when OpenAI works (default off)
--     free_provider_sources    source types that MAY be sent to a free provider
--                              (NVIDIA). Default: all but 'incentive'. Anything else
--                              stays keyword-only / pending until OpenAI works.
--   ai_vector_state            per space: when the worker may try again after an
--                              account problem (no credits, key refused, a long limit).
--   ai_ingest_write            + chunk fields embedding_alt / embed_model_alt; a
--                              chunk with no vector is written as pending instead of
--                              refused (and a stored vector with the same hash is reused).
--   ai_vector_pending / ai_vector_fill / ai_vector_defer   the backfill (service only).
--   ai_search                  + p_query_embedding_alt (default NULL): an extra
--                              semantic arm on embedding_alt, RRF-fused. Old calls
--                              are unchanged (the 9-argument form is replaced by
--                              the 10-argument one with a default).
--   ai_ingest_stats            + vector_pending, vectors{…}. Otherwise as mig 401.
--   ai_ingest_tick             also wakes the worker for pending vectors whose space
--                              is not deferred. Otherwise as mig 375.
-- Idempotent.
-- ============================================================

set local maintenance_work_mem = '64MB';
set local max_parallel_maintenance_workers = 0;

-- ── columns ─────────────────────────────────────────────────────────────
alter table public.ai_chunks add column if not exists embedding_alt   extensions.vector(1536);
alter table public.ai_chunks add column if not exists embed_model_alt text;
alter table public.ai_chunks add column if not exists vector_pending  boolean not null default false;

create or replace function public.ai_chunks_vector_pending() returns trigger
language plpgsql set search_path = public as $$
begin
  new.vector_pending := new.embedding is null;
  if new.embedding_alt is null then new.embed_model_alt := null; end if;
  return new;
end $$;
revoke execute on function public.ai_chunks_vector_pending() from public, anon, authenticated;

drop trigger if exists ai_chunks_vector_pending on public.ai_chunks;
create trigger ai_chunks_vector_pending before insert or update of embedding, embedding_alt on public.ai_chunks
  for each row execute function public.ai_chunks_vector_pending();

update public.ai_chunks set vector_pending = (embedding is null) where vector_pending is distinct from (embedding is null);

create index if not exists ai_chunks_vector_pending_idx on public.ai_chunks (source_type) where vector_pending;

-- ── the alt space: one index per corpus, as mig 382 ──────────────────────
create index if not exists ai_chunks_alt_hnsw_company on public.ai_chunks
  using hnsw ((embedding_alt::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type in ('kb_article', 'ai_doc', 'app_guide');
create index if not exists ai_chunks_alt_hnsw_reports on public.ai_chunks
  using hnsw ((embedding_alt::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type = 'report';
create index if not exists ai_chunks_alt_hnsw_tiktok on public.ai_chunks
  using hnsw ((embedding_alt::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type = 'tts_article';
create index if not exists ai_chunks_alt_hnsw_incentives on public.ai_chunks
  using hnsw ((embedding_alt::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type = 'incentive';
create index if not exists ai_chunks_alt_hnsw_other on public.ai_chunks
  using hnsw ((embedding_alt::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type not in ('kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive');

-- ── settings ─────────────────────────────────────────────────────────────
alter table public.ai_assistant_config add column if not exists embed_alt_always boolean not null default false;
alter table public.ai_assistant_config add column if not exists free_provider_sources text[] not null
  default array['kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article'];

create or replace function public.ai_embed_model_alt() returns text
language sql immutable set search_path = public as $$ select 'nvidia:llama-nemotron-embed-vl-1b-v2'::text $$;
revoke execute on function public.ai_embed_model_alt() from public, anon;
grant  execute on function public.ai_embed_model_alt() to authenticated, service_role;

-- What the worker needs to route texts (service only: the free-provider list is
-- a privacy rule, not something a client should read or rely on).
create or replace function public.ai_embed_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'model', public.ai_embed_model(),
    'alt_model', public.ai_embed_model_alt(),
    'alt_always', coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), false),
    'free_sources', to_jsonb(coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1),
                                      array['kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article'])));
$$;
revoke execute on function public.ai_embed_settings() from public, anon, authenticated;
grant  execute on function public.ai_embed_settings() to service_role;

-- ── per-space retry state ────────────────────────────────────────────────
create table if not exists public.ai_vector_state (
  space       text primary key check (space in ('primary', 'alt')),
  next_try_at timestamptz,
  last_error  text,
  updated_at  timestamptz not null default now()
);
alter table public.ai_vector_state enable row level security;
revoke all on public.ai_vector_state from anon, authenticated;

create or replace function public.ai_vector_defer(p_space text, p_seconds int, p_error text) returns void
language sql security definer set search_path = public as $$
  insert into public.ai_vector_state (space, next_try_at, last_error, updated_at)
  values (p_space, now() + make_interval(secs => greatest(coalesce(p_seconds, 1800), 60)), left(p_error, 500), now())
  on conflict (space) do update set next_try_at = excluded.next_try_at, last_error = excluded.last_error, updated_at = now();
$$;
revoke execute on function public.ai_vector_defer(text, int, text) from public, anon, authenticated;
grant  execute on function public.ai_vector_defer(text, int, text) to service_role;

-- A space may be tried when it was never deferred or its wait is over.
create or replace function public.ai_vector_ready(p_space text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.next_try_at <= now() from public.ai_vector_state s where s.space = p_space), true);
$$;
revoke execute on function public.ai_vector_ready(text) from public, anon, authenticated;
grant  execute on function public.ai_vector_ready(text) to service_role;

-- ── the write: pending chunks allowed, alt vectors carried. Otherwise as 377.
create or replace function public.ai_ingest_write(p_doc jsonb, p_chunks jsonb,
                                                  p_queue_id bigint default null, p_worker text default null)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_id      uuid;
  v_chunks  jsonb := coalesce(p_chunks, '[]'::jsonb);
  v_n       int   := jsonb_array_length(coalesce(p_chunks, '[]'::jsonb));
  v_model   text  := p_doc->>'embed_model';
  v_alt     text  := public.ai_embed_model_alt();
  v_changed int;
  v_deleted int;
  v_pending int;
begin
  if p_queue_id is not null and not public.ai_ingest_holds(p_queue_id, p_worker) then
    return jsonb_build_object('ok', false, 'reason', 'lost_lock');
  end if;
  if coalesce(p_doc->>'source_type', '') = '' or coalesce(p_doc->>'source_id', '') = ''
     or coalesce(p_doc->>'doc_hash', '') = '' or coalesce(v_model, '') = '' then
    raise exception 'ai_ingest_write: source_type, source_id, doc_hash and embed_model are required';
  end if;
  if not (p_doc->>'source_type' = any(public.ai_source_types())) then
    raise exception 'ai_ingest_write: source type % is not enabled for indexing', p_doc->>'source_type';
  end if;
  if lower(p_doc->>'source_type') ~ '(salar|compensation|payroll|attendance|leave|performance|basic_salary)' then
    raise exception 'ai_ingest_write: source type % is never indexed', p_doc->>'source_type';
  end if;
  -- The privacy rule is enforced here too, not only in the worker: no alt
  -- (free-provider) vector for a type that may not be sent there.
  if not (p_doc->>'source_type' = any(coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1), '{}')))
     and exists (select 1 from jsonb_array_elements(v_chunks) c where jsonb_typeof(c->'embedding_alt') = 'array') then
    raise exception 'ai_ingest_write: source type % may not have free-provider vectors', p_doc->>'source_type';
  end if;

  insert into public.ai_documents as d (
    source_type, source_id, title, url, brand_id, period_start, period_end,
    acl_mode, acl_roles, acl_users, author_id, metadata, doc_hash, chunk_count, status,
    source_updated_at, indexed_at, pipeline_version, embed_model, source_fp)
  values (
    p_doc->>'source_type', p_doc->>'source_id', coalesce(nullif(p_doc->>'title', ''), 'Untitled'), p_doc->>'url',
    (p_doc->>'brand_id')::uuid, (p_doc->>'period_start')::date, (p_doc->>'period_end')::date,
    p_doc->>'acl_mode',
    array(select jsonb_array_elements_text(coalesce(p_doc->'acl_roles', '[]'::jsonb))),
    array(select jsonb_array_elements_text(coalesce(p_doc->'acl_users', '[]'::jsonb))::uuid),
    (p_doc->>'author_id')::uuid, coalesce(p_doc->'metadata', '{}'::jsonb), p_doc->>'doc_hash', v_n, 'active',
    (p_doc->>'source_updated_at')::timestamptz, now(), p_doc->>'pipeline_version', v_model, p_doc->>'source_fp')
  on conflict (source_type, source_id) do update set
    title = excluded.title, url = excluded.url, brand_id = excluded.brand_id,
    period_start = excluded.period_start, period_end = excluded.period_end,
    acl_mode = excluded.acl_mode, acl_roles = excluded.acl_roles, acl_users = excluded.acl_users,
    author_id = excluded.author_id, metadata = excluded.metadata, doc_hash = excluded.doc_hash,
    chunk_count = excluded.chunk_count, status = 'active', source_updated_at = excluded.source_updated_at,
    indexed_at = now(), pipeline_version = excluded.pipeline_version, embed_model = excluded.embed_model,
    source_fp = excluded.source_fp
  returning d.id into v_id;

  -- One statement: `old` sees the vectors as they were before any row moves.
  -- A chunk with neither a new nor a reusable vector is written pending.
  with incoming as (
    select (c->>'chunk_index')::int as ci, c->>'section' as sec, c->>'content' as content, c->>'embed_text' as et,
           (c->>'token_count')::int as tc, c->>'content_hash' as h,
           case when jsonb_typeof(c->'embedding') = 'array' then (c->'embedding')::text::extensions.vector end as emb,
           case when jsonb_typeof(c->'embedding_alt') = 'array' then (c->'embedding_alt')::text::extensions.vector end as alt
      from jsonb_array_elements(v_chunks) c
  ), old as (
    select distinct on (content_hash) content_hash, embedding
      from public.ai_chunks
     where document_id = v_id and embedding is not null and embedding_model = v_model
     order by content_hash, chunk_index
  ), old_alt as (
    select distinct on (content_hash) content_hash, embedding_alt
      from public.ai_chunks
     where document_id = v_id and embedding_alt is not null and embed_model_alt = v_alt
     order by content_hash, chunk_index
  )
  insert into public.ai_chunks as t (document_id, chunk_index, section, content, embed_text, token_count,
                                     content_hash, embedding, embedding_model, embedding_alt, embed_model_alt)
  select v_id, i.ci, i.sec, i.content, i.et, i.tc, i.h, coalesce(i.emb, o.embedding), v_model,
         coalesce(i.alt, oa.embedding_alt), case when coalesce(i.alt, oa.embedding_alt) is not null then v_alt end
    from incoming i left join old o on o.content_hash = i.h left join old_alt oa on oa.content_hash = i.h
  on conflict (document_id, chunk_index) do update set
    section = excluded.section, content = excluded.content, embed_text = excluded.embed_text,
    token_count = excluded.token_count, content_hash = excluded.content_hash,
    embedding = case when t.content_hash = excluded.content_hash and t.embedding_model = excluded.embedding_model
                      and t.embedding is not null then t.embedding else excluded.embedding end,
    embedding_alt = case when t.content_hash = excluded.content_hash and t.embedding_alt is not null
                          and excluded.embedding_alt is null then t.embedding_alt else excluded.embedding_alt end,
    embed_model_alt = case when t.content_hash = excluded.content_hash and t.embedding_alt is not null
                            and excluded.embedding_alt is null then t.embed_model_alt else excluded.embed_model_alt end,
    embedding_model = excluded.embedding_model, updated_at = now()
  where (t.section, t.content, t.embed_text, t.token_count, t.content_hash, t.embedding_model)
        is distinct from
        (excluded.section, excluded.content, excluded.embed_text, excluded.token_count, excluded.content_hash, excluded.embedding_model)
     or (t.embedding is null and excluded.embedding is not null)
     or (t.embedding_alt is null and excluded.embedding_alt is not null);
  get diagnostics v_changed = row_count;

  delete from public.ai_chunks where document_id = v_id and chunk_index >= v_n;
  get diagnostics v_deleted = row_count;

  select count(*) into v_pending from public.ai_chunks where document_id = v_id and vector_pending;

  if p_queue_id is not null then perform public.ai_ingest_complete(p_queue_id, p_worker); end if;
  return jsonb_build_object('ok', true, 'document_id', v_id, 'chunks', v_n, 'changed', v_changed, 'deleted', v_deleted,
                            'vector_pending', v_pending);
end;
$$;
revoke execute on function public.ai_ingest_write(jsonb, jsonb, bigint, text) from public, anon, authenticated;

-- ── the backfill ─────────────────────────────────────────────────────────
-- Chunks of ACTIVE documents that still need a vector in this space, our
-- process documents first. 'alt' only offers the free-provider source types,
-- and only chunks without an OpenAI vector unless embed_alt_always.
create or replace function public.ai_vector_pending(p_space text, p_limit int default 64)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  with cfg as (
    select coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), false) as always_,
           coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1), '{}') as free_
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'content_hash', x.content_hash, 'embed_text', x.embed_text,
                                               'source_type', x.source_type)), '[]'::jsonb)
    from (select c.id, c.content_hash, c.embed_text, c.source_type
            from public.ai_chunks c
            join public.ai_documents d on d.id = c.document_id and d.status = 'active'
            cross join cfg
           where case p_space
                   when 'primary' then c.vector_pending
                   when 'alt' then c.embedding_alt is null and c.source_type = any(cfg.free_)
                                   and (c.vector_pending or cfg.always_)
                   else false end
           order by case when c.source_type in ('kb_article', 'ai_doc', 'app_guide') then 0
                         when c.source_type = 'report' then 1 else 2 end, c.updated_at, c.id
           limit greatest(1, least(coalesce(p_limit, 64), 500))) x;
$$;
revoke execute on function public.ai_vector_pending(text, int) from public, anon, authenticated;
grant  execute on function public.ai_vector_pending(text, int) to service_role;

-- p_rows: [{id, content_hash, embedding}]. A row whose text changed meanwhile
-- (content_hash moved) is left alone. Returns the rows filled.
create or replace function public.ai_vector_fill(p_space text, p_model text, p_rows jsonb)
returns int
language plpgsql security definer
set search_path = public, extensions
as $$
declare v_n int;
begin
  if p_space = 'primary' then
    if p_model is distinct from public.ai_embed_model() then raise exception 'ai_vector_fill: primary model must be %', public.ai_embed_model(); end if;
    update public.ai_chunks c
       set embedding = (r->'embedding')::text::extensions.vector, embedding_model = p_model, updated_at = now()
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where c.id = (r->>'id')::uuid and c.content_hash = r->>'content_hash' and c.embedding is null
       and jsonb_typeof(r->'embedding') = 'array';
  elsif p_space = 'alt' then
    if p_model is distinct from public.ai_embed_model_alt() then raise exception 'ai_vector_fill: alt model must be %', public.ai_embed_model_alt(); end if;
    update public.ai_chunks c
       set embedding_alt = (r->'embedding')::text::extensions.vector, embed_model_alt = p_model, updated_at = now()
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where c.id = (r->>'id')::uuid and c.content_hash = r->>'content_hash' and c.embedding_alt is null
       and jsonb_typeof(r->'embedding') = 'array'
       and c.source_type = any(coalesce((select x.free_provider_sources from public.ai_assistant_config x where x.id = 1), '{}'));
  else
    raise exception 'ai_vector_fill: space must be primary or alt';
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.ai_vector_fill(text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.ai_vector_fill(text, text, jsonb) to service_role;

-- ── ai_search: + p_query_embedding_alt. Otherwise as mig 382 (and the HNSW
-- branches now skip NULL vectors explicitly).
drop function if exists public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[]);

create or replace function public.ai_search(
  p_query_embedding     extensions.vector(1536),
  p_query_text          text,
  p_source_types        text[] default null,
  p_brand_ids           uuid[] default null,
  p_period_from         date   default null,
  p_period_to           date   default null,
  p_match_count         int    default 30,
  p_as_user             uuid   default null,
  p_sections            text[] default null,
  p_query_embedding_alt extensions.vector(1536) default null
)
returns table (
  chunk_id     uuid,
  document_id  uuid,
  chunk_index  int,
  source_type  text,
  source_id    text,
  title        text,
  url          text,
  section      text,
  content      text,
  brand_id     uuid,
  period_start date,
  period_end   date,
  metadata     jsonb,
  score        double precision
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  EXACT_MAX constant int := 1000;   -- chunks; above this the HNSW indexes are used
  v_uid   uuid;
  v_role  text;
  v_text  text := nullif(btrim(coalesce(p_query_text, '')), '');
  v_tsq   tsquery;
  v_model text := public.ai_embed_model();
  v_amodel text := public.ai_embed_model_alt();
  v_types text[] := public.ai_source_types();
  v_known text[] := array['kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive'];
  v_docs  uuid[];
  v_n     bigint;
  v_qh    extensions.halfvec(1536);
  v_ah    extensions.halfvec(1536);
  v_sem   uuid[] := '{}';
  v_alt   uuid[] := '{}';
  v_sort  text;
  v_company boolean; v_reports boolean; v_tiktok boolean; v_incent boolean; v_other boolean;
begin
  v_uid := case when auth.role() = 'service_role' and p_as_user is not null then p_as_user else auth.uid() end;
  if v_uid is null then return; end if;

  select p.role into v_role
    from public.profiles p
   where p.id = v_uid and p.is_active and p.deleted_at is null;
  if v_role is null then return; end if;

  if v_text is not null then
    v_tsq := replace(plainto_tsquery('english', v_text)::text, ' & ', ' | ')::tsquery;
    if numnode(v_tsq) = 0 then v_tsq := null; end if;
  end if;

  -- The documents this caller may see under these filters, resolved once.
  select coalesce(array_agg(d.id), '{}'), coalesce(sum(d.chunk_count), 0) into v_docs, v_n
    from public.ai_documents d
   where d.status = 'active'
     and d.source_type = any(v_types)
     and (p_source_types is null or d.source_type = any(p_source_types))
     and (p_brand_ids    is null or d.brand_id    = any(p_brand_ids))
     and (p_period_from  is null or coalesce(d.period_end, d.period_start) >= p_period_from)
     and (p_period_to    is null or d.period_start <= p_period_to)
     and public.ai_can_read_document(d, v_uid, v_role);
  if cardinality(v_docs) = 0 then return; end if;

  v_company := p_source_types is null or p_source_types && array['kb_article', 'ai_doc', 'app_guide'];
  v_reports := p_source_types is null or 'report' = any(p_source_types);
  v_tiktok  := p_source_types is null or 'tts_article' = any(p_source_types);
  v_incent  := p_source_types is null or 'incentive' = any(p_source_types);
  v_other   := p_source_types is null or not (p_source_types <@ v_known);

  -- ── semantic arm (OpenAI space): ids best first ──
  if p_query_embedding is not null and v_n <= EXACT_MAX then
    select coalesce(array_agg(x.id order by x.dist), '{}') into v_sem
      from (select c.id, c.embedding <=> p_query_embedding as dist
              from public.ai_chunks c
             where c.document_id = any(v_docs) and c.embedding is not null and c.embedding_model = v_model
               and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
             order by 2 limit 60) x;
  elsif p_query_embedding is not null then
    v_qh := p_query_embedding::extensions.halfvec(1536);
    perform set_config('hnsw.ef_search', '400', true);   -- recall@10 vs exact: 0.96 at 100, 1.00 at 400; same warm latency
    perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
    v_sort := current_setting('enable_sort');
    perform set_config('enable_sort', 'off', true);
    select coalesce(array_agg(s.id order by s.dist), '{}') into v_sem
      from (select u.id, u.dist from (
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh as dist from public.ai_chunks c
          where v_company and c.source_type in ('kb_article', 'ai_doc', 'app_guide') and c.embedding is not null
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_reports and c.source_type = 'report' and c.embedding is not null
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_tiktok and c.source_type = 'tts_article' and c.embedding is not null
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_incent and c.source_type = 'incentive' and c.embedding is not null
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_other and c.source_type not in ('kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive')
            and c.embedding is not null
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
      ) u order by u.dist limit 60) s;
    perform set_config('enable_sort', v_sort, true);
  end if;

  -- ── semantic arm (alt space, NVIDIA): same shape on embedding_alt ──
  if p_query_embedding_alt is not null and v_n <= EXACT_MAX then
    select coalesce(array_agg(x.id order by x.dist), '{}') into v_alt
      from (select c.id, c.embedding_alt <=> p_query_embedding_alt as dist
              from public.ai_chunks c
             where c.document_id = any(v_docs) and c.embedding_alt is not null and c.embed_model_alt = v_amodel
               and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
             order by 2 limit 60) x;
  elsif p_query_embedding_alt is not null then
    v_ah := p_query_embedding_alt::extensions.halfvec(1536);
    perform set_config('hnsw.ef_search', '400', true);
    perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
    v_sort := current_setting('enable_sort');
    perform set_config('enable_sort', 'off', true);
    select coalesce(array_agg(s.id order by s.dist), '{}') into v_alt
      from (select u.id, u.dist from (
        (select c.id, (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah as dist from public.ai_chunks c
          where v_company and c.source_type in ('kb_article', 'ai_doc', 'app_guide') and c.embedding_alt is not null
            and (c.document_id = any(v_docs)) is true and c.embed_model_alt = v_amodel
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah limit 60)
        union all
        (select c.id, (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah from public.ai_chunks c
          where v_reports and c.source_type = 'report' and c.embedding_alt is not null
            and (c.document_id = any(v_docs)) is true and c.embed_model_alt = v_amodel
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah limit 60)
        union all
        (select c.id, (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah from public.ai_chunks c
          where v_tiktok and c.source_type = 'tts_article' and c.embedding_alt is not null
            and (c.document_id = any(v_docs)) is true and c.embed_model_alt = v_amodel
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah limit 60)
        union all
        (select c.id, (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah from public.ai_chunks c
          where v_incent and c.source_type = 'incentive' and c.embedding_alt is not null
            and (c.document_id = any(v_docs)) is true and c.embed_model_alt = v_amodel
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah limit 60)
        union all
        (select c.id, (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah from public.ai_chunks c
          where v_other and c.source_type not in ('kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive')
            and c.embedding_alt is not null
            and (c.document_id = any(v_docs)) is true and c.embed_model_alt = v_amodel
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding_alt::extensions.halfvec(1536)) <=> v_ah limit 60)
      ) u order by u.dist limit 60) s;
    perform set_config('enable_sort', v_sort, true);
  end if;

  return query
  with sem as (
    select t.id, t.rnk from unnest(v_sem) with ordinality as t(id, rnk)
  ),
  alt as (
    select t.id, t.rnk from unnest(v_alt) with ordinality as t(id, rnk)
  ),
  kw as (
    -- source_type first (cheap), then a hash join to the caller's documents.
    select c.id, row_number() over (order by ts_rank_cd(c.fts, v_tsq) desc, c.chunk_index, c.id) as rnk
      from public.ai_chunks c
      join unnest(v_docs) as ad(id) on ad.id = c.document_id
     where v_tsq is not null and c.fts @@ v_tsq
       and c.source_type = any(coalesce(p_source_types, v_types))
       and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
     order by ts_rank_cd(c.fts, v_tsq) desc, c.chunk_index, c.id
     limit 60
  ),
  fused as (
    select u.id, sum(1.0 / (60 + u.rnk)) as rrf
      from (select id, rnk from sem union all select id, rnk from alt union all select id, rnk from kw) u
     group by u.id
     order by rrf desc
     limit greatest(1, least(p_match_count, 100))
  )
  select c.id, a.id, c.chunk_index, a.source_type, a.source_id, a.title, a.url, c.section, c.content,
         a.brand_id, a.period_start, a.period_end, a.metadata, f.rrf::double precision
    from fused f
    join public.ai_chunks c on c.id = f.id
    join public.ai_documents a on a.id = c.document_id
   order by f.rrf desc;
end;
$$;
revoke execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector) from public, anon;
grant  execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector) to authenticated, service_role;

-- ── ingest stats: + vectors. Otherwise as mig 401. ──────────────────────
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
    -- Chunks with no OpenAI vector yet: found by keywords (and by the alt space
    -- if they have an NVIDIA vector) until the backfill fills them.
    'vector_pending', (select count(*) from public.ai_chunks c where c.vector_pending),
    'vectors', jsonb_build_object(
       'pending_by_type', coalesce((select jsonb_object_agg(source_type, n) from (
                select c.source_type, count(*) as n from public.ai_chunks c where c.vector_pending group by 1) x), '{}'::jsonb),
       'pending_with_alt', (select count(*) from public.ai_chunks c where c.vector_pending and c.embedding_alt is not null),
       'alt_filled', (select count(*) from public.ai_chunks c where c.embedding_alt is not null),
       'state', coalesce((select jsonb_object_agg(s.space, jsonb_build_object('next_try_at', s.next_try_at, 'last_error', s.last_error))
                            from public.ai_vector_state s), '{}'::jsonb)),
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

-- ── the tick: also wakes the worker for pending vectors. Otherwise as mig 375.
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
     and not (exists (select 1 from public.ai_chunks c where c.vector_pending)
              and (public.ai_vector_ready('primary') or public.ai_vector_ready('alt'))) then
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
