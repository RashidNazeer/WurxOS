-- ============================================================
-- WurxOS v2 — Migration 216: per-brand visibility for built-in
-- report sections (so an OL can turn a section on/off per brand).
--
-- First use: the "GMV Breakdown" section. It already ships on MONTHLY
-- reports for every brand; now WEEKLY reports can show it too, but only
-- for brands the OL opts in. This jsonb holds per-brand, per-section
-- enable flags keyed by the same camelCase section keys used in
-- WEEKLY_SECTIONS / MONTHLY_SECTIONS, e.g. { "gmvBreakdown": true }.
-- Missing key → fall back to the code default (weekly GMV Breakdown
-- defaults OFF; monthly stays its existing always-on default).
--
-- Mirrors the `extras` jsonb added in mig 161 on the same row; RLS from
-- mig 104 already covers every column, so no new policy is needed.
-- Idempotent.
-- ============================================================

alter table public.brand_report_sections
  add column if not exists section_visibility jsonb not null default '{}'::jsonb;
