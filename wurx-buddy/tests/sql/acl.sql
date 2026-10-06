-- ============================================================
-- Phase 1 hard gate: ai_search permission matrix.
-- Run:  node Assistant/scripts/db-dev.mjs sql Assistant/tests/sql/acl.sql
-- Always rolled back by the runner — nothing persists.
--
-- Creates 16 synthetic documents (one per ACL case) whose text contains the
-- unique word "zqxacltest", then searches AS real dev users and compares what
-- each sees with the expected matrix. Also checks that clients cannot read
-- ai_documents / ai_chunks directly.
-- ============================================================

-- ── pick real users and brands ──────────────────────────────────────
select set_config('t.boss', (select id::text from profiles where role='boss' and is_active and deleted_at is null limit 1), true);
select set_config('t.ol',   (select id::text from profiles where role='ol'   and is_active and deleted_at is null limit 1), true);
select set_config('t.dev',  (select id::text from profiles where role='developer' and is_active and deleted_at is null limit 1), true);
-- an APC who can see at least one brand, and a TL who is NOT that brand's owner
select set_config('t.apc', (
  select p.id::text from profiles p
   where p.role='apc' and p.is_active and p.deleted_at is null
     and exists (select 1 from brands b where public.can_view_brand(b.owner_id, b.id, p.id))
     and exists (select 1 from brands b where not public.can_view_brand(b.owner_id, b.id, p.id))
   limit 1), true);
select set_config('t.bx', (select b.id::text from brands b where public.can_view_brand(b.owner_id, b.id, current_setting('t.apc')::uuid) limit 1), true);
select set_config('t.by', (select b.id::text from brands b where not public.can_view_brand(b.owner_id, b.id, current_setting('t.apc')::uuid)
                                                            and b.owner_id <> current_setting('t.apc')::uuid limit 1), true);
select set_config('t.tl', (
  select p.id::text from profiles p
   where p.role='tl' and p.is_active and p.deleted_at is null
     and not public.can_view_brand((select owner_id from brands where id = current_setting('t.bx')::uuid), current_setting('t.bx')::uuid, p.id)
     and not public.can_view_brand((select owner_id from brands where id = current_setting('t.by')::uuid), current_setting('t.by')::uuid, p.id)
   limit 1), true);

select 'fixture' as what, current_setting('t.boss') boss, current_setting('t.ol') ol, current_setting('t.tl') tl,
       current_setting('t.apc') apc, current_setting('t.dev') dev, current_setting('t.bx') brand_visible_to_apc, current_setting('t.by') brand_hidden_from_apc;

