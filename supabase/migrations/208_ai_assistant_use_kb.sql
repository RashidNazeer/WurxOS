-- ============================================================
-- WurxOS v2 — Migration 208: AI assistant can also answer from the company
-- Knowledge Base (kb_articles), toggleable by the Boss.
--
-- The ai-chat function reads KB through the CALLER's own token, so Supabase
-- RLS (mig 134) returns only the articles that user is allowed to see — a
-- role-restricted or private SOP is never surfaced to someone who can't see it.
-- This flag just lets the Boss turn the whole behaviour on/off.
-- ============================================================

alter table public.ai_assistant_config
  add column if not exists use_kb boolean not null default true;
