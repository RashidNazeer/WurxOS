-- ============================================================
-- Phase 1: ai_search edge cases (mig 368, as changed by 372: OR keyword arm,
-- kb fails closed).
-- Run:  npm run sql:search   (from Assistant/)
-- Always rolled back by the runner: nothing persists.
--
-- Fixture documents use source_type 'srch*'. WARN rows are documented design
-- behaviour that does not fail the verdict (qa/2026-09-28-phase1.md D2).
-- ============================================================

create temp table sres (n serial, test text, result text, detail text) on commit drop;
grant all on sres to authenticated, anon, service_role;
grant all on sequence sres_n_seq to authenticated, anon, service_role;
create function pg_temp.ok(t text, cond boolean, d text default null) returns void language sql as $$
  insert into sres (test, result, detail) values (t, case when cond then 'ok' else 'FAIL' end, d);
$$;
create function pg_temp.warn(t text, d text) returns void language sql as $$
  insert into sres (test, result, detail) values (t, 'WARN', d);
$$;
-- deterministic, distinct 1536-d vectors
create function pg_temp.vec(k int) returns extensions.vector language sql immutable as $$
  select (select array_agg((((g * k) % 101) + 1)::real / 101 order by g) from generate_series(1, 1536) g)::extensions.vector;
$$;

do $$ begin
  perform set_config('t.boss', (select id::text from profiles where role = 'boss' and is_active and deleted_at is null limit 1), true);
  perform set_config('t.apc',  (select id::text from profiles where role = 'apc'  and is_active and deleted_at is null limit 1), true);
  perform set_config('t.gone', (select id::text from profiles where (not is_active or deleted_at is not null) limit 1), true);
end $$;

-- ── fixtures ────────────────────────────────────────────────────────
-- Mig 377: ai_search shows only source types in ai_assistant_config.ingest_sources,
-- so the fixture types are switched on first (rolled back with everything else).
update ai_assistant_config set ingest_sources = ingest_sources || '{srchtest,srchold,srchper,srchacl,srchrank,srchmove}' where id = 1;
-- 80 semantic-only docs (embedding, no keyword) + 80 keyword-only docs (keyword, no embedding)
insert into ai_documents (source_type, source_id, title, acl_mode, doc_hash)
select 'srchtest', 'sem' || i, 'SEM ' || i, 'all', 'x' from generate_series(1, 80) i
union all
select 'srchtest', 'kw' || i, 'KW ' || i, 'all', 'x' from generate_series(1, 80) i;

insert into ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding, embedding_model)
select d.id, 0, 'semantic passage', 'semantic passage', 2, 'x', pg_temp.vec(substr(d.source_id, 4)::int + 1), public.ai_embed_model()
  from ai_documents d where d.source_type = 'srchtest' and d.source_id like 'sem%'
union all
select d.id, 0, 'zqxsrchkw passage ' || d.source_id, 'x', 2, 'x', null, public.ai_embed_model()
  from ai_documents d where d.source_type = 'srchtest' and d.source_id like 'kw%';

-- A§7 (mig 373): a vector of another model is never compared. OLD holds the
-- exact query vector under a stale model name: the semantic arm must skip it,
-- the keyword arm still finds it.
insert into ai_documents (source_type, source_id, title, acl_mode, doc_hash) values ('srchold', 'OLD', 'OLD model', 'all', 'x');
insert into ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding, embedding_model)
select id, 0, 'zqxsrchold passage', 'x', 2, 'x', pg_temp.vec(2), 'qa-retired-model' from ai_documents where source_type = 'srchold';

