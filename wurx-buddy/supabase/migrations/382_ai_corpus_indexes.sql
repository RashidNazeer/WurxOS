-- ============================================================
-- 382 — Assistant v2: one half-precision vector index per corpus, and an
-- exact path for small searches (search latency on a small instance).
-- NOT APPLIED: needs the Lead's go (it backfills every chunk row, ~11.5k).
--
-- Measured on dev (scripts/bench-search.mjs, scratch copy): the old semantic
-- arm had two failure modes.
--   • The planner prices a vector distance like any operator, not like the
--     6 KB TOAST fetch it really is. For a filtered search (one corpus, one
--     brand, an APC's reports) it therefore preferred "every candidate chunk,
--     then sort": 6,060 detoasted report vectors, 0.2 s warm, 3–6 s cold.
--   • Unfiltered, it walked ONE 91 MB graph of all corpora and dropped the
--     other corpora's tuples in the ACL join: TikTok read 4,560 tuples to
--     return 60 (9 s cold).
-- Now:
--   ai_chunks.source_type   denormalised from ai_documents (it never changes for
--                           a document: (source_type, source_id) is its key),
--                           filled by a BEFORE INSERT trigger from the parent
--                           document, so every writer (ai_ingest_write, the SQL
--                           test fixtures) stays correct unchanged.
--   partial HNSW per corpus on embedding::halfvec(1536): company (kb_article,
--                           ai_doc, app_guide) · reports · tiktok · incentives ·
--                           other (test fixture types). Half the size of full
--                           vectors (44 MB for all corpora vs 91 MB for the old
--                           single index); the table keeps full vectors.
--   ai_search               resolves the caller's documents once (ACL + filters).
--                           ≤ EXACT_MAX chunks in them (company, incentives, one
--                           brand, a restricted user's reports): EXACT search,
--                           full-precision distance, no index. More: one HNSW
--                           branch per corpus with a CONSTANT source_type
--                           predicate (matches the partial index in generic
--                           plans too), a branch the call does not need skipped
--                           by a one-time filter, enable_sort off for that one
--                           statement so the planner cannot fall back to "fetch
--                           all, sort". The keyword arm hash-joins the caller's
--                           documents. RRF, results and signature as mig 378.
--
-- Idempotent. Rollback: recreate ai_chunks_embedding_hnsw (mig 367) and re-run
-- the ai_search of mig 378 (the column, trigger and new indexes can stay).
-- ============================================================

-- The whole migration holds ai_chunks exclusively (search and ingestion wait)
-- for about 1–2 minutes on dev: apply it while the crawl is idle.
-- 128 MB with a parallel build failed on dev ("could not resize shared memory segment").
set local maintenance_work_mem = '64MB';
set local max_parallel_maintenance_workers = 0;

-- The old index goes first, so the backfill below does not insert 11.5k new
-- entries into it.
drop index if exists public.ai_chunks_embedding_hnsw;

alter table public.ai_chunks add column if not exists source_type text;

update public.ai_chunks c
   set source_type = d.source_type
  from public.ai_documents d
 where d.id = c.document_id and c.source_type is distinct from d.source_type;

alter table public.ai_chunks alter column source_type set not null;

create or replace function public.ai_chunks_set_source_type() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select d.source_type into new.source_type from public.ai_documents d where d.id = new.document_id;
  return new;
end $$;
revoke execute on function public.ai_chunks_set_source_type() from public, anon, authenticated;

drop trigger if exists ai_chunks_source_type on public.ai_chunks;
create trigger ai_chunks_source_type before insert or update of document_id on public.ai_chunks
  for each row execute function public.ai_chunks_set_source_type();

-- ── one index per corpus (INDEXES in retrieval/indexes.ts) ─────────────
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

-- ── ai_search ──────────────────────────────────────────────────────────
create or replace function public.ai_search(
  p_query_embedding extensions.vector(1536),
  p_query_text      text,
  p_source_types    text[] default null,
  p_brand_ids       uuid[] default null,
  p_period_from     date   default null,
  p_period_to       date   default null,
  p_match_count     int    default 30,
  p_as_user         uuid   default null,
  p_sections        text[] default null
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
  v_types text[] := public.ai_source_types();
  v_known text[] := array['kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive'];
  v_docs  uuid[];
  v_n     bigint;
  v_qh    extensions.halfvec(1536);
  v_sem   uuid[] := '{}';
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

  -- ── semantic arm: ids best first ──
  if p_query_embedding is not null and v_n <= EXACT_MAX then
    select coalesce(array_agg(x.id order by x.dist), '{}') into v_sem
      from (select c.id, c.embedding <=> p_query_embedding as dist
              from public.ai_chunks c
             where c.document_id = any(v_docs) and c.embedding is not null and c.embedding_model = v_model
               and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
             order by 2 limit 60) x;
  elsif p_query_embedding is not null then
    v_qh      := p_query_embedding::extensions.halfvec(1536);
    v_company := p_source_types is null or p_source_types && array['kb_article', 'ai_doc', 'app_guide'];
    v_reports := p_source_types is null or 'report' = any(p_source_types);
    v_tiktok  := p_source_types is null or 'tts_article' = any(p_source_types);
    v_incent  := p_source_types is null or 'incentive' = any(p_source_types);
    v_other   := p_source_types is null or not (p_source_types <@ v_known);
    perform set_config('hnsw.ef_search', '400', true);   -- recall@10 vs exact: 0.96 at 100, 1.00 at 400; same warm latency
    perform set_config('hnsw.iterative_scan', 'relaxed_order', true);
    v_sort := current_setting('enable_sort');
    perform set_config('enable_sort', 'off', true);
    select coalesce(array_agg(s.id order by s.dist), '{}') into v_sem
      from (select u.id, u.dist from (
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh as dist from public.ai_chunks c
          where v_company and c.source_type in ('kb_article', 'ai_doc', 'app_guide')
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_reports and c.source_type = 'report'
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_tiktok and c.source_type = 'tts_article'
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_incent and c.source_type = 'incentive'
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
        union all
        (select c.id, (c.embedding::extensions.halfvec(1536)) <=> v_qh from public.ai_chunks c
          where v_other and c.source_type not in ('kb_article', 'ai_doc', 'app_guide', 'report', 'tts_article', 'incentive')
            and (c.document_id = any(v_docs)) is true and c.embedding_model = v_model
            and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
          order by (c.embedding::extensions.halfvec(1536)) <=> v_qh limit 60)
      ) u order by u.dist limit 60) s;
    perform set_config('enable_sort', v_sort, true);
  end if;

  return query
  with sem as (
    select t.id, t.rnk from unnest(v_sem) with ordinality as t(id, rnk)
  ),
  kw as (
    -- source_type first (cheap), then a hash join to the caller's documents: a
    -- linear `= any(v_docs)` per matching chunk cost ~140 ms on broad queries.
    select c.id, row_number() over (order by ts_rank_cd(c.fts, v_tsq) desc, c.chunk_index, c.id) as rnk
      from public.ai_chunks c
      join unnest(v_docs) as ad(id) on ad.id = c.document_id
     where v_tsq is not null and c.fts @@ v_tsq
       and c.source_type = any(coalesce(p_source_types, v_types))
       and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
     order by ts_rank_cd(c.fts, v_tsq) desc, c.chunk_index, c.id   -- ties: a document's opening chunk first, the same on every plan
     limit 60
  ),
  fused as (
    select u.id, sum(1.0 / (60 + u.rnk)) as rrf
      from (select id, rnk from sem union all select id, rnk from kw) u
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
revoke execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[]) from public, anon;
grant  execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[]) to authenticated, service_role;
