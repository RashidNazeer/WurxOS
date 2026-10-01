-- ============================================================
-- 378 — Assistant v2, Phase 5 retrieval layer (phase5-design.md §2).
--
--   pg_trgm                      brand-name resolution by trigram similarity.
--   ai_search(…, p_sections)     + an optional section filter, applied INSIDE
--                                both candidate arms: report search defaults to
--                                narrative sections, and filtering after the
--                                60-candidate cut would let number tables fill it.
--                                An entry matches a section exactly or by its
--                                prefix before ':' ('insights' ⊇ 'insights:gmvmax').
--   ai_get_chunks(doc, from, to) neighbour expansion: a document's chunks by
--                                index range (≤ 21), same identity + ACL as ai_search.
--   ai_resolve_brands(name)      brands the caller can view whose name, client
--                                name or initials match, with a score in [0, 1].
--   ai_report_periods(brands…)   a brand's report calendar (periods + status,
--                                no content): its own week boundaries and
--                                whether a period is covered yet.
--   ai_viewable_brand_ids(uid)   service role only: the brand ids a user can view.
--
-- Identity everywhere: auth.uid(); p_as_user only for the service role (the
-- Slack relay and the eval), exactly as ai_search.  Idempotent.
-- ============================================================

create extension if not exists pg_trgm with schema extensions;

-- ── ai_search: + p_sections. Otherwise as mig 377.
drop function if exists public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid);

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
  v_uid   uuid;
  v_role  text;
  v_text  text := nullif(btrim(coalesce(p_query_text, '')), '');
  v_tsq   tsquery;
  v_model text := public.ai_embed_model();
  v_types text[] := public.ai_source_types();
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

  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with allowed as (
    select d.*
      from public.ai_documents d
     where d.status = 'active'
       and d.source_type = any(v_types)
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
       and c.embedding_model = v_model
       and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
     order by c.embedding <=> p_query_embedding
     limit 60
  ),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, v_tsq) desc) as rnk
      from public.ai_chunks c
      join allowed a on a.id = c.document_id
     where v_tsq is not null and c.fts @@ v_tsq
       and (p_sections is null or c.section = any(p_sections) or split_part(c.section, ':', 1) = any(p_sections))
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
revoke execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[]) from public, anon;
grant  execute on function public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[]) to authenticated, service_role;

-- ── neighbour expansion
create or replace function public.ai_get_chunks(p_document_id uuid, p_from int, p_to int, p_as_user uuid default null)
returns table (
  chunk_id    uuid,
  document_id uuid,
  chunk_index int,
  section     text,
  content     text,
  token_count int
)
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v_uid  uuid;
  v_role text;
  v_doc  public.ai_documents;
begin
  v_uid := case when auth.role() = 'service_role' and p_as_user is not null then p_as_user else auth.uid() end;
  if v_uid is null or p_document_id is null or p_from is null or p_to is null then return; end if;

  select p.role into v_role
    from public.profiles p
   where p.id = v_uid and p.is_active and p.deleted_at is null;
  if v_role is null then return; end if;

  select d.* into v_doc
    from public.ai_documents d
   where d.id = p_document_id and d.status = 'active' and d.source_type = any(public.ai_source_types());
  if not found or not public.ai_can_read_document(v_doc, v_uid, v_role) then return; end if;

  return query
  select c.id, c.document_id, c.chunk_index, c.section, c.content, c.token_count
    from public.ai_chunks c
   where c.document_id = p_document_id
     and c.chunk_index between greatest(p_from, 0) and least(p_to, greatest(p_from, 0) + 20)
   order by c.chunk_index;
end;
$$;
revoke execute on function public.ai_get_chunks(uuid, int, int, uuid) from public, anon;
grant  execute on function public.ai_get_chunks(uuid, int, int, uuid) to authenticated, service_role;

-- ── brand resolution
-- Score: exact name 1 · initials ("PDC") 0.9 · name starts with it 0.9 ·
-- contains it 0.8 · otherwise the best trigram similarity of name / client
-- name (word_similarity lets "bentgo" match "Bentgo Kids"). Below 0.3 is dropped.
create or replace function public.ai_resolve_brands(p_name text, p_as_user uuid default null)
returns table (
  brand_id    uuid,
  brand_name  text,
  client_name text,
  status      text,
  currency    text,
  score       real
)
language plpgsql stable
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid;
  v_q   text := lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
  v_lk  text;