-- period docs, a deleted doc, KB edge cases (all contain 'zqxsrchper' / 'zqxsrchacl')
insert into ai_documents (source_type, source_id, title, acl_mode, period_start, period_end, status, metadata, author_id, doc_hash) values
  ('srchper', 'P1', 'P1 aug',            'all', '2026-08-01', '2026-08-31', 'active',  '{}', null, 'x'),
  ('srchper', 'P2', 'P2 sep',            'all', '2026-09-01', '2026-09-30', 'active',  '{}', null, 'x'),
  ('srchper', 'P3', 'P3 jul start only', 'all', '2026-07-01', null,         'active',  '{}', null, 'x'),
  ('srchper', 'P4', 'P4 undated',        'all', null,         null,         'active',  '{}', null, 'x'),
  ('srchper', 'P5', 'P5 aug deleted',    'all', '2026-08-01', '2026-08-31', 'deleted', '{}', null, 'x'),
  ('srchacl', 'K1', 'K1 kb private',     'kb',  null, null, 'active', '{"visibility":"private"}', current_setting('t.boss')::uuid, 'x'),
  ('srchacl', 'K2', 'K2 kb no visibility key', 'kb', null, null, 'active', '{}', current_setting('t.boss')::uuid, 'x'),
  ('srchacl', 'K3', 'K3 kb null visibility',   'kb', null, null, 'active', '{"visibility":null}', current_setting('t.boss')::uuid, 'x'),
  ('srchacl', 'K4', 'K4 kb bogus visibility',  'kb', null, null, 'active', '{"visibility":"everyone"}', current_setting('t.boss')::uuid, 'x'),
  ('srchacl', 'K5', 'K5 kb office control',    'kb', null, null, 'active', '{"visibility":"office"}', current_setting('t.boss')::uuid, 'x');

insert into ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding_model)
select id, 0, title || ' zqxsrchper zqxsrchacl', 'x', 2, 'x', public.ai_embed_model() from ai_documents where source_type in ('srchper','srchacl');

-- OR keyword ranking: R3 has all three query words, R2 two, R1 one, R0 none
insert into ai_documents (source_type, source_id, title, acl_mode, doc_hash) values
  ('srchrank', 'R0', 'R0', 'all', 'x'), ('srchrank', 'R1', 'R1', 'all', 'x'),
  ('srchrank', 'R2', 'R2', 'all', 'x'), ('srchrank', 'R3', 'R3', 'all', 'x');
insert into ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding_model)
select id, 0, case source_id when 'R0' then 'unrelated filler text'
                             when 'R1' then 'zqxalpha filler text'
                             when 'R2' then 'zqxalpha zqxbeta filler text'
                             else 'zqxalpha zqxbeta zqxgamma filler text' end, 'x', 3, 'x', public.ai_embed_model()
  from ai_documents where source_type = 'srchrank';

-- ── searches ────────────────────────────────────────────────────────
create temp table seen (label text, title text, n int) on commit drop;
grant all on seen to authenticated, anon, service_role;

