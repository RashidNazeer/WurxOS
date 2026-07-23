-- ============================================================
-- WurxOS v2 — Migration 266: Amazon Halo — per-metric native granularity +
-- the richer single-sheet Amazon format (NTB + daily keyword search volume &
-- rank restored) alongside the existing per-product revenue and weekly branded
-- demand.
--
-- Each dataset now carries:
--   * metric_gran     jsonb  fieldKey -> 'day' | 'week' | 'month'  (native gran
--                            detected at parse time; a metric is comparable at
--                            its native granularity and coarser)
--   * weekly_metrics  jsonb  [{period_end, metrics, keywords, keywordRanks,
--                            productRevenue}]  — weekly-native metrics injected
--                            into the week/month buckets by the math
--   * monthly_metrics jsonb  [{period_end, metrics, ...}]  — monthly-native
--
-- halo_rows.keywords + keyword_ranks + product_revenue ALREADY EXIST (migs
-- 237/238/261) and are reused: keywords = per-day branded search VOLUME by
-- keyword, keyword_ranks = per-day search RANK by keyword, product_revenue =
-- per-day revenue by product.
--
-- Recreates halo_create_dataset (adds the 3 dataset-level params + persists
-- per-row keywords/keyword_ranks that mig 261 had dropped) and the two anon
-- share RPCs (get_shared_halo now returns metric_gran/weekly_metrics/
-- monthly_metrics; get_shared_halo_rows again returns keywords/keyword_ranks).
--
-- CRITICAL authz: the upload RPC keeps the is_halo_viewer() guard (Boss OR
-- active OL) — NOT is_boss(). Mig 261 regressed this to Boss-only; mig 262
-- fixed it. Do not reintroduce is_boss() here.
--
-- Additive + idempotent.
-- ============================================================

alter table public.halo_datasets
  add column if not exists metric_gran jsonb not null default '{}'::jsonb;
alter table public.halo_datasets
  add column if not exists weekly_metrics jsonb not null default '[]'::jsonb;
alter table public.halo_datasets
  add column if not exists monthly_metrics jsonb not null default '[]'::jsonb;

-- --------------------------------------------------------------
-- Atomic upload RPC — persists per-row metrics + product_revenue + keywords +
-- keyword_ranks, and dataset-level currency + weekly_keywords + metric_gran +
-- weekly_metrics + monthly_metrics. Replaces the 8-arg version.
-- --------------------------------------------------------------
drop function if exists public.halo_create_dataset(text, text, date, date, jsonb, boolean, text, jsonb);

create or replace function public.halo_create_dataset(
  p_name            text,
  p_filename        text,
  p_period_start    date,
  p_period_end      date,
  p_rows            jsonb,
  p_has_dummy       boolean default false,
  p_currency        text    default '$',
  p_weekly_keywords jsonb   default '[]'::jsonb,
  p_metric_gran     jsonb   default '{}'::jsonb,
  p_weekly_metrics  jsonb   default '[]'::jsonb,
  p_monthly_metrics jsonb   default '[]'::jsonb
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

  insert into public.halo_datasets (
    name, source_filename, period_start, period_end, has_dummy, created_by,
    row_count, currency, weekly_keywords, metric_gran, weekly_metrics, monthly_metrics
  ) values (
    coalesce(nullif(trim(p_name), ''), 'Untitled dataset'),
    p_filename, p_period_start, p_period_end, coalesce(p_has_dummy, false), v_uid, 0,
    coalesce(nullif(p_currency, ''), '$'),
    coalesce(p_weekly_keywords, '[]'::jsonb),
    coalesce(p_metric_gran, '{}'::jsonb),
    coalesce(p_weekly_metrics, '[]'::jsonb),
    coalesce(p_monthly_metrics, '[]'::jsonb)
  ) returning * into v_ds;

  insert into public.halo_rows (dataset_id, date, metrics, dummy_fields, product_revenue, keywords, keyword_ranks)
  select v_ds.id,
         (e ->> 'date')::date,
         coalesce(e -> 'metrics', '{}'::jsonb),
         coalesce(
           (select array_agg(x) from jsonb_array_elements_text(e -> 'dummy_fields') x),
           '{}'::text[]
         ),
         coalesce(e -> 'product_revenue', '{}'::jsonb),
         coalesce(e -> 'keywords', '{}'::jsonb),
         coalesce(e -> 'keyword_ranks', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  where nullif(e ->> 'date', '') is not null
  on conflict (dataset_id, date) do update
    set metrics = excluded.metrics,
        dummy_fields = excluded.dummy_fields,
        product_revenue = excluded.product_revenue,
        keywords = excluded.keywords,
        keyword_ranks = excluded.keyword_ranks;

  select count(*)::int into v_count from public.halo_rows where dataset_id = v_ds.id;
  update public.halo_datasets set row_count = v_count where id = v_ds.id returning * into v_ds;

  return v_ds;
end;
$$;
grant execute on function public.halo_create_dataset(text, text, date, date, jsonb, boolean, text, jsonb, jsonb, jsonb, jsonb) to authenticated;

-- --------------------------------------------------------------
-- Anon share: dataset list now carries metric_gran + weekly_metrics +
-- monthly_metrics (plus currency + weekly_keywords).
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
             'metric_gran',     coalesce(d.metric_gran, '{}'::jsonb),
             'weekly_metrics',  coalesce(d.weekly_metrics, '[]'::jsonb),
             'monthly_metrics', coalesce(d.monthly_metrics, '[]'::jsonb),
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
-- Anon share: each day row now carries product_revenue + keywords +
-- keyword_ranks (mig 261 had dropped the last two from this RPC).
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
