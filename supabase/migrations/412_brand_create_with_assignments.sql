-- ============================================================
-- WurxOS v2 — Migration 412: create a brand and its initial
-- APC assignments in one transaction.
--
-- The Add-brand form used to insert the brand row and then insert the
-- assignments in a second request. If the second step failed, the brand
-- already existed, the form showed an error, and retrying created a
-- duplicate brand. This function performs both writes in one transaction:
-- either both land or neither does.
--
-- SECURITY INVOKER on purpose: brands_insert and brand_assignments_write
-- RLS still decide who may create a brand and assign it, exactly as before.
-- Idempotent.
-- ============================================================

create or replace function public.brand_create_with_assignments(
  p_brand_name         text,
  p_client_name        text,
  p_tier               text,
  p_gmv                numeric,
  p_owner_id           uuid,
  p_logo_url           text,
  p_status             text,
  p_paid_collab_status text,
  p_gmv_max_status     text,
  p_currency           text,
  p_euka_store_id      text,
  p_euka_slug          text,
  p_assignee_ids       uuid[]
)
returns public.brands
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_brand public.brands;
begin
  insert into public.brands (
    brand_name, client_name, tier, gmv, owner_id, logo_url, status,
    paid_collab_status, gmv_max_status, currency, euka_store_id, euka_slug, created_by
  ) values (
    p_brand_name, coalesce(p_client_name, ''), p_tier, p_gmv, p_owner_id, p_logo_url, p_status,
    p_paid_collab_status, p_gmv_max_status, coalesce(p_currency, 'USD'), p_euka_store_id, p_euka_slug, v_me
  )
  returning * into v_brand;

  insert into public.brand_assignments (brand_id, user_id, assigned_by)
  select distinct v_brand.id, a.user_id, v_me
    from unnest(coalesce(p_assignee_ids, '{}'::uuid[])) as a(user_id);

  return v_brand;
end;
$$;

revoke all on function public.brand_create_with_assignments(
  text, text, text, numeric, uuid, text, text, text, text, text, text, text, uuid[]
) from public, anon;
grant execute on function public.brand_create_with_assignments(
  text, text, text, numeric, uuid, text, text, text, text, text, text, text, uuid[]
) to authenticated;

do $verify$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'brand_create_with_assignments'
       and not p.prosecdef
  ) then
    raise exception '412: brand_create_with_assignments missing or not SECURITY INVOKER';
  end if;
end
$verify$;