do $$
declare n int; outcome text; q extensions.vector := pg_temp.vec(2); h record;
begin
  -- as the boss (sees everything the ACL allows)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  insert into seen select 'null+empty',   null, count(*) from ai_search(null, '');
  insert into seen select 'null+blank',   null, count(*) from ai_search(null, '   ');
  insert into seen select 'null+null',    null, count(*) from ai_search(null, null);
  insert into seen select 'stopwords',    null, count(*) from ai_search(null, 'the and of', array['srchtest']);
  insert into seen select 'weird syntax', null, count(*) from ai_search(null, $w$zqxsrchkw" OR -foo !!!&|:* '); drop table x; --$w$, array['srchtest']);
  insert into seen select 'unicode',      null, count(*) from ai_search(null, 'ذوق 日本語 🚀 zqxsrchkw', array['srchtest']);
  insert into seen select 'emoji only',   null, count(*) from ai_search(null, '🚀🚀', array['srchtest']);
  -- D1 (mig 372): the keyword arm is OR, so a word absent from the chunk no longer drops it
  insert into seen select 'kw all terms', null, count(*) from ai_search(null, 'zqxsrchkw passage', array['srchtest']);
  insert into seen select 'kw one extra', null, count(*) from ai_search(null, 'zqxsrchkw passage missingword', array['srchtest']);
  insert into seen select 'kw none match', null, count(*) from ai_search(null, 'missingword otherword', array['srchtest']);
  insert into seen select 'stop+word',    null, count(*) from ai_search(null, 'what is the zqxsrchkw', array['srchtest']);
  insert into seen select 'punct only',   null, count(*) from ai_search(null, $p$&|!():*<->'"\$p$, array['srchtest']);
  insert into seen select 'rank ' || s.title, s.title, row_number() over (order by s.score desc)
    from ai_search(null, 'how does zqxalpha zqxbeta zqxgamma work', array['srchrank']) s;
  -- hostile strings: the OR rewrite re-parses plainto_tsquery's text output, so it must never raise
  for h in select row_number() over () i, u.hq as q from unnest(array[
      $h$zqxsrchkw & passage$h$, $h$zqxsrchkw | passage$h$, $h$a\b\\c zqxsrchkw$h$, $h$it's o''neil's zqxsrchkw$h$,
      $h$zqxsrchkw:* passage:A$h$, $h$!zqxsrchkw$h$, $h$zqxsrchkw <-> passage <2> x$h$, $h$(zqxsrchkw$h$,
      $h$' & '$h$, $h$zqxsrchkw' & 'passage$h$, $h$http://x.com/a&b=c zqxsrchkw$h$, $h$/usr/a & b zqxsrchkw$h$,
      $h$foo-bar-baz zqxsrchkw$h$, $h$e-mail@x.com zqxsrchkw$h$, $h$1.5e10 -3 zqxsrchkw$h$, $h$C:\path\to 'x' zqxsrchkw$h$,
      repeat('zqxsrchkw ', 5000), repeat('x', 3000) || ' zqxsrchkw']) u(hq) loop
    begin
      select count(*) into n from ai_search(null, h.q, array['srchtest']);
      insert into seen values ('hostile ' || h.i, left(h.q, 40), n);
    exception when others then
      insert into seen values ('hostile ' || h.i, left(h.q, 40) || ' RAISED ' || sqlstate || ' ' || sqlerrm, -1);
    end;
  end loop;

  insert into seen select 'count 500',  null, count(*) from ai_search(q, 'zqxsrchkw', array['srchtest'], p_match_count => 500);
  insert into seen select 'count 100',  null, count(*) from ai_search(q, 'zqxsrchkw', array['srchtest'], p_match_count => 100);
  insert into seen select 'count def',  null, count(*) from ai_search(q, 'zqxsrchkw', array['srchtest']);
  insert into seen select 'count 0',    null, count(*) from ai_search(q, 'zqxsrchkw', array['srchtest'], p_match_count => 0);
  insert into seen select 'count -5',   null, count(*) from ai_search(q, 'zqxsrchkw', array['srchtest'], p_match_count => -5);
  insert into seen select 'count null', null, count(*) from ai_search(q, 'zqxsrchkw', array['srchtest'], p_match_count => null);
  insert into seen select 'kw only',    null, count(*) from ai_search(null, 'zqxsrchkw', array['srchtest'], p_match_count => 100);
  insert into seen select 'sem only',   null, count(*) from ai_search(q, null, array['srchtest'], p_match_count => 100);
  insert into seen select 'sem top1', s.title, 1 from ai_search(q, null, array['srchtest'], p_match_count => 1) s;
  insert into seen select 'old sem', null, count(*) from ai_search(q, null, array['srchold']);
  insert into seen select 'old kw',  null, count(*) from ai_search(null, 'zqxsrchold', array['srchold']);

  insert into seen select 'from 08-15',      s.title, 1 from ai_search(null, 'zqxsrchper', array['srchper'], p_period_from => '2026-08-15') s;
  insert into seen select 'from 08-31',      s.title, 1 from ai_search(null, 'zqxsrchper', array['srchper'], p_period_from => '2026-08-31') s;
  insert into seen select 'from 09-01',      s.title, 1 from ai_search(null, 'zqxsrchper', array['srchper'], p_period_from => '2026-09-01') s;
  insert into seen select '08-15..08-20',    s.title, 1 from ai_search(null, 'zqxsrchper', array['srchper'], p_period_from => '2026-08-15', p_period_to => '2026-08-20') s;
  insert into seen select 'no period',       s.title, 1 from ai_search(null, 'zqxsrchper', array['srchper']) s;
  insert into seen select 'boss kb',         s.title, 1 from ai_search(null, 'zqxsrchacl', array['srchacl']) s;
  execute 'reset role';

  -- as an APC: KB edge cases
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into seen select 'apc kb', s.title, 1 from ai_search(null, 'zqxsrchacl', array['srchacl']) s;
  execute 'reset role';

  -- inactive / deleted profile, both as their own JWT and via the service relay
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.gone'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into seen select 'inactive jwt', null, count(*) from ai_search(null, 'zqxsrchkw', array['srchtest']);
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
  insert into seen select 'inactive relay', null, count(*) from ai_search(null, 'zqxsrchkw', array['srchtest'], p_as_user => current_setting('t.gone')::uuid);
  insert into seen select 'unknown relay',  null, count(*) from ai_search(null, 'zqxsrchkw', array['srchtest'], p_as_user => gen_random_uuid());
  insert into seen select 'service no user', null, count(*) from ai_search(null, 'zqxsrchkw', array['srchtest']);
  execute 'reset role';

  -- authenticated role without a sub claim
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into seen select 'no sub', null, count(*) from ai_search(null, 'zqxsrchkw', array['srchtest']);
  execute 'reset role';

  -- anon
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
  begin perform * from ai_search(null, 'zqxsrchkw'); outcome := 'allowed';
  exception when insufficient_privilege then outcome := 'permission denied'; when others then outcome := sqlerrm; end;
  execute 'reset role';
  insert into seen values ('anon: ' || outcome, null, 0);
end $$;

-- ── assertions ──────────────────────────────────────────────────────
do $$
declare
  c record;
  got text;
  exp_sets jsonb := jsonb_build_object(
    'from 08-15',   'P1 aug,P2 sep',
    'from 08-31',   'P1 aug,P2 sep',
    'from 09-01',   'P2 sep',
    '08-15..08-20', 'P1 aug');
  k text;
begin
  for c in select * from (values
      ('null embedding + empty text -> 0 rows', 'null+empty', 0),
      ('null embedding + blank text -> 0 rows', 'null+blank', 0),
      ('null embedding + null text -> 0 rows',  'null+null',  0),
      ('stop-words-only text -> 0 rows, no error', 'stopwords', 0),
      ('p_match_count 500 clamps to 100',        'count 500', 100),
      ('p_match_count 100 -> 100',               'count 100', 100),
      ('p_match_count default -> 30',            'count def', 30),
      ('p_match_count 0 -> 1',                   'count 0', 1),
      ('p_match_count -5 -> 1',                  'count -5', 1),
      ('p_match_count null -> 100',              'count null', 100),
      ('keyword arm alone caps at 60',           'kw only', 60),
      ('semantic arm alone caps at 60',          'sem only', 60),
      ('inactive/deleted profile (own JWT) -> 0 rows',       'inactive jwt', 0),
      ('inactive/deleted profile via service relay -> 0 rows', 'inactive relay', 0),
      ('unknown user via service relay -> 0 rows',           'unknown relay', 0),
      ('service role without p_as_user -> 0 rows',           'service no user', 0),
      ('authenticated without sub -> 0 rows',                'no sub', 0)) v(t, lbl, expected) loop
    perform pg_temp.ok(c.t, (select n from seen where label = c.lbl) = c.expected, (select n::text from seen where label = c.lbl));
  end loop;

  perform pg_temp.ok('hostile websearch syntax does not error', (select n from seen where label = 'weird syntax') is not null,
                     (select n::text from seen where label = 'weird syntax'));
  perform pg_temp.ok('unicode / emoji queries do not error',
                     (select n from seen where label = 'unicode') is not null and (select n from seen where label = 'emoji only') = 0,
                     (select n::text from seen where label = 'unicode') || '/' || (select n::text from seen where label = 'emoji only'));
  perform pg_temp.ok('keyword OR: an extra word missing from every chunk still matches (same count)',
    (select n from seen where label = 'kw one extra') = 30 and (select n from seen where label = 'kw all terms') = 30,
    (select n from seen where label = 'kw all terms') || ' / ' || (select n from seen where label = 'kw one extra'));
  perform pg_temp.ok('keyword OR: no query word in any chunk -> 0 rows', (select n from seen where label = 'kw none match') = 0,
    (select n::text from seen where label = 'kw none match'));
  perform pg_temp.ok('keyword OR: stop words dropped, the real word still matches', (select n from seen where label = 'stop+word') = 30,
    (select n::text from seen where label = 'stop+word'));
  perform pg_temp.ok('keyword OR: operator/punctuation-only text -> 0 rows, no error', (select n from seen where label = 'punct only') = 0,
    (select n::text from seen where label = 'punct only'));
  perform pg_temp.ok('keyword OR ranking: 3 words > 2 words > 1 word, a chunk with none is not returned',
    (select string_agg(title, ',' order by n) from seen where label like 'rank %') = 'R3,R2,R1',
    (select string_agg(title, ',' order by n) from seen where label like 'rank %'));
  perform pg_temp.ok('hostile keyword strings (tsquery operators, quotes, backslashes, 50k chars): none raises',
    (select count(*) from seen where label like 'hostile %') = 18 and not exists (select 1 from seen where label like 'hostile %' and n < 0),
    (select string_agg(title, ' | ') from seen where label like 'hostile %' and n < 0));
  perform pg_temp.ok('hostile strings containing zqxsrchkw still match it',
    (select count(*) from seen where label like 'hostile %' and n > 0) >= 15,
    (select string_agg(label || '=' || n, ' ' order by label) from seen where label like 'hostile %'));
  perform pg_temp.ok('semantic top-1 is the exact-match vector (SEM 1 = vec(2))', (select title from seen where label = 'sem top1') = 'SEM 1',
                     (select title from seen where label = 'sem top1'));
  perform pg_temp.ok('A§7: a vector of another model is never compared (semantic arm 0), keyword arm still finds it (1)',
    (select n from seen where label = 'old sem') = 0 and (select n from seen where label = 'old kw') = 1,
    (select n from seen where label = 'old sem') || ' / ' || (select n from seen where label = 'old kw'));
  perform pg_temp.ok('anon cannot execute ai_search', exists (select 1 from seen where label = 'anon: permission denied'),
                     (select label from seen where label like 'anon:%'));

  for k in select jsonb_object_keys(exp_sets) loop
    select string_agg(title, ',' order by title) into got from seen where label = k;
    perform pg_temp.ok('period ' || k || ' -> ' || (exp_sets->>k) || ' (deleted P5 never)', got = exp_sets->>k, coalesce(got, 'none'));
  end loop;
  select string_agg(title, ',' order by title) into got from seen where label = 'no period';
  perform pg_temp.ok('no period filter: every active doc, never the deleted one', got = 'P1 aug,P2 sep,P3 jul start only,P4 undated', got);
  perform pg_temp.warn('period filter drops undated docs (P4) and uses period_start when period_end is null (P3)',
    'from 08-15 returned: ' || coalesce((select string_agg(title, ',' order by title) from seen where label = 'from 08-15'), 'none'));

  -- M2 (mig 372): kb fails closed
  select string_agg(title, ',' order by title) into got from seen where label = 'apc kb';
  perform pg_temp.ok('apc sees only the office KB doc (private, missing, null and unknown visibility all hidden)',
    got = 'K5 kb office control', got);
  select string_agg(title, ',' order by title) into got from seen where label = 'boss kb';
  perform pg_temp.ok('boss sees all 5 KB docs',
    got = 'K1 kb private,K2 kb no visibility key,K3 kb null visibility,K4 kb bogus visibility,K5 kb office control', got);
end $$;

-- the check constraint is what guards "unknown mode is denied": confirm it rejects one
do $$
declare outcome text;
begin
  begin
    insert into ai_documents (source_type, source_id, title, acl_mode, doc_hash) values ('srchacl', 'K9', 'x', 'nonsense', 'x');
    outcome := 'accepted';
  exception when check_violation then outcome := 'rejected';
  end;
  perform pg_temp.ok('unknown acl_mode rejected at insert (default-deny branch unreachable)', outcome = 'rejected', outcome);
end $$;

-- ── reassignment applies instantly, with no re-index (phases.md P1 gate) ──
do $$
declare apc uuid; brand uuid; before_n int; after_n int;
begin
  -- an APC whose ONLY route to a brand is one brand_assignments row
  select ba.user_id, ba.brand_id into apc, brand
    from brand_assignments ba
    join profiles p on p.id = ba.user_id and p.role = 'apc' and p.is_active and p.deleted_at is null
         and not coalesce((p.permissions->>'canViewAllBrands')::boolean, false)
    join brands b on b.id = ba.brand_id and b.owner_id is distinct from ba.user_id
   where (select count(*) from brand_assignments x where x.brand_id = ba.brand_id and x.user_id = ba.user_id) = 1
     and not exists (select 1 from ads_manager_brands a where a.brand_id = ba.brand_id and a.ads_manager_id = ba.user_id)
   limit 1;
  if apc is null then
    insert into sres (test, result, detail) values ('reassignment: no suitable APC/brand pair on dev', 'WARN', 'skipped');
    return;
  end if;

  insert into ai_documents (source_type, source_id, title, acl_mode, brand_id, author_id, doc_hash) values
    ('srchmove', 'R', 'R report', 'report', brand, current_setting('t.boss')::uuid, 'x'),
    ('srchmove', 'B', 'B brand',  'brand',  brand, null, 'x');
  insert into ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding_model)
  select id, 0, title || ' zqxsrchmove', 'x', 2, 'x', public.ai_embed_model() from ai_documents where source_type = 'srchmove';

  perform set_config('request.jwt.claims', json_build_object('sub', apc, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into before_n from ai_search(null, 'zqxsrchmove', array['srchmove']);
  execute 'reset role';

  delete from brand_assignments where brand_id = brand and user_id = apc;

  execute 'set local role authenticated';
  select count(*) into after_n from ai_search(null, 'zqxsrchmove', array['srchmove']);
  execute 'reset role';

  perform pg_temp.ok('reassignment: APC sees the brand''s report + brand docs while assigned', before_n = 2, before_n::text);
  perform pg_temp.ok('reassignment: both vanish the moment the assignment is removed (no re-index)', after_n = 0, after_n::text);
end $$;

-- ── mig 377: the per-source off switch (QA B2) ──────────────────────
-- One UPDATE hides a type at once from everyone, the Boss included; the rows
-- stay; switching it back shows the same rows again. Empty list = nothing.
do $$
declare n_on int; n_off int; n_back int; n_empty int; n_other int; types text[];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n_on from ai_search(null, 'zqxsrchkw', array['srchtest'], p_match_count => 100);
  execute 'reset role';

  update ai_assistant_config set ingest_sources = array_remove(ingest_sources, 'srchtest') where id = 1;
  execute 'set local role authenticated';
  select count(*) into n_off   from ai_search(null, 'zqxsrchkw', array['srchtest'], p_match_count => 100);
  select count(*) into n_other from ai_search(null, 'zqxsrchkw', null, p_match_count => 100);   -- no type filter either
  execute 'reset role';

  update ai_assistant_config set ingest_sources = ingest_sources || '{srchtest}' where id = 1;
  execute 'set local role authenticated';
  select count(*) into n_back from ai_search(null, 'zqxsrchkw', array['srchtest'], p_match_count => 100);
  execute 'reset role';

  update ai_assistant_config set ingest_sources = '{}' where id = 1;
  types := public.ai_source_types();
  execute 'set local role authenticated';
  select count(*) into n_empty from ai_search(null, 'zqxsrchper zqxsrchacl zqxsrchkw', null, p_match_count => 100);
  execute 'reset role';
  update ai_assistant_config set ingest_sources = '{incentive,zzz_custom,report,kb_article,tts_article,app_guide,ai_doc,srchtest,srchold,srchper,srchacl,srchrank,srchmove}' where id = 1;

  perform pg_temp.ok('377 off switch: boss sees the keyword docs while on (arm cap 60)', n_on = 60, n_on::text);
  perform pg_temp.ok('377 off switch: 0 rows the moment the type leaves ingest_sources (with and without a type filter)',
                     n_off = 0 and n_other = 0, n_off || ' / ' || n_other);
  perform pg_temp.ok('377 off switch: back on shows the same 60 again (no re-index)', n_back = 60, n_back::text);
  perform pg_temp.ok('377 empty ingest_sources: ai_source_types() = {} and ai_search returns nothing',
                     types = '{}'::text[] and n_empty = 0, coalesce(types::text, 'null') || ' / ' || n_empty);
  perform pg_temp.ok('377 ai_source_types(): canonical order first, then other names alphabetically',
    public.ai_source_types() = '{kb_article,ai_doc,app_guide,tts_article,report,incentive,srchacl,srchmove,srchold,srchper,srchrank,srchtest,zzz_custom}'::text[],
    public.ai_source_types()::text);
end $$;

-- ── results ─────────────────────────────────────────────────────────
select n, result, test, detail from sres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'SEARCH: PASS' else 'SEARCH: FAIL' end as verdict,
       count(*) filter (where result = 'ok')   as ok,
       count(*) filter (where result = 'FAIL') as failed,
       count(*) filter (where result = 'WARN') as warnings
  from sres;
