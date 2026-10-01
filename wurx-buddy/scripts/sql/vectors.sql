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
