-- ============================================================
-- WurxOS v2 — Migration 195: brand-assigned APC/IPC/PCTL can
-- update campaigns they're working on
--
-- The cmp_update policy (mig 071) allowed only:
--   - added_by user
--   - Boss
--   - OL / Developer
--   - brand owner (TL/PCTL on profiles.role-via-brand)
--
-- But cmp_select lets brand-assigned APCs/IPCs/PCTLs READ a
-- campaign — they can open the Edit modal but Save fails with
-- a 406 because the UPDATE rejects them. Symptom reported
-- 2026-06-04: editing a Dr. Harvey's campaign (added_by = NULL
-- because imported from v1, no creator to fall back on).
--
-- This migration adds an "assigned-to-brand or owner-of-brand"
-- clause so anyone who can SEE the campaign as part of their
-- brand work can also UPDATE it. The same brand-team semantics
-- already used by cmp_select.
--
-- DELETE is left stricter on purpose — destructive action stays
-- with admin / owner / creator only.
-- ============================================================

drop policy if exists "cmp_update" on public.campaigns;
create policy "cmp_update" on public.campaigns for update
  using (
    added_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('ol','developer')
        and p.is_active = true
    )
    or exists (
      select 1 from public.brands b
      where b.id = campaigns.brand_id and b.owner_id = auth.uid()
    )
    -- NEW: APC/IPC/PCTL on the brand-team can edit campaigns
    -- for brands they're assigned to (or that they own).
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('apc','ipc','pctl','tl')
        and (
          exists (select 1 from public.brands b where b.id = campaigns.brand_id and b.owner_id = auth.uid())
          or exists (select 1 from public.brand_assignments ba where ba.brand_id = campaigns.brand_id and ba.user_id = auth.uid())
        )
    )
  )
  with check (
    added_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('ol','developer')
        and p.is_active = true
    )
    or exists (
      select 1 from public.brands b
      where b.id = campaigns.brand_id and b.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('apc','ipc','pctl','tl')
        and (
          exists (select 1 from public.brands b where b.id = campaigns.brand_id and b.owner_id = auth.uid())
          or exists (select 1 from public.brand_assignments ba where ba.brand_id = campaigns.brand_id and ba.user_id = auth.uid())
        )
    )
  );
