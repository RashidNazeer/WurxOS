-- ============================================================
-- WurxOS v2 — Migration 330: client share links for Amazon Halo V2.
--
-- V1 IS NOT TOUCHED. halo_shares, get_shared_halo and get_shared_halo_rows are
-- left exactly as they are, and the /portal/halo/:token links already in
-- clients' hands keep working and keep showing V1. That constraint has held
-- since V2 was built and it holds here.
--
-- V2 gets its OWN table and its OWN tokens, so:
--   * a link is unambiguously a V1 link or a V2 link -- there is no flag to
--     misread and no way for one to silently start rendering the other model;
--   * revoking a V1 link does not revoke the V2 one for the same client, which
--     matters because the two say different things and a client may be given
--     one and not the other;
--   * V2 links can be handed out (or pulled back) while V1 links stay live
--     during the transition.
--
-- The underlying DATA is shared: both read halo_brands / halo_datasets /
-- halo_rows. Only the analysis and the token differ. So these RPCs return the
-- same JSON shape as V1's, which is what lets the portal page reuse
-- HaloV2Explorer unchanged.
--
-- Idempotent.
-- ============================================================

create table if not exists public.halo_v2_shares (
  token       text primary key,
  label       text not null default '',
  brand_ids   uuid[] not null default '{}',
  created_by  uuid references public.profiles(id) on delete set null,
  expires_at  timestamptz,                 -- null = never
  revoked_at  timestamptz,                 -- null = active
  view_count  int not null default 0,
  created_at  timestamptz not null default now()
);

comment on table public.halo_v2_shares is
  'Anonymous client links for Amazon Halo V2. Separate from halo_shares on purpose: a token belongs to exactly one model version, so a V1 link can never render V2 or vice versa.';

create index if not exists halo_v2_shares_brands_idx
  on public.halo_v2_shares using gin(brand_ids);

alter table public.halo_v2_shares enable row level security;

-- Boss-only for every operation, matching halo_shares (mig 236). The anonymous
-- read path is the SECURITY DEFINER RPCs below, never the table.
drop policy if exists halo_v2_shares_select on public.halo_v2_shares;
create policy halo_v2_shares_select on public.halo_v2_shares for select
  using (public.is_boss(auth.uid()));

drop policy if exists halo_v2_shares_insert on public.halo_v2_shares;
create policy halo_v2_shares_insert on public.halo_v2_shares for insert
  with check (public.is_boss(auth.uid()) and auth.uid() = created_by);

drop policy if exists halo_v2_shares_update on public.halo_v2_shares;
create policy halo_v2_shares_update on public.halo_v2_shares for update
  using (public.is_boss(auth.uid())) with check (public.is_boss(auth.uid()));

drop policy if exists halo_v2_shares_delete on public.halo_v2_shares;
create policy halo_v2_shares_delete on public.halo_v2_shares for delete
  using (public.is_boss(auth.uid()));

revoke all on public.halo_v2_shares from anon;
grant select, insert, update, delete on public.halo_v2_shares to authenticated;

-- ── Anonymous reads ──────────────────────────────────────────────────
-- Bodies mirror mig 267's V1 pair, reading halo_v2_shares instead. Kept as
-- separate functions rather than a shared one with a version argument: one
-- table lookup per function means a token cannot be resolved against the wrong
-- share table by a caller passing the wrong flag.
create or replace function public.get_shared_halo_v2(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.halo_v2_shares%rowtype;
  v_brands   jsonb;
  v_datasets jsonb;
begin
  select * into v_share from public.halo_v2_shares where token = p_token;
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
    update public.halo_v2_shares set view_count = view_count + 1 where token = p_token;
  exception when others then null; end;

  return jsonb_build_object(
    'label',    v_share.label,
    'brands',   v_brands,
    'datasets', v_datasets
  );
end;
$$;

create or replace function public.get_shared_halo_v2_rows(p_token text, p_dataset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.halo_v2_shares%rowtype;
  v_brand uuid;
  v_rows  jsonb;
begin
  select * into v_share from public.halo_v2_shares where token = p_token;
  if not found                      then raise exception 'share_not_found' using errcode = 'P0002'; end if;
  if v_share.revoked_at is not null then raise exception 'share_revoked'   using errcode = 'P0003'; end if;
  if v_share.expires_at is not null and v_share.expires_at < now()
                                    then raise exception 'share_expired'   using errcode = 'P0004'; end if;

  -- The dataset must belong to a brand this token covers. Without this a
  -- client could read ANY dataset id they guessed.
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

grant execute on function public.get_shared_halo_v2(text) to anon, authenticated;
grant execute on function public.get_shared_halo_v2_rows(text, uuid) to anon, authenticated;
