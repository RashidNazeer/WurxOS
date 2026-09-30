-- ============================================================
-- Mig 385 (Wurx Buddy UI backend): RLS, column grants, title_edited,
-- message status, realtime publication, allowed_roles.
-- Run:  node scripts/db-dev.mjs sql scripts/sql/buddy_ui.sql   (always rolled back)
-- ============================================================

create temp table bres (n serial, test text, result text, detail text) on commit drop;
grant all on bres to authenticated, anon, service_role;
grant all on sequence bres_n_seq to authenticated, anon, service_role;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into bres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
-- Runs a statement as the current role; 'denied' on insufficient_privilege / RLS violation.
create function pg_temp.try(sql text) returns text language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  return 'rows=' || n;
exception when insufficient_privilege then return 'denied';
          when others then return 'error: ' || sqlstate;
end $$;
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;
grant execute on function pg_temp.try(text) to authenticated, anon;

do $$ begin
  perform set_config('t.me',    (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.other', (select id::text from profiles where role <> 'boss' and is_active and deleted_at is null limit 1), true);
end $$;

-- fixtures (as the owner of the tables, i.e. like the function's service role)
insert into ai_conversations (id, user_id, title) values
  ('00000000-0000-4000-8000-00000000b001', current_setting('t.me')::uuid, 'mine'),
  ('00000000-0000-4000-8000-00000000b002', current_setting('t.other')::uuid, 'theirs');
insert into ai_messages (conversation_id, role, content, status) values
  ('00000000-0000-4000-8000-00000000b001', 'user', 'q', 'done'),
  ('00000000-0000-4000-8000-00000000b001', 'assistant', '', 'generating'),
  ('00000000-0000-4000-8000-00000000b002', 'user', 'their q', 'done');

do $$ begin
  perform pg_temp.ok('status column: bad value refused',
    pg_temp.try($q$insert into ai_messages (conversation_id, role, content, status) values ('00000000-0000-4000-8000-00000000b001','user','x','weird')$q$) like 'error: 23514');
  perform pg_temp.ok('status default is done',
    (select column_default from information_schema.columns where table_name = 'ai_messages' and column_name = 'status') like '%done%');
  perform pg_temp.ok('allowed_roles defaults to {boss,developer} (mig 401)',
    (select column_default from information_schema.columns where table_name = 'ai_assistant_config' and column_name = 'allowed_roles') like '%{boss,developer}%');
  perform pg_temp.ok('realtime: both tables published',
    (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename in ('ai_messages', 'ai_conversations')) = 2);
  perform pg_temp.ok('realtime admin can read both (RLS evaluation)',
    has_table_privilege('supabase_realtime_admin', 'public.ai_messages', 'select') and has_table_privilege('supabase_realtime_admin', 'public.ai_conversations', 'select'));
  perform pg_temp.ok('no TRUNCATE for clients',
    not has_table_privilege('authenticated', 'public.ai_messages', 'truncate') and not has_table_privilege('authenticated', 'public.ai_conversations', 'truncate'));
end $$;

-- ── as the signed-in owner ─────────────────────────────────────────────
do $$ begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.me'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  perform pg_temp.ok('select: own conversations only',
    (select count(*) from ai_conversations where id in ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000b002')) = 1);
  perform pg_temp.ok('select: own messages only (incl. the generating row)',
    (select count(*) from ai_messages where conversation_id in ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000b002')) = 2);
  perform pg_temp.ok('rename own', pg_temp.try($q$update ai_conversations set title = 'renamed' where id = '00000000-0000-4000-8000-00000000b001'$q$) = 'rows=1');
  perform pg_temp.ok('rename sets title_edited', (select title_edited from ai_conversations where id = '00000000-0000-4000-8000-00000000b001'));
  perform pg_temp.ok('pin + mark read own',
    pg_temp.try($q$update ai_conversations set pinned = true, last_read_at = now() where id = '00000000-0000-4000-8000-00000000b001'$q$) = 'rows=1');
  perform pg_temp.ok('cannot set last_reply_at (function-owned)',
    pg_temp.try($q$update ai_conversations set last_reply_at = now() where id = '00000000-0000-4000-8000-00000000b001'$q$) = 'denied');
  perform pg_temp.ok('cannot move a conversation to another user',
    pg_temp.try(format($q$update ai_conversations set user_id = %L where id = '00000000-0000-4000-8000-00000000b001'$q$, current_setting('t.other'))) = 'denied');
  perform pg_temp.ok('cannot un-edit title_edited',
    pg_temp.try($q$update ai_conversations set title_edited = false where id = '00000000-0000-4000-8000-00000000b001'$q$) = 'denied');
  perform pg_temp.ok('update someone else''s: no rows',
    pg_temp.try($q$update ai_conversations set pinned = true where id = '00000000-0000-4000-8000-00000000b002'$q$) = 'rows=0');
  perform pg_temp.ok('insert conversation: refused (the function creates them)',
    pg_temp.try(format($q$insert into ai_conversations (user_id, title) values (%L, 'x')$q$, current_setting('t.me'))) = 'denied');
  perform pg_temp.ok('insert message: refused',
    pg_temp.try($q$insert into ai_messages (conversation_id, role, content) values ('00000000-0000-4000-8000-00000000b001', 'assistant', 'forged')$q$) = 'denied');
  perform pg_temp.ok('update message (e.g. flip status): refused',
    pg_temp.try($q$update ai_messages set status = 'done', content = 'forged' where conversation_id = '00000000-0000-4000-8000-00000000b001'$q$) = 'denied');
  perform pg_temp.ok('delete message: refused',
    pg_temp.try($q$delete from ai_messages where conversation_id = '00000000-0000-4000-8000-00000000b001'$q$) = 'denied');
  perform pg_temp.ok('delete someone else''s conversation: no rows',
    pg_temp.try($q$delete from ai_conversations where id = '00000000-0000-4000-8000-00000000b002'$q$) = 'rows=0');
  perform pg_temp.ok('delete own conversation',
    pg_temp.try($q$delete from ai_conversations where id = '00000000-0000-4000-8000-00000000b001'$q$) = 'rows=1');
  execute 'reset role';
end $$;

do $$ begin
  perform pg_temp.ok('delete cascaded to its messages',
    not exists (select 1 from ai_messages where conversation_id = '00000000-0000-4000-8000-00000000b001'));
  perform pg_temp.ok('the other user''s conversation is intact',
    exists (select 1 from ai_messages where conversation_id = '00000000-0000-4000-8000-00000000b002'));
end $$;

-- ── anon ───────────────────────────────────────────────────────────────
do $$ begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  perform pg_temp.ok('anon: no access to conversations', pg_temp.try('select 1 from ai_conversations limit 1') = 'denied');
  perform pg_temp.ok('anon: no access to messages', pg_temp.try('select 1 from ai_messages limit 1') = 'denied');
  execute 'reset role';
end $$;

-- ── the service role (the function) titles without marking it edited ───
do $$ begin
  insert into ai_conversations (id, user_id, title) values ('00000000-0000-4000-8000-00000000b003', current_setting('t.me')::uuid, 'auto');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update ai_conversations set title = 'auto 2', last_reply_at = now() where id = '00000000-0000-4000-8000-00000000b003';
  perform pg_temp.ok('service-role retitle keeps title_edited false',
    not (select title_edited from ai_conversations where id = '00000000-0000-4000-8000-00000000b003'));
end $$;

-- ── mig 386: stale finisher, rate limit at the start, cancel flag ───────
do $$
declare r text; n int;
begin
  insert into ai_conversations (id, user_id, title) values ('00000000-0000-4000-8000-00000000b004', current_setting('t.me')::uuid, 'stale');
  insert into ai_messages (id, conversation_id, role, content, status, created_at) values
    ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000b004', 'assistant', 'half', 'generating', now() - interval '11 minutes'),
    ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000b004', 'assistant', '', 'generating', now() - interval '2 minutes');
  perform public.ai_finish_stale_replies(10);
  perform pg_temp.ok('finisher: an 11-minute-old generating row becomes error (text kept, meta.stale)',
    (select status = 'error' and content = 'half' and (meta->>'stale')::boolean from ai_messages where id = '00000000-0000-4000-8000-00000000d001'));
  perform pg_temp.ok('finisher: a 2-minute-old generating row is left alone',
    (select status from ai_messages where id = '00000000-0000-4000-8000-00000000d002') = 'generating');
  perform pg_temp.ok('finisher scheduled every 5 minutes (pg_cron)',
    exists (select 1 from cron.job where jobname = 'ai-finish-stale-replies' and schedule = '*/5 * * * *'));

  -- rate limit: 30 rows in the last hour → refused, nothing logged; an exempt call (null limit) is logged
  insert into ai_request_log (user_id, engine, question) select current_setting('t.me')::uuid, 'v2', 'fixture' from generate_series(1, 30);
  select count(*) into n from ai_request_log where user_id = current_setting('t.me')::uuid and created_at > now() - interval '1 hour';
  r := public.ai_turn_begin('00000000-0000-4000-8000-00000000e001', current_setting('t.me')::uuid, 'q', 'gpt-5.4-mini', n);
  perform pg_temp.ok('ai_turn_begin: at the cap → rate_limited, no row', r = 'rate_limited' and not exists (select 1 from ai_request_log where id = '00000000-0000-4000-8000-00000000e001'), r);
  r := public.ai_turn_begin('00000000-0000-4000-8000-00000000e002', current_setting('t.me')::uuid, 'q', 'gpt-5.4-mini', n + 1);
  perform pg_temp.ok('ai_turn_begin: under the cap → ok, row created at the start', r = 'ok' and exists (select 1 from ai_request_log where id = '00000000-0000-4000-8000-00000000e002'), r);
  r := public.ai_turn_begin('00000000-0000-4000-8000-00000000e003', current_setting('t.me')::uuid, 'q', 'gpt-5.4-mini', null);
  perform pg_temp.ok('ai_turn_begin: exempt (null limit) → ok', r = 'ok', r);

  perform pg_temp.ok('turn-safety functions are service-role only',
    not has_function_privilege('authenticated', 'public.ai_turn_begin(uuid, uuid, text, text, int)', 'execute')
    and not has_function_privilege('authenticated', 'public.ai_finish_stale_replies(int)', 'execute')
    and not has_function_privilege('anon', 'public.ai_turn_begin(uuid, uuid, text, text, int)', 'execute')
    and has_function_privilege('service_role', 'public.ai_turn_begin(uuid, uuid, text, text, int)', 'execute'));
  perform pg_temp.ok('clients cannot set cancel_requested_at (Stop goes through the function)',
    not has_column_privilege('authenticated', 'public.ai_messages', 'cancel_requested_at', 'UPDATE'));
end $$;

-- ── mig 389: superseded ───────────────────────────────────────────────
do $$ begin
  perform pg_temp.ok('status superseded is allowed',
    pg_temp.try($q$insert into ai_messages (conversation_id, role, content, status) values ('00000000-0000-4000-8000-00000000b004', 'assistant', 'old', 'superseded')$q$) = 'rows=1');
  perform pg_temp.ok('status check still refuses unknown values',
    pg_temp.try($q$insert into ai_messages (conversation_id, role, content, status) values ('00000000-0000-4000-8000-00000000b004', 'assistant', 'x', 'hidden')$q$) like 'error: 23514');
end $$;

select n, test, result, detail from bres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'PASS' else 'FAIL' end as verdict,
       count(*) filter (where result = 'ok') as ok, count(*) filter (where result = 'FAIL') as failed from bres;
