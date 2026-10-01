-- ============================================================
-- 369 — Assistant v2: ingestion queue.
--
-- Every change to an indexed source becomes ONE pending row here (triggers
-- land in mig 373). The ai-ingest worker claims rows, re-reads the live
-- source, and writes ai_documents/ai_chunks.
--
--   Debounce  re-enqueueing a pending item pushes not_before forward, so a
--             report autosaved 50 times is indexed once, after it goes quiet.
--   Precedence delete > upsert > acl. The worker re-reads the live row anyway.
--   Safety    claim uses FOR UPDATE SKIP LOCKED; a crashed worker's items are
--             reclaimed after 10 minutes; 5 failures → 'failed' (visible).
--   Never     ai_enqueue swallows its own errors — indexing must never block
--             a user's save. The nightly reconciler catches anything missed.
--
-- Worker RPCs are service-role only (functions are PUBLIC-executable by
-- default, so each one revokes that explicitly).
-- Design: Assistant/architecture.md §3.3, §9.  Idempotent.
-- ============================================================

create table if not exists public.ai_ingest_queue (
  id           bigserial primary key,
  source_type  text not null,
  source_id    text not null,
  op           text not null check (op in ('upsert','delete','acl')),
  priority     smallint not null default 5,          -- 0 urgent … 9 backfill
  reason       text,                                 -- trigger | backfill | reconcile | manual | cascade
  status       text not null default 'pending'
                 check (status in ('pending','processing','done','failed')),
  enqueued_at  timestamptz not null default now(),
  not_before   timestamptz not null default now(),
  attempts     int not null default 0,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  done_at      timestamptz
);
create unique index if not exists ai_ingest_queue_pending_uk
  on public.ai_ingest_queue (source_type, source_id) where status = 'pending';
create index if not exists ai_ingest_queue_claim_idx
  on public.ai_ingest_queue (priority, not_before) where status = 'pending';
create index if not exists ai_ingest_queue_status_idx
  on public.ai_ingest_queue (status, done_at);

create table if not exists public.ai_ingest_runs (
  id                 bigserial primary key,
  kind               text not null default 'ingest',   -- ingest | reconcile | backfill | crawl
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  claimed            int not null default 0,
  succeeded          int not null default 0,
  failed             int not null default 0,
  skipped_unchanged  int not null default 0,
  embedded_chunks    int not null default 0,
  embed_tokens       int not null default 0,
  stats              jsonb not null default '{}'::jsonb,
  error              text
);
create index if not exists ai_ingest_runs_started_idx on public.ai_ingest_runs (started_at desc);

alter table public.ai_ingest_queue enable row level security;
alter table public.ai_ingest_runs  enable row level security;
drop policy if exists "ai_ingest_queue_admin_read" on public.ai_ingest_queue;
create policy "ai_ingest_queue_admin_read" on public.ai_ingest_queue for select
  using (public.is_ai_admin((select auth.uid())));
drop policy if exists "ai_ingest_runs_admin_read" on public.ai_ingest_runs;
create policy "ai_ingest_runs_admin_read" on public.ai_ingest_runs for select
  using (public.is_ai_admin((select auth.uid())));

-- ── enqueue (called by triggers, backfill, reconciler) ─────────────────
create or replace function public.ai_enqueue(
  p_type text, p_id text, p_op text,
  p_priority smallint default 5,
  p_debounce interval default interval '0',
  p_reason   text default 'trigger')
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.ai_ingest_queue (source_type, source_id, op, priority, reason, not_before)
  values (p_type, p_id, p_op, p_priority, p_reason, now() + p_debounce)
  on conflict (source_type, source_id) where status = 'pending'
  do update set
    enqueued_at = now(),
    not_before  = greatest(ai_ingest_queue.not_before, now() + p_debounce),
    priority    = least(ai_ingest_queue.priority, excluded.priority),
    op = case when excluded.op = 'delete' or ai_ingest_queue.op = 'delete' then 'delete'
              when excluded.op = 'upsert' or ai_ingest_queue.op = 'upsert' then 'upsert'
              else 'acl' end;
exception when others then
  raise warning 'ai_enqueue failed (% / %): %', p_type, p_id, sqlerrm;
end;
$$;
revoke execute on function public.ai_enqueue(text, text, text, smallint, interval, text) from public, anon, authenticated;

-- ── claim: urgent first, then oldest; skip rows another worker holds ───
create or replace function public.ai_ingest_claim(p_limit int, p_worker text)
returns setof public.ai_ingest_queue
language sql security definer
set search_path = public
as $$
  update public.ai_ingest_queue q
     set status = 'processing', locked_at = now(), locked_by = p_worker, attempts = q.attempts + 1
   where q.id in (
     select id from public.ai_ingest_queue
      where (status = 'pending' and not_before <= now())
         or (status = 'processing' and locked_at < now() - interval '10 minutes')
      order by priority, not_before
      limit greatest(1, least(p_limit, 200))
      for update skip locked)
  returning q.*;
$$;
revoke execute on function public.ai_ingest_claim(int, text) from public, anon, authenticated;

create or replace function public.ai_ingest_complete(p_id bigint)
returns void
language sql security definer
set search_path = public
as $$
  update public.ai_ingest_queue
     set status = 'done', done_at = now(), locked_at = null, last_error = null
   where id = p_id;
$$;
revoke execute on function public.ai_ingest_complete(bigint) from public, anon, authenticated;

-- Backoff 1m / 5m / 30m / 2h; the 5th failure parks the item as 'failed'.
-- If a newer pending row for the same source arrived meanwhile, this one is
-- simply closed — the newer row carries the latest intent.
create or replace function public.ai_ingest_fail(p_id bigint, p_error text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare r public.ai_ingest_queue;
begin
  select * into r from public.ai_ingest_queue where id = p_id;
  if not found then return; end if;
  if exists (select 1 from public.ai_ingest_queue
              where source_type = r.source_type and source_id = r.source_id
                and status = 'pending' and id <> r.id) then
    update public.ai_ingest_queue set status = 'done', done_at = now(), last_error = left(p_error, 1000)
     where id = p_id;
    return;
  end if;
  update public.ai_ingest_queue
     set status     = case when r.attempts >= 5 then 'failed' else 'pending' end,
         not_before = now() + case r.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
                                              when 3 then interval '30 minutes' else interval '2 hours' end,
         locked_at  = null,
         last_error = left(p_error, 1000)
   where id = p_id;
end;
$$;
revoke execute on function public.ai_ingest_fail(bigint, text) from public, anon, authenticated;

-- Admin: put a failed item back in the queue (health panel "Retry").
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
  perform public.ai_enqueue(r.source_type, r.source_id, r.op, 1::smallint, interval '0', 'manual');
end;
$$;
revoke execute on function public.ai_ingest_retry(bigint) from public, anon;
grant  execute on function public.ai_ingest_retry(bigint) to authenticated;
