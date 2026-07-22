-- ============================================================
-- WurxOS v2 — Migration 263: brands.gmv_max_status
--
-- Mirrors brands.paid_collab_status (mig 016). Records whether WE run the
-- brand's GMV Max (paid ads) campaigns, so Brand Analytics can show the
-- "GMV Max Budget" and "Target ROI" goal cards only for brands we manage.
--
-- Same four buckets as paid_collab_status:
--   not_applicable     — no GMV Max on this brand
--   managed_by_brand   — the brand runs their own GMV Max
--   managed_internally — we run it
--   hybrid             — shared
--
-- "We manage it" (internally OR hybrid) is what gates the analytics cards;
-- Target ROI only matters when we run GMV Max, so it follows this column.
--
-- Safe to re-run.
-- ============================================================

alter table public.brands
  add column if not exists gmv_max_status text not null default 'not_applicable';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brands_gmv_max_status_chk'
  ) then
    alter table public.brands
      add constraint brands_gmv_max_status_chk
      check (gmv_max_status in (
        'managed_by_brand',
        'managed_internally',
        'hybrid',
        'not_applicable'
      ));
  end if;
end;
$$;

create index if not exists brands_gmv_max_status_idx
  on public.brands(gmv_max_status)
  where gmv_max_status <> 'not_applicable';
