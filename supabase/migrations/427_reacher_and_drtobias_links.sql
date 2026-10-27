-- ============================================================
-- WurxOS v2 — Migration 427: link Dr Tobias to Euka, and add Reacher as a
-- second data provider (Irwin Naturals).
--
-- ── DR TOBIAS ──────────────────────────────────────────────────────────────
-- Dr Tobias exists in Euka (store f00489d2…, brand fdaa9e59…) but was never
-- linked here, so brands.euka_store_id was null: the report and checkpoint
-- forms showed a plain "Auto-fill" and never called Euka. Linking needs a
-- euka_stores row (the store<->brand pairing, mig 315) and the brand's
-- euka_store_id / euka_slug.
--
-- The pairing is not a detail. Mig 315 recorded, and this was re-verified live
-- before writing this migration, that Euka scopes rows by BRAND id: asking for
-- Dr Tobias's store with Dr. Harvey's brand id returns Dr. Harvey's figures
-- with a 200. Both ids below come from Euka's own /stores and /brands answers,
-- which agree on the names, and from the account's brand listing.
--
-- key_kind is 'shared': the one API key issued for these two brands sees BOTH
-- stores (same as every other multi-brand account here).
--
-- ── REACHER ────────────────────────────────────────────────────────────────
-- Irwin Naturals runs on Reacher, not Euka, so there was nothing to auto-fill
-- from. reacher_shop_id is the provider switch: set => the forms call
-- reacher-autofill with this shop id; null => the brand is Euka (or manual).
-- Reacher's key sees several shops and is told which one via x-shop-id, so the
-- id lives next to the brand it scopes -- the same mispairing hazard as Euka,
-- handled the same way (a database column, never a name match at call time).
--
-- Idempotent.
-- ============================================================

-- ---- Dr Tobias -> Euka -------------------------------------------------------
insert into public.euka_stores (store_id, slug, label, key_kind, is_active, euka_brand_id)
values ('f00489d2-4ff1-4efe-afa9-534efbed657e', 'drtobias', 'Dr Tobias', 'shared', true,
        'fdaa9e59-374e-43a6-8949-217602986032')
on conflict (store_id) do update
  set slug = excluded.slug,
      label = excluded.label,
      is_active = true,
      euka_brand_id = excluded.euka_brand_id;

update public.brands
   set euka_store_id = 'f00489d2-4ff1-4efe-afa9-534efbed657e',
       euka_slug     = 'drtobias'
 where brand_name = 'Dr Tobias'
   and (euka_store_id is distinct from 'f00489d2-4ff1-4efe-afa9-534efbed657e'
        or euka_slug is distinct from 'drtobias');

-- ---- Reacher provider switch -------------------------------------------------
alter table public.brands add column if not exists reacher_shop_id bigint;

comment on column public.brands.reacher_shop_id is
  'Reacher shop id (x-shop-id). Set = this brand auto-fills from Reacher; null = Euka or manual. Mutually exclusive with euka_store_id.';

-- A brand reads from ONE provider. If both were set the form would have to
-- guess which to call, and a wrong guess silently fills another platform's
-- numbers into the report.
alter table public.brands drop constraint if exists brands_one_data_provider;
alter table public.brands add constraint brands_one_data_provider
  check (reacher_shop_id is null or euka_store_id is null);

update public.brands
   set reacher_shop_id = 12832
 where brand_name = 'Irwin Naturals'
   and reacher_shop_id is distinct from 12832;

-- ---- verification ------------------------------------------------------------
do $verify$
declare
  v_store text; v_slug text; v_bid text; v_shop bigint; n int;
begin
  select euka_store_id, euka_slug into v_store, v_slug from public.brands where brand_name = 'Dr Tobias';
  if v_store is distinct from 'f00489d2-4ff1-4efe-afa9-534efbed657e' or v_slug is distinct from 'drtobias' then
    raise exception 'mig 427: Dr Tobias is not linked (store=%, slug=%)', v_store, v_slug;
  end if;

  select euka_brand_id into v_bid from public.euka_stores where store_id = v_store;
  if v_bid is distinct from 'fdaa9e59-374e-43a6-8949-217602986032' then
    raise exception 'mig 427: Dr Tobias store has the wrong Euka brand id (%)', v_bid;
  end if;

  -- The pairing must not have collided with Dr. Harvey's.
  select count(*) into n from public.euka_stores where euka_brand_id = v_bid;
  if n <> 1 then raise exception 'mig 427: Euka brand id % is paired with % stores', v_bid, n; end if;

  select reacher_shop_id into v_shop from public.brands where brand_name = 'Irwin Naturals';
  if v_shop is distinct from 12832 then
    raise exception 'mig 427: Irwin Naturals is not on Reacher shop 12832 (%)', v_shop;
  end if;

  -- Nobody may have both providers.
  select count(*) into n from public.brands where reacher_shop_id is not null and euka_store_id is not null;
  if n <> 0 then raise exception 'mig 427: % brands claim two providers', n; end if;

  raise notice '427 verified: Dr Tobias on Euka, Irwin Naturals on Reacher.';
end $verify$;
