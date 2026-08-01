-- ============================================================
-- 281 — Extend Amazon Halo management to Team Leads (parity with OL).
--
-- is_halo_viewer() (mig 244) is the SINGLE gate behind every Halo RLS policy
-- and RPC — "to add someone to Halo later = edit this function, not 9 policies."
-- Adding active TLs here grants them exactly what OLs have: the /halo page,
-- dataset upload/read, client share links, and brand curation.
--
-- Reversible: drop 'tl' from the role list to revert.
-- ============================================================
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
              and p.role in ('ol', 'tl')
              and p.is_active is true
              and p.deleted_at is null
         );
$$;

grant execute on function public.is_halo_viewer(uuid) to authenticated;
