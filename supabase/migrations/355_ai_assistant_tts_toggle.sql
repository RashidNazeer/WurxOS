-- ============================================================
-- WurxOS v2 — Migration 355: let the Boss switch the TikTok Shop Academy
-- knowledge base off.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The assistant currently retrieves from TWO sources on every question: our own
-- WurxOS guides + SOP library, and the ingested TikTok Shop Academy
-- (tts_knowledge). Both are injected into the same prompt, up to 14,000 and
-- 9,000 characters respectively. On a paid model that is a lot of context to
-- carry for a question like "how do I mark my attendance", and the Academy
-- material can crowd out our own SOPs on questions that were never about
-- TikTok at all.
--
-- This is the same shape as `use_kb` (migration 208): one boolean the Boss
-- controls from the Train tab, no redeploy needed to change it.
--
-- When OFF the function skips the whole TikTok path — including the embedding
-- API call that powers the semantic search, so it is one fewer paid request per
-- question, not just a smaller prompt. The Academy-specific instructions are
-- dropped from the system prompt too: leaving them in would tell the model to
-- cite a source it no longer has, which is how invented citations happen.
--
-- Default TRUE so nothing changes for anyone until the Boss decides otherwise.
-- ============================================================

alter table public.ai_assistant_config
  add column if not exists use_tts_academy boolean not null default true;

comment on column public.ai_assistant_config.use_tts_academy is
  'When false, the assistant never reads tts_knowledge (TikTok Shop Academy): no embedding call, no retrieval, and the Academy citation rules are removed from the system prompt. Answers come only from WurxOS guides and the company SOP library.';

do $verify$
declare v int;
begin
  select count(*) into v from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_assistant_config'
     and column_name = 'use_tts_academy';
  if v <> 1 then raise exception '355: use_tts_academy column missing'; end if;

  -- The singleton row must exist, or the flag has nowhere to live and the
  -- function would fall back to its default forever.
  select count(*) into v from public.ai_assistant_config where id = 1;
  if v <> 1 then raise exception '355: the ai_assistant_config singleton row is missing'; end if;

  raise notice '355: TikTok Shop Academy is now Boss-toggleable (default on)';
end;
$verify$;
