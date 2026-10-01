-- ============================================================
-- 407 — Wurx Buddy: ingestion rests in the evening (Owner, 2026-10-02).
--
-- Nothing automatic may ingest between 18:00 and 02:00 Pakistan time. The
-- window is read from the settings, so it can be changed without a migration,
-- and it WRAPS midnight (start > end).
--
--   ai_assistant_config
--     ingest_quiet_enabled  boolean default true
--     ingest_quiet_start    time    default '18:00'   (Asia/Karachi)
--     ingest_quiet_end      time    default '02:00'   (Asia/Karachi)
--   ai_ingest_quiet_now()        → is it quiet right now?
--   ai_ingest_next_allowed_at()  → when the window next ends (now() if not quiet)
--
-- Held back while quiet: the 12-hourly sweep (ai_ingest_sweep_if_due), the
-- minute drain (ai_ingest_tick), claiming queue items (ai_ingest_claim), the
-- vector backfill's work list (ai_vector_pending), and the TikTok crawl
-- (ai_crawl_start, ai_crawl_tick).
-- NOT held back: answering questions, ai-finish-stale-replies, ai-housekeeping,
-- and the apply side of ingestion (ai_ingest_write / _complete / _fail /
-- _touch / _delete, ai_vector_fill) — a batch a worker already claimed always
-- finishes, so no row is left 'processing'.
-- The rolling 12-hour clock is ai_last_sweep_at() = the last successful sweep
-- run row; a skipped sweep writes no row, so the clock is untouched and the
-- sweep runs at the first hourly check after the window ends.
-- Manual "Run ingestion now" (ai_run_ingestion) refuses while quiet, with the
-- next allowed time; p_force := true overrides it (the UI confirms first).
-- pg_cron runs in GMT; every comparison here converts to Asia/Karachi, so the
-- window holds through daylight-saving changes elsewhere.
-- Idempotent.
-- ============================================================

alter table public.ai_assistant_config
  add column if not exists ingest_quiet_enabled boolean not null default true,
  add column if not exists ingest_quiet_start   time    not null default '18:00',
  add column if not exists ingest_quiet_end     time    not null default '02:00';

-- Validation lives in its own trigger on these three columns, so the model /
-- role checks (mig 404) and the roles trigger (401) stay as they are.
create or replace function public.ai_trg_config_quiet_check() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.ingest_quiet_start is null or new.ingest_quiet_end is null then
    raise exception 'ingest_quiet_start and ingest_quiet_end are required (times in Asia/Karachi)';
  end if;
  if new.ingest_quiet_start = new.ingest_quiet_end then
    raise exception 'ingest_quiet_start and ingest_quiet_end cannot be the same time; switch the window off with ingest_quiet_enabled = false';
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_quiet_check() from public, anon, authenticated;
drop trigger if exists ai_assistant_config_quiet_check on public.ai_assistant_config;
create trigger ai_assistant_config_quiet_check
  before insert or update of ingest_quiet_enabled, ingest_quiet_start, ingest_quiet_end on public.ai_assistant_config
  for each row execute function public.ai_trg_config_quiet_check();

-- ── the window ───────────────────────────────────────────────────────────
-- Pakistan time, wrapping midnight when start > end. No row / switched off = never quiet.
create or replace function public.ai_ingest_quiet_now() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when not c.ingest_quiet_enabled or c.ingest_quiet_start = c.ingest_quiet_end then false
      when c.ingest_quiet_start < c.ingest_quiet_end
        then v.t >= c.ingest_quiet_start and v.t < c.ingest_quiet_end
      else v.t >= c.ingest_quiet_start or v.t < c.ingest_quiet_end       -- wraps midnight
    end
      from public.ai_assistant_config c,
           lateral (select (now() at time zone 'Asia/Karachi')::time as t) v
     where c.id = 1), false);
$$;
revoke execute on function public.ai_ingest_quiet_now() from public, anon;
grant  execute on function public.ai_ingest_quiet_now() to authenticated, service_role;

