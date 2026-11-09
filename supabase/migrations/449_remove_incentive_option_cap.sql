-- ============================================================
-- WurxOS v2 — Migration 449: no cap on workbook incentive options per APC.
--
-- Mig 422 limited an APC's plan to five workbook options (database trigger) as the backstop for
-- the picker's five-option limit. The Boss asked for the cap to go: an OL can now select as many
-- options as the plan needs, so the trigger and its guard function are removed. The counting
-- helper is kept (harmless, may be useful for reporting). Existing plans are untouched.
-- Idempotent.
-- ============================================================
drop trigger if exists incentives_zz_workbook_limit on public.incentives;
drop function if exists public.incentives_guard_workbook_limit();
