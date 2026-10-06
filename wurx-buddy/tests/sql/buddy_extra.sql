-- ============================================================
-- QA 2026-09-30: mig 385 (Wurx Buddy UI backend), checks beyond scripts/sql/buddy_ui.sql.
--   node scripts/db-dev.mjs sql tests/sql/buddy_extra.sql      (always rolled back)
-- Realtime delivery can't be observed from SQL; what is checked is what it
-- depends on: publication, replica identity (DELETE payloads skip RLS), and the
-- same RLS the realtime worker evaluates per subscriber.
-- ============================================================
create temp table xres (n serial, test text, result text, detail text) on commit drop;
grant all on xres to authenticated, anon;
grant all on sequence xres_n_seq to authenticated, anon;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into xres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;

do $$ begin
  perform set_config('t.me',    (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',   (select id::text from profiles where role = 'apc' and is_active and deleted_at is null order by id limit 1), true);
  perform set_config('t.ol',    (select id::text from profiles where role = 'ol' and is_active and deleted_at is null order by id limit 1), true);
end $$;
insert into ai_conversations (id, user_id, title) values
  ('00000000-0000-4000-8000-00000000c001', current_setting('t.apc')::uuid, 'apc private');
insert into ai_messages (conversation_id, role, content, status) values
  ('00000000-0000-4000-8000-00000000c001', 'assistant', 'apc secret answer', 'generating');

do $$
declare s text; n int;
begin
  -- policies as they are on dev
  select string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ' ; ' order by tablename, policyname) into s
    from pg_policies where schemaname = 'public' and tablename in ('ai_conversations', 'ai_messages');
  perform pg_temp.ok('policies: no permissive INSERT (only ai_msg_no_insert WITH CHECK false), no ALL policy',
    s !~ ':ALL:' and not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('ai_conversations', 'ai_messages')
                                   and cmd = 'INSERT' and coalesce(with_check, '') <> 'false'), s);
  perform pg_temp.ok('RLS enabled (not forced) on both',
    (select bool_and(relrowsecurity) from pg_class where oid in ('public.ai_conversations'::regclass, 'public.ai_messages'::regclass)));
  -- column grants: exactly title / pinned / last_read_at
  select string_agg(a.attname, ',' order by a.attname) into s from pg_attribute a
   where a.attrelid = 'public.ai_conversations'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE');
  perform pg_temp.ok('authenticated may UPDATE only title, pinned, last_read_at', s = 'last_read_at,pinned,title', s);
  perform pg_temp.ok('authenticated has no INSERT / UPDATE / DELETE on ai_messages at all',
    not has_table_privilege('authenticated', 'public.ai_messages', 'INSERT,UPDATE,DELETE,TRUNCATE')
    and not exists (select 1 from pg_attribute a where a.attrelid = 'public.ai_messages'::regclass and a.attnum > 0
                     and (has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE') or has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT'))));
  -- realtime: DELETE events are sent without RLS; with REPLICA IDENTITY FULL they would carry the whole old row
  select string_agg(relname || '=' || relreplident::text, ',' order by relname) into s from pg_class
   where oid in ('public.ai_conversations'::regclass, 'public.ai_messages'::regclass);
  perform pg_temp.ok('replica identity default (d): a DELETE event carries only the primary key, never title / content', s = 'ai_conversations=d,ai_messages=d', s);
  perform pg_temp.ok('realtime schema present (postgres_changes evaluates RLS per subscriber via realtime.subscription)',
    to_regclass('realtime.subscription') is not null);

  -- another signed-in user (OL, who reads every KB article) cannot see the APC's rows, as realtime would evaluate
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.ol'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from ai_messages where conversation_id = '00000000-0000-4000-8000-00000000c001';
  perform pg_temp.ok('OL cannot select the APC''s generating message', n = 0, n::text);
  select count(*) into n from ai_conversations where id = '00000000-0000-4000-8000-00000000c001';
  perform pg_temp.ok('OL cannot select the APC''s conversation', n = 0, n::text);
  update ai_conversations set title = 'hijack', last_read_at = now() where id = '00000000-0000-4000-8000-00000000c001';
  get diagnostics n = row_count;
  perform pg_temp.ok('OL cannot rename / mark read the APC''s conversation', n = 0, n::text);
  delete from ai_conversations where id = '00000000-0000-4000-8000-00000000c001';
  get diagnostics n = row_count;
  perform pg_temp.ok('OL cannot delete it', n = 0, n::text);
  execute 'reset role';

  -- the Boss (full RLS bypass elsewhere) cannot read the APC's chats either (owner-only, as mig 207)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.me'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from ai_messages where conversation_id = '00000000-0000-4000-8000-00000000c001';
  execute 'reset role';
  perform pg_temp.ok('the Boss cannot read another user''s chat through the API', n = 0, n::text);

  -- page_context name lookups: the helpers the function calls exist with the parameter names it passes
  perform pg_temp.ok('can_view_brand(b_owner, b_id, uid) exists as called by pageContextNote',
    exists (select 1 from pg_proc where proname = 'can_view_brand' and pg_get_function_identity_arguments(oid) ~ 'b_owner uuid, b_id uuid, uid uuid'),
    (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc where proname = 'can_view_brand'));
  perform pg_temp.ok('can_view_report(r_brand, r_author, uid) exists as called by pageContextNote',
    exists (select 1 from pg_proc where proname = 'can_view_report' and pg_get_function_identity_arguments(oid) ~ 'r_brand uuid, r_author uuid, uid uuid'),
    (select string_agg(pg_get_function_identity_arguments(oid), ' | ') from pg_proc where proname = 'can_view_report'));
  -- a brand the APC cannot view exists (so the hint must drop it)
  perform pg_temp.ok('there is a brand the APC cannot view (control for the page_context test)',
    exists (select 1 from brands b where not can_view_brand(b.owner_id, b.id, current_setting('t.apc')::uuid)));

  -- allowed_roles
  perform pg_temp.ok('allowed_roles on dev is {boss}', (select allowed_roles from ai_assistant_config where id = 1) = '{boss}',
    (select allowed_roles::text from ai_assistant_config where id = 1));
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.me'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from ai_assistant_config;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update ai_assistant_config set allowed_roles = '{boss,apc}' where id = 1;
  get diagnostics n = row_count;
  execute 'reset role';
  perform pg_temp.ok('an APC cannot widen allowed_roles (RLS: Boss only)', n = 0, n::text);

  -- stale generating rows on dev right now (a function killed mid-turn leaves one)
  select count(*) into n from ai_messages where status = 'generating' and created_at < now() - interval '10 minutes';
  perform pg_temp.ok('dev: no assistant row stuck in generating for > 10 min', n = 0, n::text);
end $$;

select n, result, test, detail from xres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'BUDDY EXTRA: PASS' else 'BUDDY EXTRA: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from xres;
