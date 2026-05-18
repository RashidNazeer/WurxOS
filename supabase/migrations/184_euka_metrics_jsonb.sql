-- ============================================================
-- WurxOS v2 — Migration 184: full metric set for Euka snapshots.
--
-- The Shop Metrics dashboard is expanding from GMV/units/orders to
-- the full set Euka can report (video GMV, AOV, creators, videos,
-- views, ad spend, ROAS, sample requests, outreach, top performers).
--
-- Rather than a column per metric, the euka-sync function now also
-- writes a `metrics` JSONB blob — { d7, d30, top } — so the metric
-- set can grow/change without further migrations. The original
-- gmv_/units_/orders_ columns stay populated for easy querying.
--
-- Idempotent.
-- ============================================================

alter table public.euka_shop_metrics
  add column if not exists metrics jsonb;
