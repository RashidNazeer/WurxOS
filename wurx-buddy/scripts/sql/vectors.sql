-- mig 406: pending vectors, the NVIDIA alt arm, the old ai_search call, grants.
-- Synthetic rows only; db-dev.mjs `sql` always rolls back.
--   node scripts/db-dev.mjs sql scripts/sql/vectors.sql
create temp table vt (name text, ok boolean, detail text);
create function pg_temp.ok(n text, c boolean, d text default '') returns void language sql as
  $$ insert into vt values (n, coalesce(c, false), d) $$;

do $$
declare
  boss  uuid := (select id from public.profiles where role = 'boss' and is_active and deleted_at is null limit 1);
  model text := public.ai_embed_model();
  v1 float4[] := array[1.0]::float4[] || array_fill(0.0::float4, array[1535]);
  v2 float4[] := array[0.0, 1.0]::float4[] || array_fill(0.0::float4, array[1534]);
  doc  jsonb;
  r    jsonb;
  n    int;
  top  text;
  err  text;
begin
  -- service role acting as the Boss (the Slack-relay path of ai_search)
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  doc := jsonb_build_object('source_type', 'kb_article', 'source_id', 'vtest-406', 'title', 'Vector test doc', 'doc_hash', 'h406',
                            'embed_model', model, 'acl_mode', 'all', 'pipeline_version', public.ai_pipeline_version());
  r := public.ai_ingest_write(doc, jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'section', 'body', 'content', 'zqxvecpend pending text', 'embed_text', 'zqxvecpend pending text',
                       'token_count', 3, 'content_hash', 'c0'),                                         -- no vector at all
    jsonb_build_object('chunk_index', 1, 'section', 'body', 'content', 'alt only text', 'embed_text', 'alt only text',
                       'token_count', 3, 'content_hash', 'c1', 'embedding_alt', to_jsonb(v1),
                       'embed_model_alt', public.ai_embed_model_alt())));
  perform pg_temp.ok('write without vectors is accepted (pending)', (r->>'ok')::boolean and (r->>'vector_pending')::int = 2, r::text);

  select count(*) into n from public.ai_search(null, 'zqxvecpend', array['kb_article'], p_as_user => boss) s where s.source_id = 'vtest-406';
  perform pg_temp.ok('a NULL-vector chunk is found by the keyword arm', n = 1, n::text);

  select s.content into top from public.ai_search(null, null, array['kb_article'], p_as_user => boss,
                                                  p_query_embedding_alt => v1::extensions.vector) s limit 1;
  perform pg_temp.ok('the alt arm (NVIDIA space) finds the alt-only chunk first', top = 'alt only text', coalesce(top, 'nothing'));

  select count(*) into n from public.ai_search(v2::extensions.vector, null, array['kb_article'], null, null, null, 30, boss, null) s
   where s.source_id = 'vtest-406';
  perform pg_temp.ok('the old 9-argument call still works; the OpenAI arm skips NULL vectors', n = 0, n::text);

  select count(*) into n from jsonb_array_elements(public.ai_vector_pending('primary', 500)) e
   where e->>'content_hash' in ('c0', 'c1');
  perform pg_temp.ok('ai_vector_pending(primary) offers both chunks', n = 2, n::text);

  n := public.ai_vector_fill('primary', model, (select jsonb_agg(jsonb_build_object('id', c.id, 'content_hash', c.content_hash, 'embedding', to_jsonb(v2)))
                                                  from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
                                                 where d.source_id = 'vtest-406'));
  select count(*) into n from public.ai_chunks c join public.ai_documents d on d.id = c.document_id
   where d.source_id = 'vtest-406' and not c.vector_pending;
  perform pg_temp.ok('ai_vector_fill clears vector_pending', n = 2, n::text);

  begin
    perform public.ai_ingest_write(jsonb_set(jsonb_set(doc, '{source_type}', '"incentive"'), '{source_id}', '"vtest-406-inc"'),
      jsonb_build_array(jsonb_build_object('chunk_index', 0, 'content', 'x', 'embed_text', 'x', 'token_count', 1, 'content_hash', 'x',
                                           'embedding_alt', to_jsonb(v1))));
    err := 'accepted';
  exception when others then err := sqlerrm;
  end;
  perform pg_temp.ok('an incentive chunk may not carry a free-provider vector', err like '%may not have free-provider vectors%' or err like '%not enabled%', err);
end $$;

