-- Mig 403/404: Boss and active developers change Buddy settings; an APC cannot. Always rolled back.
create temp table sres (n serial, test text, result text, detail text) on commit drop;
grant all on sres to authenticated; grant all on sequence sres_n_seq to authenticated;
create function pg_temp.ok(t text, c boolean, d text default null) returns void language sql as $$ insert into sres (test, result, detail) values (t, case when c then 'ok' else 'FAIL' end, d) $$;
create function pg_temp.try(sql text) returns text language plpgsql as $$
declare n int; begin execute sql; get diagnostics n = row_count; return 'rows=' || n;
exception when insufficient_privilege then return 'denied'; when others then return 'error: ' || sqlerrm; end $$;
grant execute on function pg_temp.ok(text, boolean, text), pg_temp.try(text) to authenticated;

do $$
declare who text; uid text; r text; can boolean;
begin
  foreach who in array array['boss', 'developer', 'apc'] loop
    uid := (select id::text from profiles where role = who and is_active and deleted_at is null order by id limit 1);
    can := who <> 'apc';
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    r := pg_temp.try($q$update ai_assistant_config set greeting = coalesce(greeting, '') || ' ', auto_failover = true, budget_saver_pct = 80 where id = 1$q$);
    perform pg_temp.ok(who || ': config write = ' || can, (r = 'rows=1') = can, r);
    r := pg_temp.try($q$update ai_assistant_config set role_models = '{"boss": {"model": "gpt-5.5", "key_slot": "primary"}}' where id = 1$q$);
    perform pg_temp.ok(who || ': role_models write = ' || can, (r = 'rows=1') = can, r);
    r := pg_temp.try($q$update ai_assistant_docs set updated_at = updated_at$q$);
    perform pg_temp.ok(who || ': knowledge docs write = ' || can, (r <> 'rows=0' and r not like 'error%' and r <> 'denied') = can or (not can and r in ('rows=0', 'denied')), r);
    r := pg_temp.try($q$insert into ai_excluded_documents (source_type, source_id, reason) values ('kb_article', 'test-403-' || md5(random()::text), 'test')$q$);
    perform pg_temp.ok(who || ': exclusion add = ' || can, (r = 'rows=1') = can, r);
    r := pg_temp.try($q$truncate ai_assistant_config$q$);
    perform pg_temp.ok(who || ': truncate refused', r = 'denied', r);
    execute 'reset role';
  end loop;
  r := pg_temp.try($q$update ai_assistant_config set role_models = '{"apc": {"model": "nope", "key_slot": "gemini"}}' where id = 1$q$);
  perform pg_temp.ok('role_models: an unusable model is refused', r like 'error: role_models.apc%', r);
  r := pg_temp.try($q$update ai_assistant_config set role_models = '{"intern": {}}' where id = 1$q$);
  perform pg_temp.ok('role_models: an unknown role is refused', r like 'error: role_models: unknown role%', r);
  perform pg_temp.ok('chain default (403): gemini-3.6-flash first', (select column_default from information_schema.columns
    where table_name = 'ai_assistant_config' and column_name = 'fallback_models') like '[{"model": "gemini-3.6-flash"%' or
    (select column_default from information_schema.columns where table_name = 'ai_assistant_config' and column_name = 'fallback_models') like '%gemini-3.6-flash%gemini-3-flash-preview%gemini-3.5-flash%');
end $$;
select n, test, result, detail from sres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'SETTINGS WRITE: PASS' else 'SETTINGS WRITE: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from sres;
