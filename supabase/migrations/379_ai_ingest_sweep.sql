-- ============================================================
-- 379 — Assistant v2: the ingestion sweep (Owner, 2026-09-29: new data is
-- picked up on a rolling 12 hours, or on demand), and QA M1.
--
--   ai_ingest_sweep(trigger, by)  service only. ONE pass of ai_enqueue_stale over
--                                 every enabled source = reconcile + backfill:
--                                 orphans → delete, not indexable (unapproved,
--                                 superseded, inactive) → soft delete, missing /
--                                 changed / pipeline drift → upsert (priority 8,
--                                 reason 'sweep'). Nothing changed → nothing
--                                 enqueued. One ai_ingest_runs row, kind 'sweep'.
--                                 The drain tick (mig 375) then processes the queue.
--   ai_run_ingestion()            the on-demand run (a button later): the Boss or
--                                 an ACTIVE developer (or the service role / a
--                                 direct SQL session). Refused while a sweep
--                                 started < 5 min ago ('too_soon') or while the
--                                 last sweep's items are still queued
--                                 ('already_running'). It changes no setting:
--                                 ingest_sources stays Boss-only (is_ai_admin).
--   ai_ingest_sweep_if_due()      the hourly cron job (mig 375): sweeps only when
--                                 no successful sweep, manual or scheduled,
--                                 started in the last 12 h, so a manual run
--                                 resets the clock. 5 min of slack keeps an
--                                 hourly check from slipping a whole hour.
--   ai_ingest_stats()             + last_sweep_at, next_sweep_due_at, ignored_sources.
--
-- M1 (qa/2026-09-28-phase2b-acceptance.md §9.3): one unknown name in
-- ai_assistant_config.ingest_sources made reconcile and backfill raise for
-- EVERY source. Now:
--   • ai_source_types() returns only the six known types, plus test-fixture
--     names (ai_is_test_source: qa_*, zzz_*, srch*, acltest — the names
--     tests/sql/*.sql and tests/ingest/* switch on inside their rolled-back
--     transactions; they have no loader, so nothing is ever enqueued for them).
--     Any other name is ignored and shown as ai_ingest_stats().ignored_sources
--     and in each sweep's stats.
--   • ai_enqueue_stale skips names without a loader, and one failing source no
--     longer stops the others (its error is returned under its name).
--
-- Service-only unless noted. Needs 377. Idempotent.
-- Design: Assistant/architecture.md §9.6, §9.7, §9.11.
-- ============================================================

-- ── M1: known types, test hook ─────────────────────────────────────────
create or replace function public.ai_source_canon() returns text[]
language sql immutable as $$
  select array['kb_article','ai_doc','app_guide','tts_article','report','incentive']
$$;
revoke execute on function public.ai_source_canon() from public, anon, authenticated;

-- Fixture types of the SQL / ingest test suites. Never a sensitive-looking name.
create or replace function public.ai_is_test_source(p text) returns boolean
language sql immutable as $$
  select coalesce(p ~ '^(qa_[a-z0-9_]+|zzz_[a-z0-9_]+|srch[a-z0-9_]*|acltest)$'
                  and lower(p) !~ '(salar|compensation|payroll|attendance|leave|performance)', false)
$$;
revoke execute on function public.ai_is_test_source(text) from public, anon, authenticated;

-- As mig 377, but names that are neither known nor a test fixture are dropped.
create or replace function public.ai_source_types() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array(
    select t from unnest((select c.ingest_sources from public.ai_assistant_config c order by c.id limit 1)) t
     where t = any(public.ai_source_canon()) or public.ai_is_test_source(t)
     order by array_position(public.ai_source_canon(), t) nulls last, t), '{}');
$$;
revoke execute on function public.ai_source_types() from public, anon;

-- The names ai_source_types() drops (a typo such as 'kb_articles'), for the health panel.
create or replace function public.ai_ignored_sources() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array(
    select distinct t from unnest((select c.ingest_sources from public.ai_assistant_config c order by c.id limit 1)) t
     where not (t = any(public.ai_source_canon()) or public.ai_is_test_source(t))
     order by t), '{}');
$$;
revoke execute on function public.ai_ignored_sources() from public, anon, authenticated;

-- As mig 373, plus: only types with a loader, and each type in its own
-- subtransaction so one failure does not stop the rest.
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
  foreach t in array coalesce(p_types, '{}') loop
    continue when not (t = any(public.ai_source_canon()));
    v_counts := '{}'::jsonb;
    begin
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
    exception when others then
      raise warning 'ai_enqueue_stale(%): %', t, sqlerrm;
      v_counts := jsonb_build_object('error', left(sqlerrm, 300));
    end;
    if v_counts <> '{}'::jsonb then v_out := v_out || jsonb_build_object(t, v_counts); end if;
  end loop;
  return v_out;
end;
$$;
revoke execute on function public.ai_enqueue_stale(text[], int, text, boolean, int) from public, anon, authenticated;

-- ── the sweep ──────────────────────────────────────────────────────────
-- A source-wide advisory lock keeps two sweeps (cron + a click) from running
-- at once; the second returns 'already_running'.
create or replace function public.ai_ingest_sweep(p_trigger text default 'schedule', p_by uuid default null)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_t0   timestamptz := clock_timestamp();
  v      jsonb;
  v_n    int;
  v_err  text;
  v_id   bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('ai_ingest_sweep')) then
    return jsonb_build_object('status', 'already_running', 'next_allowed_at', null);
  end if;
  v := public.ai_enqueue_stale(public.ai_source_types(), 8, 'sweep', true);
  select coalesce(sum(n.value::int), 0) into v_n
    from jsonb_each(v) t, jsonb_each_text(t.value) n where n.key <> 'error';
  select string_agg(t.key || ': ' || (t.value->>'error'), '; ') into v_err
    from jsonb_each(v) t where t.value ? 'error';
  insert into public.ai_ingest_runs (kind, started_at, finished_at, stats, error)
  values ('sweep', now(), clock_timestamp(),
          jsonb_build_object('trigger', p_trigger, 'triggered_by', p_by, 'enqueued', v, 'enqueued_total', v_n,
                             'ignored_sources', to_jsonb(public.ai_ignored_sources()),
                             'ms', (extract(epoch from clock_timestamp() - v_t0) * 1000)::int),
          v_err)
  returning id into v_id;
  return jsonb_build_object('status', case when v_err is null then 'swept' else 'partial' end,
                            'run_id', v_id, 'trigger', p_trigger, 'enqueued_total', v_n, 'enqueued', v,
                            'next_sweep_due_at', now() + interval '12 hours');
end;
$$;
revoke execute on function public.ai_ingest_sweep(text, uuid) from public, anon, authenticated;

-- Last successful sweep (manual or scheduled). A 'partial' sweep counts as
-- failed, so the hourly check retries it.
create or replace function public.ai_last_sweep_at() returns timestamptz
language sql stable security definer set search_path = public as $$
  select max(started_at) from public.ai_ingest_runs where kind = 'sweep' and error is null;
$$;
revoke execute on function public.ai_last_sweep_at() from public, anon, authenticated;

-- ── on demand: the Boss or an active developer ────────────────────────
create or replace function public.ai_run_ingestion()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text := nullif(auth.role(), '');
  v_last timestamptz;
  v_busy int;
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
  return public.ai_ingest_sweep('manual', v_uid);
end;
$$;
revoke execute on function public.ai_run_ingestion() from public, anon;
grant  execute on function public.ai_run_ingestion() to authenticated, service_role;

-- ── the hourly check (cron, mig 375) ───────────────────────────────────
create or replace function public.ai_ingest_sweep_if_due()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare v_last timestamptz := public.ai_last_sweep_at();
begin
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

-- ── health panel: + sweep clock, ignored names. Otherwise as mig 377.
create or replace function public.ai_ingest_stats()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare v_last timestamptz;
begin
  if not public.ai_is_service_or_admin() then raise exception 'not allowed'; end if;
  v_last := public.ai_last_sweep_at();
  return jsonb_build_object(
    'pipeline_version', public.ai_pipeline_version(),
    'embed_model', public.ai_embed_model(),
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
    'freshness_p95_seconds_24h', (select percentile_cont(0.95) within group (order by extract(epoch from done_at - enqueued_at))
                                    from public.ai_ingest_queue
                                   where status = 'done' and done_at > now() - interval '24 hours'),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
                select id, kind, started_at, finished_at, claimed, succeeded, failed, skipped_unchanged,
                       embedded_chunks, embed_tokens, error, stats->>'trigger' as trigger
                  from public.ai_ingest_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$$;
revoke execute on function public.ai_ingest_stats() from public, anon;
grant  execute on function public.ai_ingest_stats() to authenticated;
