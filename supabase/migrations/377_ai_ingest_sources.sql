-- ============================================================
-- 377 — Assistant v2: which sources may be indexed is a SETTING (QA B1, B2).
--
--   ai_assistant_config.ingest_sources   the allow-list, admin-editable (the
--                                        existing ai_config_write policy:
--                                        is_ai_admin). Default: every source.
--   ai_source_types()                    returns that list (canonical order).
--
-- One statement switches a source off, e.g.
--   update public.ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'incentive');
-- and then, with no other step:
--   • ai_search hides its documents at once, for everyone including the Boss;
--   • ai_ingest_write refuses it (B1: an allow-list, not an anchored deny-list);
--   • the worker completes queued items of it with a soft delete of the
--     document (no 5-fail loop, no embeds);
--   • backfill / reconcile skip it, so nothing comes back;
--   • the 374 triggers stop enqueueing it (ai_source_enabled; 374 therefore
--     needs this migration first).
-- Its documents and vectors are kept (hidden): switching it back on and running
-- a backfill revives them with 0 embeds for unchanged text.
-- Only AI admins can change the list (policy ai_config_write, mig 206).
--
-- Also L1: the report fingerprint no longer includes the author's name.
-- Idempotent.
-- ============================================================

alter table public.ai_assistant_config
  add column if not exists ingest_sources text[] not null
    default '{report,kb_article,ai_doc,app_guide,tts_article,incentive}';

-- Canonical order (backfill enqueues in it: KB → docs → guides → TikTok →
-- reports → incentives), then any other enabled name. No config row → nothing
-- is enabled (fail closed).
create or replace function public.ai_source_types() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array(
    select t from unnest((select c.ingest_sources from public.ai_assistant_config c order by c.id limit 1)) t
     order by array_position(array['kb_article','ai_doc','app_guide','tts_article','report','incentive'], t) nulls last, t), '{}');
$$;
revoke execute on function public.ai_source_types() from public, anon;

