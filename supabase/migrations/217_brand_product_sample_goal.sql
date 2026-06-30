-- ============================================================
-- WurxOS v2 — Migration 217: per-product monthly sample goal.
--
-- Each brand product gets an APC-editable monthly sample-approval goal
-- that carries across the month (a property of the product, not the
-- report). Reports compare their per-product MTD samples-approved against
-- this goal to show a "X of GOAL approved · Y pending" progress bar, and
-- the brand's overall goal = sum of its products' goals.
--
-- Keyed by brand_products.id (the stable product identity; the report's
-- productHighlights[].productId is free text and unreliable). Existing
-- bpd_* RLS on brand_products already gates writes to the brand owner /
-- assignee / APC, so no policy change is needed.
--
-- Idempotent.
-- ============================================================

alter table public.brand_products
  add column if not exists monthly_sample_goal int;
