-- ============================================================
-- Mig 401: key slots, the config checks with groq / gemini, the always-allowed
-- roles, and Buddy's settings for developers (read, never write).
-- Run:  node scripts/db-dev.mjs sql scripts/sql/providers.sql   (always rolled back)
-- ============================================================

create temp table pres (n serial, test text, result text, detail text) on commit drop;
grant all on pres to authenticated, anon;
grant all on sequence pres_n_seq to authenticated, anon;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into pres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
create function pg_temp.try(sql text) returns text language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  return 'rows=' || n;
exception when insufficient_privilege then return 'denied';
          when others then return 'error: ' || sqlerrm;
end $$;
create function pg_temp.val(sql text) returns text language plpgsql as $$
declare v text;
begin
  execute sql into v;
  return coalesce(v, 'null');
exception when insufficient_privilege then return 'denied';
          when others then return 'error: ' || sqlerrm;
end $$;
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;
grant execute on function pg_temp.try(text) to authenticated, anon;
grant execute on function pg_temp.val(text) to authenticated, anon;

do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.dev',  (select id::text from profiles where role = 'developer' and is_active and deleted_at is null order by id limit 1), true);
  perform set_config('t.apc',  (select id::text from profiles where role = 'apc' and is_active and deleted_at is null order by id limit 1), true);
end $$;

-- fixtures (owner): a catalog with the free keys
delete from ai_model_catalog;
insert into ai_model_catalog (key_slot, model, available, supports_tools, supports_stream, free, reason) values
  ('gemini', 'gemini-3.5-flash', true, true, true, true, null),
  ('gemini', 'gemini-embedding-001', false, false, false, true, 'embedding model (not for chat)'),
  ('groq', 'openai/gpt-oss-120b', true, true, true, true, null),
  ('primary', 'gpt-5.4-mini', false, false, false, false, 'no quota on this key');

-- ── state after the migration ────────────────────────────────────────────
do $$
begin
  perform pg_temp.ok('ai_key_slots: the four slots, their APIs and labels',
    (select string_agg(slot || '/' || api || '/' || label, ', ' order by sort) from ai_key_slots)
      = 'primary/openai-responses/OpenAI, fallback/openai-responses/OpenAI (fallback key), gemini/openai-chat/Gemini (free), groq/openai-chat/Groq (free)',
    (select string_agg(slot || '/' || api || '/' || label, ', ' order by sort) from ai_key_slots));
  perform pg_temp.ok('dev: allowed_roles keeps boss and developer', (select allowed_roles @> '{boss,developer}' from ai_assistant_config where id = 1),
    (select allowed_roles::text from ai_assistant_config where id = 1));
  perform pg_temp.ok('dev: auto_failover on', (select auto_failover from ai_assistant_config where id = 1));
  perform pg_temp.ok('default chain (mig 403): gemini 3.6-flash, 3-flash-preview, 3.5-flash, groq gpt-oss-120b, gpt-6-luna',
    (select column_default from information_schema.columns where table_name = 'ai_assistant_config' and column_name = 'fallback_models')
      like '%gemini-3.6-flash%gemini-3-flash-preview%gemini-3.5-flash%openai/gpt-oss-120b%gpt-6-luna%');
  perform pg_temp.ok('the catalog takes groq / gemini rows, and refuses an unknown slot',
    pg_temp.try($q$insert into ai_model_catalog (key_slot, model) values ('mistral', 'x')$q$) like 'error:%check constraint%');
end $$;

-- ── the roles trigger ────────────────────────────────────────────────────
do $$
declare r text[];
begin
  update ai_assistant_config set allowed_roles = '{apc}' where id = 1 returning allowed_roles into r;
  perform pg_temp.ok('saving {apc} keeps boss and developer first: {boss,developer,apc}', r = '{boss,developer,apc}', r::text);
  update ai_assistant_config set allowed_roles = '{}' where id = 1 returning allowed_roles into r;
  perform pg_temp.ok('saving {} leaves {boss,developer}', r = '{boss,developer}', r::text);
  update ai_assistant_config set allowed_roles = '{tl,developer,boss,apc}' where id = 1 returning allowed_roles into r;
  perform pg_temp.ok('no duplicates; other roles keep their order', r = '{boss,developer,tl,apc}', r::text);
end $$;

