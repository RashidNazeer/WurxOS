-- ============================================================
-- 432 — Wurx Buddy: free embeddings only (Owner, 2026-11-03).
--
-- OpenAI is gone from search. The paid key has had no credits since 2026-10-02 and the
-- free-tier key cannot embed (HTTP 429 "no credits remaining"), so the 11,247
-- text-embedding-3-small vectors could neither embed new content nor a new question.
--
--   MAIN space   ai_chunks.embedding      NVIDIA llama-nemotron-embed-vl-1b-v2, 1536 dims.
--                                         Label 'nvidia:llama-nemotron-embed-vl-1b-v2' in
--                                         embedding_model / ai_documents.embed_model.
--   SECOND space ai_chunks.embedding_alt  Gemini (embed_alt_provider), 1536 dims: the safety net
--                                         for company and TikTok documents if NVIDIA is down.
--
-- What this migration does to DATA (all idempotent; a second run changes nothing):
--   1. The 8,245 NVIDIA vectors move from embedding_alt to embedding (no re-embedding).
--   2. Every other OpenAI vector is cleared (embedding := NULL): it cannot be searched or
--      extended any more. Those chunks become 'waiting' and the existing backfill refills them.
--      Incentive chunks (pay data) are NOT allowed on a free provider: they stay keyword-only,
--      and the stats now say so instead of showing them as waiting.
--   3. embedding_model and ai_documents.embed_model are relabelled to the NVIDIA label, so no
--      sweep sees a "different pipeline" and no document is re-chunked (doc_hash/content_hash
--      are unchanged: the hash salt stays the old model name on purpose, see config.ts HASH_MODEL).
--   4. embedding_alt is emptied for the NVIDIA rows (they moved), the second space becomes Gemini.
--   5. The stale OpenAI "no credits" row in ai_vector_state is removed; spaces are renamed
--      'primary' → 'main'.
-- Privacy: each PROVIDER has its own allow-list of document types. NVIDIA: free_provider_sources
-- (the existing Boss setting). Gemini: gemini_provider_sources ∩ free_provider_sources, default
-- WITH report (Boss decision, 2026-11-03: client reports may go to Gemini's free tier; Google's unpaid tier
-- may use submitted content to improve its products, and the Boss accepted that for reports).
-- 'incentive' (pay data) is on no list: it is never embedded by any free provider.
-- ai_search: a query vector is used only if it is labelled with the space's own model; an unlabelled or
-- other-model vector is ignored, never compared (the old assistant, which sends no label, is safely keyword-only).
-- ============================================================

-- ── settings ─────────────────────────────────────────────────────────────
alter table public.ai_assistant_config add column if not exists gemini_provider_sources text[] not null
  default array['kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article'];

create or replace function public.ai_embed_model() returns text
language sql stable as $$ select 'nvidia:llama-nemotron-embed-vl-1b-v2'::text $$;

create or replace function public.ai_alt_model_for(p_provider text) returns text
language sql immutable set search_path = public as $$
  select case p_provider
           when 'gemini' then 'gemini:gemini-embedding-001'
           else 'nvidia:llama-nemotron-embed-vl-1b-v2'
         end;
$$;

-- The provider of each space, and the document types its PROVIDER may see.
create or replace function public.ai_space_provider(p_space text) returns text
language sql stable security definer set search_path = public as $$
  select case p_space
           when 'main' then split_part(public.ai_embed_model(), ':', 1)
           when 'alt'  then (select c.embed_alt_provider from public.ai_assistant_config c where c.id = 1)
         end;
$$;
revoke execute on function public.ai_space_provider(text) from public, anon, authenticated;
grant  execute on function public.ai_space_provider(text) to service_role;

create or replace function public.ai_provider_sources(p_provider text) returns text[]
language sql stable security definer set search_path = public as $$
  select case p_provider
           -- 'incentive' (pay data) is removed here whatever the Boss settings say: the guarantee that it
           -- never reaches a free provider must not depend on a default list staying clean.
           when 'nvidia' then array_remove(coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1), '{}'), 'incentive')
           when 'gemini' then array_remove(coalesce((select array(select x from unnest(c.gemini_provider_sources) x where x = any(c.free_provider_sources))
                                          from public.ai_assistant_config c where c.id = 1), '{}'), 'incentive')
           else '{}'::text[]
         end;
