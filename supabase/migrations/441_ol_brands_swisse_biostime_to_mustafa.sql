-- ============================================================
-- WurxOS v2 — Migration 441: team structure update (2026-11-05)
--
-- The new structure sheet gives Swisse and Biostime to Mustafa Jan; both
-- were on Muhammad Fahad's curated OL brand list (ol_incentive_brands, mig 291).
-- TL -> brand -> APC already matched the sheet, so nothing else moves.
-- Idempotent.
-- ============================================================

update public.ol_incentive_brands oib
   set ol_id = (select id from public.profiles where display_name = 'Mustafa Jan' and role = 'ol' and deleted_at is null)
 where oib.ol_id = (select id from public.profiles where display_name = 'Muhammad Fahad' and role = 'ol' and deleted_at is null)
   and oib.brand_id in (select id from public.brands where brand_name in ('Swisse', 'Biostime Shop US'))
   and not exists (
     select 1 from public.ol_incentive_brands x
      where x.brand_id = oib.brand_id
        and x.ol_id = (select id from public.profiles where display_name = 'Mustafa Jan' and role = 'ol' and deleted_at is null));
