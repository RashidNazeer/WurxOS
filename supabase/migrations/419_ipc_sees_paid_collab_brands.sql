-- ============================================================
-- WurxOS v2 — Migration 419: an IPC can see any brand Boss/OL put on the
-- Paid Collab list, even without a brand_assignments row.
--
-- Root cause of "Joymode doesn't show for the IPC, other brands do":
-- can_view_brand (mig 316) gives blanket visibility to boss/ol/pctl, but an
-- ipc only sees a brand via brand_assignments (or ownership, which an ipc
-- never has). The Paid Collab feature (mig 279) was built for Boss/OL to
-- hand the TEAM a brand to fill §09 for, independent of who that brand's
-- regular APC/TL is — so an ipc on the paid_collab_brands list was never
-- meant to need an individual assignment too. Confirmed on production:
-- Joymode was correctly on paid_collab_brands (the toggle worked, realtime
-- was live) but its only brand_assignments row was an APC, no ipc — so the
-- ipc testing it could not even open the brand's checkpoint to see §09.
--
-- pctl already sees every brand (mig 247), so this only adds the ipc case.
-- Every brand on the shared list is affected equally, so this is a general
-- fix, not a Joymode-specific one.
-- ============================================================

create or replace function public.can_view_brand(b_owner uuid, b_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (
      select 1 from public.profiles p
      where p.id = uid
        and p.is_active = true
        and (p.role = 'ol'
             or p.role = 'pctl'
             or coalesce((p.permissions->>'canViewAllBrands')::boolean, false))
    )
    or b_owner = uid
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = b_id and ba.user_id = uid
    )
    or exists (
      select 1 from public.pctl_brand_selections s
      where s.brand_id = b_id and s.pctl_id = uid
    )
    or exists (
      select 1 from public.ads_manager_brands amb
      where amb.brand_id = b_id and amb.ads_manager_id = uid
    )
    or exists (
      select 1 from public.paid_collab_brands pcb
      join public.profiles p on p.id = uid
      where pcb.brand_id = b_id
        and p.is_active = true
        and p.role = 'ipc'
    );
$$;

do $verify$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'can_view_brand'
  ) then
    raise exception '419: can_view_brand missing';
  end if;
end
$verify$;
