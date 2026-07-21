-- ============================================================
-- WurxOS v2 — Migration 262: restore OL upload access to Amazon Halo.
--
-- Migration 244 opened Halo to the OL role: it moved every gate (RLS on
-- halo_datasets/halo_rows/halo_shares AND the halo_create_dataset upload RPC)
-- from is_boss() to is_halo_viewer() (Boss OR active OL).
--
-- Migration 261 (the sheet-format change) recreated halo_create_dataset but
-- accidentally copied the PRE-244 Boss-only guard back in — so OLs kept full
-- read/delete/share access (those policies were untouched) yet their uploads
-- began failing with 'not authorised — Boss only'. This restores the
-- is_halo_viewer() guard on the current 8-arg signature. Guard-only change;
-- the body is identical to 261.
-- ============================================================

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
  if not public.is_halo_viewer(v_uid) then
    raise exception 'not authorised — Boss/OL only';
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
