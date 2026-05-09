-- ============================================================
-- WurxOS v2 — Migration 005: brand performance metrics
--
-- Adds the manual, Boss/TL-maintained performance fields from v1.
-- Computed analytics (real GMV, conversions) come later with a
-- proper analytics source — this is the denormalized snapshot.
--
-- Safe to re-run.
-- ============================================================

alter table public.brands
  add column if not exists gmv numeric(15, 2);

create index if not exists brands_gmv_idx on public.brands(gmv);
