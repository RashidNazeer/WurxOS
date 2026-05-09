-- ============================================================
-- 111 — Sync helper: bypass-and-upsert for brand sync.
--
-- The trigger from migration 025 blocks direct brands.owner_id
-- changes unless Boss is calling. The migration script runs with
-- the service-role key (auth.uid() = NULL), so direct upserts
-- through PostgREST fail.
--
-- This RPC takes a jsonb array of brand rows, sets the bypass
-- flag at txn scope, and performs the upsert. Returns the count
-- of rows written.
--
-- Service-role-only.
-- ============================================================

create or replace function public.sync_brands_upsert(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'sync_brands_upsert can only be called by the service role'
      using errcode = '42501';
  end if;

  perform set_config('wurxos.bypass_owner_guard', 'on', true);

  insert into public.brands (
    id, legacy_id, brand_name, client_name, tier, status, gmv,
    paid_collab_status, owner_id, created_by, created_at, updated_at
  )
  select
    (r->>'id')::uuid,
    r->>'legacy_id',
    r->>'brand_name',
    r->>'client_name',
    r->>'tier',
    r->>'status',
    coalesce((r->>'gmv')::numeric, 0),
    coalesce(r->>'paid_collab_status', 'not_applicable'),
    (r->>'owner_id')::uuid,
    (r->>'created_by')::uuid,
    coalesce((r->>'created_at')::timestamptz, now()),
    coalesce((r->>'updated_at')::timestamptz, now())
  from jsonb_array_elements(p_rows) as r
  on conflict (id) do update set
    legacy_id          = excluded.legacy_id,
    brand_name         = excluded.brand_name,
    client_name        = excluded.client_name,
    tier               = excluded.tier,
    status             = excluded.status,
    gmv                = excluded.gmv,
    paid_collab_status = excluded.paid_collab_status,
    owner_id           = excluded.owner_id,
    updated_at         = excluded.updated_at;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.sync_brands_upsert(jsonb) from public;
grant execute on function public.sync_brands_upsert(jsonb) to service_role;
