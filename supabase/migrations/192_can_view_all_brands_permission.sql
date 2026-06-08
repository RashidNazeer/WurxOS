-- ============================================================
-- WurxOS v2 — Migration 192: per-user 'see all brands' override
--
-- Introduces a `canViewAllBrands` permission flag on profiles.
-- When true, the user gets the same brand-visibility as
-- Boss/OL/Developer regardless of their role. Used for special-
-- case TL/PCTL accounts that need org-wide visibility (e.g.
-- Abdul Subhan as of 2026-06-04).
--
-- The flag is checked inside `can_view_brand`. Brand EDIT
-- privileges are deliberately NOT extended by this flag — those
-- remain with Boss/OL/Developer/owner. This is view-only.
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
        and (p.role in ('ol', 'developer')
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
