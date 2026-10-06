-- ============================================================
-- 373 — Assistant v2: the ingest write path, fingerprints, backfill,
-- reconcile, health stats, and the 'incentive' ACL.
--
-- "Process each piece of data once" (Owner, 2026-09-28):
--   • ai_documents.doc_hash      sha256 of the extracted document (text, header,
--                                ACL, metadata) + pipeline version + embedding
--                                model, computed by the worker. Equal → the
--                                worker skips: no chunking, no API call, no write.
--   • ai_documents.source_fp     md5 of exactly the source columns (+ context:
--                                brand, author, linked SOPs…) the extractor
--                                reads, computed HERE by ai_ingest_source(), so
--                                SQL can tell what changed without running the
--                                extractor. backfill / reconcile enqueue only
--                                rows whose fp or pipeline differs from the
--                                store, and nothing already queued: a second
--                                backfill enqueues nothing.
--   • ai_documents.pipeline_version / embed_model
--                                ai_pipeline_version() below must equal
--                                PIPELINE_VERSION in _shared/ai/config.ts; bump
--                                both together → everything reprocesses once.
--   • ai_ingest_write reuses a stored vector for any chunk whose content_hash
--                                already exists ANYWHERE in the document, so a
--                                shifted chunk is never re-embedded.
--
-- Worker RPCs take the queue id + worker id, verify the worker still holds the
-- row (FOR UPDATE) and complete it in the SAME transaction as the write: a
-- worker that lost its lock writes nothing ({ok:false}).
--
-- Service-only unless noted; ai_backfill and ai_ingest_stats are for the
-- health panel (is_ai_admin) too.
-- Design: Assistant/architecture.md §3, §9; phases.md §2.3–2.10.  Idempotent.
-- ============================================================

alter table public.ai_documents
  add column if not exists pipeline_version text,
  add column if not exists embed_model      text,
  add column if not exists source_fp        text;

alter table public.ai_documents drop constraint if exists ai_documents_acl_mode_check;
alter table public.ai_documents add constraint ai_documents_acl_mode_check
  check (acl_mode in ('all','roles','report','brand','kb','boss','incentive'));

-- ── pipeline constants (bump with config.ts PIPELINE_VERSION) ──────────
-- stable, not immutable: an immutable one could be folded into cached plans
-- and survive the bump.
create or replace function public.ai_pipeline_version() returns text
language sql stable as $$ select '2026-09-28.1'::text $$;
create or replace function public.ai_embed_model() returns text
language sql stable as $$ select 'text-embedding-3-small'::text $$;
revoke execute on function public.ai_pipeline_version() from public, anon;
revoke execute on function public.ai_embed_model() from public, anon;

-- The service role, a direct DB session (scripts, cron), or an AI admin.
create or replace function public.ai_is_service_or_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.role(), '') = 'service_role'
      or session_user = 'postgres'
      or coalesce(public.is_ai_admin(auth.uid()), false);
$$;
revoke execute on function public.ai_is_service_or_admin() from public, anon, authenticated;

-- ── enqueue: an ACL change skips the debounce too (QA L9) ──────────────
-- Mig 372 made a merge due now only for 'delete'. KB ACLs are snapshots in
-- ai_documents, so tightening visibility while a debounced upsert waits would
-- leave the old ACL searchable for the whole debounce. Now a merge involving
-- 'acl' or 'delete' on either side is due now.
create or replace function public.ai_enqueue(
  p_type text, p_id text, p_op text,
  p_priority int default 5,
  p_debounce interval default interval '0',
  p_reason   text default 'trigger')
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.ai_ingest_queue (source_type, source_id, op, priority, reason, not_before)
  values (p_type, p_id, p_op, p_priority::smallint, p_reason,
          case when p_op in ('delete', 'acl') then now() else now() + p_debounce end)
  on conflict (source_type, source_id) where status = 'pending'
  do update set
    enqueued_at = now(),
    not_before  = case when excluded.op in ('delete', 'acl') or ai_ingest_queue.op in ('delete', 'acl') then now()
                       else greatest(ai_ingest_queue.not_before, excluded.not_before) end,
    priority    = least(ai_ingest_queue.priority, excluded.priority),
    op = case when excluded.op = 'delete' or ai_ingest_queue.op = 'delete' then 'delete'
              when excluded.op = 'upsert' or ai_ingest_queue.op = 'upsert' then 'upsert'
              else 'acl' end;
exception when others then
  raise warning 'ai_enqueue failed (% / %): %', p_type, p_id, sqlerrm;
end;
$$;
revoke execute on function public.ai_enqueue(text, text, text, int, interval, text) from public, anon, authenticated;

