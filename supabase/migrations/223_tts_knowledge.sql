-- ============================================================
-- WurxOS v2 — Migration 223: TikTok Shop Academy knowledge base.
--
-- Powers the AI assistant's TikTok-Shop intelligence. Academy articles
-- (seller-us.tiktok.com/university) are ingested offline into chunk-level
-- rows here: each chunk carries its text, an OpenAI embedding for semantic
-- search, a Postgres tsvector for keyword search, and its source_url for
-- citation. The ai-chat edge function does a hybrid (vector + keyword)
-- retrieval over this table alongside the existing ai_assistant_docs /
-- kb_articles pools.
--
-- Boss-only, same as the assistant. Rows are written ONLY by the offline
-- ingestion job (service role), so no client INSERT/UPDATE policy exists.
--
-- Embeddings: OpenAI text-embedding-3-small → 1536 dims.
-- Idempotent.
-- ============================================================

-- pgvector for semantic search (Supabase ships it; enable in the extensions
-- schema per Supabase convention).
create extension if not exists vector with schema extensions;

create table if not exists public.tts_knowledge (
  id            uuid primary key default gen_random_uuid(),
  -- Article identity (stable across re-crawls) + which chunk of it this is.
  knowledge_id  text not null,               -- academy knowledge_id / content_id
  chunk_index   int  not null default 0,      -- 0-based position within the article
  source_url    text not null,               -- canonical academy URL (for citation)
  -- Human context — breadcrumb (e.g. "Ads > GMV Max") + article title. These
  -- are prepended into the embedded text so short chunks keep their context.
  breadcrumb    text,
  title         text not null,
  content_type  text not null default 'essay', -- 'essay' | 'course'
  category      text,                          -- coarse topic bucket for filtering/labels
  -- The chunk itself.
  chunk_text    text not null,
  -- Semantic + lexical search columns.
  embedding     extensions.vector(1536),
  fts           tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(chunk_text,''))) stored,
  -- Refresh bookkeeping: article-level hash so an unchanged article is skipped
  -- on re-ingest; token count for budgeting.
  content_hash  text,
  token_estimate int,
  is_active     boolean not null default true,
  ingested_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One row per (article, chunk). Re-ingesting an article upserts its chunks.
create unique index if not exists tts_knowledge_chunk_uk
  on public.tts_knowledge(knowledge_id, chunk_index);

-- Keyword search index.
create index if not exists tts_knowledge_fts_idx
  on public.tts_knowledge using gin(fts);

-- Approximate-nearest-neighbour index for the embedding (cosine). ivfflat is
-- fine at this corpus size (low thousands of chunks); lists=100 is a sensible
-- default. Built only when there are rows to train on (ivfflat needs data),
-- so the offline ingest job (re)creates it after the first load — but declare
-- it here idempotently for environments that already have data.
do $$
begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='tts_knowledge_embedding_idx'
  ) then
    begin
      execute 'create index tts_knowledge_embedding_idx on public.tts_knowledge '
            || 'using ivfflat (embedding extensions.vector_cosine_ops) with (lists = 100)';
    exception when others then
      -- ivfflat can''t build on an empty table in some pg builds; the ingest
      -- job will create it post-load. Non-fatal.
      raise notice 'Deferred tts_knowledge embedding index (build after first load): %', sqlerrm;
    end;
  end if;
end $$;

alter table public.tts_knowledge enable row level security;

-- Read: Boss only (mirrors the assistant's ALLOWED_ROLES). The edge function
-- reads with the service role (bypasses RLS) for retrieval, but this policy
-- keeps any direct client read Boss-gated.
drop policy if exists "tts_knowledge_select_boss" on public.tts_knowledge;
create policy "tts_knowledge_select_boss"
  on public.tts_knowledge for select
  using (public.is_boss(auth.uid()));

-- No INSERT/UPDATE/DELETE policies: only the service-role ingestion job writes.

-- ------------------------------------------------------------
-- Hybrid retrieval RPC — returns the top chunks for a query embedding,
-- combining semantic (cosine) rank with keyword (ts_rank) rank via
-- Reciprocal Rank Fusion. SECURITY DEFINER so the edge function can call it
-- with the caller's JWT while still reading the Boss-only table; the function
-- itself re-checks is_boss so it can't be used to leak the KB to non-Boss.
-- ------------------------------------------------------------
create or replace function public.tts_knowledge_search(
  p_query_embedding extensions.vector(1536),
  p_query_text text,
  p_match_count int default 8
)
returns table (
  knowledge_id text,
  chunk_index int,
  title text,
  breadcrumb text,
  source_url text,
  category text,
  chunk_text text,
  score double precision
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_boss(auth.uid()) then
    return; -- non-Boss: empty result, never leaks the KB
  end if;

  return query
  with sem as (
    select k.id,
           row_number() over (order by k.embedding <=> p_query_embedding) as rnk
    from public.tts_knowledge k
    where k.is_active and k.embedding is not null
    order by k.embedding <=> p_query_embedding
    limit 40
  ),
  kw as (
    select k.id,
           row_number() over (
             order by ts_rank(k.fts, websearch_to_tsquery('english', p_query_text)) desc
           ) as rnk
    from public.tts_knowledge k
    where k.is_active
      and p_query_text is not null and length(btrim(p_query_text)) > 0
      and k.fts @@ websearch_to_tsquery('english', p_query_text)
    limit 40
  ),
  fused as (
    -- Reciprocal Rank Fusion (k=60), summing whichever arms matched.
    select id, sum(1.0 / (60 + rnk)) as rrf
    from (
      select id, rnk from sem
      union all
      select id, rnk from kw
    ) u
    group by id
    order by rrf desc
    limit p_match_count
  )
  select k.knowledge_id, k.chunk_index, k.title, k.breadcrumb, k.source_url,
         k.category, k.chunk_text, f.rrf
  from fused f
  join public.tts_knowledge k on k.id = f.id
  order by f.rrf desc;
end $$;

grant execute on function public.tts_knowledge_search(extensions.vector, text, int) to authenticated;
