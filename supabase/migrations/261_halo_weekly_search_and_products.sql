-- ============================================================
-- WurxOS v2 — Migration 261: Amazon Halo — weekly search demand + per-product
-- revenue + currency (2026-07 sheet format change).
--
-- The source sheet changed:
--   * NTB and Keyword Search RANK columns were removed.
--   * Amazon Revenue is now split into per-PRODUCT columns + a "Total
--     Revenue/Day". We keep the per-product split alongside the daily total.
--   * Keyword Search Volume moved to a WEEKLY subsheet (Week Ending = Saturday,
--     one column per product's branded search volume). It is weekly-native — we
--     store it at the DATASET level, not per day, and the explorer correlates it
--     week-over-week.
--   * Sheets can be in £ (this brand) — store the detected currency symbol.
--
-- Adds:
--   * halo_datasets.weekly_keywords jsonb  [{week_ending, keywords:{name:vol}}]
--   * halo_datasets.currency text          display symbol ($/£/€)
--   * halo_rows.product_revenue jsonb       {productName: dailyRevenue}
--   * recreates halo_create_dataset (persists the above) + the two anon share
--     RPCs (return the above).
--
-- Additive + idempotent. Old keywords/keyword_ranks columns are left in place
-- (unused by the new explorer, harmless for any legacy rows).
-- ============================================================

alter table public.halo_datasets
  add column if not exists weekly_keywords jsonb not null default '[]'::jsonb;
alter table public.halo_datasets
  add column if not exists currency text not null default '$';

alter table public.halo_rows
  add column if not exists product_revenue jsonb not null default '{}'::jsonb;

-- --------------------------------------------------------------
-- Atomic upload RPC — now also persists per-dataset currency +
-- weekly_keywords and per-row product_revenue. Replaces the 6-arg version.
-- --------------------------------------------------------------
drop function if exists public.halo_create_dataset(text, text, date, date, jsonb, boolean);

create or replace function public.halo_create_dataset(
  p_name            text,
  p_filename        text,
  p_period_start    date,
  p_period_end      date,
  p_rows            jsonb,
  p_has_dummy       boolean default false,
  p_currency        text    default '$',
  p_weekly_keywords jsonb   default '[]'::jsonb
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
  if not public.is_boss(v_uid) then
    raise exception 'not authorised — Boss only';
  end if;

  insert into public.halo_datasets (
    name, source_filename, period_start, period_end, has_dummy, created_by,
    row_count, currency, weekly_keywords
  ) values (
    coalesce(nullif(trim(p_name), ''), 'Untitled dataset'),
    p_filename, p_period_start, p_period_end, coalesce(p_has_dummy, false), v_uid, 0,
    coalesce(nullif(p_currency, ''), '$'),
    coalesce(p_weekly_keywords, '[]'::jsonb)
  ) returning * into v_ds;

  insert into public.halo_rows (dataset_id, date, metrics, dummy_fields, product_revenue)
  select v_ds.id,
         (e ->> 'date')::date,
         coalesce(e -> 'metrics', '{}'::jsonb),
         coalesce(
           (select array_agg(x) from jsonb_array_elements_text(e -> 'dummy_fields') x),
           '{}'::text[]
         ),
         coalesce(e -> 'product_revenue', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  where nullif(e ->> 'date', '') is not null
  on conflict (dataset_id, date) do update
    set metrics = excluded.metrics,
        dummy_fields = excluded.dummy_fields,
        product_revenue = excluded.product_revenue;

  select count(*)::int into v_count from public.halo_rows where dataset_id = v_ds.id;
  update public.halo_datasets set row_count = v_count where id = v_ds.id returning * into v_ds;

  return v_ds;
end;
$$;
grant execute on function public.halo_create_dataset(text, text, date, date, jsonb, boolean, text, jsonb) to authenticated;

-- --------------------------------------------------------------
-- Anon share: dataset list now carries currency + weekly_keywords.
-- --------------------------------------------------------------
create or replace function public.get_shared_halo(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.halo_shares%rowtype;
  v_datasets jsonb;
begin
  select * into v_share from public.halo_shares where token = p_token;
  if not found                      then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if v_share.revoked_at is not null then raise exception 'share_revoked'   using errcode = 'P0003'; end if;
  if v_share.expires_at is not null and v_share.expires_at < now()
                                    then raise exception 'share_expired'   using errcode = 'P0004'; end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',              d.id,
             'name',            d.name,
             'source_filename', d.source_filename,
             'period_start',    d.period_start,
             'period_end',      d.period_end,
             'row_count',       d.row_count,
             'has_dummy',       d.has_dummy,
             'currency',        coalesce(d.currency, '$'),
             'weekly_keywords', coalesce(d.weekly_keywords, '[]'::jsonb),
             'created_at',      d.created_at
           ) order by d.created_at desc
         ), '[]'::jsonb)
    into v_datasets
  from public.halo_datasets d;

  begin
    update public.halo_shares set view_count = view_count + 1 where token = p_token;
  exception when others then null;
  end;

  return jsonb_build_object(
    'label',      v_share.label,
    'datasets',   v_datasets,
    'shared_at',  v_share.created_at,
    'expires_at', v_share.expires_at
  );
end;
$$;
grant execute on function public.get_shared_halo(text) to anon, authenticated;

-- --------------------------------------------------------------
-- Anon share: each day row now carries product_revenue.
-- --------------------------------------------------------------
create or replace function public.get_shared_halo_rows(p_token text, p_dataset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.halo_shares%rowtype;
  v_rows  jsonb;
begin
  select * into v_share from public.halo_shares where token = p_token;
  if not found                      then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if v_share.revoked_at is not null then raise exception 'share_revoked'   using errcode = 'P0003'; end if;
  if v_share.expires_at is not null and v_share.expires_at < now()
                                    then raise exception 'share_expired'   using errcode = 'P0004'; end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'date',            r.date,
             'metrics',         coalesce(r.metrics, '{}'::jsonb),
             'dummy_fields',    coalesce(to_jsonb(r.dummy_fields), '[]'::jsonb),
             'product_revenue', coalesce(r.product_revenue, '{}'::jsonb)
           ) order by r.date asc
         ), '[]'::jsonb)
    into v_rows
  from public.halo_rows r
  where r.dataset_id = p_dataset_id;

  return v_rows;
end;
$$;
grant execute on function public.get_shared_halo_rows(text, uuid) to anon, authenticated;
