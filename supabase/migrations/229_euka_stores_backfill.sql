-- ============================================================
-- WurxOS v2 — Migration 229: Euka store reference + brand backfill.
--
-- Two things:
--  1. `euka_stores` — a small reference list of the Euka stores available
--     across our Euka OpenAPI accounts (slug + store_id + which key it lives
--     on). The Add/Edit Brand form reads this to offer a store DROPDOWN, so
--     linking a WurxOS brand to Euka is a pick (no typos) and captures BOTH
--     the store_id (to scope queries) and the slug (to pick the API key).
--     Non-secret (names + ids only), so readable by any authenticated user.
--  2. Backfill `brands.euka_store_id` + `brands.euka_slug` for the 12 brands
--     we currently have on Euka. Euka store names differ from our brand names
--     in several cases (Biostime→"Biostime Shop US", Cutler Nutrition→"Cutler
--     Nutritions", Dangle-it→"Dangle", Louisveille→"Louisville Jerky", Swisse
--     Wellness→"Swisse", Transformation→"Transformation Body"), so this maps
--     by our EXACT brand_name to the right store — confirmed against the live
--     Euka /stores list.
--
-- euka_store_id + euka_slug columns already exist (mig 183 / 222). "On Euka"
-- for a brand simply means euka_store_id IS NOT NULL — no extra flag needed.
-- The Add-Brand form makes the store REQUIRED only when the brand is marked
-- as on Euka (frontend rule; non-Euka brands stay store-less by design).
-- Idempotent.
-- ============================================================

-- 1. Reference table ------------------------------------------------
create table if not exists public.euka_stores (
  store_id   text primary key,
  slug       text not null,
  label      text not null,
  -- which env key this store's account uses: 'own' = a dedicated key
  -- (EUKA_API_KEY / EUKA_API_KEY_<SLUG>), 'shared' = the shared account key.
  key_kind   text not null default 'shared',
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.euka_stores (store_id, slug, label, key_kind) values
  ('e9d58f04-dc44-4ab2-adb2-62853a3dbe38', 'solidgold',        'Solid Gold Pets',   'own'),
  ('d2c4a42e-6e19-4e69-b193-378d7d1b9f87', 'innosupps',        'InnoSupps',         'own'),
  ('7ba26f87-2312-435a-ba9b-b86c5c79a14b', 'aurelia',          'Aurelia',           'shared'),
  ('96e4b513-72a3-4dcb-93c9-57cf330a5746', 'biostime',         'Biostime',          'shared'),
  ('d4555fac-379f-4200-8fec-53c96c5f22ce', 'cutlernutrition',  'Cutler Nutrition',  'shared'),
  ('d664109e-daba-4d59-866c-82546d14d483', 'dangleit',         'Dangle-it',         'shared'),
  ('3facdc2f-7a6a-4202-9083-22effded00bd', 'drharvey',         'Dr. Harvey''s',     'shared'),
  ('edf7c9f9-c114-4d0d-8e8d-bbe368f82f52', 'longevitybox',     'Longevity Box',     'shared'),
  ('3fe4446d-6e27-4fef-a9c3-a7648801cb64', 'louisveillejerky', 'Louisveille Jerky', 'shared'),
  ('a7c0a850-4511-42b1-ba56-32134a33e267', 'penetrex',         'Penetrex',          'shared'),
  ('ed3c1253-957f-4366-bfd8-30003fa7c50e', 'swissewellness',   'Swisse Wellness',   'shared'),
  ('a9c3f23a-eb46-4649-8c8d-17988729065a', 'transformation',   'Transformation',    'shared')
on conflict (store_id) do update
  set slug = excluded.slug, label = excluded.label, key_kind = excluded.key_kind, is_active = true;

alter table public.euka_stores enable row level security;
drop policy if exists euka_stores_read on public.euka_stores;
create policy euka_stores_read on public.euka_stores for select
  using (auth.role() = 'authenticated');

-- 2. Backfill brands (exact brand_name → store) ---------------------
-- Sets BOTH euka_store_id and euka_slug. Matches our exact brand names.
update public.brands b
set euka_store_id = m.store_id, euka_slug = m.slug
from (values
  ('solid gold pets',     'e9d58f04-dc44-4ab2-adb2-62853a3dbe38', 'solidgold'),
  ('inno supps',          'd2c4a42e-6e19-4e69-b193-378d7d1b9f87', 'innosupps'),
  ('aurelia',             '7ba26f87-2312-435a-ba9b-b86c5c79a14b', 'aurelia'),
  ('biostime shop us',    '96e4b513-72a3-4dcb-93c9-57cf330a5746', 'biostime'),
  ('cutler nutritions',   'd4555fac-379f-4200-8fec-53c96c5f22ce', 'cutlernutrition'),
  ('dangle',              'd664109e-daba-4d59-866c-82546d14d483', 'dangleit'),
  ('dr. harvey''s',       '3facdc2f-7a6a-4202-9083-22effded00bd', 'drharvey'),
  ('longevity box',       'edf7c9f9-c114-4d0d-8e8d-bbe368f82f52', 'longevitybox'),
  ('louisville jerky',    '3fe4446d-6e27-4fef-a9c3-a7648801cb64', 'louisveillejerky'),
  ('penetrex',            'a7c0a850-4511-42b1-ba56-32134a33e267', 'penetrex'),
  ('swisse',              'ed3c1253-957f-4366-bfd8-30003fa7c50e', 'swissewellness'),
  ('transformation body', 'a9c3f23a-eb46-4649-8c8d-17988729065a', 'transformation')
) as m(name, store_id, slug)
where lower(btrim(b.brand_name)) = m.name;
