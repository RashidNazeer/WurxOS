-- ============================================================
-- WurxOS v2 — Migration 267: Amazon Halo — PER-BRAND + explicit 3-granularity
-- sheets (daily / weekly / monthly) + multi-brand client share links.
--
-- Reworks Halo from a single global dataset to a per-brand feature:
--   * A brand can have up to THREE datasets — one per granularity ('day',
--     'week','month'). Each is parsed from its own uploaded sheet (identical
--     column layout; only the date column's values differ). Re-uploading a
--     granularity REPLACES that brand's dataset for that granularity.
--   * `halo_brands` = the curated list of brands Halo is enabled for (drives the
--     main-page brand dropdown; a brand can be enabled before any sheet exists).
--   * `halo_shares.brand_ids` scopes a client link to one or more brands (mirrors
--     `client_access.brand_ids`, mig 109). The share RPCs return only those
--     brands' datasets/rows.
--
-- The correlation math now reads a granularity's OWN sheet when present, else
-- rolls the finest finer sheet up — so per-dataset weekly_metrics/monthly_metrics/
-- metric_gran/weekly_keywords (migs 261/266) are no longer written (each dataset
-- is single-granularity). Those columns are LEFT IN PLACE (harmless) to avoid a
-- destructive drop; the new create RPC simply stops populating them.
--
-- Authz unchanged: is_halo_viewer() = Boss OR active OL (mig 244). RLS on
-- halo_datasets/halo_rows already gates on is_halo_viewer 'for all' — brand_id
-- adds no row-security (Boss/OL see every brand's Halo; enablement is UI
-- curation, not per-user security). Clients read only via the anon share RPCs.
--
-- Additive + idempotent. No backfill — 0 datasets exist at ship time.
-- ============================================================

-- ---- 1. per-brand + explicit granularity on datasets ------------------------
alter table public.halo_datasets
  add column if not exists brand_id uuid references public.brands(id) on delete cascade;
alter table public.halo_datasets
  add column if not exists granularity text check (granularity in ('day','week','month'));

-- one dataset per (brand, granularity) — re-upload replaces the prior one
create unique index if not exists halo_datasets_brand_gran_uidx
  on public.halo_datasets(brand_id, granularity)
  where brand_id is not null and granularity is not null;

create index if not exists halo_datasets_brand_idx on public.halo_datasets(brand_id);

-- ---- 2. raw period label for week/month rows --------------------------------
-- ("1 June - 7 June", "June 2026") — shown verbatim; `date` holds the parsed
-- anchor (week START / month first-day) for ordering + lag arithmetic.
alter table public.halo_rows
  add column if not exists period_label text;

-- ---- 3. curated brand enablement -------------------------------------------
create table if not exists public.halo_brands (
  brand_id   uuid primary key references public.brands(id) on delete cascade,
  enabled_by uuid references public.profiles(id) on delete set null,
  enabled_at timestamptz not null default now()
);
alter table public.halo_brands enable row level security;
drop policy if exists halo_brands_all on public.halo_brands;
create policy halo_brands_all on public.halo_brands for all
  using (public.is_halo_viewer(auth.uid()))
  with check (public.is_halo_viewer(auth.uid()));

-- ---- 4. multi-brand scope on shares (mirrors client_access.brand_ids) -------
alter table public.halo_shares
  add column if not exists brand_ids uuid[] not null default '{}';
create index if not exists halo_shares_brands_idx
  on public.halo_shares using gin(brand_ids);

-- ---- 5. new atomic create RPC: brand + granularity, REPLACE semantics -------
-- Drops the live 11-arg version (mig 266) and replaces it with an 8-arg,
-- brand/granularity-scoped upsert. Each sheet is single-granularity, so the
-- weekly/monthly/metric_gran params are gone.
drop function if exists public.halo_create_dataset(
  text, text, date, date, jsonb, boolean, text, jsonb, jsonb, jsonb, jsonb);

create or replace function public.halo_create_dataset(
  p_brand_id     uuid,
  p_granularity  text,
  p_name         text,
  p_filename     text,
  p_period_start date,
  p_period_end   date,
  p_rows         jsonb,
  p_currency     text default '$'
) returns public.halo_datasets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_ds    public.halo_datasets;
  v_count int;
begin
  if not public.is_halo_viewer(v_uid) then
    raise exception 'not authorised — Boss/OL only';
  end if;
  if p_brand_id is null then
    raise exception 'brand is required';
  end if;
  if p_granularity is null or p_granularity not in ('day','week','month') then
    raise exception 'granularity must be day, week or month';
  end if;

  -- REPLACE any existing dataset for this (brand, granularity); rows cascade.
  delete from public.halo_datasets
   where brand_id = p_brand_id and granularity = p_granularity;

  insert into public.halo_datasets (
    name, source_filename, period_start, period_end, has_dummy, created_by,
    row_count, currency, brand_id, granularity
  ) values (
    coalesce(nullif(trim(p_name), ''), 'Untitled dataset'),
    p_filename, p_period_start, p_period_end, false, v_uid, 0,
    coalesce(nullif(p_currency, ''), '$'), p_brand_id, p_granularity
  ) returning * into v_ds;

  insert into public.halo_rows (
    dataset_id, date, period_label, metrics, dummy_fields,
    product_revenue, keywords, keyword_ranks
  )
  select v_ds.id,
         (e ->> 'date')::date,
         nullif(e ->> 'period_label', ''),
         coalesce(e -> 'metrics', '{}'::jsonb),
         '{}'::text[],
         coalesce(e -> 'product_revenue', '{}'::jsonb),
         coalesce(e -> 'keywords', '{}'::jsonb),
         coalesce(e -> 'keyword_ranks', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  where nullif(e ->> 'date', '') is not null
  on conflict (dataset_id, date) do update
    set period_label   = excluded.period_label,
        metrics        = excluded.metrics,
        product_revenue = excluded.product_revenue,
        keywords       = excluded.keywords,
        keyword_ranks  = excluded.keyword_ranks;

  select count(*)::int into v_count from public.halo_rows where dataset_id = v_ds.id;
  update public.halo_datasets set row_count = v_count where id = v_ds.id returning * into v_ds;

  return v_ds;
end;
$$;
grant execute on function
  public.halo_create_dataset(uuid, text, text, text, date, date, jsonb, text)
  to authenticated;

-- ---- 6. brand-scoped anon share: dataset list ------------------------------
-- Returns the share's brands + all datasets for those brands (grouped by brand
-- client-side). Each dataset carries its brand_id + granularity so the portal
-- can offer a brand dropdown and a per-brand granularity toggle.
create or replace function public.get_shared_halo(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.halo_shares%rowtype;
  v_brands   jsonb;
  v_datasets jsonb;
begin
  select * into v_share from public.halo_shares where token = p_token;
  if not found                      then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if v_share.revoked_at is not null then raise exception 'share_revoked'   using errcode = 'P0003'; end if;
  if v_share.expires_at is not null and v_share.expires_at < now()
                                    then raise exception 'share_expired'   using errcode = 'P0004'; end if;

  select coalesce(jsonb_agg(
           jsonb_build_object('id', b.id, 'brand_name', b.brand_name, 'logo_url', b.logo_url)
           order by b.brand_name
         ), '[]'::jsonb)
    into v_brands
  from public.brands b
  where b.id = any(v_share.brand_ids);

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',              d.id,
             'brand_id',        d.brand_id,
             'granularity',     d.granularity,
             'name',            d.name,
             'source_filename', d.source_filename,
             'period_start',    d.period_start,
             'period_end',      d.period_end,
             'row_count',       d.row_count,
             'currency',        coalesce(d.currency, '$'),
             'created_at',      d.created_at
           ) order by d.created_at desc
         ), '[]'::jsonb)
    into v_datasets
  from public.halo_datasets d
  where d.brand_id = any(v_share.brand_ids);

  begin
    update public.halo_shares set view_count = view_count + 1 where token = p_token;
  exception when others then null;
  end;

  return jsonb_build_object(
    'label',      v_share.label,
    'brands',     v_brands,
    'datasets',   v_datasets,
    'shared_at',  v_share.created_at,
    'expires_at', v_share.expires_at
  );