create or replace function public.ai_source_enabled(p_type text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_type = any(public.ai_source_types());
$$;
revoke execute on function public.ai_source_enabled(text) from public, anon, authenticated;

-- ── L1: the report fingerprint without the author name (the extractor never
-- reads it; a profile rename no longer touches every report). Otherwise as mig 376.

create or replace function public.ai_ingest_source(p_type text, p_ids text[] default null, p_payload boolean default true)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v jsonb;
begin
  if p_type = 'report' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'source_id', s.id::text,
             'indexable', s.status = 'approved',   -- Owner decision: approved only
             'fp', md5(s.j::text),
             'payload', case when p_payload then s.j || jsonb_build_object('updated_at', s.updated_at) end)
           order by s.period_start desc nulls last, s.id), '[]'::jsonb)
      into v
      from (select r.id, r.status, r.updated_at, r.period_start,
                   jsonb_build_object(
                     'row', jsonb_build_object('id', r.id, 'type', r.type, 'brand_id', r.brand_id, 'author_id', r.author_id,
                              'status', r.status, 'period_label', r.period_label, 'period_start', r.period_start,
                              'period_end', r.period_end, 'data', r.data, 'sections_enabled', r.sections_enabled,
                              'legacy_id', r.legacy_id),
                     'brand', case when b.id is not null then jsonb_build_object(
                                'brand_name', b.brand_name, 'client_name', b.client_name, 'currency', b.currency) end) as j
              from public.reports r
              left join public.brands   b on b.id = r.brand_id
             where p_ids is null or r.id = any(p_ids::uuid[])) s;

  elsif p_type = 'kb_article' then
    -- Latest APPROVED version per SOP group, as ai-chat picks it.
    select coalesce(jsonb_agg(jsonb_build_object(
             'source_id', s.id::text,
             'indexable', s.approval_status = 'approved' and s.is_latest,
             'fp', md5(s.j::text),
             'payload', case when p_payload then s.j || jsonb_build_object('updated_at', s.updated_at) end)
           order by s.id), '[]'::jsonb)
      into v
      from (select k.id, k.approval_status, coalesce(l.is_latest, false) as is_latest,
                   greatest(k.updated_at, (select max(d.updated_at) from public.ai_assistant_docs d where d.kb_article_id = k.id)) as updated_at,
                   jsonb_build_object(
                     'row', jsonb_build_object('id', k.id, 'title', k.title, 'body', k.body, 'url', k.url, 'category', k.category,
                              'tags', k.tags, 'visibility', k.visibility, 'visible_to_roles', k.visible_to_roles,
                              'visible_to_users', k.visible_to_users, 'created_by', k.created_by, 'submitted_by', k.submitted_by,
                              'approval_status', k.approval_status, 'sop_group_id', k.sop_group_id, 'version', k.version,
                              'version_label', k.version_label, 'requires_ack', k.requires_ack),
                     'is_latest', coalesce(l.is_latest, false),
                     'linked_docs', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'title', d.title, 'content', d.content,
                                                'is_active', d.is_active, 'kind', d.kind, 'kb_article_id', d.kb_article_id) order by d.id)
                                                from public.ai_assistant_docs d where d.kb_article_id = k.id), '[]'::jsonb)) as j
              from public.kb_articles k
              left join (select a.id, row_number() over (partition by coalesce(a.sop_group_id, a.id)
                                                          order by a.version desc nulls last, a.id) = 1 as is_latest
                           from public.kb_articles a where a.approval_status = 'approved') l on l.id = k.id
             where p_ids is null or k.id = any(p_ids::uuid[])) s;

  elsif p_type in ('ai_doc', 'app_guide') then
    -- A full scan lists only this kind; an explicit id is returned whatever its
    -- kind, so a doc that changed kind reads as not indexable and is removed.
    select coalesce(jsonb_agg(jsonb_build_object(
             'source_id', s.id::text,
             'indexable', s.kind = (case p_type when 'ai_doc' then 'doc' else 'app_guide' end)
                          and s.is_active and s.kb_article_id is null
                          and strpos(s.content, '<!--wurx-sop-import-->') = 0,
             'fp', md5(s.j::text),
             'payload', case when p_payload then s.j || jsonb_build_object('updated_at', s.updated_at) end)
           order by s.id), '[]'::jsonb)
      into v
      from (select d.id, d.kind, d.is_active, d.kb_article_id, d.content, d.updated_at,
                   jsonb_build_object('row', jsonb_build_object('id', d.id, 'title', d.title, 'content', d.content,
                     'is_active', d.is_active, 'kind', d.kind, 'slug', d.slug, 'meta', d.meta, 'kb_article_id', d.kb_article_id)) as j
              from public.ai_assistant_docs d
             where (p_ids is null and d.kind = (case p_type when 'ai_doc' then 'doc' else 'app_guide' end))
                or d.id = any(p_ids::uuid[])) s;

  elsif p_type = 'tts_article' then
    -- views / last_seen_at / missed_crawls are crawl bookkeeping, not content.
    select coalesce(jsonb_agg(jsonb_build_object(
             'source_id', s.knowledge_id,
             'indexable', s.is_active,
             'fp', md5(s.j::text),
             'payload', case when p_payload then s.j || jsonb_build_object('updated_at', s.updated_at) end)
           order by s.knowledge_id), '[]'::jsonb)
      into v
      from (select t.knowledge_id, t.is_active, t.updated_at,
                   jsonb_build_object('row', jsonb_build_object('knowledge_id', t.knowledge_id, 'kind', t.kind, 'url', t.url,
                     'title', t.title, 'breadcrumb', t.breadcrumb, 'course', t.course, 'keywords', t.keywords,
                     'applies_to', t.applies_to, 'source', t.source, 'ai_summary', t.ai_summary, 'toc', t.toc,
                     'body', t.body, 'source_modified_at', t.source_modified_at, 'is_active', t.is_active)) as j
              from public.tts_articles t
             where p_ids is null or t.knowledge_id = any(p_ids)) s;

  elsif p_type = 'incentive' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'source_id', s.id::text,
             'indexable', jsonb_array_length(s.j->'row'->'incentives') + jsonb_array_length(s.j->'row'->'bonuses') > 0,
             'fp', md5(s.j::text),
             'payload', case when p_payload then s.j || jsonb_build_object('updated_at', s.updated_at) end)
           order by s.month desc, s.id), '[]'::jsonb)
      into v
      from (select i.id, i.month, i.updated_at,
                   jsonb_build_object(
                     'row', jsonb_build_object('id', i.id, 'user_id', i.user_id, 'month', i.month,
                              'incentives', public.ai_incentive_items(i.incentives),
                              'bonuses', public.ai_incentive_items(i.bonuses),
                              'verified', i.verified, 'payout_cleared', i.payout_cleared),
                     'person', jsonb_build_object('name', p.display_name, 'role', p.role),
                     'brands', coalesce((select jsonb_object_agg(b.id::text, b.brand_name)
                                           from public.brands b
                                          where b.id::text in (select e->>'brandId'
                                                                 from jsonb_array_elements(coalesce(i.incentives, '[]'::jsonb) || coalesce(i.bonuses, '[]'::jsonb)) e
                                                                where jsonb_typeof(e) = 'object')), '{}'::jsonb)) as j
              from public.incentives i
              left join public.profiles p on p.id = i.user_id
             where p_ids is null or i.id = any(p_ids::uuid[])) s;

  else
    raise exception 'ai_ingest_source: unknown source type %', p_type;
  end if;
  return v;
