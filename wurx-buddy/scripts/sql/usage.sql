-- ============================================================
-- Mig 387: ai_usage_summary (Boss-only) against hand sums on synthetic rows.
-- Run:  node scripts/db-dev.mjs sql scripts/sql/usage.sql   (always rolled back)
-- The synthetic rows sit in a far-future window (2031-03) so real dev data
-- cannot mix into the sums; month_to_date is checked for shape only.
-- ============================================================

create temp table ures (n serial, test text, result text, detail text) on commit drop;
grant all on ures to authenticated, anon;
grant all on sequence ures_n_seq to authenticated, anon;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into ures (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;

do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',  (select id::text from profiles where role = 'apc'  and is_active and deleted_at is null order by id limit 1), true);
end $$;

-- known prices for the test
update ai_assistant_config set prices = '{"gpt-5.4-mini":{"in":1,"cached":0.1,"out":10},"gpt-5.5":{"in":5,"cached":0.5,"out":30},"text-embedding-3-small":{"in":0.02,"cached":0.02,"out":0}}',
                               monthly_budget_usd = 20 where id = 1;

-- Chat rows. PKT day = UTC + 5 h: 2031-03-01 20:00 UTC is 2031-03-02 01:00 PKT.
insert into ai_request_log (created_at, user_id, engine, model, surface, tokens_in, tokens_cached, tokens_out, est_cost_usd, latency_ms, error, flags) values
  ('2031-03-01 10:00+00', current_setting('t.boss')::uuid, 'v2', 'gpt-5.4-mini', 'full',  1000, 200, 100, 0.00182, 4000, null, '{}'),
  ('2031-03-01 20:00+00', current_setting('t.boss')::uuid, 'v2', 'gpt-5.4-mini', 'quick', 2000,   0, 200, 0.004,   6000, null, '{"cancelled":true}'),
  ('2031-03-02 09:00+00', current_setting('t.apc')::uuid,  'v2', 'gpt-5.5',      'slack', 3000,   0, 300, 0.024,   8000, 'boom', '{"deadline_hit":true}'),
  ('2031-03-05 09:00+00', current_setting('t.apc')::uuid,  'v2', 'gpt-5.4-mini', null,       0,   0,   0, 0,       null, null, '{}');   -- outside the range
insert into ai_usage_log (created_at, kind, model, user_id, calls, tokens_in, tokens_cached, tokens_out, est_cost_usd) values
  ('2031-03-01 10:00+00', 'rerank',       'gpt-5.4-mini',           current_setting('t.boss')::uuid, 1, 6000, 0, 100, 0.007),
  ('2031-03-01 10:00+00', 'embed_query',  'text-embedding-3-small', current_setting('t.boss')::uuid, 2,   20, 0,   0, 0.0000004),
  ('2031-03-02 09:00+00', 'rate_limited', null,                     current_setting('t.apc')::uuid,  1,    0, 0,   0, 0);
insert into ai_ingest_runs (kind, started_at, finished_at, embed_tokens) values ('ingest', '2031-03-02 03:00+00', '2031-03-02 03:05+00', 1000000);

-- ── not the Boss → refused ─────────────────────────────────────────────
do $$
declare ok boolean := false;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform public.ai_usage_summary('2031-03-01', '2031-03-03'); exception when others then ok := sqlerrm like 'not allowed%'; end;
  execute 'reset role';
  perform pg_temp.ok('an APC is refused', ok);
  ok := false;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  begin perform public.ai_usage_summary('2031-03-01', '2031-03-03'); exception when others then ok := sqlerrm like 'not allowed%'; end;
  perform pg_temp.ok('the service role (no user) is refused too', ok);
  perform pg_temp.ok('anon cannot execute', not has_function_privilege('anon', 'public.ai_usage_summary(date, date)', 'execute'));
  perform pg_temp.ok('clients cannot read ai_usage_log directly', not has_table_privilege('authenticated', 'public.ai_usage_log', 'select'));
end $$;

-- ── as the Boss: aggregates vs hand sums ───────────────────────────────
do $$
declare s jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  s := public.ai_usage_summary('2031-03-01', '2031-03-03');
  execute 'reset role';
  perform set_config('t.s', s::text, true);

  -- ingest: 1,000,000 tokens × $0.02 = 0.02
  -- total cost = chat 0.00182 + 0.004 + 0.024 + rerank 0.007 + embed 0.0000004 + ingest 0.02 = 0.0568204
  perform pg_temp.ok('totals.questions = 3', (s->'totals'->>'questions')::int = 3, s->>'totals');
  perform pg_temp.ok('totals.est_cost_usd = 0.056820 (6 dp)', (s->'totals'->>'est_cost_usd')::numeric = 0.056820, s->'totals'->>'est_cost_usd');
  perform pg_temp.ok('totals.tokens_in = 1000+2000+3000+6000+20+1000000', (s->'totals'->>'tokens_in')::bigint = 1012020);
  perform pg_temp.ok('totals.tokens_cached = 200', (s->'totals'->>'tokens_cached')::int = 200);
  perform pg_temp.ok('totals.tokens_out = 700', (s->'totals'->>'tokens_out')::int = 700);
  perform pg_temp.ok('by_kind: chat 3 calls $0.02982', (s->'by_kind'->'chat'->>'calls')::int = 3 and (s->'by_kind'->'chat'->>'est_cost_usd')::numeric = 0.02982);
  perform pg_temp.ok('by_kind: rerank $0.007, embeddings_query 2 calls, embeddings_ingest $0.02',
    (s->'by_kind'->'rerank'->>'est_cost_usd')::numeric = 0.007 and (s->'by_kind'->'embeddings_query'->>'calls')::int = 2
    and (s->'by_kind'->'embeddings_ingest'->>'est_cost_usd')::numeric = 0.02, s->>'by_kind');
  perform pg_temp.ok('by_day: 3 PKT days; day 1 has 1 question, day 2 has 2 (20:00 UTC is 01:00 PKT next day)',
    jsonb_array_length(s->'by_day') = 3 and (s->'by_day'->0->>'questions')::int = 1 and (s->'by_day'->1->>'questions')::int = 2
    and (s->'by_day'->2->>'questions')::int = 0, s->>'by_day');
  perform pg_temp.ok('by_day: day 1 cost = 0.00182 + 0.007 + 0.0000004 = 0.008820',
    (s->'by_day'->0->>'est_cost_usd')::numeric = 0.008820, s->'by_day'->0->>'est_cost_usd');
  perform pg_temp.ok('by_surface: full 1, quick 1, slack 1',
    (s->'by_surface'->'full'->>'questions')::int = 1 and (s->'by_surface'->'quick'->>'questions')::int = 1 and (s->'by_surface'->'slack'->>'questions')::int = 1, s->>'by_surface');
  perform pg_temp.ok('by_model: gpt-5.5 $0.024, text-embedding-3-small includes ingest',
    exists (select 1 from jsonb_array_elements(s->'by_model') m where m->>'model' = 'gpt-5.5' and (m->>'est_cost_usd')::numeric = 0.024)
    and exists (select 1 from jsonb_array_elements(s->'by_model') m where m->>'model' = 'text-embedding-3-small' and (m->>'est_cost_usd')::numeric = 0.020000), s->>'by_model');
  perform pg_temp.ok('by_user: the Boss 2 questions, the APC 1, with name and role',
    exists (select 1 from jsonb_array_elements(s->'by_user') u where u->>'user_id' = current_setting('t.boss') and (u->>'questions')::int = 2 and u->>'role' = 'boss' and u->>'name' is not null)
    and exists (select 1 from jsonb_array_elements(s->'by_user') u where u->>'user_id' = current_setting('t.apc') and (u->>'questions')::int = 1 and u->>'role' = 'apc'), s->>'by_user');
  perform pg_temp.ok('outcomes: errors 1 (not counting the cancel), cancelled 1, deadline_hit 1, rate_limited 1',
    (s->'outcomes'->>'errors')::int = 1 and (s->'outcomes'->>'cancelled')::int = 1 and (s->'outcomes'->>'deadline_hit')::int = 1
    and (s->'outcomes'->>'rate_limited')::int = 1, s->>'outcomes');
  perform pg_temp.ok('outcomes: avg latency (4000+6000+8000)/3 = 6000', (s->'outcomes'->>'avg_latency_ms')::numeric = 6000, s->'outcomes'->>'avg_latency_ms');
  perform pg_temp.ok('month_to_date: shape, budget 20, projection ≥ month to date',
    s->'month_to_date' ?& array['month', 'days_elapsed', 'days_in_month', 'est_cost_usd', 'projected_month_usd', 'budget_usd', 'budget_used_pct', 'projected_budget_pct']
    and (s->'month_to_date'->>'budget_usd')::numeric = 20
    and (s->'month_to_date'->>'projected_month_usd')::numeric >= (s->'month_to_date'->>'est_cost_usd')::numeric, s->>'month_to_date');
  perform pg_temp.ok('prices echoed for the UI', s->'prices_per_1m'->'gpt-5.4-mini'->>'out' = '10');
end $$;

-- ── a rate-limited ai_turn_begin leaves a counted, zero-cost row ───────
do $$
declare r text; n int;
begin
  insert into ai_request_log (user_id, engine, question) select current_setting('t.apc')::uuid, 'v2', 'fixture' from generate_series(1, 5);
  select count(*) into n from ai_request_log where user_id = current_setting('t.apc')::uuid and created_at > now() - interval '1 hour';
  r := public.ai_turn_begin('00000000-0000-4000-8000-00000000f001', current_setting('t.apc')::uuid, 'q', 'gpt-5.4-mini', n);
  perform pg_temp.ok('rate-limited begin writes one ai_usage_log rate_limited row',
    r = 'rate_limited' and exists (select 1 from ai_usage_log where request_id = '00000000-0000-4000-8000-00000000f001' and kind = 'rate_limited' and est_cost_usd = 0), r);
end $$;

-- ── mig 396: NULL counts become 0; ingest defer keeps the attempt ───────
do $$
declare r record; ok boolean;
begin
  insert into ai_usage_log (kind, model, calls, tokens_in, tokens_cached, tokens_out, est_cost_usd)
  values ('embed_query', 'text-embedding-3-small', null, 12, null, null, null) returning * into r;
  perform pg_temp.ok('F2: explicit NULLs in ai_usage_log become 0 (calls 1)',
    r.calls = 1 and r.tokens_in = 12 and r.tokens_cached = 0 and r.tokens_out = 0 and r.est_cost_usd = 0);

  insert into ai_ingest_queue (id, source_type, source_id, op, status, attempts, locked_at, locked_by)
  values (-99001, 'report', 'defer-test', 'upsert', 'processing', 3, now(), 'w1');
  ok := public.ai_ingest_defer(-99001, 'someone-else', 'x', 1800);
  perform pg_temp.ok('F3: defer by a worker that does not hold the item does nothing', not ok);
  ok := public.ai_ingest_defer(-99001, 'w1', 'embeddings HTTP 429: insufficient_quota', 1800);
  select * into r from ai_ingest_queue where id = -99001;
  perform pg_temp.ok('F3: deferred → pending, attempt given back (3 → 2), due in ~30 min, error kept',
    ok and r.status = 'pending' and r.attempts = 2 and r.not_before > now() + interval '29 minutes' and r.locked_at is null
    and r.last_error like '%insufficient_quota%', r.status || ' ' || r.attempts);
  perform pg_temp.ok('F3: ai_ingest_defer is service-role only',
    not has_function_privilege('authenticated', 'public.ai_ingest_defer(bigint, text, text, int)', 'execute')
    and has_function_privilege('service_role', 'public.ai_ingest_defer(bigint, text, text, int)', 'execute'));
end $$;

select n, test, result, detail from ures order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'USAGE: PASS' else 'USAGE: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from ures;