-- ── synthetic documents (one chunk each) ────────────────────────────
-- Mig 377: ai_search shows only types in ai_assistant_config.ingest_sources.
update ai_assistant_config set ingest_sources = ingest_sources || '{acltest}' where id = 1;
insert into ai_documents (source_type, source_id, title, acl_mode, acl_roles, acl_users, brand_id, author_id, metadata, doc_hash)
values
  ('acltest','d01','D01 all',                  'all',    '{}',     '{}', null, null, '{}', 'x'),
  ('acltest','d02','D02 roles tl',             'roles',  '{tl}',   '{}', null, null, '{}', 'x'),
  ('acltest','d03','D03 report visible brand', 'report', '{}',     '{}', current_setting('t.bx')::uuid, current_setting('t.boss')::uuid, '{}', 'x'),
  ('acltest','d04','D04 report hidden brand',  'report', '{}',     '{}', current_setting('t.by')::uuid, current_setting('t.boss')::uuid, '{}', 'x'),
  ('acltest','d05','D05 kb role ol',           'kb',     '{ol}',   '{}', null, current_setting('t.boss')::uuid, '{"visibility":"role"}', 'x'),
  ('acltest','d06','D06 kb users apc',         'kb',     '{}',     array[current_setting('t.apc')::uuid], null, current_setting('t.boss')::uuid, '{"visibility":"users"}', 'x'),
  ('acltest','d07','D07 kb office',            'kb',     '{}',     '{}', null, current_setting('t.boss')::uuid, '{"visibility":"office"}', 'x'),
  ('acltest','d08','D08 boss plus ol',         'boss',   '{ol}',   '{}', null, null, '{}', 'x'),
  ('acltest','d09','D09 boss only',            'boss',   '{}',     '{}', null, null, '{}', 'x'),
  ('acltest','d10','D10 brand visible',        'brand',  '{}',     '{}', current_setting('t.bx')::uuid, null, '{}', 'x'),
  -- mig 372 (kb_select parity, mig 134): submitter, author, and fail-closed visibility
  ('acltest','d11','D11 kb private submitted by apc', 'kb', '{}', '{}', null, current_setting('t.boss')::uuid,
     jsonb_build_object('visibility','private','submitted_by',current_setting('t.apc')), 'x'),
  ('acltest','d12','D12 kb private',           'kb',     '{}',     '{}', null, current_setting('t.boss')::uuid, '{"visibility":"private"}', 'x'),
  ('acltest','d13','D13 kb no visibility',     'kb',     '{}',     '{}', null, current_setting('t.boss')::uuid, '{}', 'x'),
  ('acltest','d14','D14 kb unknown visibility','kb',     '{apc,tl}', array[current_setting('t.apc')::uuid], null, current_setting('t.boss')::uuid, '{"visibility":"team"}', 'x'),
  ('acltest','d15','D15 kb private authored by apc', 'kb', '{}', '{}', null, current_setting('t.apc')::uuid, '{"visibility":"private"}', 'x'),
  ('acltest','d16','D16 kb role tl',           'kb',     '{tl}',   '{}', null, current_setting('t.boss')::uuid, '{"visibility":"role"}', 'x');

insert into ai_chunks (document_id, chunk_index, content, embed_text, token_count, content_hash, embedding_model)
select id, 0, title || ' zqxacltest', title || ' zqxacltest', 5, 'x', 'none' from ai_documents where source_type = 'acltest';

-- ── search as each user ─────────────────────────────────────────────
create temp table acl_seen (who text, title text) on commit drop;
grant all on acl_seen to authenticated, service_role;

do $$
declare
  u record;