end;
$$;
revoke execute on function public.ai_ingest_source(text, text[], boolean) from public, anon, authenticated;

-- ── the write: allow-list first (B1). Otherwise as mig 373.

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
  v_missing int;
  v_changed int;
  v_deleted int;
begin
  if p_queue_id is not null and not public.ai_ingest_holds(p_queue_id, p_worker) then
    return jsonb_build_object('ok', false, 'reason', 'lost_lock');
  end if;
  if coalesce(p_doc->>'source_type', '') = '' or coalesce(p_doc->>'source_id', '') = ''
     or coalesce(p_doc->>'doc_hash', '') = '' or coalesce(v_model, '') = '' then
    raise exception 'ai_ingest_write: source_type, source_id, doc_hash and embed_model are required';
  end if;
  -- QA B1: an ALLOW-list (the admin setting ai_assistant_config.ingest_sources)
  -- decides what may enter the store; anything else is refused. The deny-list
  -- stays as a second net, matched anywhere in the name (A§4.4).
  if not (p_doc->>'source_type' = any(public.ai_source_types())) then
    raise exception 'ai_ingest_write: source type % is not enabled for indexing', p_doc->>'source_type';
  end if;
  if lower(p_doc->>'source_type') ~ '(salar|compensation|payroll|attendance|leave|performance|basic_salary)' then
    raise exception 'ai_ingest_write: source type % is never indexed', p_doc->>'source_type';
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

  select count(*) into v_missing
    from jsonb_array_elements(v_chunks) c
   where jsonb_typeof(c->'embedding') is distinct from 'array'
     and not exists (select 1 from public.ai_chunks o
                      where o.document_id = v_id and o.content_hash = c->>'content_hash'
                        and o.embedding is not null and o.embedding_model = v_model);
  if v_missing > 0 then
    raise exception 'ai_ingest_write: % chunk(s) have no embedding and no stored vector to reuse', v_missing;
  end if;

  -- One statement: `old` sees the vectors as they were before any row moves.
  with incoming as (
    select (c->>'chunk_index')::int as ci, c->>'section' as sec, c->>'content' as content, c->>'embed_text' as et,
           (c->>'token_count')::int as tc, c->>'content_hash' as h,
           case when jsonb_typeof(c->'embedding') = 'array' then (c->'embedding')::text::extensions.vector end as emb
      from jsonb_array_elements(v_chunks) c
  ), old as (
    select distinct on (content_hash) content_hash, embedding
      from public.ai_chunks
     where document_id = v_id and embedding is not null and embedding_model = v_model
     order by content_hash, chunk_index
  )
  insert into public.ai_chunks as t (document_id, chunk_index, section, content, embed_text, token_count,
                                     content_hash, embedding, embedding_model)
  select v_id, i.ci, i.sec, i.content, i.et, i.tc, i.h, coalesce(i.emb, o.embedding), v_model
    from incoming i left join old o on o.content_hash = i.h
  on conflict (document_id, chunk_index) do update set
    section = excluded.section, content = excluded.content, embed_text = excluded.embed_text,
    token_count = excluded.token_count, content_hash = excluded.content_hash,
    embedding = case when t.content_hash = excluded.content_hash and t.embedding_model = excluded.embedding_model
                      and t.embedding is not null then t.embedding else excluded.embedding end,
    embedding_model = excluded.embedding_model, updated_at = now()
  where (t.section, t.content, t.embed_text, t.token_count, t.content_hash, t.embedding_model)
        is distinct from
        (excluded.section, excluded.content, excluded.embed_text, excluded.token_count, excluded.content_hash, excluded.embedding_model);
  get diagnostics v_changed = row_count;

  delete from public.ai_chunks where document_id = v_id and chunk_index >= v_n;
  get diagnostics v_deleted = row_count;

  if p_queue_id is not null then perform public.ai_ingest_complete(p_queue_id, p_worker); end if;
  return jsonb_build_object('ok', true, 'document_id', v_id, 'chunks', v_n, 'changed', v_changed, 'deleted', v_deleted);
