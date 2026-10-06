-- ============================================================
-- QA security gate 2026-10-01: p_as_user cannot be used to borrow another
-- identity through the API, and the per-user rate limit (mig 386/387).
--   node scripts/db-dev.mjs sql tests/sql/security_extra.sql     (always rolled back)
-- ============================================================
create temp table sres (n serial, test text, result text, detail text) on commit drop;
grant all on sres to authenticated, anon;
grant all on sequence sres_n_seq to authenticated, anon;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into sres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
grant execute on function pg_temp.ok(text, boolean, text) to authenticated, anon;

do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',  (select p.id::text from profiles p where p.role = 'apc' and p.is_active and p.deleted_at is null
                                  and exists (select 1 from brands b where not can_view_brand(b.owner_id, b.id, p.id)) order by p.id limit 1), true);
end $$;

-- What the APC may read, computed as postgres, for comparison.
create temp table apc_docs on commit drop as
  select d.id from ai_documents d, profiles p
   where p.id = current_setting('t.apc')::uuid and d.status = 'active' and ai_can_read_document(d, p.id, p.role);
grant select on apc_docs to authenticated;
create temp table hidden_doc on commit drop as
  select d.id from ai_documents d where d.status = 'active' and d.source_type = 'report' and d.id not in (select id from apc_docs) limit 1;
grant select on hidden_doc to authenticated;
create temp table hidden_brand on commit drop as
  select b.brand_name from brands b where not can_view_brand(b.owner_id, b.id, current_setting('t.apc')::uuid)
   and b.status = 'active' order by b.brand_name limit 1;
grant select on hidden_brand to authenticated;

do $$
declare n int; bad int; x text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  -- ai_search with p_as_user = the Boss: ignored for a JWT caller
  select count(*), count(*) filter (where s.document_id not in (select id from apc_docs)) into n, bad
    from ai_search(null::extensions.vector, 'gmv report brand creators', null, null, null, null, 100, current_setting('t.boss')::uuid) s;
  execute 'reset role';
  perform pg_temp.ok('ai_search(p_as_user => Boss) as an APC JWT: only the APC''s documents', n > 0 and bad = 0, n || ' rows, ' || bad || ' outside the APC''s ACL');

  execute 'set local role authenticated';
  select count(*) into n from ai_get_chunks((select id from hidden_doc), 0, 5, current_setting('t.boss')::uuid);
  execute 'reset role';
  perform pg_temp.ok('ai_get_chunks(hidden report, p_as_user => Boss) as an APC JWT: nothing', n = 0, n::text);

  execute 'set local role authenticated';
  select count(*) into n from ai_resolve_brands((select brand_name from hidden_brand), current_setting('t.boss')::uuid) r
   where r.brand_name = (select brand_name from hidden_brand);
  execute 'reset role';
  perform pg_temp.ok('ai_resolve_brands(hidden brand, p_as_user => Boss) as an APC JWT: not resolved', n = 0, n::text);

  execute 'set local role authenticated';
  select count(*) into n from ai_report_periods(array(select b.id from brands b where b.brand_name = (select brand_name from hidden_brand)), null, null, 50, current_setting('t.boss')::uuid);
  execute 'reset role';
  perform pg_temp.ok('ai_report_periods(hidden brand, p_as_user => Boss) as an APC JWT: nothing', n = 0, n::text);

  -- rate limit: 30 per user per hour, counted at the start of a turn
  delete from ai_request_log where user_id = current_setting('t.apc')::uuid and created_at > now() - interval '1 hour';
  insert into ai_request_log (id, user_id, engine, question) select gen_random_uuid(), current_setting('t.apc')::uuid, 'qa', 'qa' from generate_series(1, 29);
  x := ai_turn_begin(gen_random_uuid(), current_setting('t.apc')::uuid, 'q', 'gpt-5.4-mini', 30);
  perform pg_temp.ok('rate limit: the 30th question in an hour is accepted', x = 'ok', x);
  x := ai_turn_begin(gen_random_uuid(), current_setting('t.apc')::uuid, 'q', 'gpt-5.4-mini', 30);
  perform pg_temp.ok('rate limit: the 31st is refused (rate_limited) and not logged', x = 'rate_limited'
    and (select count(*) from ai_request_log where user_id = current_setting('t.apc')::uuid and created_at > now() - interval '1 hour') = 30, x);
  x := ai_turn_begin(gen_random_uuid(), current_setting('t.apc')::uuid, 'q', 'gpt-5.4-mini', null);
  perform pg_temp.ok('rate limit: an exempt caller (limit null) still goes through and is logged', x = 'ok', x);
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin x := ai_turn_begin(gen_random_uuid(), current_setting('t.apc')::uuid, 'q', 'm', null);
  exception when insufficient_privilege then x := 'denied'; end;
  execute 'reset role';
  perform pg_temp.ok('rate limit: a client cannot call ai_turn_begin to bypass or pollute it', x = 'denied', x);

  perform pg_temp.ok('allowed_roles (current dev value, informational)', true, (select allowed_roles::text from ai_assistant_config where id = 1));
end $$;

select n, result, test, detail from sres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'SECURITY EXTRA: PASS' else 'SECURITY EXTRA: FAIL' end verdict,
       count(*) filter (where result = 'ok') ok, count(*) filter (where result = 'FAIL') failed from sres;
