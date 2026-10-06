-- ============================================================
-- 403 — Wurx Buddy: developers change the settings too, and the fallback
-- chain leads with the Gemini models that passed their checks (Owner and Lead,
-- 2026-10-01). 402 is Engineer 2's (a second vector space).
--
--   ai_can_edit_settings(uid)  Boss or an active developer. The Buddy write
--     policies use it instead of is_ai_admin (mig 207, still Boss-only and still
--     used for the log / queue / crawl reads, ai_is_service_or_admin, ai_ingest_retry):
--       ai_assistant_config   (every column: model, chain, roles, sources, persona, prices, budget, ...)
--       ai_assistant_docs     (the knowledge docs of the Train tab)
--       ai_excluded_documents (add / remove)
--     Triggers still apply to everyone: boss + developer stay in allowed_roles,
--     models must be usable, ingest_sources must be known.
--   TRUNCATE / REFERENCES / TRIGGER revoked from clients on the config and docs
--     tables (TRUNCATE skips row-level security).
--   fallback_models default: gemini-3.6-flash, gemini-3-flash-preview,
--     gemini-3.5-flash (503s on large requests, live), groq gpt-oss-120b,
--     gpt-6-luna. Dev's row takes it only if it still has 401's default.
-- Idempotent.
-- ============================================================

create or replace function public.ai_can_edit_settings(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_boss(uid)
      or exists (select 1 from public.profiles p
                  where p.id = uid and p.role = 'developer' and p.is_active and p.deleted_at is null);
$$;
revoke execute on function public.ai_can_edit_settings(uuid) from public, anon;
grant  execute on function public.ai_can_edit_settings(uuid) to authenticated, service_role;

drop policy if exists "ai_config_write" on public.ai_assistant_config;
create policy "ai_config_write" on public.ai_assistant_config for all
  using (public.ai_can_edit_settings((select auth.uid()))) with check (public.ai_can_edit_settings((select auth.uid())));

drop policy if exists "ai_docs_write" on public.ai_assistant_docs;
create policy "ai_docs_write" on public.ai_assistant_docs for all
  using (public.ai_can_edit_settings((select auth.uid()))) with check (public.ai_can_edit_settings((select auth.uid())));

drop policy if exists "ai_excluded_documents_admin" on public.ai_excluded_documents;
create policy "ai_excluded_documents_admin" on public.ai_excluded_documents for all
  using (public.ai_can_edit_settings((select auth.uid()))) with check (public.ai_can_edit_settings((select auth.uid())));

revoke truncate, references, trigger on public.ai_assistant_config, public.ai_assistant_docs, public.ai_excluded_documents from authenticated, anon;

alter table public.ai_assistant_config alter column fallback_models set default
  '[{"key_slot": "gemini", "model": "gemini-3.6-flash"}, {"key_slot": "gemini", "model": "gemini-3-flash-preview"}, {"key_slot": "gemini", "model": "gemini-3.5-flash"}, {"key_slot": "groq", "model": "openai/gpt-oss-120b"}, {"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb;
update public.ai_assistant_config
   set fallback_models = '[{"key_slot": "gemini", "model": "gemini-3.6-flash"}, {"key_slot": "gemini", "model": "gemini-3-flash-preview"}, {"key_slot": "gemini", "model": "gemini-3.5-flash"}, {"key_slot": "groq", "model": "openai/gpt-oss-120b"}, {"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb
 where fallback_models = '[{"key_slot": "gemini", "model": "gemini-3.5-flash"}, {"key_slot": "groq", "model": "openai/gpt-oss-120b"}, {"key_slot": "groq", "model": "qwen/qwen3.8-27b"}, {"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb;
