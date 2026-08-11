-- ============================================================
-- WurxOS v2 — Migration 314: link Apothecary to Euka + re-assert Cutler.
--
-- 1. APOTHECARY — a new brand on Euka with its OWN OpenAPI key (secret
--    EUKA_API_KEY_APOTHECARY), the same "own key" pattern as Solid Gold /
--    Inno Supps / Bentgo. Confirmed live against that key's /me + /stores:
--      store_id add2f01e-67ab-4fa9-b1c8-52880587c784  name "Apothecary Brands"
--      region US, shopId 7495787958262467076 — the key's ONLY store, so no
--      storeId injection is needed in euka-api (it reads /stores itself).
--    Adds the store to the euka_stores reference list (Add/Edit Brand dropdown)
--    and links our existing "Apothecary" brand row, which is what every
--    brand-aware Euka path resolves on: euka-report-autofill (weekly "Auto
--    Generate from Euka"), euka-checkpoint-autofill, video-review-targets.
--
-- 2. CUTLER NUTRITION — its store is back on the SHARED Euka account (verified
--    against the shared key's /stores: same store_id as mig 229, d4555fac…).
--    It had been moved to a dedicated key; that key is gone, so the fix is a
--    secrets change — unset EUKA_API_KEY_CUTLERNUTRITION so eukaKeyForSlug()
--    falls through to EUKA_SHARED_API_KEY again (EUKA_SHARED_BRANDS already
--    maps cutlernutrition → d4555fac…). The rows below only re-assert the DB
--    side so 'shared' is recorded as the key kind and the brand stays linked.
--
-- Idempotent.
-- ============================================================

insert into public.euka_stores (store_id, slug, label, key_kind) values
  ('add2f01e-67ab-4fa9-b1c8-52880587c784', 'apothecary',      'Apothecary Brands', 'own'),
  ('d4555fac-379f-4200-8fec-53c96c5f22ce', 'cutlernutrition', 'Cutler Nutrition',  'shared')
on conflict (store_id) do update
  set slug = excluded.slug, label = excluded.label, key_kind = excluded.key_kind, is_active = true;

update public.brands b
set euka_store_id = m.store_id, euka_slug = m.slug
from (values
  ('apothecary',        'add2f01e-67ab-4fa9-b1c8-52880587c784', 'apothecary'),
  ('cutler nutritions', 'd4555fac-379f-4200-8fec-53c96c5f22ce', 'cutlernutrition')
) as m(name, store_id, slug)
where lower(btrim(b.brand_name)) = m.name;