$$;
revoke execute on function public.ai_provider_sources(text) from public, anon, authenticated;
grant  execute on function public.ai_provider_sources(text) to service_role;

create or replace function public.ai_space_sources(p_space text) returns text[]
language sql stable security definer set search_path = public as $$
  select public.ai_provider_sources(public.ai_space_provider(p_space));
$$;
revoke execute on function public.ai_space_sources(text) from public, anon, authenticated;
grant  execute on function public.ai_space_sources(text) to service_role;

-- The second space must be a different provider from the main one, and one model per column.
create or replace function public.ai_trg_config_alt_provider() returns trigger
language plpgsql set search_path = public as $$
declare v_n int; v_new text;
begin
  if tg_op = 'UPDATE' and new.embed_alt_provider is not distinct from old.embed_alt_provider then return new; end if;
  if new.embed_alt_provider = split_part(public.ai_embed_model(), ':', 1) then
    raise exception 'the second vector space must use a different provider from the main one (%)', new.embed_alt_provider;
  end if;
  v_new := public.ai_alt_model_for(new.embed_alt_provider);
  select count(*) into v_n from public.ai_chunks c
   where c.embedding_alt is not null and c.embed_model_alt is distinct from v_new;
  if v_n > 0 then
    raise exception 'the alt vector space holds % chunk(s) from another model: run select public.ai_vector_reset_alt() first (it clears embedding_alt so it can be rebuilt)', v_n;
  end if;
  return new;
end;
$$;

-- What the worker needs (service only: the allow-lists are a privacy rule).
create or replace function public.ai_embed_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'model', public.ai_embed_model(),
    'alt_model', public.ai_embed_model_alt(),
    'alt_provider', public.ai_space_provider('alt'),
    'alt_always', coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), true),
    'free_sources', to_jsonb(public.ai_space_sources('main')),
    'main_sources', to_jsonb(public.ai_space_sources('main')),
    'alt_sources', to_jsonb(public.ai_space_sources('alt')));
$$;
revoke execute on function public.ai_embed_settings() from public, anon, authenticated;
grant  execute on function public.ai_embed_settings() to service_role;

-- ── per-space retry state: 'main' | 'alt' ────────────────────────────────
alter table public.ai_vector_state drop constraint if exists ai_vector_state_space_check;
delete from public.ai_vector_state where space = 'primary';   -- the stale OpenAI "no credits" row
alter table public.ai_vector_state add constraint ai_vector_state_space_check check (space in ('main', 'alt'));

create or replace function public.ai_vector_defer(p_space text, p_seconds int, p_error text) returns void
language sql security definer set search_path = public as $$
  insert into public.ai_vector_state (space, next_try_at, last_error, updated_at)
  values (p_space, now() + make_interval(secs => greatest(coalesce(p_seconds, 1800), 60)), left(p_error, 500), now())
  on conflict (space) do update set next_try_at = excluded.next_try_at, last_error = excluded.last_error, updated_at = now();
$$;

-- A success clears the space's state: it is never left looking 'down' after it works again.
create or replace function public.ai_vector_ok(p_space text) returns void
language sql security definer set search_path = public as $$
  delete from public.ai_vector_state where space = p_space;
$$;
revoke execute on function public.ai_vector_ok(text) from public, anon, authenticated;
grant  execute on function public.ai_vector_ok(text) to service_role;

-- ── the data (idempotent) ────────────────────────────────────────────────
-- Dropping the HNSW indexes first keeps the 13k-row rewrite fast; they are rebuilt below.
drop index if exists public.ai_chunks_hnsw_company, public.ai_chunks_hnsw_reports, public.ai_chunks_hnsw_tiktok,
  public.ai_chunks_hnsw_incentives, public.ai_chunks_hnsw_other,
  public.ai_chunks_alt_hnsw_company, public.ai_chunks_alt_hnsw_reports, public.ai_chunks_alt_hnsw_tiktok,
  public.ai_chunks_alt_hnsw_incentives, public.ai_chunks_alt_hnsw_other;

