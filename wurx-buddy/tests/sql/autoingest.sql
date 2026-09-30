-- ============================================================
-- QA 2026-09-29: the auto-ingestion package (379, 380; 374 / 375 / 381 when present).
--   (a) who may run ingestion on demand (ai_run_ingestion): Boss + ACTIVE developers only
--   (b) no developer (or anyone but the Boss) can change any setting it depends on
--   (c) the exclusion list is Boss-only (read and write), crawl state Boss-read-only
--   (f) the first sweep over the REAL store enqueues only the testing-doc soft delete
--   + the 12-hour rolling clock, too_soon / already_running, partial sweeps.
-- Before deploy:  node tests/run-with-migrations.mjs --mig 379,380,374,375,381 tests/sql/autoingest.sql
-- After deploy:   node scripts/db-dev.mjs sql tests/sql/autoingest.sql
-- Everything happens in the runner's transaction and is rolled back.
-- ============================================================
create temp table ares (n serial, test text, result text, detail text) on commit drop;
grant all on ares to authenticated, anon;
grant all on sequence ares_n_seq to authenticated, anon;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into ares (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;

-- people: one active user per role (dev has no inactive developer: one is made so in this transaction)
create temp table ppl (label text primary key, uid uuid) on commit drop;
grant select on ppl to authenticated, anon;
insert into ppl
select r, (select id from profiles where role = r and is_active and deleted_at is null order by id limit 1)
  from unnest(array['boss','developer','ol','tl','apc','ipc','pctl','ads_manager']) r;
insert into ppl values ('developer2', (select id from profiles where role = 'developer' and is_active and deleted_at is null order by id desc limit 1));

create function pg_temp.as_user(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare o text; n bigint;
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '{"role":"authenticated"}' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  execute 'set local role authenticated';
  begin
    if p_sql ~* '^\s*select|\mreturning\M' then execute p_sql into o; else execute p_sql; end if;
    get diagnostics n = row_count;
    o := coalesce(o, 'rows=' || n);
  exception when others then o := 'ERR ' || sqlstate || ' ' || sqlerrm;
  end;
  execute 'reset role';
  return o;
end $$;

do $$
declare s text; v jsonb; r record; x text; n int; d jsonb; last_run bigint; pre_sweep boolean; n_cand bigint;
  testing_doc constant text := '833b9bda-8282-41dc-a8da-8ff3f032354d';
begin
  perform pg_temp.ok('precondition: 379 + 380 present', to_regprocedure('public.ai_run_ingestion()') is not null and to_regclass('public.ai_excluded_documents') is not null);
  if to_regprocedure('public.ai_run_ingestion()') is null then return; end if;
  perform pg_temp.ok('precondition: one active user for each role + 2 developers',
    (select count(*) from ppl where uid is not null) = 9 and (select uid from ppl where label = 'developer') <> (select uid from ppl where label = 'developer2'),
    (select string_agg(label, ',') from ppl where uid is null));
  perform pg_temp.ok('precondition: dev queue idle (nothing pending / processing)',
    not exists (select 1 from ai_ingest_queue where status in ('pending','processing')));

  -- State-aware since the deploy (2026-09-30): before the first sweep the testing
  -- doc is still active and is the only candidate; after it, candidates are the
  -- genuine changes since the last sweep (e.g. crawl results), never an excluded
  -- document. Real sweep rows are pushed back 13 h in this transaction so the
  -- 5-minute and 12-hour clocks below start from a known state.
  pre_sweep := exists (select 1 from ai_documents where source_type = 'kb_article' and source_id = testing_doc and status = 'active');
  update ai_ingest_runs set started_at = started_at - interval '13 hours' where kind = 'sweep';
  select jsonb_object_agg(t, c), coalesce(sum(tot), 0) into d, n_cand from (
    select t, jsonb_object_agg(k, cnt) c, sum(cnt) tot from (
      select t, bc.op || ':' || bc.why k, count(*) cnt from unnest(ai_source_types()) t, lateral ai_backfill_candidates(t) bc group by 1, 2) y group by t) z;
  if pre_sweep then
    perform pg_temp.ok('(f) pre-first-sweep: candidates over the real store = exactly the testing doc (delete: not indexable)',
      d = '{"kb_article": {"delete:not indexable": 1}}'::jsonb, coalesce(d::text, '{}'));
  else
    perform pg_temp.ok('(f) post-first-sweep: the testing doc is soft-deleted and is not a candidate (never re-added)',
      exists (select 1 from ai_documents where source_type = 'kb_article' and source_id = testing_doc and status = 'deleted')
      and not exists (select 1 from ai_backfill_candidates('kb_article') bc where bc.source_id = testing_doc), coalesce(d::text, '{}'));
    perform pg_temp.ok('(f) post-first-sweep: no candidate would upsert an excluded document',
      not exists (select 1 from ai_excluded_documents e, lateral ai_backfill_candidates(e.source_type) bc
                   where bc.source_id = e.source_id and bc.op = 'upsert'));
  end if;
  perform pg_temp.ok('(f) every source type: 0 pipeline-drift documents (no mass re-embed)',
    not exists (select 1 from ai_documents where status = 'active'
                 and (pipeline_version is distinct from ai_pipeline_version() or embed_model is distinct from ai_embed_model())));
  -- ── (a) who may run it. Each call is undone by a savepoint-equivalent: the result is read, the sweep rows stay in this tx.
  -- Negative cases first (they must not sweep at all).
  for r in select * from ppl where label not in ('boss','developer','developer2') loop
    x := pg_temp.as_user(r.uid, 'select public.ai_run_ingestion()::text');
    perform pg_temp.ok('(a) ' || r.label || ' is refused (42501 not allowed)', x like 'ERR 42501 not allowed%', x);
  end loop;
  x := pg_temp.as_user(null, 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) authenticated without sub is refused', x like 'ERR 42501%', x);
  x := pg_temp.as_user(gen_random_uuid(), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) a JWT for a user with no profile is refused', x like 'ERR 42501%', x);

  -- inactive / deleted developer, inactive Boss, role-less claims
  update profiles set is_active = false where id = (select uid from ppl where label = 'developer2');
  x := pg_temp.as_user((select uid from ppl where label = 'developer2'), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) an INACTIVE developer is refused', x like 'ERR 42501%', x);
  update profiles set is_active = true, deleted_at = now() where id = (select uid from ppl where label = 'developer2');
  x := pg_temp.as_user((select uid from ppl where label = 'developer2'), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) a soft-DELETED developer (is_active still true) is refused', x like 'ERR 42501%', x);
  update profiles set deleted_at = null where id = (select uid from ppl where label = 'developer2');
  update profiles set is_active = false where id = (select uid from ppl where label = 'boss');
  x := pg_temp.as_user((select uid from ppl where label = 'boss'), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) an INACTIVE Boss is refused', x like 'ERR 42501%', x);
  update profiles set is_active = true where id = (select uid from ppl where label = 'boss');
  select count(*) into n from ai_ingest_runs where kind = 'sweep' and started_at = now();
  perform pg_temp.ok('(a) none of the refused calls swept (0 sweep rows)', n = 0, n::text);

  -- an active developer runs it
  x := pg_temp.as_user((select uid from ppl where label = 'developer'), 'select public.ai_run_ingestion()::text');
  v := x::jsonb;
  perform pg_temp.ok('(a) an ACTIVE developer runs it: status swept', v->>'status' = 'swept', x);
  perform pg_temp.ok('(f) the sweep enqueues exactly the candidates (' || n_cand || '), nothing else',
    (v->>'enqueued_total')::int = n_cand
    and (not pre_sweep or exists (select 1 from ai_ingest_queue where status = 'pending' and source_type = 'kb_article' and source_id = testing_doc and op = 'delete' and reason = 'sweep')),
    (v->'enqueued')::text);  last_run := (v->>'run_id')::bigint;
  select stats into d from ai_ingest_runs where id = last_run;
  perform pg_temp.ok('(a) the run row records trigger manual + the developer''s id',
    d->>'trigger' = 'manual' and d->>'triggered_by' = (select uid from ppl where label = 'developer')::text, d::text);

  -- too_soon (5 min), for the Boss too
  x := pg_temp.as_user((select uid from ppl where label = 'boss'), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) the Boss right after: too_soon (5-minute guard)', x::jsonb->>'status' = 'too_soon', x);
  -- already_running: 6 minutes later, the sweep's item still queued
  update ai_ingest_runs set started_at = started_at - interval '6 minutes' where id = last_run;
  x := pg_temp.as_user((select uid from ppl where label = 'boss'), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) 6 min later with the items still queued: already_running (queued = ' || n_cand || '); with nothing queued: swept',
    case when n_cand > 0 then x::jsonb->>'status' = 'already_running' and (x::jsonb->>'queued')::int = n_cand
         else x::jsonb->>'status' = 'swept' end, x);
  -- a retrying item (last_error set) does not block
  update ai_ingest_queue set last_error = 'qa' where status = 'pending' and reason = 'sweep';
  -- (with nothing queued the call above swept at now(): move it out of the 5-minute window too)
  update ai_ingest_runs set started_at = started_at - interval '6 minutes' where kind = 'sweep' and started_at > now() - interval '1 hour';
  x := pg_temp.as_user((select uid from ppl where label = 'boss'), 'select public.ai_run_ingestion()::text');
  perform pg_temp.ok('(a) an item in retry (last_error set) does not block; the Boss sweeps; nothing new queued (pending item skipped)',
    x::jsonb->>'status' = 'swept' and (x::jsonb->>'enqueued_total')::int = 0, x);
  update ai_ingest_queue set status = 'done', done_at = now(), last_error = null where status = 'pending' and reason = 'sweep';

  -- ── the 12-hour rolling clock (ai_ingest_sweep_if_due, the hourly cron body)
  update ai_ingest_runs set started_at = now() - interval '11 hours 54 minutes' where kind = 'sweep' and started_at > now() - interval '1 hour';
  v := ai_ingest_sweep_if_due();
  perform pg_temp.ok('12h: last sweep 11h54m ago → not_due', v->>'status' = 'not_due', v::text);
  update ai_ingest_runs set started_at = now() - interval '11 hours 56 minutes' where kind = 'sweep' and started_at > now() - interval '12 hours';
  v := ai_ingest_sweep_if_due();
  perform pg_temp.ok('12h: 11h56m ago (inside the 5-min slack) → swept by the schedule', v->>'status' = 'swept' and v->>'trigger' = 'schedule', v::text);
  v := ai_ingest_sweep_if_due();
  perform pg_temp.ok('12h: straight after → not_due, next due in 12 h', v->>'status' = 'not_due'
    and (v->>'next_sweep_due_at')::timestamptz = now() + interval '12 hours', v::text);
  -- a failed (partial) sweep does not count: the hourly check retries
  update ai_ingest_runs set started_at = now() - interval '13 hours' where kind = 'sweep';
  insert into ai_ingest_runs (kind, started_at, finished_at, stats, error) values ('sweep', now() - interval '1 hour', now(), '{"trigger":"schedule"}', 'qa: boom');
  perform pg_temp.ok('12h: a sweep row with error is ignored by ai_last_sweep_at()', ai_last_sweep_at() = now() - interval '13 hours', ai_last_sweep_at()::text);
  v := ai_ingest_sweep_if_due();
  perform pg_temp.ok('12h: ... so the hourly check sweeps again', v->>'status' = 'swept', v::text);
  perform pg_temp.ok('health: ai_ingest_stats() shows last_sweep_at = now and next due +12 h, ignored_sources []',
    (ai_ingest_stats()->>'last_sweep_at')::timestamptz = now() and (ai_ingest_stats()->>'next_sweep_due_at')::timestamptz = now() + interval '12 hours'
    and ai_ingest_stats()->'ignored_sources' = '[]'::jsonb);

  -- ── (b) nobody but the Boss changes a setting
  for r in select * from ppl where label <> 'boss' loop
    s := concat_ws(' | ',
      'cfg=' || pg_temp.as_user(r.uid, $q$update public.ai_assistant_config set ingest_sources = '{report}' where id = 1$q$),
      'cfgins=' || left(pg_temp.as_user(r.uid, $q$insert into public.ai_assistant_config (id, ingest_sources) values (7, '{report}')$q$), 40),
      'appsel=' || pg_temp.as_user(r.uid, $q$select count(*)::text from public.app_config where key like 'ai\_%'$q$),
      'appupd=' || pg_temp.as_user(r.uid, $q$update public.app_config set value = 'https://evil.example/x' where key in ('ai_ingest_url','ai_crawl_url','ai_ingest_secret')$q$),
      'appins=' || left(pg_temp.as_user(r.uid, $q$insert into public.app_config (key, value) values ('ai_ingest_url_qa', 'x')$q$), 40),
      'crawlupd=' || left(pg_temp.as_user(r.uid, $q$update public.ai_crawl_state set status = 'idle'$q$), 40),
      'crawlsel=' || pg_temp.as_user(r.uid, $q$select count(*)::text from public.ai_crawl_state$q$),
      'items=' || left(pg_temp.as_user(r.uid, $q$select count(*)::text from public.ai_crawl_items$q$), 40),
      'start=' || left(pg_temp.as_user(r.uid, $q$select public.ai_crawl_start()::text$q$), 40),
      'tts=' || left(pg_temp.as_user(r.uid, $q$update public.tts_articles set is_active = false$q$), 40),
      'queue=' || left(pg_temp.as_user(r.uid, $q$insert into public.ai_ingest_queue (source_type, source_id, op) values ('kb_article', 'x', 'upsert')$q$), 40));
    perform pg_temp.ok('(b) ' || r.label || ': cannot change ingest_sources / app_config (URLs, secret) / crawl state / tts / queue, nor read app_config or crawl state',
      s ~ 'cfg=rows=0 ' and s ~ 'cfgins=ERR 42501' and s ~ 'appsel=0 ' and s ~ 'appupd=rows=0 ' and s ~ 'appins=ERR 42501' and s ~ 'crawlupd=ERR 42501'
      and s ~ 'crawlsel=0 ' and s ~ 'items=ERR 42501' and s ~ 'start=ERR 42501' and s ~ 'tts=ERR 42501|tts=rows=0' and s ~ 'queue=ERR 42501', s);
  end loop;
  -- the Boss: reads + updates app_config (policy app_config_boss_*), reads crawl state, cannot write crawl tables directly
  s := concat_ws(' | ',
    'appsel=' || pg_temp.as_user((select uid from ppl where label = 'boss'), $q$select count(*)::text from public.app_config where key in ('ai_ingest_url','ai_ingest_secret','ai_crawl_url')$q$),
    'crawlsel=' || pg_temp.as_user((select uid from ppl where label = 'boss'), $q$select count(*)::text from public.ai_crawl_state$q$),
    'crawlupd=' || left(pg_temp.as_user((select uid from ppl where label = 'boss'), $q$update public.ai_crawl_state set status = 'idle'$q$), 40),
    'start=' || left(pg_temp.as_user((select uid from ppl where label = 'boss'), $q$select public.ai_crawl_start()::text$q$), 40));
  perform pg_temp.ok('(b) the Boss reads crawl state but cannot write it or start a crawl through the API (service / SQL only)',
    s ~ 'crawlsel=1' and s ~ 'crawlupd=ERR 42501' and s ~ 'start=ERR 42501', s);
  perform pg_temp.ok('(b) NOTE the Boss can read app_config.ai_ingest_secret (policy app_config_boss_select, same as send_push_secret)',
    s ~ ('appsel=' || (select count(*) from app_config where key in ('ai_ingest_url','ai_ingest_secret','ai_crawl_url'))::text), s);

  -- ── (c) the exclusion list
  for r in select * from ppl where label <> 'boss' loop
    s := concat_ws(' | ',
      'sel=' || pg_temp.as_user(r.uid, $q$select count(*)::text from public.ai_excluded_documents$q$),
      'ins=' || left(pg_temp.as_user(r.uid, $q$insert into public.ai_excluded_documents (source_type, source_id, reason) values ('kb_article', 'qa-x', 'x')$q$), 40),
      'upd=' || pg_temp.as_user(r.uid, $q$update public.ai_excluded_documents set reason = 'x'$q$),
      'del=' || pg_temp.as_user(r.uid, $q$delete from public.ai_excluded_documents$q$),
      'tru=' || left(pg_temp.as_user(r.uid, $q$truncate public.ai_excluded_documents$q$), 40),
      'fn=' || left(pg_temp.as_user(r.uid, $q$select count(*)::text from public.ai_ingest_source('kb_article', array['833b9bda-8282-41dc-a8da-8ff3f032354d'], false)$q$), 40));
    perform pg_temp.ok('(c) ' || r.label || ': exclusion list unreadable (0 rows) and unwritable (RLS / no TRUNCATE / no fn)',
      s ~ 'sel=0 ' and s ~ 'ins=ERR 42501' and s ~ 'upd=rows=0 ' and s ~ 'del=rows=0 ' and s ~ 'tru=ERR 42501' and s ~ 'fn=ERR 42501', s);
  end loop;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  begin perform count(*) from public.ai_excluded_documents; x := 'read';
  exception when insufficient_privilege then x := 'denied'; end;
  execute 'reset role';
  perform pg_temp.ok('(c) anon: permission denied on the exclusion list', x = 'denied', x);
  update profiles set is_active = false where id = (select uid from ppl where label = 'boss');
  x := pg_temp.as_user((select uid from ppl where label = 'boss'), $q$select count(*)::text from public.ai_excluded_documents$q$);
  perform pg_temp.ok('(c) an inactive Boss sees 0 rows', x = '0', x);
  update profiles set is_active = true where id = (select uid from ppl where label = 'boss');
  s := concat_ws(' | ',
    'sel=' || pg_temp.as_user((select uid from ppl where label = 'boss'), $q$select count(*)::text from public.ai_excluded_documents$q$),
    'ins=' || pg_temp.as_user((select uid from ppl where label = 'boss'), $q$insert into public.ai_excluded_documents (source_type, source_id, reason) values ('kb_article', 'qa-boss', 'qa') returning excluded_by::text$q$),
    'del=' || pg_temp.as_user((select uid from ppl where label = 'boss'), $q$delete from public.ai_excluded_documents where source_id = 'qa-boss' returning 'one'$q$));
  perform pg_temp.ok('(c) the Boss reads, adds (excluded_by = the Boss) and removes exclusions',
    s = 'sel=' || (select count(*) from ai_excluded_documents)::text || ' | ins=' || (select uid from ppl where label = 'boss')::text || ' | del=one', s);
  x := pg_temp.as_user((select uid from ppl where label = 'boss'), $q$insert into public.ai_excluded_documents (source_type, source_id) values ('', 'x')$q$);
  perform pg_temp.ok('(c) empty source_type refused (check constraint)', x like 'ERR 23514%', x);

  -- the exclusion's effect on real read access: per role, readable KB documents drop by exactly the testing doc
  begin
    delete from ai_excluded_documents;
    select jsonb_object_agg(p.label, (select count(*) from ai_documents ad where ad.status = 'active' and ad.source_type = 'kb_article'
                                         and ai_can_read_document(ad, p.uid, (select role from profiles where id = p.uid))))
      into d from ppl p;
    raise exception 'qa_undo';
  exception when raise_exception then
    if sqlerrm <> 'qa_undo' then raise; end if;
  end;
  perform pg_temp.ok('exclusion undo worked (the seed row is back)', exists (select 1 from ai_excluded_documents where source_id = testing_doc));
  select string_agg(p.label || ' ' || (d->>p.label) || '→' || cx.cnt || case when cx.saw then ' (saw it)' else '' end, ', ' order by p.label) into s
    from ppl p cross join lateral (
      select count(*) filter (where ai_can_read_document(ad, p.uid, pr.role)) cnt,
             bool_or(ad.source_id = testing_doc and ai_can_read_document(ad, p.uid, pr.role)) saw
        from ai_documents ad, profiles pr where pr.id = p.uid and ad.status = 'active' and ad.source_type = 'kb_article') cx;
  perform pg_temp.ok('ACL: nobody can read the testing doc; every role reads the same KB documents minus at most that one',
    s !~ 'saw it' and not exists (
      select 1 from ppl p cross join lateral (
        select count(*) filter (where ai_can_read_document(ad, p.uid, pr.role)) cnt
          from ai_documents ad, profiles pr where pr.id = p.uid and ad.status = 'active' and ad.source_type = 'kb_article') cx
       where (d->>p.label)::int - cx.cnt not in (0, 1)), s);
  perform pg_temp.ok('ACL: the Boss (who reads everything) loses exactly the testing doc (1 before the first sweep, 0 once it is soft-deleted)',
    (d->>'boss')::int - (select count(*) from ai_documents ad where ad.status = 'active' and ad.source_type = 'kb_article'
                          and ai_can_read_document(ad, (select uid from ppl where label = 'boss'), 'boss')) = case when pre_sweep then 1 else 0 end, s);

  -- the seeded row and its effect on the store
  perform pg_temp.ok('seed: the testing doc is on the exclusion list',
    true and exists (select 1 from ai_excluded_documents where source_id = testing_doc and source_type = 'kb_article'));
  perform pg_temp.ok('seed: the testing doc is an indexed KB article titled like a test',
    exists (select 1 from ai_documents ad join kb_articles k on k.id::text = ad.source_id
             where ad.source_type = 'kb_article' and ad.source_id = testing_doc and k.title ilike '%test%'),
    (select k.title from kb_articles k where k.id::text = testing_doc));
end $$;

select n, result, test, detail from ares order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'AUTOINGEST: PASS' else 'AUTOINGEST: FAIL' end as verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from ares;
