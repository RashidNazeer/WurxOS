-- ============================================================
-- WurxOS v2 — Migration 315: record each Euka store's BRAND id.
--
-- Euka changed `GET /data-export` (Aug 2026): it now requires `brand_id` in
-- ADDITION to `store_id`. Their published OpenAPI spec still lists only
-- store_id, so this is undocumented. Sending store_id alone returns
--   400 {"message":"data-export:: Missing required parameters: type, brand_id"}
-- which is why Video Reviews' Euka mode had been returning empty lists for
-- every brand (the 400 is swallowed → `data` is not an array → 0 candidates)
-- and the checkpoint's target-invites count came back blank.
--
-- WORSE — and the reason this is a DB column and not a runtime guess:
-- `brand_id` is what actually SCOPES the export. Verified against the live API
-- on the shared key: Cutler's store_id + Aurelia's brand_id returns AURELIA's
-- rows (59) instead of Cutler's (564). A wrong/guessed brand_id silently
-- returns another brand's data, so the pairing must be an exact stored link,
-- never a name match at call time.
--
-- Store→brand ids below were read from `GET /brands` on each Euka account
-- (the 4 own-key accounts + the shared account) on 2026-08-10. `/stores` does
-- NOT expose a brand id, so this table is the only place the pairing lives;
-- every /data-export caller (euka-api proxy, video-review-targets,
-- euka-checkpoint-autofill) reads it from here and injects it SERVER-SIDE.
--
-- Adding a new Euka brand now also means: fetch its brand id from /brands and
-- put it in this column, or its exports will fail with a clear config error.
-- Idempotent.
-- ============================================================

alter table public.euka_stores add column if not exists euka_brand_id text;

comment on column public.euka_stores.euka_brand_id is
  'Euka BRAND uuid (GET /brands) for this store. Required by GET /data-export '
  'alongside store_id, and it is the param that scopes the rows — a mismatched '
  'pair silently returns another brand''s data.';

update public.euka_stores s
set euka_brand_id = m.brand_id
from (values
  ('e9d58f04-dc44-4ab2-adb2-62853a3dbe38', '0e9d7386-b311-42f0-a34e-1de293bbefc6'), -- solidgold (own)
  ('d2c4a42e-6e19-4e69-b193-378d7d1b9f87', '9a44aa09-6e4f-4036-af5e-9e2b477eb868'), -- innosupps (own)
  ('daf16999-c7aa-47c7-b8cc-8a4fc1186d5c', '68af376d-8075-49aa-828f-3e009d9451be'), -- bentgo (own)
  ('add2f01e-67ab-4fa9-b1c8-52880587c784', '01d6dd58-8a4d-4e86-9e75-02d1447a4337'), -- apothecary (own)
  ('7ba26f87-2312-435a-ba9b-b86c5c79a14b', '7d7f4276-6297-49fa-aff0-b3944ab102b1'), -- aurelia
  ('96e4b513-72a3-4dcb-93c9-57cf330a5746', 'c0639dfb-e89a-4791-929a-7c7382d5e635'), -- biostime
  ('d4555fac-379f-4200-8fec-53c96c5f22ce', '635c761f-733a-459a-b62b-73537ea38033'), -- cutlernutrition
  ('d664109e-daba-4d59-866c-82546d14d483', 'cd52f816-c93e-49cf-838f-fa9b726855ac'), -- dangleit
  ('3facdc2f-7a6a-4202-9083-22effded00bd', 'c02fd126-a144-4fbc-8f42-cd8a9aade3ca'), -- drharvey
  ('edf7c9f9-c114-4d0d-8e8d-bbe368f82f52', 'cc7a548a-8ce3-4238-96d4-34b565848bd2'), -- longevitybox
  ('a7c0a850-4511-42b1-ba56-32134a33e267', '60ab542e-4b63-412e-babf-99e3104561d1'), -- penetrex
  ('ed3c1253-957f-4366-bfd8-30003fa7c50e', '01804daa-a04e-4b94-aec7-e7b24f6911c3')  -- swissewellness
) as m(store_id, brand_id)
where s.store_id = m.store_id;