end;
$$;
revoke execute on function public.ai_ingest_write(jsonb, jsonb, bigint, text) from public, anon, authenticated;

-- ── candidates: a disabled source has none, in either direction (its hidden
-- documents are neither re-added nor deleted). Otherwise as mig 373.
create or replace function public.ai_backfill_candidates(p_type text)
returns table (source_id text, op text, why text, ord bigint)
language sql stable security definer
set search_path = public
as $$
  with enabled as (
    select public.ai_source_enabled(p_type) as on_
  ), src as (
    select x->>'source_id' as sid, (x->>'indexable')::boolean as ix, x->>'fp' as fp, o
      from enabled, jsonb_array_elements(case when enabled.on_ then public.ai_ingest_source(p_type, null, false) else '[]'::jsonb end)
           with ordinality t(x, o)
  ), doc as (
    select d.source_id, d.source_fp, d.pipeline_version, d.embed_model, d.status
      from public.ai_documents d, enabled
     where d.source_type = p_type and enabled.on_
  )
  select s.sid, 'upsert',
         case when d.source_id is null then 'missing'
              when d.status <> 'active' then 'revived'
              when d.source_fp is distinct from s.fp then 'changed'
              else 'pipeline' end,
         s.o
    from src s left join doc d on d.source_id = s.sid
   where s.ix and (d.source_id is null or d.status <> 'active' or d.source_fp is distinct from s.fp
                   or d.pipeline_version is distinct from public.ai_pipeline_version()
                   or d.embed_model is distinct from public.ai_embed_model())
  union all
  select d.source_id, 'delete', case when s.sid is null then 'orphan' else 'not indexable' end, 0
    from doc d left join src s on s.sid = d.source_id
   where s.sid is null or (not s.ix and d.status = 'active');
$$;
revoke execute on function public.ai_backfill_candidates(text) from public, anon, authenticated;

-- ── backfill: a disabled (or unknown) source enqueues nothing. Otherwise as mig 373.
create or replace function public.ai_backfill(p_source_type text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not public.ai_is_service_or_admin() then raise exception 'not allowed'; end if;
  if p_source_type is not null and not public.ai_source_enabled(p_source_type) then
    raise notice 'ai_backfill: source type % is not enabled (ai_assistant_config.ingest_sources)', p_source_type;
    return '{}'::jsonb;
  end if;
  v := public.ai_enqueue_stale(case when p_source_type is null then public.ai_source_types() else array[p_source_type] end,
                               9, 'backfill', true);
  insert into public.ai_ingest_runs (kind, finished_at, stats) values ('backfill', now(), jsonb_build_object('enqueued', v));
  return v;
end;
$$;
revoke execute on function public.ai_backfill(text) from public, anon;
grant  execute on function public.ai_backfill(text) to authenticated;

-- ── health panel: + the enabled source list. Otherwise as mig 373.

create or replace function public.ai_ingest_stats()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.ai_is_service_or_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'pipeline_version', public.ai_pipeline_version(),
    'embed_model', public.ai_embed_model(),
    'ingest_sources', to_jsonb(public.ai_source_types()),
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
    'freshness_p95_seconds_24h', (select percentile_cont(0.95) within group (order by extract(epoch from done_at - enqueued_at))
                                    from public.ai_ingest_queue
                                   where status = 'done' and done_at > now() - interval '24 hours'),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
                select id, kind, started_at, finished_at, claimed, succeeded, failed, skipped_unchanged,
                       embedded_chunks, embed_tokens, error
                  from public.ai_ingest_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$$;
revoke execute on function public.ai_ingest_stats() from public, anon;
grant  execute on function public.ai_ingest_stats() to authenticated;

-- ── ai_search: only enabled sources (B2). Otherwise as mig 373.

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
       and d.source_type = any(v_types)          -- a source switched off is hidden at once
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