-- ── incentives: the plan without the read-time-derived fields ──────────
-- achievedValue / completed* are computed live by overlays (ai-chat,
-- incentivesApi.js); a commission_tier amount is derived from FX. Stripping
-- them keeps an APC's progress update from counting as a document change.
create or replace function public.ai_incentive_items(p jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(
           case when e->>'source' = 'commission_tier'
                then (e - 'achievedValue' - 'completed' - 'completedAt' - 'completedBy' - '_commissionInfo') - 'amount'
                else  e - 'achievedValue' - 'completed' - 'completedAt' - 'completedBy' - '_commissionInfo' end
           order by o), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) with ordinality t(e, o)
   where jsonb_typeof(e) = 'object';
$$;
revoke execute on function public.ai_incentive_items(jsonb) from public, anon, authenticated;

-- ── ACL: + 'incentive' ─────────────────────────────────────────────────
-- 'incentive' is the app's inc_select policy (mig 213, verified live on dev
-- 2026-09-28) with auth.uid() → uid and incentives.user_id → d.author_id.
-- Every other branch is unchanged from mig 372.
create or replace function public.ai_can_read_document(d public.ai_documents, uid uuid, urole text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(case
    when urole = 'boss'           then true
    when d.acl_mode = 'all'       then true
    when d.acl_mode = 'roles'     then urole = any(d.acl_roles)
    when d.acl_mode = 'report'    then public.can_view_report(d.brand_id, d.author_id, uid)
    when d.acl_mode = 'brand'     then exists (
                                         select 1 from public.brands b
                                          where b.id = d.brand_id
                                            and public.can_view_brand(b.owner_id, b.id, uid))
    when d.acl_mode = 'kb'        then urole in ('ol','developer')
                                    or d.author_id = uid
                                    or d.metadata->>'submitted_by' = uid::text
                                    or coalesce(d.metadata->>'visibility','') = 'office'
                                    or (d.metadata->>'visibility' = 'role'  and urole = any(d.acl_roles))
                                    or (d.metadata->>'visibility' = 'users' and uid   = any(d.acl_users))
    when d.acl_mode = 'boss'      then urole = any(d.acl_roles)
    when d.acl_mode = 'incentive' then uid = d.author_id
                                    or public.is_boss(uid)
                                    or exists (select 1 from public.profiles p where p.id = uid and p.role = 'ol' and p.is_active = true)
                                    or exists (select 1 from public.profiles p where p.id = d.author_id and p.reports_to = uid)
    else false
  end, false);
$$;
revoke execute on function public.ai_can_read_document(public.ai_documents, uuid, text) from public, anon, authenticated;

-- ── loader: live rows + context + fingerprint, one statement per call ──
-- Returns [{source_id, indexable, fp, payload, ord}]. p_ids null = every row of
-- the type (backfill / reconcile / dry run); p_payload=false omits payloads.
-- `indexable` must agree with the TS extractor's indexable() (the dry run
-- checks it on real data): a disagreement would be re-enqueued every night.
-- fp covers exactly what the extractor reads; updated_at is payload-only.
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
             'indexable', s.status in ('submitted','verified','approved'),
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
                                'brand_name', b.brand_name, 'client_name', b.client_name, 'currency', b.currency) end,
                     'author_name', p.display_name) as j
              from public.reports r
              left join public.brands   b on b.id = r.brand_id
              left join public.profiles p on p.id = r.author_id
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

-- ── what the store holds: [{source_id, doc_hash, source_fp, pipeline_version,
--    embed_model, status, chunk_hashes (by chunk_index)}] ────────────────
create or replace function public.ai_ingest_existing(p_type text, p_ids text[] default null)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'source_id', d.source_id, 'doc_hash', d.doc_hash, 'source_fp', d.source_fp,
           'pipeline_version', d.pipeline_version, 'embed_model', d.embed_model, 'status', d.status,
           'chunk_hashes', coalesce((select jsonb_agg(c.content_hash order by c.chunk_index)
                                       from public.ai_chunks c where c.document_id = d.id), '[]'::jsonb))), '[]'::jsonb)
    from public.ai_documents d
   where d.source_type = p_type and (p_ids is null or d.source_id = any(p_ids));
$$;
revoke execute on function public.ai_ingest_existing(text, text[]) from public, anon, authenticated;

