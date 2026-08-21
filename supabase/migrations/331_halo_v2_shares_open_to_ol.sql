-- ============================================================
-- WurxOS v2 — Migration 331: let OLs (and TLs) manage Halo V2 share links,
-- matching V1.
--
-- MY MISTAKE IN MIG 330. I mirrored halo_shares' policies from mig 236, which
-- is Boss-only and carries the comment "Boss-only for every operation (no
-- OL/developer here)". That has not been true since mig 244, which replaced
-- every one of those policies with public.is_halo_viewer(), and mig 281 then
-- widened is_halo_viewer to include TL. So V2 shipped with the ORIGINAL 2024
-- rules while V1 had been open to OLs for months, and an OL creating a link
-- got:
--     new row violates row-level security policy for table "halo_v2_shares"
--
-- The lesson worth keeping: when copying a policy, copy the CURRENT definition
-- (the last migration that touches it), not the one that created the table.
-- The oldest file is the one most likely to be stale and its comments are
-- the most likely to be wrong.
--
-- These are now character-for-character V1's policies from mig 244, with the
-- table name changed. Using the same helper rather than a copied role list
-- means V1 and V2 cannot drift apart again: widening is_halo_viewer widens
-- both, as mig 281 did.
--
-- Idempotent.
-- ============================================================

drop policy if exists halo_v2_shares_select on public.halo_v2_shares;
create policy halo_v2_shares_select on public.halo_v2_shares for select
  using (public.is_halo_viewer(auth.uid()));

drop policy if exists halo_v2_shares_insert on public.halo_v2_shares;
create policy halo_v2_shares_insert on public.halo_v2_shares for insert
  with check (
    public.is_halo_viewer(auth.uid())
    and created_by = auth.uid()
  );

drop policy if exists halo_v2_shares_update on public.halo_v2_shares;
create policy halo_v2_shares_update on public.halo_v2_shares for update
  using (public.is_halo_viewer(auth.uid()))
  with check (public.is_halo_viewer(auth.uid()));

drop policy if exists halo_v2_shares_delete on public.halo_v2_shares;
create policy halo_v2_shares_delete on public.halo_v2_shares for delete
  using (public.is_halo_viewer(auth.uid()));
