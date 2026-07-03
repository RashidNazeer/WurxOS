-- ============================================================
-- WurxOS v2 — Migration 224: fix tts_knowledge_search return type.
--
-- The RRF score `sum(1.0/(60+rnk))` is typed numeric by Postgres, but the
-- function declares `score double precision` → "structure of query does not
-- match function result type". Cast the fused score to double precision.
-- Recreate the function (create or replace).
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
    select id, sum(1.0 / (60 + rnk))::double precision as rrf
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