-- 1. NVIDIA vectors: embedding_alt → embedding
update public.ai_chunks
   set embedding = embedding_alt, embedding_model = 'nvidia:llama-nemotron-embed-vl-1b-v2',
       embedding_alt = null, embed_model_alt = null
 where embedding_alt is not null and embed_model_alt = 'nvidia:llama-nemotron-embed-vl-1b-v2';
-- 2. every remaining OpenAI vector is dead
update public.ai_chunks set embedding = null
 where embedding is not null and embedding_model is distinct from 'nvidia:llama-nemotron-embed-vl-1b-v2';
-- 3. labels
update public.ai_chunks set embedding_model = 'nvidia:llama-nemotron-embed-vl-1b-v2'
 where embedding_model is distinct from 'nvidia:llama-nemotron-embed-vl-1b-v2';
update public.ai_documents set embed_model = 'nvidia:llama-nemotron-embed-vl-1b-v2'
 where embed_model is distinct from 'nvidia:llama-nemotron-embed-vl-1b-v2';
-- 4. the second space is Gemini, filled for all allowed types
update public.ai_assistant_config set embed_alt_provider = 'gemini', embed_alt_always = true
 where id = 1 and (embed_alt_provider is distinct from 'gemini' or embed_alt_always is distinct from true);

create or replace function public.ai_vector_reset_main() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update public.ai_chunks set embedding = null, updated_at = now() where embedding is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.ai_vector_reset_main() from public, anon, authenticated;
grant  execute on function public.ai_vector_reset_main() to service_role;