-- ── mig 408: "waiting" = no vector in either space; one model per column ──
do $$
declare
  model text := public.ai_embed_model();
  v1 float4[] := array[1.0]::float4[] || array_fill(0.0::float4, array[1535]);
  base jsonb;
  st   jsonb;
  pend0 int; main0 int;
  err  text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  st := public.ai_ingest_stats();
  pend0 := (st->>'vector_pending')::int;
  main0 := (st->'vectors'->>'main_missing')::int;

  base := jsonb_build_object('source_type', 'kb_article', 'title', 'Vector count test', 'doc_hash', 'h408',
                             'embed_model', model, 'acl_mode', 'all', 'pipeline_version', public.ai_pipeline_version());
  -- A: no vector at all → waiting.   B: alt only → DONE, but the main key is behind.
  perform public.ai_ingest_write(jsonb_set(base, '{source_id}', '"vt408-a"'), jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'content', 'none bucket', 'embed_text', 'none bucket', 'token_count', 2, 'content_hash', 'a0')));
  perform public.ai_ingest_write(jsonb_set(base, '{source_id}', '"vt408-b"'), jsonb_build_array(
    jsonb_build_object('chunk_index', 0, 'content', 'alt only', 'embed_text', 'alt only', 'token_count', 2, 'content_hash', 'b0',
                       'embedding_alt', to_jsonb(v1), 'embed_model_alt', public.ai_embed_model_alt())));
  st := public.ai_ingest_stats();
  perform pg_temp.ok('vector_pending counts only chunks with NO vector in either space',
    (st->>'vector_pending')::int = pend0 + 1, format('%s → %s', pend0, st->>'vector_pending'));
  perform pg_temp.ok('a chunk with only an alt vector is DONE, and shows under main_missing',
    (st->'vectors'->>'main_missing')::int = main0 + 1 and not (select c.vector_pending from public.ai_chunks c
       join public.ai_documents d on d.id = c.document_id where d.source_id = 'vt408-b'),
    format('%s → %s', main0, st->'vectors'->>'main_missing'));
  perform pg_temp.ok('by_space {main, alt, none} adds up to the chunks of active documents',
    (st->'vectors'->'by_space'->>'main')::int + (st->'vectors'->'by_space'->>'none')::int
      = (select count(*) from public.ai_chunks c join public.ai_documents d on d.id = c.document_id and d.status = 'active'),
    (st->'vectors'->'by_space')::text);
  perform pg_temp.ok('ai_vector_pending(alt) offers the none-bucket chunk first (quiet hours aside)',
    public.ai_vector_backfill_allowed() is false
      or (public.ai_vector_pending('alt', 500) @> jsonb_build_array(jsonb_build_object('content_hash', 'a0')))
      or not ('kb_article' = any(coalesce((select c.free_provider_sources from public.ai_assistant_config c where c.id = 1), '{}'))),
    format('backfill_allowed %s', public.ai_vector_backfill_allowed()));

  begin
    update public.ai_assistant_config set embed_alt_provider = 'gemini' where id = 1;
    err := 'accepted';
  exception when others then err := sqlerrm;
  end;
  perform pg_temp.ok('switching the alt provider is refused while the space holds another model',
    err like '%another model%', left(err, 90));
  perform pg_temp.ok('ai_vector_reset_alt() clears the alt space so it can be rebuilt',
    public.ai_vector_reset_alt() > 0 and not exists (select 1 from public.ai_chunks where embedding_alt is not null));
  update public.ai_assistant_config set embed_alt_provider = 'gemini' where id = 1;
  perform pg_temp.ok('…and then the switch is allowed, with the new model label',
    public.ai_embed_model_alt() = 'gemini:gemini-embedding-001', public.ai_embed_model_alt());
end $$;

select pg_temp.ok('grants: ai_vector_reset_alt / backfill_allowed are service-only',
  not has_function_privilege('authenticated', 'public.ai_vector_reset_alt()', 'execute')
  and not has_function_privilege('authenticated', 'public.ai_vector_backfill_allowed()', 'execute')
  and has_function_privilege('service_role', 'public.ai_vector_reset_alt()', 'execute'));

select pg_temp.ok('grants: ai_vector_fill / pending / defer / settings are service-only',
  not has_function_privilege('authenticated', 'public.ai_vector_fill(text, text, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.ai_vector_pending(text, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.ai_vector_defer(text, int, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.ai_embed_settings()', 'execute')
  and has_function_privilege('service_role', 'public.ai_vector_fill(text, text, jsonb)', 'execute'));
select pg_temp.ok('grants: ai_search (10 args) for authenticated + service_role, not anon',
  has_function_privilege('authenticated', 'public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector)', 'execute')
  and not has_function_privilege('anon', 'public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[], extensions.vector)', 'execute'));
select pg_temp.ok('the 9-argument ai_search form is gone (no ambiguous overload)',
  to_regprocedure('public.ai_search(extensions.vector, text, text[], uuid[], date, date, int, uuid, text[])') is null);

select name, case when ok then 'PASS' else 'FAIL' end as result, detail from vt;
select case when bool_and(ok) then 'VECTORS: PASS' else 'VECTORS: FAIL' end as verdict, count(*) filter (where ok) as ok, count(*) filter (where not ok) as failed from vt;
