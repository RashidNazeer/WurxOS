-- ============================================================
-- WurxOS v2 — Migration 222: brands.euka_slug — link a WurxOS brand to
-- its Euka OpenAPI account (brand slug), so the Boss "Create weekly report
-- from Euka" flow knows WHICH Euka account/store to fetch for a brand.
--
-- Background: mig 183 already added `brands.euka_store_id` (the specific
-- Euka store). But each Euka *account* is addressed by a brand SLUG
-- (the euka-api edge fn routes by slug — solidgold / innosupps / the
-- shared-key brands), which we had no column for. The autofill flow needs
-- BOTH: euka_slug (which key/account) + euka_store_id (which store on it).
--
-- The slugs must match the ones the euka-api edge function discovers from
-- its env secrets (see /__brands): the per-key brands `solidgold`,
-- `innosupps`, and the shared-key brands `aurelia`, `biostime`,
-- `cutlernutrition`, `dangleit`, `drharvey`, `longevitybox`,
-- `louisveillejerky`, `penetrex`, `swissewellness`, `transformation`.
--
-- Backfill: set euka_slug for brands whose name clearly matches a known
-- Euka slug. This is best-effort by name; brands with no confident match
-- are left NULL and simply fall back to manual WurxOS-brand selection in
-- the create modal (they can be set later via the Euka page or SQL).
-- euka_store_id is NOT backfilled here — it is auto-discovered per store
-- and can be set explicitly; the create flow reads the live /stores list.
--
-- No RLS change: the Boss already has full insert rights on `reports`,
-- and `brands` UPDATE is already gated to admins. Idempotent.
-- ============================================================

alter table public.brands
  add column if not exists euka_slug text;

-- Best-effort name → Euka slug backfill. Only sets rows still NULL, and
-- only for unambiguous name matches, so re-running is safe and won't
-- clobber a value an admin set by hand.
update public.brands b
set euka_slug = m.slug
from (values
  ('solid gold',        'solidgold'),
  ('innosupps',         'innosupps'),
  ('inno supps',        'innosupps'),
  ('aurelia',           'aurelia'),
  ('biostime',          'biostime'),
  ('cutler nutrition',  'cutlernutrition'),
  ('cutler',            'cutlernutrition'),
  ('dangle it',         'dangleit'),
  ('dangleit',          'dangleit'),
  ('dr harvey',         'drharvey'),
  ('dr. harvey',        'drharvey'),
  ('longevity box',     'longevitybox'),
  ('louisveille jerky', 'louisveillejerky'),
  ('louisveille',       'louisveillejerky'),
  ('penetrex',          'penetrex'),
  ('swisse wellness',   'swissewellness'),
  ('swisse',            'swissewellness'),
  ('transformation',    'transformation')
) as m(name, slug)
where b.euka_slug is null
  and lower(btrim(b.brand_name)) = m.name;
