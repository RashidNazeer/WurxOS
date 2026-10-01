-- ============================================================
-- 374 — Assistant v2: the KB security trigger (the ONLY ingest trigger).
-- NOT APPLIED: needs its own Owner go. Independent of 375: apply it, or skip
-- it and let the 12-hour sweep carry ACL changes too.
--
-- Owner, 2026-09-29: content reaches the store on a rolling 12 hours (the
-- sweep, mig 379 + 375) or on demand (ai_run_ingestion), so there are no
-- content triggers. What must not wait 12 hours is a KB article becoming
-- LESS visible: its old ACL is a snapshot in ai_documents, so until the
-- document is re-read, ai_search still shows it to the old audience.
--
--   kb_articles   visibility, visible_to_roles, visible_to_users, submitted_by,
--                 created_by or approval_status changes → 'acl' op, priority 0,
--                 due now; DELETE → 'delete' op, due now. Only for articles
--                 that are in the store: anything else cannot leak, and waits
--                 for the sweep. The tick (375) drains it within ~1 minute.
--
-- Title / body / tags edits, new articles, SOP text and every other source
-- enqueue nothing here. The body swallows every error: indexing never blocks
-- a user's save; the sweep catches anything missed.
-- scripts/test-triggers.mjs runs this file inside a rolled-back transaction.
-- Needs 377 (ai_source_enabled). Idempotent.
-- ============================================================

-- The earlier draft of this migration (content triggers on six tables) was
-- never applied; remove it wherever it was.
drop trigger if exists ai_reports_enqueue           on public.reports;
drop trigger if exists ai_kb_articles_enqueue       on public.kb_articles;
drop trigger if exists ai_assistant_docs_enqueue    on public.ai_assistant_docs;
drop trigger if exists ai_tts_articles_enqueue      on public.tts_articles;
drop trigger if exists ai_incentives_enqueue        on public.incentives;
drop trigger if exists ai_brands_enqueue            on public.brands;
drop function if exists public.ai_trg_reports();
drop function if exists public.ai_trg_kb_articles();
drop function if exists public.ai_trg_ai_assistant_docs();
drop function if exists public.ai_trg_tts_articles();
drop function if exists public.ai_trg_incentives();
drop function if exists public.ai_trg_brands();

-- Enqueue only sources enabled in ai_assistant_config.ingest_sources (mig 377).
create or replace function public.ai_enqueue_enabled(
  p_type text, p_id text, p_op text, p_priority int default 5,
  p_debounce interval default interval '0', p_reason text default 'trigger')
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.ai_source_enabled(p_type) then
    perform public.ai_enqueue(p_type, p_id, p_op, p_priority, p_debounce, p_reason);
  end if;
exception when others then
  raise warning 'ai_enqueue_enabled failed (% / %): %', p_type, p_id, sqlerrm;
end $$;
revoke execute on function public.ai_enqueue_enabled(text, text, text, int, interval, text) from public, anon, authenticated;

-- ── kb_articles: access changes only ───────────────────────────────────
create or replace function public.ai_trg_kb_articles_acl() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  begin
    if not exists (select 1 from public.ai_documents d
                    where d.source_type = 'kb_article' and d.source_id = v_id::text and d.status = 'active') then
      return null;
    end if;
    if tg_op = 'DELETE' then
      perform public.ai_enqueue_enabled('kb_article', v_id::text, 'delete', 0);
    elsif new.visibility       is distinct from old.visibility
       or new.visible_to_roles is distinct from old.visible_to_roles
       or new.visible_to_users is distinct from old.visible_to_users
       or new.submitted_by     is distinct from old.submitted_by
       or new.created_by       is distinct from old.created_by
       or new.approval_status  is distinct from old.approval_status then
      perform public.ai_enqueue_enabled('kb_article', v_id::text, 'acl', 0);
    end if;
  exception when others then
    raise warning 'ai_trg_kb_articles_acl: %', sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.ai_trg_kb_articles_acl() from public, anon, authenticated;

create or replace trigger ai_kb_articles_acl
  after update of visibility, visible_to_roles, visible_to_users, submitted_by, created_by, approval_status
     or delete on public.kb_articles
  for each row execute function public.ai_trg_kb_articles_acl();
