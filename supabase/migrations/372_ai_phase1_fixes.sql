-- ============================================================
-- 372 — Assistant v2: Phase 1 QA fixes (qa/2026-09-28-phase1.md).
--
--   M1  claim parks a stuck 'processing' row as 'failed' once it has had 5
--       attempts — a crash or timeout counts as an attempt (decision 2).
--   M2  kb ACL fails closed: a missing/unknown visibility is not 'office'.
--       Now mirrors kb_select (mig 134) exactly, submitted_by included.
--   M3  ai_enqueue takes p_priority int, so triggers can pass a plain 5.
--   L1  a merge that becomes 'delete' is due now (deletes skip the debounce).
--   L2  complete/fail act only on a row this worker still holds.
--   L3  no client write privileges on any assistant table.
--   L4  ai_feedback rejects a null rating.
--   D1  keyword search matches ANY query word; ts_rank_cd still ranks chunks
--       that match more words higher (decision 1).
--   index on ai_assistant_docs.kb_article_id (SOP ↔ KB link, decision 3).
--
-- Idempotent.
-- ============================================================

-- ── M1: claim ──────────────────────────────────────────────────────────
create or replace function public.ai_ingest_claim(p_limit int, p_worker text)
returns setof public.ai_ingest_queue
language plpgsql security definer
set search_path = public
as $$
begin
  -- A row that has been claimed 5 times and is stuck again killed its worker
  -- every time; reclaiming it forever would hide it and re-embed each time.
  update public.ai_ingest_queue
     set status = 'failed', locked_at = null, last_error = 'worker crashed or timed out 5 times'
   where status = 'processing' and locked_at < now() - interval '10 minutes' and attempts >= 5;

  return query
  update public.ai_ingest_queue q
     set status = 'processing', locked_at = now(), locked_by = p_worker, attempts = q.attempts + 1
   where q.id in (
     select id from public.ai_ingest_queue
      where (status = 'pending' and not_before <= now())
         or (status = 'processing' and locked_at < now() - interval '10 minutes' and attempts < 5)
      order by priority, not_before
      limit greatest(1, least(p_limit, 200))
      for update skip locked)
  returning q.*;
end;
$$;
revoke execute on function public.ai_ingest_claim(int, text) from public, anon, authenticated;

-- ── M2: kb ACL ─────────────────────────────────────────────────────────
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
    -- kb_select (mig 134): created_by, submitted_by, boss, ol, developer, or
    -- approved + matching visibility. Only approved articles are indexed.
    -- Missing, unknown or 'private' visibility matches no visibility branch.
    when d.acl_mode = 'kb'        then urole in ('ol','developer')
                                    or d.author_id = uid
                                    or d.metadata->>'submitted_by' = uid::text
                                    or coalesce(d.metadata->>'visibility','') = 'office'
                                    or (d.metadata->>'visibility' = 'role'  and urole = any(d.acl_roles))
                                    or (d.metadata->>'visibility' = 'users' and uid   = any(d.acl_users))
    when d.acl_mode = 'boss'      then urole = any(d.acl_roles)
    else false
  end, false);
$$;
revoke execute on function public.ai_can_read_document(public.ai_documents, uuid, text) from public, anon, authenticated;

-- ── M3 + L1: enqueue ───────────────────────────────────────────────────
-- create or replace cannot change an argument type.
drop function if exists public.ai_enqueue(text, text, text, smallint, interval, text);
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
          case when p_op = 'delete' then now() else now() + p_debounce end)
  on conflict (source_type, source_id) where status = 'pending'
  do update set
    enqueued_at = now(),
    not_before  = case when excluded.op = 'delete' or ai_ingest_queue.op = 'delete' then now()
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

