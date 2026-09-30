-- ============================================================
-- 383 — Assistant v2 agent core (phase5-design.md §7): grounding flags on the
-- request log.
--
--   ai_request_log.flags  jsonb, e.g.
--     numbers_without_data  sentences that state a figure with no [D#] citation
--     stripped_citations    ids the model cited that no tool returned this turn
--     serious, persona, empty_retry, ceiling_hit, skipped_calls, persist_error
--
-- Written only by the assistant (service role); read under the existing
-- ai_request_log_read policy.  Idempotent.
-- ============================================================

alter table public.ai_request_log
  add column if not exists flags jsonb not null default '{}'::jsonb;
