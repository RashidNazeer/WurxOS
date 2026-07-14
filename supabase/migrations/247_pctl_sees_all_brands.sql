-- ============================================================
-- WurxOS v2 — Migration 247: PCTLs see every brand
--
-- The Boss's ruling: "for pctl, they should be able to see all brands and can
-- assign tasks to anyone including OL and TL."
--
-- Today a PCTL sees a brand ONLY if it appears in pctl_brand_selections — and
-- that table is EMPTY (0 rows in prod). So both PCTLs (Muhammad Asad Aman, Test
-- PCTL) currently see ZERO brands anywhere: the Reporting brand picker, the task
-- Create-Task brand picker, everything. Silent, no error — just an empty list.
--
-- can_view_brand is the real gate (the frontend list is cosmetic; loosening only
-- that would leave them staring at rows RLS then refuses to return). So the PCTL
-- role joins the elevated branch alongside 'ol'.
--
-- BLAST RADIUS — stated plainly, because this is a privilege elevation and the
-- `developer` role is currently being demoted for exactly this kind of sprawl.
-- can_view_brand gates SELECT on: brands, brand_assignments, brand_custom_fields,
-- bi_weekly_anchors, agenda_tasks, agenda_resources, agenda_settings. A PCTL
-- therefore gains org-wide READ across those, i.e. the same brand visibility an
-- OL already has. It grants NO new write rights, and does NOT touch
-- can_edit_brand or can_view_report.
--
-- Tasks need no DB change: can_create_tasks (mig 022) already returns true for
-- 'pctl', and the tasks_insert policy never restricted WHO the assignee may be.
-- Limiting a PCTL to "IPCs who report to me" was purely a frontend list.
--
-- Based verbatim on mig 212's definition, adding only `or p.role = 'pctl'`.
-- Idempotent. Reversible: drop the pctl clause.
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
    );
$$;
