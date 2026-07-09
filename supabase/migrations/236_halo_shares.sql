-- ============================================================
-- WurxOS v2 — Migration 236: Amazon Halo share links
--
-- Adds a Boss-only, revocable public link for the Amazon Halo
-- explorer (/halo). A logged-out client opens the link and sees a
-- read-only explorer over ALL Halo datasets — identical to what the
-- Boss sees, including the dummy "(test)" Amazon columns. No upload,
-- no delete for the client.
--
-- Adds:
--   * halo_shares table — one row per shareable link (whole-Halo, no
--     dataset_id: a link exposes every dataset).
--   * get_shared_halo(token)      RPC — anon-invokable; returns the
--     label + the full dataset list for a live token.
--   * get_shared_halo_rows(token, dataset_id) RPC — anon-invokable;
--     returns one dataset's day rows for a live token.
--
-- Mirrors migration 018 (report_shares) but Boss-only: only the Boss
-- can create / list / revoke links. The RPCs are SECURITY DEFINER and
-- enforce every access rule internally, so anon can call them safely.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. halo_shares
-- --------------------------------------------------------------
create table if not exists public.halo_shares (
  token        text primary key,
  label        text not null default '',
  created_by   uuid references public.profiles(id) on delete set null,
  expires_at   timestamptz,                 -- null = never
  revoked_at   timestamptz,                 -- null = active
  view_count   int not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists halo_shares_creator_idx on public.halo_shares(created_by);

-- --------------------------------------------------------------
-- 2. RLS — Boss-only for every operation (no OL/developer here).
--    The anon read path is the SECURITY DEFINER RPCs below.
-- --------------------------------------------------------------
alter table public.halo_shares enable row level security;

drop policy if exists "halo_shares_select" on public.halo_shares;
create policy "halo_shares_select"
  on public.halo_shares for select
  using (public.is_boss(auth.uid()));

drop policy if exists "halo_shares_insert" on public.halo_shares;
create policy "halo_shares_insert"
  on public.halo_shares for insert
  with check (
    public.is_boss(auth.uid())
    and auth.uid() = created_by
  );

drop policy if exists "halo_shares_update" on public.halo_shares;
create policy "halo_shares_update"
  on public.halo_shares for update
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

drop policy if exists "halo_shares_delete" on public.halo_shares;
create policy "halo_shares_delete"
  on public.halo_shares for delete
  using (public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- 3. Public RPC — resolve a token to the full Halo dataset list.
--    SECURITY DEFINER so it can bypass RLS; we enforce the
--    not-revoked + not-expired checks inside. A live link exposes
--    every dataset (no per-dataset scoping).
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
             'created_at',      d.created_at
           ) order by d.created_at desc
         ), '[]'::jsonb)
    into v_datasets
  from public.halo_datasets d;

  -- Bump the view counter (best-effort; don't fail the request)
  begin
    update public.halo_shares set view_count = view_count + 1 where token = p_token;
  exception when others then
    null;
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
-- 4. Public RPC — resolve a token + dataset to that dataset's rows.
--    Same live-token checks; any dataset is allowed since a link =
--    the whole Halo. Does NOT bump view_count.
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
             'dummy_fields', coalesce(to_jsonb(r.dummy_fields), '[]'::jsonb)
           ) order by r.date asc
         ), '[]'::jsonb)
    into v_rows
  from public.halo_rows r
  where r.dataset_id = p_dataset_id;

  return v_rows;
end;
$$;

grant execute on function public.get_shared_halo_rows(text, uuid) to anon, authenticated;
