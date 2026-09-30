-- ============================================================
-- Phase 1: grants, SECURITY DEFINER hygiene, client write-denial, ai_feedback.
-- Run:  npm run sql:grants   (from Assistant/)
-- Always rolled back by the runner: nothing persists.
-- The phase-1 WARNs (L3 write privileges, L4 null rating) are hard
-- assertions since mig 372.
-- ============================================================

create temp table gres (n serial, test text, result text, detail text) on commit drop;
grant all on gres to authenticated, anon, service_role;
grant all on sequence gres_n_seq to authenticated, anon, service_role;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into gres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
create function pg_temp.warn(t text, d text) returns void language sql as $$
  insert into gres (test, result, detail) values (t, 'WARN', d);
$$;

-- ── the functions of mig 367–371 and who may execute them ───────────
create temp view phase1_fns as
select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_exec,
       (select string_agg(coalesce(r.rolname, 'PUBLIC'), ', ' order by 1)
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee
         where a.privilege_type = 'EXECUTE') as grantees
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('ai_can_read_document','ai_search','ai_enqueue','ai_ingest_claim','ai_ingest_complete',
                     'ai_ingest_fail','ai_ingest_retry','ai_feedback');

select proname, args, prosecdef as secdef, proconfig, grantees from phase1_fns order by proname;

do $$
declare f record; n int;
begin
  select count(*) into n from phase1_fns;
  perform pg_temp.ok('all 8 phase-1 functions exist, no stray overloads', n = 8, n::text);

  for f in select * from phase1_fns loop
    perform pg_temp.ok(f.proname || ': SECURITY DEFINER', f.prosecdef);
    perform pg_temp.ok(f.proname || ': search_path pinned', exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'),
                       array_to_string(f.proconfig, ' '));
    perform pg_temp.ok(f.proname || ': not executable by PUBLIC', not f.public_exec, f.grantees);
    perform pg_temp.ok(f.proname || ': not executable by anon', not f.anon_exec, f.grantees);
    if f.proname in ('ai_search','ai_feedback','ai_ingest_retry') then
      perform pg_temp.ok(f.proname || ': executable by authenticated', f.auth_exec, f.grantees);
    else
      perform pg_temp.ok(f.proname || ': NOT executable by authenticated (service only)', not f.auth_exec, f.grantees);
    end if;
    if f.proname in ('ai_search','ai_enqueue','ai_ingest_claim','ai_ingest_complete','ai_ingest_fail') then
      perform pg_temp.ok(f.proname || ': executable by service_role', f.service_exec, f.grantees);
    end if;
  end loop;
end $$;

-- ── client writes on the new tables ─────────────────────────────────
-- Behaviour first (what a PostgREST client can actually do), as a boss —
-- the most privileged client — and as anon.
do $$
declare
  t text; who record; outcome text; n bigint;
  tables text[] := array['ai_documents','ai_chunks','ai_ingest_queue','ai_ingest_runs','tts_articles','ai_request_log'];
  ins jsonb := jsonb_build_object(
    'ai_documents',    $q$insert into public.ai_documents (source_type, source_id, title, acl_mode, doc_hash) values ('gtest','x','x','all','x')$q$,
    'ai_chunks',       $q$insert into public.ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding_model) values (gen_random_uuid(), 0, 'x','x',1,'x','x')$q$,
    'ai_ingest_queue', $q$insert into public.ai_ingest_queue (source_type, source_id, op) values ('gtest','x','upsert')$q$,
    'ai_ingest_runs',  $q$insert into public.ai_ingest_runs (kind) values ('gtest')$q$,
    'tts_articles',    $q$insert into public.tts_articles (knowledge_id, kind, url, title, body, content_hash) values ('gtest','essay','x','x','x','x')$q$,
    'ai_request_log',  $q$insert into public.ai_request_log (engine) values ('gtest')$q$);
begin
  -- a row in each queue/log table so UPDATE/DELETE have a target
  insert into ai_ingest_queue (source_type, source_id, op) values ('gtest', 'seed', 'upsert');
  insert into ai_ingest_runs (kind) values ('gtest');
  insert into tts_articles (knowledge_id, kind, url, title, body, content_hash) values ('gtest-seed', 'essay', 'x', 'x', 'x', 'x');
  insert into ai_request_log (engine, user_id) values ('gtest', (select id from profiles where role = 'boss' and is_active limit 1));

  for who in select * from (values
      ('authenticated(boss)', 'authenticated', json_build_object('sub', (select id from profiles where role = 'boss' and is_active and deleted_at is null limit 1), 'role', 'authenticated')::text),
      ('anon', 'anon', json_build_object('role', 'anon')::text)) v(label, rolname, claims) loop
    foreach t in array tables loop
      perform set_config('request.jwt.claims', who.claims, true);
      execute format('set local role %I', who.rolname);
      begin execute ins->>t; outcome := 'INSERTED';
      exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
      execute 'reset role';
      perform pg_temp.ok(who.label || ' cannot INSERT ' || t, outcome <> 'INSERTED', outcome);

      execute format('set local role %I', who.rolname);
      begin execute format('update public.%I set %I = %I', t,
                           case t when 'ai_documents' then 'title' when 'ai_chunks' then 'content' when 'ai_ingest_queue' then 'reason'
                                  when 'ai_ingest_runs' then 'error' when 'tts_articles' then 'title' else 'rating_note' end,
                           case t when 'ai_documents' then 'title' when 'ai_chunks' then 'content' when 'ai_ingest_queue' then 'reason'
                                  when 'ai_ingest_runs' then 'error' when 'tts_articles' then 'title' else 'rating_note' end);
            get diagnostics n = row_count; outcome := n || ' rows updated';
      exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
      execute 'reset role';
      perform pg_temp.ok(who.label || ' cannot UPDATE ' || t, outcome not like '%rows updated' or outcome = '0 rows updated', outcome);

      execute format('set local role %I', who.rolname);
      begin execute format('delete from public.%I', t); get diagnostics n = row_count; outcome := n || ' rows deleted';
      exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
      execute 'reset role';
      perform pg_temp.ok(who.label || ' cannot DELETE ' || t, outcome not like '%rows deleted' or outcome = '0 rows deleted', outcome);
    end loop;
  end loop;
