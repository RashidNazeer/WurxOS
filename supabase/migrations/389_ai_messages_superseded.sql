-- ============================================================
-- 389 — Wurx Buddy: Regenerate in place.
--
--   ai_messages.status  + 'superseded': the reply a regenerate replaced. It is
--                       kept (meta.superseded_by = the new reply's id; the new
--                       one has meta.supersedes), but hidden from the model's
--                       history and from the UI's chat view.
-- Idempotent.
-- ============================================================

alter table public.ai_messages drop constraint if exists ai_messages_status_check;
alter table public.ai_messages add constraint ai_messages_status_check
  check (status in ('generating', 'done', 'error', 'superseded'));