begin
  v_uid := case when auth.role() = 'service_role' and p_as_user is not null then p_as_user else auth.uid() end;
  if v_uid is null or v_q = '' or length(v_q) > 200 then return; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.is_active and p.deleted_at is null) then return; end if;
  v_lk := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  select s.id, s.brand_name, s.client_name, s.status, s.currency, s.sc
    from (
      select b.id, b.brand_name, b.client_name, b.status, b.currency,
             greatest(
               case when lower(b.brand_name) = v_q then 1.0
                    when length(v_q) >= 2 and v_q = (select string_agg(left(w, 1), '')
                                                       from regexp_split_to_table(lower(b.brand_name), '[^a-z0-9]+') w
                                                      where w <> '') then 0.9
                    when length(v_q) >= 3 and lower(b.brand_name) like v_lk || '%' then 0.9
                    when length(v_q) >= 3 and lower(b.brand_name) like '%' || v_lk || '%' then 0.8
                    else 0 end,
               similarity(lower(b.brand_name), v_q),
               word_similarity(v_q, lower(b.brand_name)),
               0.9 * similarity(lower(coalesce(b.client_name, '')), v_q)
             )::real as sc
        from public.brands b
       where public.can_view_brand(b.owner_id, b.id, v_uid)
    ) s
   where s.sc >= 0.3
   order by s.sc desc, s.brand_name
   limit 10;
end;
$$;
revoke execute on function public.ai_resolve_brands(text, uuid) from public, anon;
grant  execute on function public.ai_resolve_brands(text, uuid) to authenticated, service_role;

-- ── report calendar per brand
-- Each brand reports on its own week (498 weekly reports run Sunday–Saturday,
-- one brand Monday–Sunday), so "last week" is resolved from the brand's own
-- recent periods, and the answer can say "not in yet" / "awaiting approval".
-- Periods and status only, never report content; drafts are left out; the
-- caller sees only reports the app lets them see (can_view_report).
create or replace function public.ai_report_periods(p_brand_ids uuid[], p_from date default null, p_to date default null,
                                                    p_limit int default 60, p_as_user uuid default null)
returns table (
  report_id    uuid,
  brand_id     uuid,
  report_type  text,
  status       text,
  period_label text,
  period_start date,
  period_end   date
)
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  v_uid := case when auth.role() = 'service_role' and p_as_user is not null then p_as_user else auth.uid() end;
  if v_uid is null or p_brand_ids is null then return; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.is_active and p.deleted_at is null) then return; end if;

  return query
  select r.id, r.brand_id, r.type, r.status, r.period_label, r.period_start, r.period_end
    from public.reports r
   where r.brand_id = any(p_brand_ids)
     and r.status in ('submitted', 'verified', 'approved')
     and r.period_start is not null
     and (p_from is null or coalesce(r.period_end, r.period_start) >= p_from)
     and (p_to   is null or r.period_start <= p_to)
     and public.can_view_report(r.brand_id, r.author_id, v_uid)
   order by r.period_start desc, r.id
   limit greatest(1, least(coalesce(p_limit, 60), 200));
end;
$$;
revoke execute on function public.ai_report_periods(uuid[], date, date, int, uuid) from public, anon;
grant  execute on function public.ai_report_periods(uuid[], date, date, int, uuid) to authenticated, service_role;

-- ── the brands a user can view, in one call (WP-B data tools: one RPC per
-- request instead of one can_view_brand per brand). Service role only: it
-- takes any uid, so a client must never call it.
create or replace function public.ai_viewable_brand_ids(p_uid uuid)
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
  select b.id from public.brands b where public.can_view_brand(b.owner_id, b.id, p_uid)
$$;
revoke execute on function public.ai_viewable_brand_ids(uuid) from public, anon, authenticated;
grant  execute on function public.ai_viewable_brand_ids(uuid) to service_role;
