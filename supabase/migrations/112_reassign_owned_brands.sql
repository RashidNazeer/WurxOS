-- ============================================================
-- 112 — RPC: reassign all brands owned by a deleted user.
--
-- The brands_block_owner_change trigger (migration 025) prevents
-- direct owner_id updates by non-Boss / service-role callers.
-- The delete-user Edge Function needs to move a soft-deleted
-- user's brands to the calling Boss in one shot.
--
-- This RPC bypasses the guard inside its own transaction and
-- performs the reassignment. Service-role only.
-- ============================================================

create or replace function public.reassign_owned_brands(
  p_from_user uuid,
  p_to_user   uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'reassign_owned_brands can only be called by the service role'
      using errcode = '42501';
  end if;
  if p_from_user is null or p_to_user is null then
    raise exception 'both p_from_user and p_to_user are required';
  end if;

  -- Bypass the owner-change guard for this transaction.
  perform set_config('wurxos.bypass_owner_guard', 'on', true);

  update public.brands
     set owner_id = p_to_user, updated_at = now()
   where owner_id = p_from_user;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.reassign_owned_brands(uuid, uuid) from public;
grant execute on function public.reassign_owned_brands(uuid, uuid) to service_role;
