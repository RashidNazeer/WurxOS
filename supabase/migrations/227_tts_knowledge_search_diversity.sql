-- ============================================================
-- WurxOS v2 — Migration 227: article diversity in tts_knowledge_search.
--
-- At full-corpus scale a query often matches several chunks of the SAME
-- article, so the top-N came back dominated by one article's chunks (e.g. 3×
-- "Co-funded Ads"), wasting the assistant's context budget. Rework the RPC to
-- (a) fuse semantic+keyword ranks via RRF as before, then (b) keep at most 2
-- chunks per article, preferring distinct articles — so the model sees more
-- of the academy per answer.
--
-- Also widen the candidate pools (60 each) now that the corpus is larger.
-- create or replace; return shape unchanged.
-- ============================================================

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
    limit 60
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
    limit 60
  ),
  fused as (
    select id, sum(1.0 / (60 + rnk))::double precision as rrf
    from (
      select id, rnk from sem
      union all
      select id, rnk from kw
    ) u
    group by id
  ),
  ranked as (
    -- attach each fused chunk to its article and rank chunks WITHIN an article
    select f.id, f.rrf, k.knowledge_id,
           row_number() over (partition by k.knowledge_id order by f.rrf desc) as chunk_rank_in_article
    from fused f
    join public.tts_knowledge k on k.id = f.id
  ),
  diversified as (
    -- keep at most 2 chunks per article so results span more of the academy
    select id, rrf from ranked
    where chunk_rank_in_article <= 2
    order by rrf desc
    limit p_match_count
  )
  select k.knowledge_id, k.chunk_index, k.title, k.breadcrumb, k.source_url,
         k.category, k.chunk_text, d.rrf
  from diversified d
  join public.tts_knowledge k on k.id = d.id
  order by d.rrf desc;
end $$;

grant execute on function public.tts_knowledge_search(extensions.vector, text, int) to authenticated;