end;
$$;
grant execute on function public.get_shared_halo(text) to anon, authenticated;

-- ---- 7. brand-scoped anon share: one dataset's rows ------------------------
-- Guards that the requested dataset belongs to a brand within the share scope.
create or replace function public.get_shared_halo_rows(p_token text, p_dataset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.halo_shares%rowtype;
  v_brand uuid;
  v_rows  jsonb;
begin
  select * into v_share from public.halo_shares where token = p_token;
  if not found                      then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if v_share.revoked_at is not null then raise exception 'share_revoked'   using errcode = 'P0003'; end if;
  if v_share.expires_at is not null and v_share.expires_at < now()
                                    then raise exception 'share_expired'   using errcode = 'P0004'; end if;

  select brand_id into v_brand from public.halo_datasets where id = p_dataset_id;
  if v_brand is null or not (v_brand = any(v_share.brand_ids)) then
    raise exception 'dataset_out_of_scope' using errcode = 'P0005';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'date',            r.date,
             'period_label',    r.period_label,
             'metrics',         coalesce(r.metrics, '{}'::jsonb),
             'product_revenue', coalesce(r.product_revenue, '{}'::jsonb),
             'keywords',        coalesce(r.keywords, '{}'::jsonb),
             'keyword_ranks',   coalesce(r.keyword_ranks, '{}'::jsonb)
           ) order by r.date asc
         ), '[]'::jsonb)
    into v_rows
  from public.halo_rows r
  where r.dataset_id = p_dataset_id;

  return v_rows;
end;
$$;
grant execute on function public.get_shared_halo_rows(text, uuid) to anon, authenticated;