begin
  for u in select * from (values ('boss', current_setting('t.boss')), ('ol', current_setting('t.ol')),
                                 ('tl', current_setting('t.tl')), ('apc', current_setting('t.apc')),
                                 ('developer', current_setting('t.dev'))) v(who, uid) loop
    perform set_config('request.jwt.claims', json_build_object('sub', u.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into acl_seen select u.who, s.title from public.ai_search(null, 'zqxacltest', array['acltest']) s;
    execute 'reset role';
  end loop;

  -- Slack-relay path: service role answering AS the APC must see only the APC's view
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
  insert into acl_seen select 'service_as_apc', s.title
    from public.ai_search(null, 'zqxacltest', array['acltest'], p_as_user => current_setting('t.apc')::uuid) s;
  execute 'reset role';

  -- p_as_user must be IGNORED for a normal authenticated caller (no impersonation)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.apc'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into acl_seen select 'apc_spoofing_boss', s.title
    from public.ai_search(null, 'zqxacltest', array['acltest'], p_as_user => current_setting('t.boss')::uuid) s;
  execute 'reset role';
end $$;

-- ── expected matrix ─────────────────────────────────────────────────
create temp table acl_expected (who text, title text) on commit drop;
insert into acl_expected values
  ('boss','D01 all'),('boss','D02 roles tl'),('boss','D03 report visible brand'),('boss','D04 report hidden brand'),
  ('boss','D05 kb role ol'),('boss','D06 kb users apc'),('boss','D07 kb office'),('boss','D08 boss plus ol'),
  ('boss','D09 boss only'),('boss','D10 brand visible'),
  -- OL: sees all brands/reports (can_view_brand), KB role/dev override, boss-plus-ol
  ('ol','D01 all'),('ol','D03 report visible brand'),('ol','D04 report hidden brand'),('ol','D05 kb role ol'),
  ('ol','D06 kb users apc'),('ol','D07 kb office'),('ol','D08 boss plus ol'),('ol','D10 brand visible'),
  -- TL (not owner of either test brand)
  ('tl','D01 all'),('tl','D02 roles tl'),('tl','D07 kb office'),
  -- APC: own brand only, named-user KB, office KB
  ('apc','D01 all'),('apc','D03 report visible brand'),('apc','D06 kb users apc'),('apc','D07 kb office'),('apc','D10 brand visible'),
  -- Developer: KB override (mig 134) but no report/brand access (mig 212)
  ('developer','D01 all'),('developer','D05 kb role ol'),('developer','D06 kb users apc'),('developer','D07 kb office'),
  ('service_as_apc','D01 all'),('service_as_apc','D03 report visible brand'),('service_as_apc','D06 kb users apc'),
  ('service_as_apc','D07 kb office'),('service_as_apc','D10 brand visible'),
  ('apc_spoofing_boss','D01 all'),('apc_spoofing_boss','D03 report visible brand'),('apc_spoofing_boss','D06 kb users apc'),
  ('apc_spoofing_boss','D07 kb office'),('apc_spoofing_boss','D10 brand visible'),
  -- mig 372 KB rows: boss/ol/developer see every KB doc (kb_select override); the submitter
  -- and the author see their own; private/missing/unknown visibility is hidden from everyone else
  ('boss','D11 kb private submitted by apc'),('boss','D12 kb private'),('boss','D13 kb no visibility'),
  ('boss','D14 kb unknown visibility'),('boss','D15 kb private authored by apc'),('boss','D16 kb role tl'),
  ('ol','D11 kb private submitted by apc'),('ol','D12 kb private'),('ol','D13 kb no visibility'),
  ('ol','D14 kb unknown visibility'),('ol','D15 kb private authored by apc'),('ol','D16 kb role tl'),
  ('developer','D11 kb private submitted by apc'),('developer','D12 kb private'),('developer','D13 kb no visibility'),
  ('developer','D14 kb unknown visibility'),('developer','D15 kb private authored by apc'),('developer','D16 kb role tl'),
  ('tl','D16 kb role tl'),
  ('apc','D11 kb private submitted by apc'),('apc','D15 kb private authored by apc'),
  ('service_as_apc','D11 kb private submitted by apc'),('service_as_apc','D15 kb private authored by apc'),
  ('apc_spoofing_boss','D11 kb private submitted by apc'),('apc_spoofing_boss','D15 kb private authored by apc');

select coalesce(e.who, s.who) as who, coalesce(e.title, s.title) as doc,
       case when e.title is null then 'FAIL — LEAK (seen, not expected)'
            when s.title is null then 'FAIL — missing (expected, not seen)'
            else 'ok' end as result
  from acl_expected e
  full join acl_seen s on s.who = e.who and s.title = e.title
 order by result desc, who, doc;

select case when count(*) filter (where (e.title is null) <> (s.title is null)) = 0 then 'ACL MATRIX: PASS' else 'ACL MATRIX: FAIL' end as verdict,
       count(*) filter (where e.title is null) as leaks,
       count(*) filter (where s.title is null) as missing
  from acl_expected e full join acl_seen s on s.who = e.who and s.title = e.title;

-- ── direct table access must be denied for clients ─────────────────
do $$
declare denied_docs boolean := false; denied_chunks boolean := false;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.boss'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform 1 from public.ai_documents limit 1; exception when insufficient_privilege then denied_docs := true; end;
  begin perform 1 from public.ai_chunks limit 1;    exception when insufficient_privilege then denied_chunks := true; end;
  execute 'reset role';
  raise notice 'DIRECT ACCESS (even as boss): ai_documents denied=%, ai_chunks denied=%', denied_docs, denied_chunks;
  perform set_config('t.direct', (denied_docs and denied_chunks)::text, true);
end $$;
select case when current_setting('t.direct')::boolean then 'DIRECT ACCESS: PASS (denied even for boss)'
            else 'DIRECT ACCESS: FAIL (a client can read ai_documents/ai_chunks)' end as verdict;
