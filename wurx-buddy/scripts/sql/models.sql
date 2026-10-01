-- ============================================================
-- Mig 397: model catalog RLS, the config model check, the summary additions.
-- Run:  node scripts/db-dev.mjs sql scripts/sql/models.sql   (always rolled back)
-- ============================================================

create temp table mres (n serial, test text, result text, detail text) on commit drop;
grant all on mres to authenticated, anon;
grant all on sequence mres_n_seq to authenticated, anon;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into mres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
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
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;
grant execute on function pg_temp.try(text) to authenticated, anon;

do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',  (select id::text from profiles where role = 'apc'  and is_active and deleted_at is null order by id limit 1), true);
end $$;

-- fixtures (service role / owner): a catalog for both keys
delete from ai_model_catalog;
insert into ai_model_catalog (key_slot, model, available, supports_tools, supports_stream, free) values
  ('primary',  'gpt-5.4-mini', false, false, false, false),
  ('primary',  'gpt-5.5',      true,  true,  true,  false),
  ('fallback', 'gpt-6-luna',   true,  true,  true,  true),
  ('fallback', 'gpt-nostream', true,  true,  false, true);

-- ── RLS: the Boss reads, nobody else; nobody writes through the API ────
do $$
declare n int; r text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from ai_model_catalog;
  perform pg_temp.ok('an APC sees no catalog rows', n = 0, n::text);
  r := pg_temp.try($q$update ai_model_catalog set available = true$q$);
  perform pg_temp.ok('an APC cannot write the catalog', r = 'denied', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-5.5'$q$);
  perform pg_temp.ok('an APC cannot change the model (config RLS: Boss only)', r in ('rows=0', 'denied'), r);
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from ai_model_catalog;
  perform pg_temp.ok('the Boss reads the catalog', n = 4, n::text);
  r := pg_temp.try($q$insert into ai_model_catalog (key_slot, model) values ('primary', 'x')$q$);
  perform pg_temp.ok('even the Boss cannot write it directly (the function does, with the service role)', r = 'denied', r);

  -- the config check, as the Boss through the API
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-5.5', model_key_slot = 'primary' where id = 1$q$);
  perform pg_temp.ok('a usable catalog model is accepted', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-5.4-mini' where id = 1$q$);
  perform pg_temp.ok('a model the catalog marks unavailable is refused', r like 'error: model gpt-5.4-mini is not usable%', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-6-luna', model_key_slot = 'fallback' where id = 1$q$);
  perform pg_temp.ok('a fallback-key model can be the main model', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-nostream' where id = 1$q$);
  perform pg_temp.ok('a model without streaming is refused', r like 'error: model gpt-nostream%', r);
  r := pg_temp.try($q$update ai_assistant_config set model_key_slot = 'other' where id = 1$q$);
  perform pg_temp.ok('an unknown key slot is refused', r like 'error:%', r);
  r := pg_temp.try($q$update ai_assistant_config set fallback_models = '[{"key_slot":"fallback"}]' where id = 1$q$);
  perform pg_temp.ok('a fallback without a model is refused', r like 'error: each fallback%', r);
  r := pg_temp.try($q$update ai_assistant_config set fallback_models = '[{"key_slot":"fallback","model":"a"},{"key_slot":"fallback","model":"b"},{"key_slot":"fallback","model":"c"},{"key_slot":"fallback","model":"d"},{"key_slot":"fallback","model":"e"},{"key_slot":"fallback","model":"f"},{"key_slot":"fallback","model":"g"}]' where id = 1$q$);
  perform pg_temp.ok('more than 6 fallbacks are refused (mig 401)', r like 'error: fallback_models must be%', r);
  r := pg_temp.try($q$update ai_assistant_config set fallback_models = '[{"key_slot":"fallback","model":"gpt-6-luna"},{"key_slot":"primary","model":"gpt-5.5"}]', fallback_enabled = false where id = 1$q$);
  perform pg_temp.ok('a valid chain and the switch are accepted', r = 'rows=1', r);
  execute 'reset role';
end $$;

-- ── out of credit: a built-in stays choosable ─────────────────────────
do $$
declare r text;
begin
  insert into ai_model_catalog (key_slot, model, available, last_error) values ('primary', 'gpt-5.4-nano', false, 'HTTP 429: insufficient_quota'),
                                                                             ('primary', 'gpt-odd', false, 'HTTP 429: insufficient_quota');
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-5.4-nano', model_key_slot = 'primary' where id = 1$q$);
  perform pg_temp.ok('a built-in that failed only for lack of credits can still be chosen', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-odd' where id = 1$q$);
  perform pg_temp.ok('another model that failed for lack of credits cannot', r like 'error:%', r);
end $$;

-- ── with an empty catalog only the built-ins pass ──────────────────────
do $$
declare r text;
begin
  delete from ai_model_catalog;
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-5.4-nano', model_key_slot = 'primary' where id = 1$q$);
  perform pg_temp.ok('empty catalog: a built-in model is accepted', r = 'rows=1', r);
  r := pg_temp.try($q$update ai_assistant_config set model = 'gpt-6-luna', model_key_slot = 'fallback' where id = 1$q$);
  perform pg_temp.ok('empty catalog: an uncatalogued model is refused', r like 'error:%', r);
  perform pg_temp.ok('defaults: the fallback chain ends with gpt-6-luna on the fallback key, enabled',
    (select column_default from information_schema.columns where table_name = 'ai_assistant_config' and column_name = 'fallback_models') like '%gpt-6-luna%'
    and (select column_default from information_schema.columns where table_name = 'ai_assistant_config' and column_name = 'fallback_enabled') = 'true');
  perform pg_temp.ok('gpt-6-luna is priced at 0', (select prices->'gpt-6-luna'->>'out' from ai_assistant_config where id = 1)::numeric = 0);
end $$;

-- ── the summary: unpriced + by_key_slot ────────────────────────────────
do $$
declare s jsonb;
begin
  insert into ai_request_log (created_at, user_id, engine, model, key_slot, tokens_in, tokens_out, est_cost_usd, flags) values
    ('2031-04-01 10:00+00', current_setting('t.boss')::uuid, 'v2', 'gpt-6-luna', 'fallback', 500, 50, 0, '{"fallback_used":{"from":"primary:gpt-5.4-mini","to":"fallback:gpt-6-luna"}}'),
    ('2031-04-01 11:00+00', current_setting('t.boss')::uuid, 'v2', 'gpt-mystery', 'primary', 300, 30, 0, '{"unpriced":true}');
  insert into ai_usage_log (created_at, kind, model, key_slot, tokens_in, unpriced) values ('2031-04-01 11:00+00', 'embed_query', 'emb-mystery', 'fallback', 7, true);
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  s := public.ai_usage_summary('2031-04-01', '2031-04-01');
  execute 'reset role';
  perform pg_temp.ok('unpriced: 2 calls (a chat and an embedding), tokens and models listed',
    (s->'unpriced'->>'calls')::int = 2 and (s->'unpriced'->>'tokens_in')::int = 307
    and s->'unpriced'->'models' @> '["gpt-mystery","emb-mystery"]', s->>'unpriced');
  perform pg_temp.ok('by_key_slot: fallback 1 question (1 via fallback), primary 1',
    (s->'by_key_slot'->'fallback'->>'questions')::int = 1 and (s->'by_key_slot'->'fallback'->>'fallback_used')::int = 1
    and (s->'by_key_slot'->'primary'->>'questions')::int = 1, s->>'by_key_slot');
end $$;

select n, test, result, detail from mres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'MODELS: PASS' else 'MODELS: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from mres;
