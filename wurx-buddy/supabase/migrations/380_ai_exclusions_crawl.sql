-- ============================================================
-- 380 — Assistant v2: save-time source check (M1-b), the Boss's document
-- exclusion list, and the state of the weekly TikTok Shop Academy re-crawl.
-- Owner decisions 2026-09-29. Needs 377 and 379 (ai_source_canon,
-- ai_is_test_source). Schedules nothing: the crawl jobs are mig 381.
--
-- 1. M1-b  ai_assistant_config.ingest_sources refuses, when saved, any name that
--          is neither a known source (ai_source_canon) nor a test fixture
--          (ai_is_test_source). 379's ignore-and-report stays as a second net.
--
-- 2. ai_excluded_documents (source_type, source_id)   Boss-managed (is_ai_admin).
--    An excluded document is, at once and for everyone including the Boss:
--      • hidden by ai_search / ai_get_chunks (ai_can_read_document);
--      • not indexable in ai_ingest_source (flag `excluded`): the next sweep
--        queues a soft delete, the worker performs it (plan.ts honours the
--        flag), and no sweep adds it back. Removing the row revives it at the
--        next sweep (0 embeds for unchanged text).
--    Seeded with the junk KB article "testing doc".
--
-- 3. The crawl (edge function tts-crawl, _shared/ai/crawl/*), one run a week:
--      idle → discover (sitemap → ai_crawl_items) → crawl (one page per item,
--      politely; a JS-only shell is retried with backoff) → finalize (records →
--      the importer's winner rules → ai_tts_apply writes only new / changed /
--      revived rows) → idle (ai_crawl_finish: articles missing from 3
--      consecutive crawls → is_active = false).
--    Each call holds a 3-minute lease on ai_crawl_state, so ticks never overlap.
--    ai_crawl_tick() posts to the function only while a crawl is running.
--
-- Service-only unless noted. Idempotent.
-- Design: Assistant/architecture.md §9.8; runbook-ingestion.md.
-- ============================================================

-- ── 1. M1-b: refuse unknown source names when the setting is saved ──────
-- security definer: the Boss saves through RLS as `authenticated`, which has
-- no EXECUTE on ai_source_canon / ai_is_test_source.
create or replace function public.ai_trg_ingest_sources_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_bad text[];
begin
  select array_agg(distinct coalesce(t, '<null>')) into v_bad
    from unnest(new.ingest_sources) t
   where t is null or not (t = any(public.ai_source_canon()) or public.ai_is_test_source(t));
  if v_bad is not null then
    raise exception 'ingest_sources: unknown source name(s) %; allowed: %',
      array_to_string(v_bad, ', '), array_to_string(public.ai_source_canon(), ', ')
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.ai_trg_ingest_sources_check() from public, anon, authenticated;

create or replace trigger ai_assistant_config_sources_check
  before insert or update of ingest_sources on public.ai_assistant_config
  for each row execute function public.ai_trg_ingest_sources_check();

-- ── 2. the exclusion list ──────────────────────────────────────────────
create table if not exists public.ai_excluded_documents (
  source_type  text not null check (source_type <> ''),
  source_id    text not null check (source_id <> ''),
  reason       text not null default '',
  excluded_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  excluded_at  timestamptz not null default now(),
  primary key (source_type, source_id)
);
alter table public.ai_excluded_documents enable row level security;
drop policy if exists "ai_excluded_documents_admin" on public.ai_excluded_documents;
create policy "ai_excluded_documents_admin" on public.ai_excluded_documents for all
  using (public.is_ai_admin((select auth.uid())))
  with check (public.is_ai_admin((select auth.uid())));
-- TRUNCATE ignores RLS: never a client privilege.
revoke all on public.ai_excluded_documents from anon;
revoke truncate, references, trigger on public.ai_excluded_documents from authenticated;
grant select, insert, update, delete on public.ai_excluded_documents to authenticated;

insert into public.ai_excluded_documents (source_type, source_id, reason)
values ('kb_article', '833b9bda-8282-41dc-a8da-8ff3f032354d', 'junk test article, Owner 2026-09-29')
on conflict (source_type, source_id) do nothing;

-- As mig 373, plus: an excluded document is readable by nobody (the Boss included).
create or replace function public.ai_can_read_document(d public.ai_documents, uid uuid, urole text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select not exists (select 1 from public.ai_excluded_documents e
                      where e.source_type = d.source_type and e.source_id = d.source_id)
     and coalesce(case
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

-- As mig 377, plus the last step: excluded ids read {indexable:false, excluded:true}.
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

  if exists (select 1 from public.ai_excluded_documents e where e.source_type = p_type) then
    select coalesce(jsonb_agg(case when e.source_id is null then x
                                   else x || '{"indexable": false, "excluded": true}'::jsonb end order by o), '[]'::jsonb)
      into v
      from jsonb_array_elements(v) with ordinality t(x, o)
      left join public.ai_excluded_documents e on e.source_type = p_type and e.source_id = x->>'source_id';
  end if;
  return v;
end;
$$;
revoke execute on function public.ai_ingest_source(text, text[], boolean) from public, anon, authenticated;

-- ── 3. the TikTok Shop Academy crawl ───────────────────────────────────
create table if not exists public.ai_crawl_state (
  id              int primary key default 1 check (id = 1),
  status          text not null default 'idle' check (status in ('idle','discover','crawl','finalize')),
  crawl_no        int not null default 0,
  started_at      timestamptz,
  finished_at     timestamptz,
  lease_owner     text,
  lease_until     timestamptz,
  finalize_after  text,                         -- finalize cursor: last knowledge_id applied
  stats           jsonb not null default '{}'::jsonb,
  last_error      text,
  errors          int not null default 0,
  updated_at      timestamptz not null default now()
);
insert into public.ai_crawl_state (id) values (1) on conflict (id) do nothing;

-- One row per page of the current crawl (emptied when the next one starts).
create table if not exists public.ai_crawl_items (
  id          bigserial primary key,
  key         text not null unique,              -- 'essay:<knowledge_id>' | 'course:<learning_id>'
  kind        text not null check (kind in ('essay','course')),
  item_id     text not null,
  url         text not null,
  discovered  boolean not null default false,    -- found through page links, not in the sitemap
  status      text not null default 'pending' check (status in ('pending','done','dead','failed')),
  attempts    int not null default 0,
  not_before  timestamptz not null default now(),
  last_error  text,
  done_at     timestamptz
);
create index if not exists ai_crawl_items_due_idx on public.ai_crawl_items (status, not_before, id);

-- The crawler's records (an essay: one; a course: one per lesson).
create table if not exists public.ai_crawl_records (
  item_id    bigint not null references public.ai_crawl_items(id) on delete cascade,
  ord        int not null,
  record_id  text not null,
  record     jsonb not null,
  primary key (item_id, ord)
);
create index if not exists ai_crawl_records_id_idx on public.ai_crawl_records (record_id);

alter table public.ai_crawl_state   enable row level security;
alter table public.ai_crawl_items   enable row level security;
alter table public.ai_crawl_records enable row level security;
drop policy if exists "ai_crawl_state_admin_read" on public.ai_crawl_state;
create policy "ai_crawl_state_admin_read" on public.ai_crawl_state for select
  using (public.is_ai_admin((select auth.uid())));
revoke all on public.ai_crawl_state, public.ai_crawl_items, public.ai_crawl_records from anon, authenticated;
grant select on public.ai_crawl_state to authenticated;

-- Holds the lease? Then extend it: a long call keeps it, a dead one loses it in 3 min.
create or replace function public.ai_crawl_holds(p_worker text) returns boolean
language sql security definer set search_path = public as $$
  with u as (update public.ai_crawl_state
                set lease_until = now() + interval '3 minutes', updated_at = now()
              where id = 1 and lease_owner = p_worker and lease_until >= now()
             returning 1)
  select exists (select 1 from u);
$$;
revoke execute on function public.ai_crawl_holds(text) from public, anon, authenticated;

-- Weekly (mig 381) or by hand. A crawl still running is left alone unless it
-- started more than 6 days ago (then it is stuck and starts over).
create or replace function public.ai_crawl_start() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.ai_crawl_state;
begin
  select * into s from public.ai_crawl_state where id = 1 for update;
  if s.status <> 'idle' and s.started_at > now() - interval '6 days' then
    return jsonb_build_object('status', 'already_running', 'crawl_no', s.crawl_no, 'crawl_status', s.status, 'started_at', s.started_at);
  end if;
  delete from public.ai_crawl_items where true;          -- records cascade
  update public.ai_crawl_state
     set status = 'discover', crawl_no = crawl_no + 1, started_at = now(), finished_at = null,
         lease_owner = null, lease_until = null, finalize_after = null, stats = '{}'::jsonb,
         last_error = null, errors = 0, updated_at = now()
   where id = 1;
  return jsonb_build_object('status', 'started', 'crawl_no', s.crawl_no + 1, 'restarted', s.status <> 'idle');
end $$;
revoke execute on function public.ai_crawl_start() from public, anon, authenticated;

-- Take the lease. Null: no crawl is running, or another call holds it.
create or replace function public.ai_crawl_lease(p_worker text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  update public.ai_crawl_state
     set lease_owner = p_worker, lease_until = now() + interval '3 minutes', updated_at = now()
   where id = 1 and status <> 'idle' and (lease_until is null or lease_until < now())
  returning jsonb_build_object('status', status, 'crawl_no', crawl_no, 'finalize_after', finalize_after) into v;
  return v;
end $$;
revoke execute on function public.ai_crawl_lease(text) from public, anon, authenticated;

create or replace function public.ai_crawl_release(p_worker text) returns void
language sql security definer set search_path = public as $$
  update public.ai_crawl_state set lease_owner = null, lease_until = null, updated_at = now()
   where id = 1 and lease_owner = p_worker;
$$;
revoke execute on function public.ai_crawl_release(text) from public, anon, authenticated;

-- A failed sitemap fetch and the like. Ten in a row while discovering ends the crawl.
create or replace function public.ai_crawl_note_error(p_worker text, p_error text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  update public.ai_crawl_state
     set last_error = left(p_error, 1000), errors = errors + 1,
         status = case when status = 'discover' and errors + 1 >= 10 then 'idle' else status end,
         finished_at = case when status = 'discover' and errors + 1 >= 10 then now() else finished_at end,
         stats = case when status = 'discover' and errors + 1 >= 10
                      then stats || jsonb_build_object('aborted', left(p_error, 300)) else stats end,
         updated_at = now()
   where id = 1
  returning jsonb_build_object('ok', true, 'status', status, 'errors', errors) into v;
  return v;
end $$;
revoke execute on function public.ai_crawl_note_error(text, text) from public, anon, authenticated;

-- Sitemap entries, or links found on a page ({key, kind, item_id, url, discovered}).
create or replace function public.ai_crawl_add_items(p_worker text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  insert into public.ai_crawl_items (key, kind, item_id, url, discovered)
  select x->>'key', x->>'kind', x->>'item_id', x->>'url', coalesce((x->>'discovered')::boolean, false)
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
  on conflict (key) do nothing;
  get diagnostics n = row_count;
  update public.ai_crawl_state set status = 'crawl', updated_at = now() where id = 1 and status = 'discover';
  return jsonb_build_object('ok', true, 'added', n);
end $$;
revoke execute on function public.ai_crawl_add_items(text, jsonb) from public, anon, authenticated;

-- The next due pages. When none is left to fetch, the crawl moves to 'finalize'.
create or replace function public.ai_crawl_next(p_worker text, p_limit int default 5) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_items jsonb; v_pending int; v_waiting int; v_status text;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', i.key, 'kind', i.kind, 'item_id', i.item_id, 'url', i.url,
                                               'attempts', i.attempts) order by i.id), '[]'::jsonb)
    into v_items
    from (select * from public.ai_crawl_items where status = 'pending' and not_before <= now()
           order by id limit greatest(1, p_limit)) i;
  select count(*), count(*) filter (where not_before > now()) into v_pending, v_waiting
    from public.ai_crawl_items where status = 'pending';
  update public.ai_crawl_state set status = 'finalize', updated_at = now()
   where id = 1 and status = 'crawl' and v_pending = 0
  returning status into v_status;
  if v_status is null then select status into v_status from public.ai_crawl_state where id = 1; end if;
  return jsonb_build_object('ok', true, 'status', v_status, 'items', v_items, 'waiting', v_waiting);
end $$;
revoke execute on function public.ai_crawl_next(text, int) from public, anon, authenticated;

-- One fetch outcome: 'done' (with its records), 'dead' (the page is gone) or
-- 'retry' (JS shell, throttled, timeout): backoff 5 s → 2 min, 'failed' after 6 attempts.
create or replace function public.ai_crawl_put(p_worker text, p_key text, p_outcome text,
                                               p_records jsonb default null, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_att int; v_status text;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  select id, attempts + 1 into v_id, v_att from public.ai_crawl_items where key = p_key and status = 'pending' for update;
  if v_id is null then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if p_outcome = 'done' then
    delete from public.ai_crawl_records where item_id = v_id;
    insert into public.ai_crawl_records (item_id, ord, record_id, record)
    select v_id, o, x->>'id', x
      from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) with ordinality t(x, o)
     where coalesce(x->>'id', '') <> '';
    v_status := 'done';
  elsif p_outcome = 'dead' then
    v_status := 'dead';
  elsif p_outcome = 'retry' then
    v_status := case when v_att >= 6 then 'failed' else 'pending' end;
  else
    raise exception 'ai_crawl_put: outcome must be done, dead or retry, not %', p_outcome;
  end if;
  update public.ai_crawl_items
     set status = v_status, attempts = v_att, last_error = left(p_error, 500),
         not_before = case when v_status = 'pending'
                           then now() + make_interval(secs => (array[5, 15, 30, 60, 120])[least(v_att, 5)]) else not_before end,
         done_at = case when v_status = 'pending' then null else now() end
   where id = v_id;
  return jsonb_build_object('ok', true, 'status', v_status, 'attempts', v_att);
end $$;
revoke execute on function public.ai_crawl_put(text, text, text, jsonb, text) from public, anon, authenticated;

-- Finalize reads the records in whole-id groups (every record of an id in one
-- page, so the importer's winner rules see them all), after the cursor.
create or replace function public.ai_crawl_read_records(p_worker text, p_after text default null, p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  with ids as (
    select distinct r.record_id from public.ai_crawl_records r
     where p_after is null or r.record_id > p_after
     order by 1 limit greatest(1, p_limit)
  )
  select jsonb_build_object('ok', true,
           'last', (select max(record_id) from ids),
           'records', coalesce((select jsonb_agg(r.record order by r.record_id, r.item_id, r.ord)
                                  from public.ai_crawl_records r join ids using (record_id)), '[]'::jsonb))
    into v;
  return v;
end $$;
revoke execute on function public.ai_crawl_read_records(text, text, int) from public, anon, authenticated;

-- Rows from crawlToRows (ingest/ttsImport.ts). The same upsert as
-- importArticles: only new rows, a changed content_hash or a retired article
-- are written; unchanged rows are not touched. Advances the cursor in the same
-- transaction, so a retried page is harmless.
create or replace function public.ai_tts_apply(p_worker text, p_rows jsonb, p_last text, p_stats jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ins int; v_upd int; v_n int := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  if (select status from public.ai_crawl_state where id = 1) <> 'finalize' then
    return jsonb_build_object('ok', false, 'reason', 'not_finalizing');
  end if;
  with up as (
    insert into public.tts_articles as t (knowledge_id, kind, url, title, breadcrumb, course, keywords, applies_to, source,
                                          ai_summary, toc, body, views, source_created_at, source_modified_at, content_hash)
    select r.knowledge_id, r.kind, r.url, r.title, r.breadcrumb, r.course, coalesce(r.keywords, '{}'), r.applies_to, r.source,
           r.ai_summary, coalesce(r.toc, '[]'::jsonb), r.body, r.views, r.source_created_at, r.source_modified_at, r.content_hash
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(knowledge_id text, kind text, url text, title text, breadcrumb text,
           course jsonb, keywords text[], applies_to text, source text, ai_summary text, toc jsonb, body text, views bigint,
           source_created_at timestamptz, source_modified_at timestamptz, content_hash text)
    on conflict (knowledge_id) do update set
      kind = excluded.kind, url = excluded.url, title = excluded.title, breadcrumb = excluded.breadcrumb,
      course = excluded.course, keywords = excluded.keywords, applies_to = excluded.applies_to, source = excluded.source,
      ai_summary = excluded.ai_summary, toc = excluded.toc, body = excluded.body, views = excluded.views,
      source_created_at = excluded.source_created_at, source_modified_at = excluded.source_modified_at,
      content_hash = excluded.content_hash, is_active = true, missed_crawls = 0, last_seen_at = now(), updated_at = now()
    where t.content_hash is distinct from excluded.content_hash or not t.is_active
    returning (t.xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from up;
  update public.ai_crawl_state
     set finalize_after = p_last, updated_at = now(),
         stats = stats || jsonb_build_object(
           'inserted',      coalesce((stats->>'inserted')::int, 0) + v_ins,
           'updated',       coalesce((stats->>'updated')::int, 0) + v_upd,
           'unchanged',     coalesce((stats->>'unchanged')::int, 0) + v_n - v_ins - v_upd,
           'records',       coalesce((stats->>'records')::int, 0) + coalesce((p_stats->>'records')::int, 0),
           'duplicate_ids', coalesce((stats->>'duplicate_ids')::int, 0) + coalesce((p_stats->>'duplicate_ids')::int, 0),
           'skipped_empty', coalesce((stats->>'skipped_empty')::int, 0) + coalesce((p_stats->>'skipped_empty')::int, 0))
   where id = 1;
  return jsonb_build_object('ok', true, 'inserted', v_ins, 'updated', v_upd, 'unchanged', v_n - v_ins - v_upd);
end $$;
revoke execute on function public.ai_tts_apply(text, jsonb, text, jsonb) from public, anon, authenticated;

-- End of a crawl. "Seen" = every id a fetched page returned, plus what a page
-- that FAILED (not dead) would have returned: that essay, or the stored lessons
-- of that course, so a flaky fetch never counts against an article.
-- Unseen active articles: missed_crawls + 1, retired (is_active = false) at 3.
-- Seen ones: missed_crawls back to 0. The retire step is skipped when the
-- crawl looks broken (> 5 % of pages failed, or it saw under half of the
-- active articles), so an outage never retires the catalogue.
create or replace function public.ai_crawl_finish(p_worker text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_items int; v_done int; v_dead int; v_failed int; v_disc int;
  v_active int; v_seen int; v_missed int := 0; v_retired int := 0; v_reset int;
  v_skip text;
  v_stats jsonb;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  if (select status from public.ai_crawl_state where id = 1) <> 'finalize' then
    return jsonb_build_object('ok', false, 'reason', 'not_finalizing');
  end if;
  select count(*), count(*) filter (where status = 'done'), count(*) filter (where status = 'dead'),
         count(*) filter (where status = 'failed'), count(*) filter (where discovered)
    into v_items, v_done, v_dead, v_failed, v_disc
    from public.ai_crawl_items;

  create temp table if not exists ai_crawl_seen (id text primary key) on commit drop;
  truncate ai_crawl_seen;
  insert into ai_crawl_seen
  select record_id from public.ai_crawl_records
  union select item_id from public.ai_crawl_items where status = 'failed' and kind = 'essay'
  union select t.knowledge_id from public.tts_articles t
          join public.ai_crawl_items i on i.status = 'failed' and i.kind = 'course'
                                      and t.course @> jsonb_build_array(jsonb_build_object('learning_id', i.item_id))
  on conflict do nothing;

  select count(*) into v_active from public.tts_articles where is_active;
  select count(*) into v_seen from public.tts_articles t where t.is_active and exists (select 1 from ai_crawl_seen s where s.id = t.knowledge_id);
  v_skip := case when v_failed > v_items * 0.05 then format('%s of %s pages failed', v_failed, v_items)
                 when v_seen < v_active * 0.5   then format('saw %s of %s active articles', v_seen, v_active) end;

  if v_skip is null then
    with m as (
      update public.tts_articles t
         set missed_crawls = t.missed_crawls + 1,
             is_active     = t.missed_crawls + 1 < 3,
             updated_at    = case when t.missed_crawls + 1 >= 3 then now() else t.updated_at end
       where t.is_active and not exists (select 1 from ai_crawl_seen s where s.id = t.knowledge_id)
      returning t.is_active
    )
    select count(*), count(*) filter (where not is_active) into v_missed, v_retired from m;
  end if;
  update public.tts_articles t set missed_crawls = 0
   where t.missed_crawls > 0 and t.is_active and exists (select 1 from ai_crawl_seen s where s.id = t.knowledge_id);
  get diagnostics v_reset = row_count;

  update public.ai_crawl_state
     set status = 'idle', finished_at = now(), lease_owner = null, lease_until = null, updated_at = now(),
         stats = stats || jsonb_build_object('pages', v_items, 'pages_done', v_done, 'dead', v_dead, 'failed', v_failed,
                                            'discovered_outside_sitemap', v_disc, 'active_before', v_active, 'seen_active', v_seen,
                                            'missed', v_missed, 'retired', v_retired, 'missed_reset', v_reset,
                                            'retire_skipped', v_skip,
                                            'minutes', round(extract(epoch from now() - started_at) / 60.0, 1))
   where id = 1
  returning stats into v_stats;
  return jsonb_build_object('ok', true, 'stats', v_stats);
end $$;
revoke execute on function public.ai_crawl_finish(text) from public, anon, authenticated;

-- Every minute (mig 381): post to tts-crawl only while a crawl runs, nobody
-- holds the lease, and there is something to do now. Idle → no call.
create or replace function public.ai_crawl_tick() returns void
language plpgsql security definer
set search_path = public, net
as $$
declare v_url text; v_secret text;
begin
  select value into v_url from public.app_config where key = 'ai_crawl_url';
  if coalesce(v_url, '') = '' then return; end if;
  if not exists (select 1 from public.ai_crawl_state s
                  where s.id = 1 and s.status <> 'idle' and (s.lease_until is null or s.lease_until < now())
                    and (s.status in ('discover', 'finalize')
                         or exists (select 1 from public.ai_crawl_items i where i.status = 'pending' and i.not_before <= now())
                         or not exists (select 1 from public.ai_crawl_items i where i.status = 'pending'))) then
    return;
  end if;
  select value into v_secret from public.app_config where key = 'ai_ingest_secret';
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', coalesce(v_secret, '')),
    body := '{"mode":"continue"}'::jsonb,
    timeout_milliseconds := 150000);
exception when others then
  raise warning 'ai_crawl_tick failed: %', sqlerrm;
end;
$$;
revoke execute on function public.ai_crawl_tick() from public, anon, authenticated;