end $$;

-- Table-level privileges (defence in depth: RLS is the only thing stopping writes where these are true)
select c.relname as table_name, r.rolname,
       string_agg(p.priv, ',' order by p.priv) filter (where has_table_privilege(r.rolname, c.oid, p.priv)) as privileges_held
  from pg_class c
  cross join (values ('anon'),('authenticated')) r(rolname)
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('ai_documents','ai_chunks','ai_ingest_queue','ai_ingest_runs','tts_articles','ai_request_log')
 group by c.relname, r.rolname order by 1, 2;

-- L3 (mig 372): no client write privilege of any kind on the 6 tables
do $$
declare t record;
begin
  for t in select c.relname, r.rolname,
                  string_agg(p.priv, ',') filter (where has_table_privilege(r.rolname, c.oid, p.priv)) as privs
             from pg_class c
             cross join (values ('anon'),('authenticated')) r(rolname)
             cross join (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
            where c.relnamespace = 'public'::regnamespace
              and c.relname in ('ai_documents','ai_chunks','ai_ingest_queue','ai_ingest_runs','tts_articles','ai_request_log')
            group by 1, 2 order by 1, 2 loop
    perform pg_temp.ok(t.relname || ': ' || t.rolname || ' holds no write privilege (incl. TRUNCATE/REFERENCES/TRIGGER)',
                       t.privs is null, t.privs);
  end loop;
  -- column-level grants would survive a table-level revoke
  perform pg_temp.ok('no column-level INSERT/UPDATE/REFERENCES grants to anon/authenticated on the 6 tables',
    not exists (select 1 from information_schema.column_privileges
                 where table_schema = 'public' and grantee in ('anon','authenticated')
                   and privilege_type in ('INSERT','UPDATE','REFERENCES')
                   and table_name in ('ai_documents','ai_chunks','ai_ingest_queue','ai_ingest_runs','tts_articles','ai_request_log')));
  perform pg_temp.ok('ai_documents: no client privileges at all',
    not has_table_privilege('authenticated', 'public.ai_documents', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    and not has_table_privilege('anon', 'public.ai_documents', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
  perform pg_temp.ok('ai_chunks: no client privileges at all',
    not has_table_privilege('authenticated', 'public.ai_chunks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    and not has_table_privilege('anon', 'public.ai_chunks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
end $$;

-- ── RLS reads: admin-only tables and own-rows request log ───────────
do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',  (select id::text from profiles where role = 'apc'  and is_active and deleted_at is null limit 1), true);
  perform set_config('t.tl',   (select id::text from profiles where role = 'tl'   and is_active and deleted_at is null limit 1), true);
  perform set_config('t.dev',  (select id::text from profiles where role = 'developer' and is_active and deleted_at is null limit 1), true);
end $$;

insert into ai_ingest_queue (source_type, source_id, op) values ('gtest', 'read', 'upsert');
insert into ai_ingest_runs (kind) values ('gtest-read');
insert into tts_articles (knowledge_id, kind, url, title, body, content_hash) values ('gtest-read', 'essay', 'x', 'x', 'x', 'x');
insert into ai_request_log (id, engine, user_id) values
  ('00000000-0000-4000-8000-00000000000a', 'gtest', current_setting('t.apc')::uuid),
  ('00000000-0000-4000-8000-00000000000b', 'gtest', current_setting('t.tl')::uuid);

do $$
declare who record; q int; r int; a int; l int;
begin
  for who in select * from (values ('boss', current_setting('t.boss'), true), ('apc', current_setting('t.apc'), false),
                                   ('developer', current_setting('t.dev'), false)) v(label, uid, admin) loop
    perform set_config('request.jwt.claims', json_build_object('sub', who.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into q from ai_ingest_queue where source_type = 'gtest';
    select count(*) into r from ai_ingest_runs  where kind like 'gtest%';
    select count(*) into a from tts_articles    where knowledge_id like 'gtest%';
    select count(*) into l from ai_request_log  where engine = 'gtest';
    execute 'reset role';
    if who.admin then
      perform pg_temp.ok('RLS read: boss sees queue/runs/tts_articles', q > 0 and r > 0 and a > 0, q || '/' || r || '/' || a);
      perform pg_temp.ok('RLS read: boss sees every request_log row', l >= 2, l::text);
    else
      perform pg_temp.ok('RLS read: ' || who.label || ' sees no queue/runs/tts_articles', q = 0 and r = 0 and a = 0, q || '/' || r || '/' || a);
    end if;
    if who.label = 'apc' then
      perform pg_temp.ok('RLS read: apc sees only own request_log row', l = 1, l::text);
    end if;
  end loop;
end $$;

-- ── ai_feedback ─────────────────────────────────────────────────────
do $$
declare outcome text; ra smallint; rb smallint; note text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform ai_feedback('00000000-0000-4000-8000-00000000000a', 1::smallint, 'good'); outcome := 'ok';
  exception when others then outcome := sqlerrm; end;
  begin perform ai_feedback('00000000-0000-4000-8000-00000000000b', (-1)::smallint, 'not mine'); exception when others then null; end;
  execute 'reset role';
  select rating, rating_note into ra, note from ai_request_log where id = '00000000-0000-4000-8000-00000000000a';
  select rating into rb from ai_request_log where id = '00000000-0000-4000-8000-00000000000b';
  perform pg_temp.ok('feedback: user rates own request', outcome = 'ok' and ra = 1 and note = 'good', coalesce(outcome, '') || ' rating=' || coalesce(ra::text, 'null'));
  perform pg_temp.ok('feedback: user cannot rate someone else''s request', rb is null, coalesce(rb::text, 'null'));

  execute 'set local role authenticated';
  foreach ra in array array[0, 2, -2]::smallint[] loop
    begin perform ai_feedback('00000000-0000-4000-8000-00000000000a', ra); outcome := 'accepted';
    exception when others then outcome := sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('feedback: rating ' || ra || ' rejected', outcome = 'rating must be -1 or 1', outcome);
    execute 'set local role authenticated';
  end loop;
  begin perform ai_feedback('00000000-0000-4000-8000-00000000000a', (-1)::smallint, repeat('n', 5000)); outcome := 'ok';
  exception when others then outcome := sqlerrm; end;
  execute 'reset role';
  select rating, rating_note into ra, note from ai_request_log where id = '00000000-0000-4000-8000-00000000000a';
  perform pg_temp.ok('feedback: -1 accepted, note capped at 2000', outcome = 'ok' and ra = -1 and length(note) = 2000,
                     outcome || ' rating=' || coalesce(ra::text, 'null') || ' note_len=' || coalesce(length(note)::text, 'null'));

  -- L4 (mig 372): a null rating is rejected and leaves the existing rating alone
  execute 'set local role authenticated';
  begin perform ai_feedback('00000000-0000-4000-8000-00000000000a', null::smallint, 'cleared?'); outcome := 'null accepted';
  exception when others then outcome := sqlerrm; end;
  execute 'reset role';
  select rating, rating_note into ra, note from ai_request_log where id = '00000000-0000-4000-8000-00000000000a';
  perform pg_temp.ok('feedback: null rating rejected, rating and note unchanged',
    outcome = 'rating must be -1 or 1' and ra = -1 and length(note) = 2000,
    outcome || ' rating=' || coalesce(ra::text, 'null'));

  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  begin perform ai_feedback('00000000-0000-4000-8000-00000000000a', 1::smallint); outcome := 'allowed';
  exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlerrm; end;
  execute 'reset role';
  perform pg_temp.ok('feedback: anon has no execute', outcome = 'permission denied', outcome);
end $$;

-- service-only RPCs called by a logged-in user
do $$
declare fn text; outcome text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  foreach fn in array array[
      $q$select public.ai_enqueue('gtest','x','upsert')$q$,
      $q$select * from public.ai_ingest_claim(10, 'evil')$q$,
      $q$select public.ai_ingest_complete(1, 'evil')$q$,
      $q$select public.ai_ingest_fail(1, 'evil', 'x')$q$,
      $q$select public.ai_can_read_document(null::public.ai_documents, gen_random_uuid(), 'boss')$q$] loop
    execute 'set local role authenticated';
    begin execute fn; outcome := 'EXECUTED';
    exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('authenticated (even boss) cannot call: ' || split_part(split_part(fn, 'public.', 2), '(', 1), outcome = 'permission denied', outcome);
  end loop;
end $$;

-- ── Phase 2B (mig 373 / 376): the ingest write path ──────────────────
-- kind: service = service_role only; admin = authenticated may call, the body
-- checks ai_is_service_or_admin(); const = harmless constants, no definer;
-- config = mig 377 ai_source_types(): definer (reads ai_assistant_config, which
-- clients cannot read in full), pinned, returns only the enabled type names.
create temp table p2b_expect (proname text, args text, kind text) on commit drop;
insert into p2b_expect values
  ('ai_is_service_or_admin', '', 'service'),
  ('ai_incentive_items', 'p jsonb', 'service'),
  ('ai_ingest_source', 'p_type text, p_ids text[], p_payload boolean', 'service'),
  ('ai_ingest_existing', 'p_type text, p_ids text[]', 'service'),
  ('ai_ingest_holds', 'p_queue_id bigint, p_worker text', 'service'),
  ('ai_ingest_write', 'p_doc jsonb, p_chunks jsonb, p_queue_id bigint, p_worker text', 'service'),
  ('ai_ingest_delete', 'p_type text, p_id text, p_queue_id bigint, p_worker text, p_soft boolean', 'service'),
  ('ai_ingest_touch', 'p_type text, p_id text, p_fp text, p_queue_id bigint, p_worker text', 'service'),
  ('ai_ingest_run_start', 'p_kind text, p_worker text', 'service'),
  ('ai_ingest_run_finish', 'p_id bigint, p_stats jsonb, p_error text', 'service'),
  ('ai_backfill_candidates', 'p_type text', 'service'),
  ('ai_enqueue_stale', 'p_types text[], p_priority integer, p_reason text, p_stagger boolean, p_pipeline_budget integer', 'service'),
  ('ai_reconcile', 'p_pipeline_budget integer', 'service'),
  ('ai_backfill', 'p_source_type text', 'admin'),
  ('ai_ingest_stats', '', 'admin'),
  ('ai_pipeline_version', '', 'const'),
  ('ai_embed_model', '', 'const'),
  ('ai_source_types', '', 'config'),
  ('ai_source_enabled', 'p_type text', 'service');

create temp view p2b_fns as
select e.kind, p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig, p.provolatile,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_exec,
       pg_get_functiondef(p.oid) as def
  from pg_proc p join p2b_expect e on e.proname = p.proname
 where p.pronamespace = 'public'::regnamespace;

do $$
declare f record; e record; n int; s text;
begin
  for e in select * from p2b_expect loop
    select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = e.proname;
    perform pg_temp.ok('2B ' || e.proname || ': exists once, signature (' || e.args || ')',
      n = 1 and exists (select 1 from p2b_fns x where x.proname = e.proname and x.args = e.args),
      n || ' overload(s): ' || coalesce((select string_agg(x.args, ' | ') from p2b_fns x where x.proname = e.proname), 'none'));
  end loop;

  for f in select * from p2b_fns loop
    perform pg_temp.ok('2B ' || f.proname || ': not executable by PUBLIC', not f.public_exec);
    perform pg_temp.ok('2B ' || f.proname || ': not executable by anon', not f.anon_exec);
    if f.prosecdef then
      perform pg_temp.ok('2B ' || f.proname || ': SECURITY DEFINER with pinned search_path',
        exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'), array_to_string(f.proconfig, ' '));
    end if;
    if f.kind = 'service' then
      perform pg_temp.ok('2B ' || f.proname || ': NOT executable by authenticated (service only)', not f.auth_exec);
      perform pg_temp.ok('2B ' || f.proname || ': executable by service_role', f.service_exec);
    elsif f.kind = 'admin' then
      perform pg_temp.ok('2B ' || f.proname || ': SECURITY DEFINER, executable by authenticated', f.prosecdef and f.auth_exec);
      perform pg_temp.ok('2B ' || f.proname || ': body checks ai_is_service_or_admin() before anything else',
        position('if not public.ai_is_service_or_admin() then raise exception' in f.def) > 0
        and position('if not public.ai_is_service_or_admin()' in f.def) < coalesce(nullif(position('ai_enqueue_stale' in f.def), 0), 1000000)
        and position('if not public.ai_is_service_or_admin()' in f.def) < coalesce(nullif(position('jsonb_build_object' in f.def), 0), 1000000));
    elsif f.kind = 'config' then
      perform pg_temp.ok('377 ' || f.proname || ': SECURITY DEFINER, reads only ai_assistant_config.ingest_sources, writes nothing',
        f.prosecdef and f.def ~ 'ai_assistant_config' and f.def ~ 'ingest_sources'
        and f.def !~* '\m(update|insert|delete)\M' and f.provolatile = 's', left(regexp_replace(f.def, '\s+', ' ', 'g'), 160));
    else
      perform pg_temp.ok('2B ' || f.proname || ': harmless constant (no SECURITY DEFINER, reads no table)',
        not f.prosecdef and f.def !~* '\m(from|update|insert|delete)\M', left(regexp_replace(f.def, '\s+', ' ', 'g'), 120));
    end if;
  end loop;

  -- Only the admin helper's JWT paths can be exercised here: this runner's
  -- session_user is postgres, which the helper treats as a trusted direct
  -- session. A PostgREST client's session_user is authenticator.
  select string_agg(p.proname, ',' order by p.proname) into s
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname like 'ai\_%'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and p.proname not in ('ai_search','ai_feedback','ai_ingest_retry','ai_backfill','ai_ingest_stats',
                           'ai_pipeline_version','ai_embed_model','ai_source_types',
                           'ai_run_ingestion',                                             -- 379: body checks Boss / active developer
                           'ai_usage_summary',                                             -- 387: body checks is_boss(auth.uid()) first
                           'ai_get_chunks','ai_resolve_brands','ai_report_periods');       -- 378: identity = auth.uid(), same ACL as ai_search
  perform pg_temp.ok('2B/379: no other ai_* function is executable by authenticated', s is null, s);

  -- Owner (2026-09-29, final): only the Boss changes ingest_sources. No Developer RPC.
  perform pg_temp.ok('no ai_set_source_enabled function exists (only the Boss may change ingest_sources)',
    not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_set_source_enabled'));
  perform pg_temp.ok('is_ai_admin() is still boss-only (mig 207: no developer path to config, chats or persona)',
    pg_get_functiondef('public.is_ai_admin(uuid)'::regprocedure) !~* 'developer');

  -- The draft content triggers of 374 must never exist (374 was rewritten to the KB security trigger only).
  select string_agg(proname, ',') into s from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('ai_trg_reports','ai_trg_kb_articles','ai_trg_ai_assistant_docs','ai_trg_tts_articles',
                     'ai_trg_incentives','ai_trg_brands');
  perform pg_temp.ok('374: none of the draft content-trigger functions exists', s is null, s);
  -- State-aware (flips at deploy): 374 is either absent or complete.
  perform pg_temp.ok('374: absent, or complete (ai_enqueue_enabled + ai_trg_kb_articles_acl + trigger ai_kb_articles_acl)',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('ai_enqueue_enabled','ai_trg_kb_articles_acl'))
      + (select count(*) from pg_trigger where tgname = 'ai_kb_articles_acl' and tgrelid = 'public.kb_articles'::regclass) in (0, 3));
  perform pg_temp.ok('377: ai_assistant_config.ingest_sources exists, text[] not null',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_assistant_config'
             and column_name = 'ingest_sources' and data_type = 'ARRAY' and is_nullable = 'NO'));
  select string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ' ; ') into s
    from pg_policies where schemaname = 'public' and tablename = 'ai_assistant_config' and cmd in ('UPDATE','ALL','INSERT','DELETE');
  perform pg_temp.ok('377: every write policy on ai_assistant_config is gated by is_ai_admin',
    s is not null and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_assistant_config'
                                     and cmd in ('UPDATE','ALL','INSERT','DELETE')
                                     and (coalesce(qual, '') || coalesce(with_check, '')) !~ 'is_ai_admin'), s);
  perform pg_temp.ok('377: RLS is enabled on ai_assistant_config',
    exists (select 1 from pg_class where oid = 'public.ai_assistant_config'::regclass and relrowsecurity));
  -- State-aware (flips at deploy): the ai-* jobs are exactly those of 375 (when ai_ingest_tick exists)
  -- and 381 (when ai_crawl_tick exists), with the approved schedules; nothing else.
  select string_agg(jobname || ' ' || schedule || ' ' || command, ' | ' order by jobname) into s from cron.job where jobname ilike 'ai%';
  perform pg_temp.ok('375/381: the ai-* cron jobs match what is applied (none before deploy; 3 + 2 after)',
    coalesce(s, '') = concat_ws(' | ',
      case when to_regprocedure('public.ai_finish_stale_replies(integer)') is not null then 'ai-finish-stale-replies */5 * * * * select public.ai_finish_stale_replies(10)' end,   -- mig 386
      case when to_regprocedure('public.ai_housekeeping()') is not null then 'ai-housekeeping 30 22 * * * select public.ai_housekeeping()' end,
      case when to_regprocedure('public.ai_ingest_tick()') is not null then 'ai-ingest-sweep 5 * * * * select public.ai_ingest_sweep_if_due()' end,
      case when to_regprocedure('public.ai_ingest_tick()') is not null then 'ai-ingest-tick * * * * * select public.ai_ingest_tick()' end,
      case when to_regprocedure('public.ai_crawl_tick()') is not null and exists (select 1 from public.app_config where key = 'ai_crawl_url') then 'ai-tts-crawl-start 0 23 * * 6 select public.ai_crawl_start()' end,
      case when to_regprocedure('public.ai_crawl_tick()') is not null and exists (select 1 from public.app_config where key = 'ai_crawl_url') then 'ai-tts-crawl-tick * * * * * select public.ai_crawl_tick()' end),
    s);
  perform pg_temp.ok('375: app_config keys ai_ingest_url / ai_ingest_secret present iff 375 is',
    (to_regprocedure('public.ai_ingest_tick()') is not null)
      = ((select count(*) from public.app_config where key in ('ai_ingest_url','ai_ingest_secret')) = 2));
end $$;

-- ── 379 / 380 / 374 / 375 (auto-ingestion package): every new or redefined function ──
-- kind: service = service_role only; ondemand = authenticated may call, the body
-- checks Boss / active developer; const = immutable helper, no definer, no table.
create temp table pkg_expect (mig text, proname text, args text, kind text) on commit drop;
insert into pkg_expect values
  ('379', 'ai_source_canon', '', 'const'),
  ('379', 'ai_is_test_source', 'p text', 'const'),
  ('379', 'ai_ignored_sources', '', 'service'),
  ('379', 'ai_ingest_sweep', 'p_trigger text, p_by uuid', 'service'),
  ('379', 'ai_last_sweep_at', '', 'service'),
  ('379', 'ai_ingest_sweep_if_due', '', 'service'),
  ('379', 'ai_run_ingestion', '', 'ondemand'),
  ('380', 'ai_trg_ingest_sources_check', '', 'service'),
  ('380', 'ai_crawl_holds', 'p_worker text', 'service'),
  ('380', 'ai_crawl_start', '', 'service'),
  ('380', 'ai_crawl_lease', 'p_worker text', 'service'),
  ('380', 'ai_crawl_release', 'p_worker text', 'service'),
  ('380', 'ai_crawl_note_error', 'p_worker text, p_error text', 'service'),
  ('380', 'ai_crawl_add_items', 'p_worker text, p_items jsonb', 'service'),
  ('380', 'ai_crawl_next', 'p_worker text, p_limit integer', 'service'),
  ('380', 'ai_crawl_put', 'p_worker text, p_key text, p_outcome text, p_records jsonb, p_error text', 'service'),
  ('380', 'ai_crawl_read_records', 'p_worker text, p_after text, p_limit integer', 'service'),
  ('380', 'ai_tts_apply', 'p_worker text, p_rows jsonb, p_last text, p_stats jsonb', 'service'),
  ('380', 'ai_crawl_finish', 'p_worker text', 'service'),
  ('380', 'ai_crawl_tick', '', 'service'),
  ('380', 'ai_can_read_document', 'd ai_documents, uid uuid, urole text', 'service'),
  ('380', 'ai_ingest_source', 'p_type text, p_ids text[], p_payload boolean', 'service'),
  ('374', 'ai_enqueue_enabled', 'p_type text, p_id text, p_op text, p_priority integer, p_debounce interval, p_reason text', 'service'),
  ('374', 'ai_trg_kb_articles_acl', '', 'service'),
  ('375', 'ai_ingest_tick', '', 'service'),
  ('375', 'ai_housekeeping', '', 'service'),
  ('382', 'ai_chunks_set_source_type', '', 'service'),
  ('386', 'ai_finish_stale_replies', 'p_minutes integer', 'service'),
  ('386', 'ai_turn_begin', 'p_request_id uuid, p_user_id uuid, p_question text, p_model text, p_limit integer', 'service');

create temp view pkg_fns as
select e.mig, e.kind, e.args as want_args, p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig, p.provolatile,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_exec,
       pg_get_functiondef(p.oid) as def
  from pkg_expect e join pg_proc p on p.proname = e.proname and p.pronamespace = 'public'::regnamespace;

do $$
declare f record; m text; n int; want int; s text;
begin
  -- a migration is either fully present or fully absent (state-aware: flips at deploy)
  foreach m in array array['379','380','374','375','382','386'] loop
    select count(*) into want from pkg_expect where mig = m;
    select count(distinct proname) into n from pkg_fns where mig = m
       and not (proname in ('ai_can_read_document','ai_ingest_source') and def !~ 'ai_excluded_documents');   -- pre-380 versions exist already
    perform pg_temp.ok('pkg ' || m || ': all or none of its ' || want || ' functions present', n in (0, want), n || ' of ' || want);
  end loop;
  select string_agg(pf.proname || '(' || pf.args || ')', ', ') into s from pkg_fns pf
   where (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = pf.proname) > 1 or pf.args <> pf.want_args;
  perform pg_temp.ok('pkg: no stray overloads, signatures as expected', s is null, s);

  for f in select * from pkg_fns loop
    perform pg_temp.ok('pkg ' || f.mig || ' ' || f.proname || ': not executable by PUBLIC / anon', not f.public_exec and not f.anon_exec);
    if f.kind = 'const' then
      perform pg_temp.ok('pkg ' || f.mig || ' ' || f.proname || ': immutable helper, no definer, reads no table, not executable by authenticated',
        not f.prosecdef and f.provolatile = 'i' and f.def !~* '\m(from|update|insert|delete)\M' and not f.auth_exec);
    else
      perform pg_temp.ok('pkg ' || f.mig || ' ' || f.proname || ': SECURITY DEFINER with search_path pinned',
        f.prosecdef and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'), array_to_string(f.proconfig, ' '));
      perform pg_temp.ok('pkg ' || f.mig || ' ' || f.proname || ': executable by service_role', f.service_exec);
      if f.kind = 'service' then
        perform pg_temp.ok('pkg ' || f.mig || ' ' || f.proname || ': NOT executable by authenticated (service only)', not f.auth_exec);
      else
        perform pg_temp.ok('pkg ' || f.mig || ' ' || f.proname || ': executable by authenticated; the caller check comes before any work',
          f.auth_exec and position('raise exception ''not allowed''' in f.def) > 0
          and position('raise exception ''not allowed''' in f.def) < position('ai_ingest_sweep(' in f.def));
      end if;
    end if;
  end loop;
end $$;

-- behaviour: a logged-in Boss cannot call any service-only package function; anon cannot call ai_run_ingestion
do $$
declare fn text; outcome text;
begin
  if to_regprocedure('public.ai_crawl_tick()') is null then
    perform pg_temp.ok('pkg behaviour: 379/380 not present, calls skipped', true);
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  foreach fn in array array[
      $q$select public.ai_source_canon()$q$,
      $q$select public.ai_is_test_source('qa_x')$q$,
      $q$select public.ai_ignored_sources()$q$,
      $q$select public.ai_ingest_sweep('manual', null)$q$,
      $q$select public.ai_last_sweep_at()$q$,
      $q$select public.ai_ingest_sweep_if_due()$q$,
      $q$select public.ai_crawl_holds('evil')$q$,
      $q$select public.ai_crawl_start()$q$,
      $q$select public.ai_crawl_lease('evil')$q$,
      $q$select public.ai_crawl_release('evil')$q$,
      $q$select public.ai_crawl_note_error('evil', 'x')$q$,
      $q$select public.ai_crawl_add_items('evil', '[]'::jsonb)$q$,
      $q$select public.ai_crawl_next('evil', 5)$q$,
      $q$select public.ai_crawl_put('evil', 'k', 'done', null, null)$q$,
      $q$select public.ai_crawl_read_records('evil', null, 10)$q$,
      $q$select public.ai_tts_apply('evil', '[]'::jsonb, null, '{}'::jsonb)$q$,
      $q$select public.ai_crawl_finish('evil')$q$,
      $q$select public.ai_crawl_tick()$q$,
      $q$select public.ai_ingest_source('kb_article', null, false)$q$] loop
    execute 'set local role authenticated';
    begin execute fn; outcome := 'EXECUTED';
    exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('pkg authenticated boss cannot call: ' || split_part(split_part(fn, 'public.', 2), '(', 1), outcome = 'permission denied', outcome);
  end loop;
  if to_regprocedure('public.ai_ingest_tick()') is not null then
    foreach fn in array array[$q$select public.ai_ingest_tick()$q$, $q$select public.ai_housekeeping()$q$,
                              $q$select public.ai_enqueue_enabled('kb_article', 'x', 'acl', 0, interval '0', 'evil')$q$] loop
      execute 'set local role authenticated';
      begin execute fn; outcome := 'EXECUTED';
      exception when insufficient_privilege then outcome := 'permission denied'; when undefined_function then outcome := 'permission denied (absent)'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
      execute 'reset role';
      perform pg_temp.ok('pkg authenticated boss cannot call: ' || split_part(split_part(fn, 'public.', 2), '(', 1), outcome like 'permission denied%', outcome);
    end loop;
  end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  begin perform public.ai_run_ingestion(); outcome := 'EXECUTED';
  exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  perform pg_temp.ok('pkg anon cannot call ai_run_ingestion', outcome = 'permission denied', outcome);
end $$;

-- ── 380 tables: privileges and RLS ──
do $$
declare s text;
begin
  if to_regclass('public.ai_excluded_documents') is null then
    perform pg_temp.ok('380 tables: not present, skipped', true);
    return;
  end if;
  select string_agg(c.relname || '/' || r.rolname || '=' || coalesce(x.privs, ''), '; ' order by c.relname, r.rolname) into s
    from pg_class c cross join (values ('anon'),('authenticated')) r(rolname)
    cross join lateral (select string_agg(p.priv, ',' order by p.o) filter (where has_table_privilege(r.rolname, c.oid, p.priv)) privs
                          from (values ('SELECT',1),('INSERT',2),('UPDATE',3),('DELETE',4),('TRUNCATE',5),('REFERENCES',6),('TRIGGER',7)) p(priv, o)) x
   where c.relnamespace = 'public'::regnamespace and c.relname in ('ai_excluded_documents','ai_crawl_state','ai_crawl_items','ai_crawl_records');
  perform pg_temp.ok('380 table privileges: exclusions S/I/U/D for authenticated only; crawl_state SELECT; items / records none; anon none',
    s = 'ai_crawl_items/anon=; ai_crawl_items/authenticated=; ai_crawl_records/anon=; ai_crawl_records/authenticated=; '
     || 'ai_crawl_state/anon=; ai_crawl_state/authenticated=SELECT; ai_excluded_documents/anon=; ai_excluded_documents/authenticated=SELECT,INSERT,UPDATE,DELETE', s);
  perform pg_temp.ok('380: RLS enabled on the 4 tables',
    (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity
        and relname in ('ai_excluded_documents','ai_crawl_state','ai_crawl_items','ai_crawl_records')) = 4);
  select string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ' ; ' order by tablename) into s
    from pg_policies where schemaname = 'public' and tablename in ('ai_excluded_documents','ai_crawl_state','ai_crawl_items','ai_crawl_records');
  perform pg_temp.ok('380 policies: exclusions ALL gated by is_ai_admin both ways; crawl_state SELECT by is_ai_admin; none on items / records',
    s = 'ai_crawl_state:ai_crawl_state_admin_read:SELECT:is_ai_admin(( SELECT auth.uid() AS uid))| ; '
     || 'ai_excluded_documents:ai_excluded_documents_admin:ALL:is_ai_admin(( SELECT auth.uid() AS uid))|is_ai_admin(( SELECT auth.uid() AS uid))', s);
  -- (information_schema.column_privileges also lists table-level grants; attacl holds only true column grants)
  perform pg_temp.ok('380: no column-level grants on the 4 tables (a column grant would survive a table-level revoke)',
    not exists (select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
                 where c.relnamespace = 'public'::regnamespace and a.attacl is not null
                   and c.relname in ('ai_excluded_documents','ai_crawl_state','ai_crawl_items','ai_crawl_records')));
  perform pg_temp.ok('380: none of the 4 tables is in the supabase_realtime publication',
    not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and tablename in ('ai_excluded_documents','ai_crawl_state','ai_crawl_items','ai_crawl_records')));
end $$;

-- behaviour: a logged-in user (even the Boss) cannot call the service-only 2B functions
do $$
declare fn text; outcome text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  foreach fn in array array[
      $q$select public.ai_is_service_or_admin()$q$,
      $q$select public.ai_incentive_items('[]'::jsonb)$q$,
      $q$select public.ai_ingest_source('incentive', null, true)$q$,
      $q$select public.ai_ingest_existing('incentive', null)$q$,
      $q$select public.ai_ingest_holds(1, 'evil')$q$,
      $q$select public.ai_ingest_write('{"source_type":"gtest","source_id":"x","doc_hash":"h","embed_model":"m","acl_mode":"all"}'::jsonb, '[]'::jsonb, null, null)$q$,
      $q$select public.ai_ingest_delete('report', 'x', null, null, false)$q$,
      $q$select public.ai_ingest_touch('report', 'x', 'fp', null, null)$q$,
      $q$select public.ai_ingest_run_start('ingest', 'evil')$q$,
      $q$select public.ai_ingest_run_finish(1, '{}'::jsonb, null)$q$,
      $q$select * from public.ai_backfill_candidates('incentive')$q$,
      $q$select public.ai_enqueue_stale(array['incentive'], 9, 'evil', false, null)$q$,
      $q$select public.ai_reconcile(1)$q$,
      $q$select public.ai_source_enabled('incentive')$q$] loop
    execute 'set local role authenticated';
    begin execute fn; outcome := 'EXECUTED';
    exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('2B authenticated boss cannot call: ' || split_part(split_part(fn, 'public.', 2), '(', 1), outcome = 'permission denied', outcome);
  end loop;

  -- anon: not even the admin-checked or constant functions
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  foreach fn in array array[$q$select public.ai_backfill(null)$q$, $q$select public.ai_ingest_stats()$q$,
                            $q$select public.ai_pipeline_version()$q$, $q$select public.ai_embed_model()$q$, $q$select public.ai_source_types()$q$] loop
    execute 'set local role anon';
    begin execute fn; outcome := 'EXECUTED';
    exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('2B anon cannot call: ' || split_part(split_part(fn, 'public.', 2), '(', 1), outcome = 'permission denied', outcome);
  end loop;
end $$;

-- ── 382 / 384 / 386 ─────────────────────────────────────────────────
do $$
declare s text; outcome text; n bigint;
begin
  if exists (select 1 from pg_attribute where attrelid = 'public.ai_chunks'::regclass and attname = 'source_type' and not attisdropped) then
    perform pg_temp.ok('382: ai_chunks.source_type is NOT NULL',
      (select attnotnull from pg_attribute where attrelid = 'public.ai_chunks'::regclass and attname = 'source_type'));
    select count(*) into n from public.ai_chunks c join public.ai_documents d on d.id = c.document_id where c.source_type is distinct from d.source_type;
    perform pg_temp.ok('382: every chunk''s source_type equals its document''s', n = 0, n::text);
    select string_agg(pg_get_triggerdef(oid), ' | ') into s from pg_trigger where tgrelid = 'public.ai_chunks'::regclass and not tgisinternal;
    perform pg_temp.ok('382: the one trigger on ai_chunks is ai_chunks_source_type (BEFORE INSERT OR UPDATE OF document_id)',
      s ~ '^CREATE TRIGGER ai_chunks_source_type BEFORE INSERT OR UPDATE OF document_id ON public.ai_chunks FOR EACH ROW' and s !~ '\|', s);
    perform pg_temp.ok('382: authenticated still has no privilege on ai_chunks',
      not has_table_privilege('authenticated', 'public.ai_chunks', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
  end if;
  if exists (select 1 from pg_attribute where attrelid = 'public.ai_messages'::regclass and attname = 'cancel_requested_at' and not attisdropped) then
    perform pg_temp.ok('386: no client can write ai_messages.cancel_requested_at (column or table grant)',
      not has_column_privilege('authenticated', 'public.ai_messages', 'cancel_requested_at', 'UPDATE')
      and not has_column_privilege('authenticated', 'public.ai_messages', 'cancel_requested_at', 'INSERT')
      and not has_column_privilege('anon', 'public.ai_messages', 'cancel_requested_at', 'UPDATE'));
  end if;
  -- 387: usage is Boss-only (the definer body checks is_boss(auth.uid()) before anything else)
  if to_regprocedure('public.ai_usage_summary(date, date)') is not null then
    perform pg_temp.ok('387 ai_usage_summary: SECURITY DEFINER, search_path pinned, not PUBLIC / anon, authenticated allowed (body-gated)',
      (select prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%') from pg_proc where oid = 'public.ai_usage_summary(date, date)'::regprocedure)
      and not has_function_privilege('anon', 'public.ai_usage_summary(date, date)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.ai_usage_summary(date, date)', 'EXECUTE'));
    perform pg_temp.ok('387 ai_usage_summary: the Boss check comes before any read',
      position('if not public.is_boss(auth.uid()) then raise exception' in pg_get_functiondef('public.ai_usage_summary(date, date)'::regprocedure)) between 1
      and position(' from public.' in pg_get_functiondef('public.ai_usage_summary(date, date)'::regprocedure)));
    for s in select id::text from profiles where role <> 'boss' and is_active and deleted_at is null and role in ('ol','developer','apc') loop
      perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin perform public.ai_usage_summary(null, null); outcome := 'EXECUTED';
      exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
      execute 'reset role';
      perform pg_temp.ok('387 ai_usage_summary: a non-Boss (' || (select role from profiles where id = s::uuid) || ') is refused', outcome like '%not allowed%', outcome);
    end loop;
    perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin perform public.ai_usage_summary(null, null); outcome := 'EXECUTED';
    exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('387 ai_usage_summary: the Boss gets it', outcome = 'EXECUTED', outcome);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
    begin perform public.ai_usage_summary(null, null); outcome := 'EXECUTED';
    exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('387 ai_usage_summary: anon has no EXECUTE', outcome = 'permission denied', outcome);
    perform pg_temp.ok('387 ai_usage_log: no client privilege at all',
      not has_table_privilege('authenticated', 'public.ai_usage_log', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      and not has_table_privilege('anon', 'public.ai_usage_log', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));
  end if;
  -- 384's check constraint must not break the Boss's own exclusion writes (authenticated role)
  if exists (select 1 from pg_constraint where conname = 'ai_excluded_documents_source_type_known') then
    perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      insert into public.ai_excluded_documents (source_type, source_id, reason) values ('kb_article', 'qa-grants-384', 'qa');
      outcome := 'inserted';
    exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
    execute 'reset role';
    perform pg_temp.ok('384: the Boss can still add an exclusion through the API (check constraint executable by authenticated)', outcome = 'inserted', outcome);
  end if;
end $$;

-- ── results ─────────────────────────────────────────────────────────
select n, result, test, detail from gres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'GRANTS: PASS' else 'GRANTS: FAIL' end as verdict,
       count(*) filter (where result = 'ok')   as ok,
       count(*) filter (where result = 'FAIL') as failed,
       count(*) filter (where result = 'WARN') as warnings
  from gres;
