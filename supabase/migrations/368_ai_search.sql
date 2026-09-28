-- ============================================================
-- 368 — Assistant v2: permission-aware hybrid search.
--
-- ai_can_read_document(doc, uid, role)
--   The ACL check. Calls the app's own helpers (can_view_report,
--   can_view_brand, is_boss) so the index never grants more than the app
--   does, and a brand reassignment or role change applies instantly — no
--   re-index. Unknown modes are denied.
--
-- ai_search(...)
--   Hybrid retrieval: semantic (cosine, HNSW) + keyword (full-text), merged
--   by Reciprocal Rank Fusion, restricted to documents the caller may read.
--   Identity is auth.uid(); p_as_user is honoured ONLY for the service role
--   (the Slack relay, which ai-chat has already verified answers as a Boss).
--   The caller's role is resolved once per query — per-row profile lookups
--   are what made the KB page time out (mig 134).
--
-- Design: Assistant/architecture.md §4, §10.  Idempotent.
-- ============================================================

create or replace function public.ai_can_read_document(d public.ai_documents, uid uuid, urole text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when urole = 'boss'           then true
    when d.acl_mode = 'all'       then true
    when d.acl_mode = 'roles'     then urole = any(d.acl_roles)
    when d.acl_mode = 'report'    then public.can_view_report(d.brand_id, d.author_id, uid)
    when d.acl_mode = 'brand'     then exists (
                                         select 1 from public.brands b
                                          where b.id = d.brand_id
                                            and public.can_view_brand(b.owner_id, b.id, uid))
    -- Mirrors the kb_select policy (mig 134). Only approved articles are
    -- ever indexed, so the approval branch is implied.
    when d.acl_mode = 'kb'        then urole in ('ol','developer')
                                    or d.author_id = uid
                                    or coalesce(d.metadata->>'visibility','office') = 'office'
                                    or (d.metadata->>'visibility' = 'role'  and urole = any(d.acl_roles))
                                    or (d.metadata->>'visibility' = 'users' and uid   = any(d.acl_users))
    when d.acl_mode = 'boss'      then urole = any(d.acl_roles)
    else false
  end;
$$;
revoke execute on function public.ai_can_read_document(public.ai_documents, uuid, text) from public, anon, authenticated;

create or replace function public.ai_search(
  p_query_embedding extensions.vector(1536),
  p_query_text      text,
  p_source_types    text[] default null,
  p_brand_ids       uuid[] default null,
  p_period_from     date   default null,
  p_period_to       date   default null,
  p_match_count     int    default 30,
  p_as_user         uuid   default null
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
  v_uid   uuid;
  v_role  text;
  v_text  text := nullif(btrim(coalesce(p_query_text, '')), '');
  v_tsq   tsquery;
begin
  v_uid := case when auth.role() = 'service_role' and p_as_user is not null then p_as_user else auth.uid() end;
  if v_uid is null then return; end if;

  select p.role into v_role
    from public.profiles p
   where p.id = v_uid and p.is_active and p.deleted_at is null;
  if v_role is null then return; end if;

  if v_text is not null then v_tsq := websearch_to_tsquery('english', v_text); end if;

  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);   -- pgvector ≥ 0.8: keeps recall under filters

  return query
  with allowed as (
    select d.*
      from public.ai_documents d
     where d.status = 'active'
       and (p_source_types is null or d.source_type = any(p_source_types))
       and (p_brand_ids    is null or d.brand_id    = any(p_brand_ids))
       and (p_period_from  is null or coalesce(d.period_end, d.period_start) >= p_period_from)
       and (p_period_to    is null or d.period_start <= p_period_to)
       and public.ai_can_read_document(d, v_uid, v_role)
  ),
  sem as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) as rnk
      from public.ai_chunks c
      join allowed a on a.id = c.document_id
     where p_query_embedding is not null and c.embedding is not null
     order by c.embedding <=> p_query_embedding
     limit 60
  ),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, v_tsq) desc) as rnk
      from public.ai_chunks c
      join allowed a on a.id = c.document_id
     where v_tsq is not null and c.fts @@ v_tsq
     order by ts_rank_cd(c.fts, v_tsq) desc
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
    join allowed a on a.id = c.document_id
   order by f.rrf desc;
end;
$$;
revoke execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid) from public, anon;
grant  execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid) to authenticated, service_role;