-- ── the model check with the new slots (as the Boss) ─────────────────────
do $$
declare r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := pg_temp.try($q$update ai_assistant_config set model = 'gemini-3.5-flash', model_key_slot = 'gemini' where id = 1$q$);
  perform pg_temp.ok('Boss: a usable Gemini model can be the main model', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gemini-embedding-001' where id = 1$q$);
  perform pg_temp.ok('Boss: a listed but unusable model is refused', r like 'error: model gemini-embedding-001 is not usable%', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'openai/gpt-oss-120b', model_key_slot = 'groq' where id = 1$q$);
  perform pg_temp.ok('Boss: a Groq model can be the main model', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set model_key_slot = 'mistral' where id = 1$q$);
  perform pg_temp.ok('Boss: an unknown key slot is refused', r like 'error: model_key_slot must be%', r);
  r := pg_temp.try($q$update ai_assistant_config set fallback_models = '[{"key_slot":"gemini","model":"a"},{"key_slot":"groq","model":"b"},{"key_slot":"groq","model":"c"},{"key_slot":"fallback","model":"d"},{"key_slot":"primary","model":"e"},{"key_slot":"gemini","model":"f"}]' where id = 1$q$);
  perform pg_temp.ok('Boss: 6 fallbacks across all four slots are accepted', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set fallback_models = '[{"key_slot":"mistral","model":"a"}]' where id = 1$q$);
  perform pg_temp.ok('Boss: a fallback on an unknown slot is refused', r like 'error: each fallback%', r);
  r := pg_temp.try($q$update ai_assistant_config set auto_failover = false where id = 1$q$);
  perform pg_temp.ok('Boss: can switch auto_failover', r = 'rows=1', r);
  execute 'reset role';
end $$;

-- ── settings: a developer reads and (mig 403) writes the settings; an APC neither ─
do $$
declare who text; uid text; r text; can boolean;
begin
  foreach who in array array['dev', 'apc'] loop
    uid := current_setting('t.' || who);
    can := who = 'dev';
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    r := pg_temp.val('select count(*)::text from ai_model_catalog');
    perform pg_temp.ok(who || ': catalog rows visible = ' || can, (r = '4') = can, r);
    r := pg_temp.val('select count(*)::text from ai_key_slots');
    perform pg_temp.ok(who || ': key slots visible = ' || can, (r = '4') = can, r);
    r := pg_temp.val($q$select (public.ai_usage_summary(current_date - 1, current_date) ? 'totals')::text$q$);
    perform pg_temp.ok(who || ': ai_usage_summary allowed = ' || can, (r = 'true') = can, r);
    -- ai_ingest_stats also lets a direct postgres session in (ai_is_service_or_admin),
    -- which is what this runner is: its new gate is checked through the helper.
    r := pg_temp.val($q$select (public.ai_ingest_stats() ? 'queue')::text$q$);
    perform pg_temp.ok(who || ': ai_ingest_stats answers (developer)', not can or r = 'true', r);
    perform pg_temp.ok(who || ': ai_can_view_settings = ' || can, public.ai_can_view_settings(uid::uuid) = can);
    r := pg_temp.val('select (count(*) > 0)::text from ai_ingest_runs');
    perform pg_temp.ok(who || ': ingest runs visible = ' || can, (r = 'true') = can, r);
    r := pg_temp.val('select count(*)::text from ai_crawl_state');
    perform pg_temp.ok(who || ': crawl state visible = ' || can, (r <> '0') = can, r);
    -- settings writes: the developer yes (mig 403), the APC no; the catalog and key slots: nobody
    r := pg_temp.try($q$update ai_assistant_config set persona = 'x', greeting = 'y' where id = 1$q$);
    perform pg_temp.ok(who || ': change the settings = ' || can, (r = 'rows=1') = can, r);
    r := pg_temp.try($q$update ai_assistant_config set allowed_roles = '{boss,developer,apc,tl}' where id = 1$q$);
    perform pg_temp.ok(who || ': change who may use Buddy = ' || can, (r = 'rows=1') = can, r);
    r := pg_temp.try($q$update ai_model_catalog set available = true$q$);
    perform pg_temp.ok(who || ': cannot write the catalog', r = 'denied', r);
    r := pg_temp.try($q$insert into ai_key_slots (slot, provider, api, label, secret_name) values ('x', 'x', 'openai-chat', 'x', 'x')$q$);
    perform pg_temp.ok(who || ': cannot add a key slot', r = 'denied', r);
    r := pg_temp.try($q$insert into ai_excluded_documents (source_type, source_id, reason) values ('kb_article', 'x', 'test')$q$);
    perform pg_temp.ok(who || ': add an exclusion = ' || can, (r = 'rows=1') = can, r);
    r := pg_temp.try($q$delete from ai_excluded_documents where reason = 'test'$q$);
    perform pg_temp.ok(who || ': remove exclusions = ' || can, (r <> 'rows=0' and r <> 'denied') = can, r);
    execute 'reset role';
  end loop;
  perform pg_temp.ok('anon cannot call ai_can_view_settings', not has_function_privilege('anon', 'public.ai_can_view_settings(uuid)', 'execute'));
  perform pg_temp.ok('an inactive developer is not a settings viewer', not exists (
    select 1 from profiles p where p.role = 'developer' and not p.is_active and public.ai_can_view_settings(p.id)));
end $$;

select n, test, result, detail from pres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'PROVIDERS: PASS' else 'PROVIDERS: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from pres;
