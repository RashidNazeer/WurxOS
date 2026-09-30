-- ============================================================
-- Phase 1: the v1 assistant's writes still work after mig 370.
-- Replays the exact column sets that supabase/functions/ai-chat/index.ts and
-- src/lib/aiAssistantApi.js write, as the roles that write them.
-- Run:  node Assistant/scripts/db-dev.mjs sql Assistant/tests/sql/v1compat.sql
-- Always rolled back by the runner.
-- ============================================================

create temp table vres (n serial, test text, result text, detail text) on commit drop;
grant all on vres to authenticated, service_role;
grant all on sequence vres_n_seq to authenticated, service_role;

do $$
declare boss uuid := (select id from profiles where role = 'boss' and is_active and deleted_at is null limit 1);
        cid uuid; outcome text; r record;
begin
  -- ai-chat (service role): new conversation + two messages
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  execute 'set local role service_role';
  begin
    insert into ai_conversations (user_id, title) values (boss, 'v1compat') returning id into cid;
    insert into ai_messages (conversation_id, role, content) values (cid, 'user', 'q'), (cid, 'assistant', 'a');
    update ai_conversations set updated_at = now() where id = cid;
    outcome := 'ok';
  exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  insert into vres (test, result, detail) values ('ai-chat: conversation + message inserts', case when outcome = 'ok' then 'ok' else 'FAIL' end, outcome);
  select meta into r from ai_messages where conversation_id = cid limit 1;
  insert into vres (test, result, detail) values ('ai_messages.meta defaults to {}', case when r.meta = '{}'::jsonb then 'ok' else 'FAIL' end, r.meta::text);

  -- Boss UI (authenticated): saveDoc insert / update, updateAiConfig
  perform set_config('request.jwt.claims', json_build_object('sub', boss, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into ai_assistant_docs (title, content, is_active, created_by) values ('v1compat', 'body', true, boss);
    update ai_assistant_docs set title = 'v1compat2', content = 'b2', is_active = false, updated_at = now() where title = 'v1compat';
    update ai_assistant_config set persona = persona, greeting = greeting, enabled = enabled, use_kb = use_kb,
           use_tts_academy = use_tts_academy, model = model, updated_at = now() where id = 1;
    outcome := 'ok';
  exception when others then outcome := sqlstate || ' ' || sqlerrm; end;
  execute 'reset role';
  insert into vres (test, result, detail) values ('Boss UI: saveDoc insert/update + updateAiConfig', case when outcome = 'ok' then 'ok' else 'FAIL' end, outcome);
  select kind, meta, slug into r from ai_assistant_docs where title = 'v1compat2';
  insert into vres (test, result, detail) values ('new ai_assistant_docs row gets kind=doc, meta={}, slug null',
    case when r.kind = 'doc' and r.meta = '{}'::jsonb and r.slug is null then 'ok' else 'FAIL' end, row(r.kind, r.meta, r.slug)::text);
  select engine, provider into r from ai_assistant_config where id = 1;
  insert into vres (test, result, detail) values ('config row: engine v1, provider openai (v1 stays live)',
    case when r.engine = 'v1' and r.provider = 'openai' then 'ok' else 'FAIL' end, row(r.engine, r.provider)::text);
  insert into vres (test, result, detail) values ('existing ai_assistant_docs rows all kind=doc',
    case when not exists (select 1 from ai_assistant_docs where kind <> 'doc') then 'ok' else 'FAIL' end,
    (select count(*)::text from ai_assistant_docs));
end $$;

select n, result, test, detail from vres order by n;
select case when count(*) filter (where result = 'FAIL') = 0 then 'V1 COMPAT: PASS' else 'V1 COMPAT: FAIL' end as verdict,
       count(*) filter (where result = 'ok') as ok, count(*) filter (where result = 'FAIL') as failed
  from vres;