-- When ingestion may run again: now() unless quiet, else the next local `end`.
create or replace function public.ai_ingest_next_allowed_at() returns timestamptz
language sql stable security definer set search_path = public as $$
  select case when not public.ai_ingest_quiet_now() then now() else (
    select case when d.cand > l.now_local then d.cand else d.cand + interval '1 day' end at time zone 'Asia/Karachi'
      from public.ai_assistant_config c,
           lateral (select (now() at time zone 'Asia/Karachi') as now_local) l,
           lateral (select date_trunc('day', l.now_local) + c.ingest_quiet_end::interval as cand) d
     where c.id = 1) end;
$$;
revoke execute on function public.ai_ingest_next_allowed_at() from public, anon;
grant  execute on function public.ai_ingest_next_allowed_at() to authenticated, service_role;

-- ── the automatic paths ──────────────────────────────────────────────────

-- The 12-hourly sweep: nothing is written while quiet, so ai_last_sweep_at()
-- (and with it the rolling clock) does not move.
create or replace function public.ai_ingest_sweep_if_due() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_last timestamptz := public.ai_last_sweep_at();
begin
  if public.ai_ingest_quiet_now() then
    return jsonb_build_object('status', 'quiet_hours', 'last_sweep_at', v_last,
                              'next_allowed_at', public.ai_ingest_next_allowed_at());
  end if;
  if v_last is not null and now() < v_last + interval '12 hours' - interval '5 minutes' then
    return jsonb_build_object('status', 'not_due', 'last_sweep_at', v_last, 'next_sweep_due_at', v_last + interval '12 hours');
  end if;
  begin
    return public.ai_ingest_sweep('schedule', null);
  exception when others then
    insert into public.ai_ingest_runs (kind, finished_at, stats, error)
    values ('sweep', clock_timestamp(), jsonb_build_object('trigger', 'schedule'), left(sqlerrm, 1000));
    return jsonb_build_object('status', 'error', 'error', left(sqlerrm, 300));
  end;
end;
$$;
revoke execute on function public.ai_ingest_sweep_if_due() from public, anon, authenticated;
grant  execute on function public.ai_ingest_sweep_if_due() to service_role;

-- No new items are claimed while quiet; a batch already claimed is untouched
-- here and finishes through the apply RPCs.
create or replace function public.ai_ingest_claim(p_limit integer, p_worker text)
returns setof public.ai_ingest_queue
language plpgsql security definer set search_path = public as $$
begin
  if public.ai_ingest_quiet_now() then return; end if;
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
revoke execute on function public.ai_ingest_claim(integer, text) from public, anon, authenticated;
grant  execute on function public.ai_ingest_claim(integer, text) to service_role;

-- The minute drain: no worker is woken while quiet.
create or replace function public.ai_ingest_tick() returns void
language plpgsql security definer set search_path = public, net as $$
declare
  v_url    text;
  v_secret text;
begin
  if public.ai_ingest_quiet_now() then return; end if;
  if not exists (select 1 from public.ai_ingest_queue
                  where (status = 'pending' and not_before <= now())
                     or (status = 'processing' and locked_at < now() - interval '10 minutes'))
     and not (exists (select 1 from public.ai_chunks c where c.vector_pending)
              and (public.ai_vector_ready('primary') or public.ai_vector_ready('alt'))) then
    return;
  end if;
  select value into v_url    from public.app_config where key = 'ai_ingest_url';
  select value into v_secret from public.app_config where key = 'ai_ingest_secret';
  if coalesce(v_url, '') = '' then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', coalesce(v_secret, '')),
    body := '{"mode":"drain"}'::jsonb,
    timeout_milliseconds := 150000);
exception when others then
  raise warning 'ai_ingest_tick failed: %', sqlerrm;
end;
$$;
revoke execute on function public.ai_ingest_tick() from public, anon, authenticated;
grant  execute on function public.ai_ingest_tick() to service_role;

