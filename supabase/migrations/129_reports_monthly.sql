-- ============================================================
-- Migration 129 — Reports: add Monthly cadence
--
-- v1 has a separate Monthly Reports module (commit 825cd6f) with a
-- 15-section toggle (sectionsEnabled). v2's reports table was originally
-- weekly + biweekly only (mig 012). This migration:
--
--   1. Widens the type CHECK to accept 'monthly'
--   2. Adds sections_enabled jsonb (per-report, monthly-specific) so
--      each monthly report can selectively show/hide v1's 15 sections
--   3. Backfills sections_enabled = '{}' for existing rows (treated as
--      "all on" by the UI fallback)
--
-- The unique constraint on (brand_id, type, period_start) already
-- prevents collisions with weekly/biweekly because monthly's period_start
-- is always the 1st of the month.
--
-- The status enum, audit columns, RLS, and notification triggers from
-- migration 012 already work for any type — no changes needed there.
--
-- Safe to re-run.
-- ============================================================

-- 1. Widen type CHECK
do $$
begin
  alter table public.reports drop constraint if exists reports_type_check;
exception when undefined_object then null;
end $$;

alter table public.reports
  add constraint reports_type_check
  check (type in ('weekly','biweekly','monthly'));

-- 2. sections_enabled: per-report jsonb mapping section-key → boolean.
--    NULL / '{}' / missing keys are treated as "section enabled" by the
--    UI so old rows render unchanged. Only monthly forms write to it;
--    weekly/biweekly leave it as-is.
alter table public.reports
  add column if not exists sections_enabled jsonb not null default '{}'::jsonb;

-- 3. Index for "month picker" queries (already covered by period_year+month)
--    and a partial index on type='monthly' for the monthly-tab listing.
create index if not exists reports_monthly_idx
  on public.reports(brand_id, period_year, period_month)
  where type = 'monthly';