-- ── indexes: one per corpus, per space (as mig 382 / 406) ────────────────
create index if not exists ai_chunks_hnsw_company on public.ai_chunks
  using hnsw ((embedding::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type in ('kb_article', 'ai_doc', 'app_guide');
create index if not exists ai_chunks_hnsw_reports on public.ai_chunks
  using hnsw ((embedding::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type = 'report';
create index if not exists ai_chunks_hnsw_tiktok on public.ai_chunks
  using hnsw ((embedding::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type = 'tts_article';
create index if not exists ai_chunks_hnsw_incentives on public.ai_chunks
  using hnsw ((embedding::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type = 'incentive';
create index if not exists ai_chunks_hnsw_other on public.ai_chunks
  using hnsw ((embedding::extensions.halfvec(1536)) extensions.halfvec_cosine_ops) with (m = 16, ef_construction = 64)
  where source_type not in ('kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive');
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
create index if not exists ai_chunks_alt_missing_idx on public.ai_chunks (source_type) where embedding_alt is null;

-- ── the write: each space's vectors only for source types its provider may see ──
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
  -- The privacy rule is enforced here too, not only in the worker: each space's vectors only for the
  -- source types that space's PROVIDER may see (NVIDIA: free_provider_sources; Gemini: its own, narrower list).
  if not (p_doc->>'source_type' = any(public.ai_space_sources('main')))
     and exists (select 1 from jsonb_array_elements(v_chunks) c where jsonb_typeof(c->'embedding') = 'array') then
    raise exception 'ai_ingest_write: source type % may not have free-provider vectors', p_doc->>'source_type';
  end if;
  if not (p_doc->>'source_type' = any(public.ai_space_sources('alt')))
     and exists (select 1 from jsonb_array_elements(v_chunks) c where jsonb_typeof(c->'embedding_alt') = 'array') then
    raise exception 'ai_ingest_write: source type % may not have second-provider vectors', p_doc->>'source_type';
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

-- ── the second space's daily allowance ───────────────────────────────────
-- Gemini's free tier allows 1,000 embedded inputs per model per DAY (measured 2026-11-03: HTTP 429 "Embed
-- content requests per day limit exceeded on Free Tier", limit 1000, retry in ~13 h). A question's query
-- vector costs one of them too, so the backfill keeps 150 back: at most 850 vectors per rolling 24 h.
-- Other providers: no cap here.
create or replace function public.ai_alt_budget() returns int
language sql stable security definer set search_path = public as $$
  select case when public.ai_space_provider('alt') = 'gemini'
              then greatest(0, 850 - (select count(*)::int from public.ai_chunks c
                                       where c.embedding_alt is not null and c.updated_at > now() - interval '24 hours'))
              else 1000000 end;
$$;
revoke execute on function public.ai_alt_budget() from public, anon, authenticated;
grant  execute on function public.ai_alt_budget() to service_role;

-- ── the backfill ─────────────────────────────────────────────────────────
-- 'main': chunks with no NVIDIA vector, of the types NVIDIA may see. 'alt': chunks with no second-space
-- vector, of the types that provider may see (all of them when embed_alt_always). The `none` bucket (no
-- vector anywhere) is served first. Nothing is returned during quiet hours.
create or replace function public.ai_vector_pending(p_space text, p_limit int default 64)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  with cfg as (
    select coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), true) as always_,
           public.ai_space_sources('main') as main_,
           public.ai_space_sources('alt') as alt_,
           public.ai_vector_backfill_allowed() as allowed_,
           public.ai_alt_budget() as alt_budget_
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'content_hash', x.content_hash, 'embed_text', x.embed_text,
                                               'source_type', x.source_type)), '[]'::jsonb)
    from (select c.id, c.content_hash, c.embed_text, c.source_type
            from public.ai_chunks c
            join public.ai_documents d on d.id = c.document_id and d.status = 'active'
            cross join cfg
           where cfg.allowed_
             and case p_space
                   when 'main' then c.embedding is null and c.source_type = any(cfg.main_)
                   when 'alt' then c.embedding_alt is null and c.source_type = any(cfg.alt_)
                                   and (c.vector_pending or cfg.always_)
                   else false end
           order by c.vector_pending desc,
                    case when c.source_type in ('kb_article', 'ai_doc', 'app_guide') then 0
                         when c.source_type = 'report' then 1 else 2 end, c.updated_at, c.id
           limit case when p_space = 'alt' then greatest(0, least(coalesce(p_limit, 64), 500, (select alt_budget_ from cfg)))
                      else greatest(1, least(coalesce(p_limit, 64), 500)) end) x;
$$;
revoke execute on function public.ai_vector_pending(text, int) from public, anon, authenticated;
grant  execute on function public.ai_vector_pending(text, int) to service_role;

-- p_rows: [{id, content_hash, embedding}]. A row whose text changed meanwhile (content_hash moved) is
-- left alone. A row of a type the space's provider may not see is refused here too (privacy is enforced in
-- the database, not only in the worker). Returns the rows filled.
create or replace function public.ai_vector_fill(p_space text, p_model text, p_rows jsonb)
returns int
language plpgsql security definer
set search_path = public, extensions
as $$
declare v_n int;
begin
  if p_space = 'main' then
    if p_model is distinct from public.ai_embed_model() then raise exception 'ai_vector_fill: main model must be %', public.ai_embed_model(); end if;
    update public.ai_chunks c
       set embedding = (r->'embedding')::text::extensions.vector, embedding_model = p_model, updated_at = now()
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where c.id = (r->>'id')::uuid and c.content_hash = r->>'content_hash' and c.embedding is null
       and jsonb_typeof(r->'embedding') = 'array'
       and c.source_type = any(public.ai_space_sources('main'));
  elsif p_space = 'alt' then
    if p_model is distinct from public.ai_embed_model_alt() then raise exception 'ai_vector_fill: alt model must be %', public.ai_embed_model_alt(); end if;
    update public.ai_chunks c
       set embedding_alt = (r->'embedding')::text::extensions.vector, embed_model_alt = p_model, updated_at = now()
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
     where c.id = (r->>'id')::uuid and c.content_hash = r->>'content_hash' and c.embedding_alt is null
       and jsonb_typeof(r->'embedding') = 'array'
       and c.source_type = any(public.ai_space_sources('alt'));
  else
    raise exception 'ai_vector_fill: space must be main or alt';
  end if;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.ai_vector_fill(text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.ai_vector_fill(text, text, jsonb) to service_role;

-- ── ai_search: + p_query_model / p_query_model_alt ───────────────────────
drop function if exists public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[]);
drop function if exists public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector);

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
  p_query_embedding_alt extensions.vector(1536) default null,
  p_query_model         text default null,   -- the model that made p_query_embedding; a mismatch ignores that arm
  p_query_model_alt     text default null
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
  W_SEM constant float := 20.0;   -- RRF weights (benchmark 2026-11-03: dense alone recall@5 0.908; dense:keywords 3:1 gave 0.700, 20:1 0.900)
  W_ALT constant float := 20.0;
  W_KW  constant float := 1.0;
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
  -- NEVER compare vectors of different models. A query vector counts only if it says which model made it AND that
  -- is the space's model: an unlabelled one (an old caller) or another model's is ignored, and that arm falls back to keywords.
  if p_query_embedding is not null and p_query_model is distinct from v_model then p_query_embedding := null; end if;
  if p_query_embedding_alt is not null and p_query_model_alt is distinct from v_amodel then p_query_embedding_alt := null; end if;
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

  -- ── semantic arm (main space): ids best first ──
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

  -- ── semantic arm (second space): same shape on embedding_alt ──
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
    select u.id, sum(u.w / (60 + u.rnk)) as rrf
      from (select id, rnk, W_SEM as w from sem union all select id, rnk, W_ALT from alt union all select id, rnk, W_KW from kw) u
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
revoke execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector, text, text) from public, anon;
grant  execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector, text, text) to authenticated, service_role;

