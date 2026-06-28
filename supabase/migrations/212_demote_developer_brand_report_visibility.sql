-- ============================================================
-- WurxOS v2 — Migration 212: demote `developer` from elevated
-- brand & report visibility.
--
-- For most of the app's history `developer` was treated as an
-- OL-tier role (org-wide read access). Per product decision
-- (2026-06) the developer role is limited to bug/suggestion triage
-- plus their own HR surfaces (attendance, leave, compensation,
-- settings). This removes `developer` from the elevated branch of
-- the two CORE read helpers, which together gate brands, reports,
-- AND the brand-analytics page:
--   • can_view_brand  (last defined in mig 192 — keep the
--     canViewAllBrands override + owner/assignment/pctl branches)
--   • can_view_report (mig 012)
--
-- Only the `developer` literal is removed; every other role's
-- visibility is byte-identical to before. RLS is evaluated live, so
-- no backfill is needed. The frontend route guards are tightened to
-- match in the same release.
--
-- SCOPE NOTE: `developer` remains elevated in OTHER policies/RPCs
-- (performance, incentives, audit-read, others' attendance/leave,
-- KB admin, broadcasts, product/campaign data, brand-switch RPCs,
-- paid collab). Those are intentionally NOT changed here — demoting
-- them is a larger, staged follow-up. Until then the frontend guards
-- keep developer out of those pages.
--
-- Idempotent (create or replace).
-- ============================================================

-- can_view_brand — drop `developer` from the elevated branch.
-- Based verbatim on migration 192's definition (the authoritative
-- latest), changing only `role in ('ol','developer')` -> `role = 'ol'`.
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
    );
$$;

-- can_view_report — drop `developer` from the elevated branch.
-- Based verbatim on migration 012, changing only
-- `role in ('ol','developer')` -> `role = 'ol'`.
create or replace function public.can_view_report(r_brand uuid, r_author uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (select 1 from public.profiles p where p.id = uid and p.role = 'ol' and p.is_active)
    or r_author = uid
    or exists (
      select 1 from public.brands b
      where b.id = r_brand and public.can_view_brand(b.owner_id, b.id, uid)
    );
$$;
