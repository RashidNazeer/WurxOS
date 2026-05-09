-- ============================================================
-- Migration 131 — Sync bypass for the inactive-brand write block
--
-- Migration 115 added a BEFORE INSERT trigger that blocks writes
-- on inactive brands unless the caller is boss/ol/developer.
-- The Firestore→Supabase sync runs as service_role (no auth.uid()),
-- so it can't pass the role check and gets blocked when re-importing
-- rows on a brand that has since been deactivated.
--
-- Fix: let service_role through the gate. service_role is only used
-- by the sync (and other server-only admin paths); never by client
-- requests. RLS still applies, and the trigger still blocks every
-- normal user who tries to write on an inactive brand.
-- ============================================================

create or replace function public._brand_write_block_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if new.brand_id is null then return new; end if;

  -- service_role is the v1→v2 sync (or other admin tooling). Always
  -- allowed: those imports legitimately recreate rows on inactive
  -- brands during ongoing sync.
  if pg_has_role(current_user, 'service_role', 'member') then
    return new;
  end if;

  select status into v_status from public.brands where id = new.brand_id;
  if v_status is null then return new; end if;
  if v_status = 'active' then return new; end if;

  -- Boss / OL / Developer can still insert if they need to.
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active = true
      and p.role in ('boss','ol','developer')
  ) then return new; end if;

  raise exception 'Brand is inactive — new % records cannot be created on this brand. Reactivate the brand first.',
    tg_table_name
    using errcode = 'P0008';
end;
$$;