-- ── lock check: this worker still holds the queue row (and now locks it) ─
create or replace function public.ai_ingest_holds(p_queue_id bigint, p_worker text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  perform 1 from public.ai_ingest_queue
   where id = p_queue_id and status = 'processing' and locked_by = p_worker
   for update;
  return found;
end;
$$;
revoke execute on function public.ai_ingest_holds(bigint, text) from public, anon, authenticated;

-- ── the write: one document + its chunks, one transaction ──────────────
-- p_chunks: [{chunk_index, section, content, embed_text, token_count,
-- content_hash, embedding (array | null)}], the COMPLETE new chunk list.
--   • a null embedding reuses the stored vector of any chunk of this document
--     with the same content_hash (same text, any position); none → error
--   • same hash at the same index, same content → untouched (no updated_at)
--   • same hash, different content (e.g. status in the content header) →
--     content updated, vector kept
--   • chunks at index ≥ the new count are deleted
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
  -- Defence in depth (A§4.4, QA R8): these are served only by role-checked
  -- tools, whatever an extractor might try to write. ('incentive' plans are
  -- indexed under their own ACL mode, see ai_can_read_document.)
  if lower(p_doc->>'source_type') ~ '^(salar|compensation|attendance|leave|performance)' then
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

-- Hard delete when the source row is gone (chunks cascade). Soft delete when
-- it still exists but is not indexable (draft, unapproved, superseded,
-- inactive): status 'deleted' hides it from ai_search at once, and the chunks
-- keep their vectors, so re-publishing the same text embeds nothing.
create or replace function public.ai_ingest_delete(p_type text, p_id text, p_queue_id bigint default null,
                                                   p_worker text default null, p_soft boolean default false)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_n int;
begin
  if p_queue_id is not null and not public.ai_ingest_holds(p_queue_id, p_worker) then
    return jsonb_build_object('ok', false, 'reason', 'lost_lock');
  end if;
  if p_soft then
    update public.ai_documents set status = 'deleted', indexed_at = now()
     where source_type = p_type and source_id = p_id and status <> 'deleted';
  else
    delete from public.ai_documents where source_type = p_type and source_id = p_id;
  end if;
  get diagnostics v_n = row_count;
  if p_queue_id is not null then perform public.ai_ingest_complete(p_queue_id, p_worker); end if;
  return jsonb_build_object('ok', true, 'deleted', v_n, 'soft', p_soft);
end;
$$;
revoke execute on function public.ai_ingest_delete(text, text, bigint, text, boolean) from public, anon, authenticated;

-- Document unchanged but its SQL fingerprint moved: record the new fp only,
-- so backfill/reconcile stop flagging it. No chunk is touched.
create or replace function public.ai_ingest_touch(p_type text, p_id text, p_fp text, p_queue_id bigint default null, p_worker text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if p_queue_id is not null and not public.ai_ingest_holds(p_queue_id, p_worker) then
    return jsonb_build_object('ok', false, 'reason', 'lost_lock');
  end if;
  update public.ai_documents set source_fp = p_fp where source_type = p_type and source_id = p_id;
  if p_queue_id is not null then perform public.ai_ingest_complete(p_queue_id, p_worker); end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke execute on function public.ai_ingest_touch(text, text, text, bigint, text) from public, anon, authenticated;

-- ── run bookkeeping (ai_ingest_runs) ───────────────────────────────────
create or replace function public.ai_ingest_run_start(p_kind text default 'ingest', p_worker text default null)
returns bigint
language sql security definer
set search_path = public
as $$
  insert into public.ai_ingest_runs (kind, stats) values (p_kind, jsonb_build_object('worker', p_worker)) returning id;
$$;
revoke execute on function public.ai_ingest_run_start(text, text) from public, anon, authenticated;

create or replace function public.ai_ingest_run_finish(p_id bigint, p_stats jsonb, p_error text default null)
returns void
language sql security definer
set search_path = public
as $$
  update public.ai_ingest_runs
     set finished_at       = now(),
         claimed           = coalesce((p_stats->>'claimed')::int, claimed),
         succeeded         = coalesce((p_stats->>'succeeded')::int, succeeded),
         failed            = coalesce((p_stats->>'failed')::int, failed),
         skipped_unchanged = coalesce((p_stats->>'skipped_unchanged')::int, skipped_unchanged),
         embedded_chunks   = coalesce((p_stats->>'embedded_chunks')::int, embedded_chunks),
         embed_tokens      = coalesce((p_stats->>'embed_tokens')::int, embed_tokens),
         stats             = stats || coalesce(p_stats, '{}'::jsonb),
         error             = left(p_error, 1000)
   where id = p_id;
$$;
revoke execute on function public.ai_ingest_run_finish(bigint, jsonb, text) from public, anon, authenticated;

-- ── what is out of date: shared by backfill and reconcile (QA R4) ──────
-- Read-only. For one source type:
--   upsert  indexable, and missing from the store, soft-deleted, or its fp /
--           pipeline version / model differs          why: missing | revived | changed | pipeline
--   delete  in the store (active), but the source row is gone (orphan) or no
--           longer indexable                          why: orphan | not indexable
-- On an empty store the upserts are exactly the indexable rows.
create or replace function public.ai_backfill_candidates(p_type text)
returns table (source_id text, op text, why text, ord bigint)
language sql stable security definer
set search_path = public
as $$
  with src as (
    select x->>'source_id' as sid, (x->>'indexable')::boolean as ix, x->>'fp' as fp, o
      from jsonb_array_elements(public.ai_ingest_source(p_type, null, false)) with ordinality t(x, o)
  ), doc as (
    select d.source_id, d.source_fp, d.pipeline_version, d.embed_model, d.status
      from public.ai_documents d where d.source_type = p_type
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

create or replace function public.ai_source_types() returns text[]
language sql immutable as $$
  select array['kb_article','ai_doc','app_guide','tts_article','report','incentive']
$$;
revoke execute on function public.ai_source_types() from public, anon;

-- Enqueue what ai_backfill_candidates reports, skipping anything already
-- pending or processing (so a second backfill enqueues nothing). At most
-- p_pipeline_budget items whose only reason is a pipeline/model change (null =
-- no limit). Returns {type: {why: count}}.
create or replace function public.ai_enqueue_stale(p_types text[], p_priority int, p_reason text, p_stagger boolean,
                                                   p_pipeline_budget int default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  t text;
  r record;
  v_rank int := 0;
  v_drift int := 0;
  v_out jsonb := '{}'::jsonb;
  v_counts jsonb;
begin
  foreach t in array p_types loop
    v_counts := '{}'::jsonb;
    for r in
      select s.source_id, s.op, s.why
        from public.ai_backfill_candidates(t) s
       where not exists (select 1 from public.ai_ingest_queue q
                          where q.source_type = t and q.source_id = s.source_id
                            and q.status in ('pending', 'processing'))
       order by s.ord
    loop
      if r.why = 'pipeline' then
        if p_pipeline_budget is not null and v_drift >= p_pipeline_budget then continue; end if;
        v_drift := v_drift + 1;
      end if;
      v_rank := v_rank + 1;
      -- Staggering not_before by 1 ms keeps the claim order = this order
      -- (KB → docs → guides → TikTok → reports newest first → incentives).
      perform public.ai_enqueue(t, r.source_id, r.op, p_priority,
                                case when p_stagger then make_interval(secs => v_rank / 1000.0) else interval '0' end,
                                p_reason);
      v_counts := jsonb_set(v_counts, array[r.why], to_jsonb(coalesce((v_counts->>r.why)::int, 0) + 1));
    end loop;
    if v_counts <> '{}'::jsonb then v_out := v_out || jsonb_build_object(t, v_counts); end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.ai_enqueue_stale(text[], int, text, boolean, int) from public, anon, authenticated;

-- ── backfill: priority 9, only what differs from the store ─────────────
create or replace function public.ai_backfill(p_source_type text default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not public.ai_is_service_or_admin() then raise exception 'not allowed'; end if;
  if p_source_type is not null and not (p_source_type = any(public.ai_source_types())) then
    raise exception 'unknown source type %', p_source_type;
  end if;
  v := public.ai_enqueue_stale(case when p_source_type is null then public.ai_source_types() else array[p_source_type] end,
                               9, 'backfill', true);
  insert into public.ai_ingest_runs (kind, finished_at, stats) values ('backfill', now(), jsonb_build_object('enqueued', v));
  return v;
end;
$$;
revoke execute on function public.ai_backfill(text) from public, anon;
grant  execute on function public.ai_backfill(text) to authenticated;

-- ── reconcile (nightly): catches anything a trigger missed ─────────────
-- Same comparison as backfill at priority 8; orphans become deletes. Pipeline
-- / model drift is re-done at most p_pipeline_budget documents a night (A§9.7);
-- after a planned bump, run ai_backfill() instead to do it all at once. A
-- non-zero 'missing' or 'changed' on consecutive nights means a trigger bug.
create or replace function public.ai_reconcile(p_pipeline_budget int default 500)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v jsonb;
begin
  if not public.ai_is_service_or_admin() then raise exception 'not allowed'; end if;
  v := public.ai_enqueue_stale(public.ai_source_types(), 8, 'reconcile', false, p_pipeline_budget);
  insert into public.ai_ingest_runs (kind, finished_at, stats) values ('reconcile', now(), jsonb_build_object('enqueued', v));
  return v;
end;
$$;
revoke execute on function public.ai_reconcile(int) from public, anon, authenticated;

-- ── health panel ───────────────────────────────────────────────────────
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

-- ── ai_search: the semantic arm compares only vectors of the ACTIVE model ─
-- (A§7): during a model change old and new vectors live in different spaces
-- and a cosine distance between them is meaningless; the keyword arm still
-- finds not-yet-re-embedded chunks. Otherwise verbatim from mig 372.
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