-- ── the minute drain: wake only for work that CAN be done ────────────────
-- (the old condition woke every minute for the incentive chunks, which no free provider may embed)
create or replace function public.ai_ingest_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
declare
  v_url    text;
  v_secret text;
  v_main   text[] := public.ai_space_sources('main');
  v_alt    text[] := public.ai_space_sources('alt');
  v_always boolean := coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), true);
  -- hoisted: these are SECURITY DEFINER functions, so inside the EXISTS they would run once per chunk
  v_ready_m boolean := public.ai_vector_ready('main');
  v_ready_a boolean := public.ai_vector_ready('alt') and public.ai_alt_budget() > 0;
  v_allowed boolean := public.ai_vector_backfill_allowed();
begin
  -- Ingestion rests in the evening (mig 407): no worker is woken.
  if public.ai_ingest_quiet_now() then return; end if;
  if not exists (select 1 from public.ai_ingest_queue
                  where (status = 'pending' and not_before <= now())
                     or (status = 'processing' and locked_at < now() - interval '10 minutes'))
     and not (v_allowed
              and exists (select 1 from public.ai_chunks c
                            join public.ai_documents d on d.id = c.document_id and d.status = 'active'
                           where (c.embedding is null and c.source_type = any(v_main) and v_ready_m)
                              or (c.embedding_alt is null and c.source_type = any(v_alt) and (c.vector_pending or v_always)
                                  and v_ready_a))) then
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

