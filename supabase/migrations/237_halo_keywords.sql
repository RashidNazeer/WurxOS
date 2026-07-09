-- ============================================================
-- WurxOS v2 — Migration 237: Amazon Halo — per-keyword search volume
--
-- Keyword Search Volume becomes per-keyword. Each halo_rows day now
-- carries an optional `keywords` map: { "keyword text": dailyVolume }.
-- The explorer's keyword picker resolves keyword_search_volume to the
-- chosen keyword's daily number; "All keywords" keeps the aggregate
-- stored in metrics.keyword_search_volume (unchanged).
--
-- Backward-compatible: the column defaults to '{}' and every RPC
-- coalesces a missing `keywords` to '{}', so old datasets and rows
-- keep working exactly as before.
--
-- Safe to re-run (idempotent column add + create-or-replace RPCs).
-- ============================================================

-- 1. Per-row keyword breakdown column.
alter table public.halo_rows
  add column if not exists keywords jsonb not null default '{}'::jsonb;

-- --------------------------------------------------------------
-- 2. Recreate the atomic upload RPC so each p_rows element may include
--    a `keywords` object which is persisted into the new column.
--    (Signature unchanged; only the row insert gains the keywords col.)
-- --------------------------------------------------------------
create or replace function public.halo_create_dataset(
  p_name         text,
  p_filename     text,
  p_period_start date,
  p_period_end   date,
  p_rows         jsonb,
  p_has_dummy    boolean default false
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
    name, source_filename, period_start, period_end, has_dummy, created_by, row_count
  ) values (
    coalesce(nullif(trim(p_name), ''), 'Untitled dataset'),
    p_filename, p_period_start, p_period_end, coalesce(p_has_dummy, false), v_uid, 0
  ) returning * into v_ds;

  insert into public.halo_rows (dataset_id, date, metrics, dummy_fields, keywords)
  select v_ds.id,
         (e ->> 'date')::date,
         coalesce(e -> 'metrics', '{}'::jsonb),
         coalesce(
           (select array_agg(x) from jsonb_array_elements_text(e -> 'dummy_fields') x),
           '{}'::text[]
         ),
         coalesce(e -> 'keywords', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  where nullif(e ->> 'date', '') is not null
  on conflict (dataset_id, date) do update
    set metrics = excluded.metrics,
        dummy_fields = excluded.dummy_fields,
        keywords = excluded.keywords;

  select count(*)::int into v_count from public.halo_rows where dataset_id = v_ds.id;
  update public.halo_datasets set row_count = v_count where id = v_ds.id returning * into v_ds;

  return v_ds;
end;
$$;
grant execute on function public.halo_create_dataset(text, text, date, date, jsonb, boolean) to authenticated;

-- --------------------------------------------------------------
-- 3. Recreate the public share rows RPC (from migration 236) so each
--    returned row object ALSO carries `keywords` (coalesced to '{}'),
--    keeping the anon share view in sync with getHaloRows().
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
             'date',         r.date,
             'metrics',      coalesce(r.metrics, '{}'::jsonb),
             'dummy_fields', coalesce(to_jsonb(r.dummy_fields), '[]'::jsonb),
             'keywords',     coalesce(r.keywords, '{}'::jsonb)
           ) order by r.date asc
         ), '[]'::jsonb)
    into v_rows
  from public.halo_rows r
  where r.dataset_id = p_dataset_id;

  return v_rows;
end;
$$;

grant execute on function public.get_shared_halo_rows(text, uuid) to anon, authenticated;