-- The vector backfill (mig 406) counts as ingestion: no work list while quiet,
-- so backfillVectors() finds nothing to do. ai_vector_fill is NOT gated, so a
-- batch already embedded is still stored.
-- Mig 406's body, with the quiet guard in front.
create or replace function public.ai_vector_pending(p_space text, p_limit integer default 64)
returns jsonb
language sql stable security definer set search_path = public as $$
  with cfg as (
    select coalesce((select c.embed_alt_always from public.ai_assistant_config c where c.id = 1), false) as always_,
           coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1), '{}') as free_
  )
  select case when public.ai_ingest_quiet_now() then '[]'::jsonb else
    coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'content_hash', x.content_hash, 'embed_text', x.embed_text,
                                          'source_type', x.source_type)), '[]'::jsonb) end
    from (select c.id, c.content_hash, c.embed_text, c.source_type
            from public.ai_chunks c
            join public.ai_documents d on d.id = c.document_id and d.status = 'active'
            cross join cfg
           where case p_space
                   when 'primary' then c.vector_pending
                   when 'alt' then c.embedding_alt is null and c.source_type = any(cfg.free_)
                                   and (c.vector_pending or cfg.always_)
                   else false end
           order by case when c.source_type in ('kb_article', 'ai_doc', 'app_guide') then 0
                         when c.source_type = 'report' then 1 else 2 end, c.updated_at, c.id
           limit greatest(1, least(coalesce(p_limit, 64), 500))) x;
$$;
revoke execute on function public.ai_vector_pending(text, integer) from public, anon, authenticated;
grant  execute on function public.ai_vector_pending(text, integer) to service_role;

-- The TikTok crawl feeds ingestion, so it rests too (Sunday 04:00 PKT is
-- already outside the window; a crawl running into it pauses and resumes).
create or replace function public.ai_crawl_start() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.ai_crawl_state;
begin
  if public.ai_ingest_quiet_now() then
    return jsonb_build_object('status', 'quiet_hours', 'next_allowed_at', public.ai_ingest_next_allowed_at());
  end if;
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
revoke execute on function public.ai_crawl_start() from public, anon;
grant  execute on function public.ai_crawl_start() to authenticated, service_role;

create or replace function public.ai_crawl_tick() returns void
language plpgsql security definer set search_path = public, net as $$
declare v_url text; v_secret text;
begin
  if public.ai_ingest_quiet_now() then return; end if;
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
grant  execute on function public.ai_crawl_tick() to service_role;

