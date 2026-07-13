-- ============================================================
-- WurxOS v2 — Migration 244: open Amazon Halo to the OL role
--
-- Halo shipped Boss-only (mig 233/236/237/238). The Boss wants OLs to have
-- the same access.
--
-- The security boundary here is RLS + the SECURITY DEFINER upload RPC — NOT
-- the React route guard. Loosening only the frontend would leave an OL staring
-- at an empty page: the route would render, then every read would return zero
-- rows and the upload would raise 'not authorised — Boss only'. So every gate
-- moves together, and the frontend change is cosmetic on top of this.
--
-- Scope — full parity with Boss on this page, which is what was asked for:
--   * halo_datasets / halo_rows  — read, upload, delete
--   * halo_shares                — mint / revoke public share links
--   * halo_create_dataset()      — the atomic upload RPC
--
-- Note on halo_shares: a share link is PUBLIC (no login, read-only, all
-- datasets) though revocable. OLs can now mint them. If that should stay
-- Boss-only, revert just the four halo_shares policies below to is_boss() —
-- nothing else depends on them.
--
-- Idempotent. Reversible: swap is_halo_viewer() back to is_boss() everywhere.
-- ============================================================

-- --------------------------------------------------------------
-- 1. One helper, so the role list lives in exactly one place. Adding a role
--    to Halo later = edit this function, not 9 policies.
-- --------------------------------------------------------------
create or replace function public.is_halo_viewer(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_boss(p_uid)
      or exists (
           select 1 from public.profiles p
            where p.id = p_uid
              and p.role = 'ol'
              and p.is_active is true
              and p.deleted_at is null
         );
$$;

grant execute on function public.is_halo_viewer(uuid) to authenticated;

-- --------------------------------------------------------------
-- 2. Dataset + row RLS (was is_boss, mig 233).
-- --------------------------------------------------------------
drop policy if exists halo_ds_boss on public.halo_datasets;
create policy halo_ds_boss on public.halo_datasets for all
  using (public.is_halo_viewer(auth.uid()))
  with check (public.is_halo_viewer(auth.uid()));

drop policy if exists halo_rows_boss on public.halo_rows;
create policy halo_rows_boss on public.halo_rows for all
  using (public.is_halo_viewer(auth.uid()))
  with check (public.is_halo_viewer(auth.uid()));

-- --------------------------------------------------------------
-- 3. Share-link RLS (was is_boss, mig 236). The insert policy also stamped
--    created_by = auth.uid(); that check is preserved.
-- --------------------------------------------------------------
drop policy if exists "halo_shares_select" on public.halo_shares;
create policy "halo_shares_select" on public.halo_shares for select
  using (public.is_halo_viewer(auth.uid()));

drop policy if exists "halo_shares_insert" on public.halo_shares;
create policy "halo_shares_insert" on public.halo_shares for insert
  with check (
    public.is_halo_viewer(auth.uid())
    and created_by = auth.uid()
  );

drop policy if exists "halo_shares_update" on public.halo_shares;
create policy "halo_shares_update" on public.halo_shares for update
  using (public.is_halo_viewer(auth.uid()))
  with check (public.is_halo_viewer(auth.uid()));

drop policy if exists "halo_shares_delete" on public.halo_shares;
create policy "halo_shares_delete" on public.halo_shares for delete
  using (public.is_halo_viewer(auth.uid()));

-- --------------------------------------------------------------
-- 4. The upload RPC. Body is verbatim from mig 238 (keywords +
--    keyword_ranks); ONLY the authz guard changes.
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
  if not public.is_halo_viewer(v_uid) then
    raise exception 'not authorised — Boss/OL only';
  end if;

  insert into public.halo_datasets (
    name, source_filename, period_start, period_end, has_dummy, created_by, row_count
  ) values (
    coalesce(nullif(trim(p_name), ''), 'Untitled dataset'),
    p_filename, p_period_start, p_period_end, coalesce(p_has_dummy, false), v_uid, 0
  ) returning * into v_ds;

  insert into public.halo_rows (dataset_id, date, metrics, dummy_fields, keywords, keyword_ranks)
  select v_ds.id,
         (e ->> 'date')::date,
         coalesce(e -> 'metrics', '{}'::jsonb),
         coalesce(
           (select array_agg(x) from jsonb_array_elements_text(e -> 'dummy_fields') x),
           '{}'::text[]
         ),
         coalesce(e -> 'keywords', '{}'::jsonb),
         coalesce(e -> 'keyword_ranks', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) e
  where nullif(e ->> 'date', '') is not null
  on conflict (dataset_id, date) do update
    set metrics = excluded.metrics,
        dummy_fields = excluded.dummy_fields,
        keywords = excluded.keywords,
        keyword_ranks = excluded.keyword_ranks;

  select count(*)::int into v_count from public.halo_rows where dataset_id = v_ds.id;
  update public.halo_datasets set row_count = v_count where id = v_ds.id returning * into v_ds;

  return v_ds;
end;
$$;

grant execute on function public.halo_create_dataset(text, text, date, date, jsonb, boolean) to authenticated;
