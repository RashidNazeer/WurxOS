-- ============================================================
-- 376 — Assistant v2: only APPROVED reports are indexed.
--
-- Owner decision (2026-09-28, overrides D2): submitted, verified, draft and
-- any other status are not indexable. A report that leaves approved is
-- soft-deleted (status 'deleted', vectors kept), so re-approving the same
-- text embeds nothing. The TypeScript twin is reportExtractor.indexable
-- (extractors/report.ts); the reports trigger (mig 374) enqueues on the same
-- rule. ai_ingest_source is redefined whole; only the report `indexable`
-- line differs from mig 373.  Idempotent.
-- ============================================================

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