create or replace function public.ai_ingest_retry(p_id bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
declare r public.ai_ingest_queue;
begin
  if not public.is_ai_admin(auth.uid()) then raise exception 'not allowed'; end if;
  select * into r from public.ai_ingest_queue where id = p_id and status = 'failed';
  if not found then return; end if;
  update public.ai_ingest_queue set status = 'done', done_at = now() where id = p_id;
  perform public.ai_enqueue(r.source_type, r.source_id, r.op, 1, interval '0', 'manual');
end;
$$;
revoke execute on function public.ai_ingest_retry(bigint) from public, anon;
grant  execute on function public.ai_ingest_retry(bigint) to authenticated;

-- ── L2: complete / fail only by the worker holding the row ─────────────
drop function if exists public.ai_ingest_complete(bigint);
create or replace function public.ai_ingest_complete(p_id bigint, p_worker text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  update public.ai_ingest_queue
     set status = 'done', done_at = now(), locked_at = null, last_error = null
   where id = p_id and status = 'processing' and locked_by = p_worker;
  return found;
end;
$$;
revoke execute on function public.ai_ingest_complete(bigint, text) from public, anon, authenticated;

-- Backoff 1m / 5m / 30m / 2h; the 5th failure parks the item as 'failed'.
-- If a newer pending row for the same source arrived meanwhile, this one is
-- simply closed — the newer row carries the latest intent.
drop function if exists public.ai_ingest_fail(bigint, text);
create or replace function public.ai_ingest_fail(p_id bigint, p_worker text, p_error text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare r public.ai_ingest_queue;
begin
  select * into r from public.ai_ingest_queue
   where id = p_id and status = 'processing' and locked_by = p_worker
   for update;
  if not found then return false; end if;
  if exists (select 1 from public.ai_ingest_queue
              where source_type = r.source_type and source_id = r.source_id
                and status = 'pending' and id <> r.id) then
    update public.ai_ingest_queue
       set status = 'done', done_at = now(), locked_at = null, last_error = left(p_error, 1000)
     where id = p_id;
    return true;
  end if;
  update public.ai_ingest_queue
     set status     = case when r.attempts >= 5 then 'failed' else 'pending' end,
         not_before = now() + case r.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
                                              when 3 then interval '30 minutes' else interval '2 hours' end,
         locked_at  = null,
         last_error = left(p_error, 1000)
   where id = p_id;
  return true;
end;
$$;
revoke execute on function public.ai_ingest_fail(bigint, text, text) from public, anon, authenticated;

-- ── L3: no client writes (RLS aside, TRUNCATE ignores RLS) ─────────────
revoke insert, update, delete, truncate, references, trigger
  on public.ai_documents, public.ai_chunks, public.ai_ingest_queue,
     public.ai_ingest_runs, public.tts_articles, public.ai_request_log
  from anon, authenticated;

-- ── L4: feedback ───────────────────────────────────────────────────────
create or replace function public.ai_feedback(p_request_id uuid, p_rating smallint, p_note text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_rating is null or p_rating not in (-1, 1) then raise exception 'rating must be -1 or 1'; end if;
  update public.ai_request_log
     set rating = p_rating, rating_note = left(p_note, 2000)
   where id = p_request_id and user_id = auth.uid();
end;
$$;
revoke execute on function public.ai_feedback(uuid, smallint, text) from public, anon;
grant  execute on function public.ai_feedback(uuid, smallint, text) to authenticated;

-- ── D1: keyword arm matches ANY word ───────────────────────────────────
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

  -- plainto_tsquery drops stop words and ANDs the rest; turning every '&'
  -- into '|' makes any word enough to match (a natural-language question
  -- rarely has every word in one chunk). Its output only quotes lexemes, so
  -- ' & ' appears only as the operator. ts_rank_cd below still ranks chunks
  -- that match more words higher.
  if v_text is not null then
    v_tsq := replace(plainto_tsquery('english', v_text)::text, ' & ', ' | ')::tsquery;
    if numnode(v_tsq) = 0 then v_tsq := null; end if;
  end if;

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

-- ── decision 3: SOP ↔ KB link lookups (kb change → its linked docs) ────
create index if not exists ai_assistant_docs_kb_article_idx
  on public.ai_assistant_docs (kb_article_id) where kb_article_id is not null;