-- ── "Run ingestion now": refused while quiet unless forced ───────────────
-- A default argument would make ai_run_ingestion() ambiguous with the old
-- zero-argument function, so that one goes first.
drop function if exists public.ai_run_ingestion();
create or replace function public.ai_run_ingestion(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_role text := nullif(auth.role(), '');
  v_last timestamptz;
  v_busy int;
  v_next timestamptz;
begin
  -- A JWT user must be the Boss or an active developer. No JWT at all is a
  -- direct database session (SQL editor, psql), which only the owner has.
  if v_role = 'service_role' then
    null;
  elsif v_uid is null and v_role is null and session_user in ('postgres', 'supabase_admin') then
    null;
  elsif v_uid is null
        or not (public.is_boss(v_uid)
                or exists (select 1 from public.profiles p
                            where p.id = v_uid and p.role = 'developer' and p.is_active and p.deleted_at is null)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- Quiet hours: refused unless the caller deliberately forces it.
  if not coalesce(p_force, false) and public.ai_ingest_quiet_now() then
    v_next := public.ai_ingest_next_allowed_at();
    return jsonb_build_object('status', 'quiet_hours', 'next_allowed_at', v_next,
      'message', format('Ingestion rests between %s and %s Pakistan time. It can run again after %s, or run it now with force.',
        to_char((select ingest_quiet_start from public.ai_assistant_config where id = 1), 'HH24:MI'),
        to_char((select ingest_quiet_end   from public.ai_assistant_config where id = 1), 'HH24:MI'),
        to_char(v_next at time zone 'Asia/Karachi', 'HH24:MI "on" DD Mon')));
  end if;

  v_last := public.ai_last_sweep_at();
  if v_last > now() - interval '5 minutes' then
    return jsonb_build_object('status', 'too_soon', 'last_sweep_at', v_last, 'next_allowed_at', v_last + interval '5 minutes');
  end if;
  -- Items of an earlier sweep still waiting (retries after an error excluded:
  -- a new sweep would not re-enqueue them anyway).
  select count(*) into v_busy from public.ai_ingest_queue
   where reason = 'sweep' and status in ('pending', 'processing') and last_error is null;
  if v_busy > 0 then
    return jsonb_build_object('status', 'already_running', 'queued', v_busy, 'next_allowed_at', null);
  end if;
  return public.ai_ingest_sweep('manual', v_uid) || jsonb_build_object('forced', coalesce(p_force, false) and public.ai_ingest_quiet_now());
end;
$$;
revoke execute on function public.ai_run_ingestion(boolean) from public, anon;
grant  execute on function public.ai_run_ingestion(boolean) to authenticated, service_role;

-- ── the settings screen: when ingestion rests. Otherwise as mig 406. ────
create or replace function public.ai_ingest_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_last timestamptz;
begin
  if not (public.ai_is_service_or_admin() or public.ai_can_view_settings(auth.uid())) then raise exception 'not allowed'; end if;
  v_last := public.ai_last_sweep_at();
  return jsonb_build_object(
    -- When ingestion rests (mig 407), for the settings screen.
    'quiet_hours', jsonb_build_object(
      'enabled', (select c.ingest_quiet_enabled from public.ai_assistant_config c where c.id = 1),
      'start', to_char((select c.ingest_quiet_start from public.ai_assistant_config c where c.id = 1), 'HH24:MI'),
      'end', to_char((select c.ingest_quiet_end from public.ai_assistant_config c where c.id = 1), 'HH24:MI'),
      'tz', 'Asia/Karachi',
      'active_now', public.ai_ingest_quiet_now(),
      'next_allowed_at', public.ai_ingest_next_allowed_at()),
    'pipeline_version', public.ai_pipeline_version(),
    'embed_model', public.ai_embed_model(),
    'embed_model_alt', public.ai_embed_model_alt(),
    'ingest_sources', to_jsonb(public.ai_source_types()),
    'ignored_sources', to_jsonb(public.ai_ignored_sources()),
    'last_sweep_at', v_last,
    'next_sweep_due_at', coalesce(v_last + interval '12 hours', now()),
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
    -- Chunks with no OpenAI vector yet: found by keywords (and by the alt space
    -- if they have an NVIDIA vector) until the backfill fills them.
    'vector_pending', (select count(*) from public.ai_chunks c where c.vector_pending),
    'vectors', jsonb_build_object(
       'pending_by_type', coalesce((select jsonb_object_agg(source_type, n) from (
                select c.source_type, count(*) as n from public.ai_chunks c where c.vector_pending group by 1) x), '{}'::jsonb),
       'pending_with_alt', (select count(*) from public.ai_chunks c where c.vector_pending and c.embedding_alt is not null),
       'alt_filled', (select count(*) from public.ai_chunks c where c.embedding_alt is not null),
       'state', coalesce((select jsonb_object_agg(s.space, jsonb_build_object('next_try_at', s.next_try_at, 'last_error', s.last_error))
                            from public.ai_vector_state s), '{}'::jsonb)),
    'freshness_p95_seconds_24h', (select percentile_cont(0.95) within group (order by extract(epoch from done_at - enqueued_at))
                                    from public.ai_ingest_queue
                                   where status = 'done' and done_at > now() - interval '24 hours'),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
                select id, kind, started_at, finished_at, claimed, succeeded, failed, skipped_unchanged,
                       embedded_chunks, embed_tokens, error, stats->>'trigger' as trigger
                  from public.ai_ingest_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$function$;
revoke execute on function public.ai_ingest_stats() from public, anon;
grant  execute on function public.ai_ingest_stats() to authenticated, service_role;