-- ── the settings screen ──────────────────────────────────────────────────
-- Shape changes for the UI (all old keys kept):
--   vector_pending                 = chunks WAITING for a vector (allowed on a free provider, none yet)
--   vectors.waiting / waiting_by_type
--   vectors.keyword_only_not_allowed / keyword_only_by_type   incentive (pay data): never sent to a free provider
--   vectors.main_provider / main_model, vectors.spaces.{main,alt} =
--        {provider, model, filled, missing, not_allowed, allowed_types, status, next_try_at, last_error}
--        status: 'complete' | 'filling' | 'down' (deferred after an error) | 'paused_quiet_hours'
--                | 'daily_limit' (alt only: Gemini's free 1,000/day allowance is used; resumes by itself)
--   vectors.by_space.none          = chunks no space can find by meaning (waiting + keyword-only)
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
    -- Chunks WAITING for a vector: none in either space, and a free provider may embed them.
    'vector_pending', (select count(*) from public.ai_chunks c join public.ai_documents d on d.id = c.document_id and d.status = 'active'
                        where c.embedding is null and c.embedding_alt is null
                          and (c.source_type = any(public.ai_space_sources('main')) or c.source_type = any(public.ai_space_sources('alt')))),
    'vectors', (with src as (select public.ai_space_sources('main') as m, public.ai_space_sources('alt') as a,
                                    public.ai_vector_backfill_allowed() as allowed),
                     k as (select c.source_type, (c.embedding is not null) as has_m, (c.embedding_alt is not null) as has_a,
                                  c.embed_model_alt
                             from public.ai_chunks c join public.ai_documents d2 on d2.id = c.document_id and d2.status = 'active'),
                     st as (select s.space, s.next_try_at, s.last_error from public.ai_vector_state s)
                select jsonb_build_object(
       'main_provider', public.ai_space_provider('main'),
       'main_model', public.ai_embed_model(),
       'alt_provider', public.ai_space_provider('alt'),
       'alt_model', public.ai_embed_model_alt(),
       'alt_always', coalesce((select x.embed_alt_always from public.ai_assistant_config x where x.id = 1), false),
       'backfill_allowed', (select allowed from src),
       'by_space', jsonb_build_object(
          'main', (select count(*) from k where has_m),
          'alt',  (select count(*) from k where has_a),
          'none', (select count(*) from k where not has_m and not has_a)),
       'main_missing', (select count(*) from k where not has_m and has_a),
       'alt_filled', (select count(*) from k where has_a),
       'alt_models', coalesce((select jsonb_agg(distinct embed_model_alt) from k where embed_model_alt is not null), '[]'::jsonb),
       'waiting', (select count(*) from k, src where not has_m and not has_a and (source_type = any(src.m) or source_type = any(src.a))),
       'waiting_by_type', coalesce((select jsonb_object_agg(source_type, n) from (
                select k.source_type, count(*) as n from k, src
                 where not has_m and not has_a and (k.source_type = any(src.m) or k.source_type = any(src.a)) group by 1) y), '{}'::jsonb),
       'keyword_only_not_allowed', (select count(*) from k, src where not has_m and not has_a and not (source_type = any(src.m)) and not (source_type = any(src.a))),
       'keyword_only_by_type', coalesce((select jsonb_object_agg(source_type, n) from (
                select k.source_type, count(*) as n from k, src
                 where not has_m and not has_a and not (k.source_type = any(src.m)) and not (k.source_type = any(src.a)) group by 1) y), '{}'::jsonb),
       'pending_by_type', coalesce((select jsonb_object_agg(source_type, n) from (
                select k.source_type, count(*) as n from k, src
                 where not has_m and not has_a and (k.source_type = any(src.m) or k.source_type = any(src.a)) group by 1) y), '{}'::jsonb),
       'spaces', jsonb_build_object(
          'main', jsonb_build_object(
             'provider', public.ai_space_provider('main'), 'model', public.ai_embed_model(),
             'filled', (select count(*) from k where has_m),
             'missing', (select count(*) from k, src where not has_m and source_type = any(src.m)),
             'not_allowed', (select count(*) from k, src where not has_m and not (source_type = any(src.m))),
             'allowed_types', to_jsonb((select m from src)),
             'status', case when (select next_try_at > now() from st where space = 'main') then 'down'
                            when (select count(*) from k, src where not has_m and source_type = any(src.m)) = 0 then 'complete'
                            when not (select allowed from src) then 'paused_quiet_hours' else 'filling' end,
             'next_try_at', (select next_try_at from st where space = 'main'), 'last_error', (select last_error from st where space = 'main')),
          'alt', jsonb_build_object(
             'provider', public.ai_space_provider('alt'), 'model', public.ai_embed_model_alt(),
             'filled', (select count(*) from k where has_a),
             'missing', (select count(*) from k, src where not has_a and source_type = any(src.a)),
             'not_allowed', (select count(*) from k, src where not has_a and not (source_type = any(src.a))),
             'allowed_types', to_jsonb((select a from src)),
             'status', case when (select next_try_at > now() from st where space = 'alt') then 'down'
                            when (select count(*) from k, src where not has_a and source_type = any(src.a)) = 0 then 'complete'
                            when not (select allowed from src) then 'paused_quiet_hours'
                            when public.ai_alt_budget() <= 0 then 'daily_limit' else 'filling' end,
             'daily_budget_left', case when public.ai_alt_budget() >= 1000000 then null else public.ai_alt_budget() end,
             'next_try_at', (select next_try_at from st where space = 'alt'), 'last_error', (select last_error from st where space = 'alt'))),
       'state', coalesce((select jsonb_object_agg(space, jsonb_build_object('next_try_at', next_try_at, 'last_error', last_error)) from st), '{}'::jsonb))),
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
