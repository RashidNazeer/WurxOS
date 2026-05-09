-- ============================================================
-- WurxOS v2 — Migration 143: tighten can_view_task for APCs
--
-- Problem: a TL self-assigned a brand task (e.g. Biostime) and
-- it was visible to all APCs of that brand. APCs only need to
-- see brand tasks that involve them or their fellow APCs.
--
-- New rule for the brand-viewer branch:
--   * Boss/OL/developer  → see everything (unchanged top branch)
--   * Direct involvement → assignee = uid OR creator = uid (unchanged)
--   * Brand-viewer (APC) → only when assignee.role = 'apc'
--                          AND assignee belongs to that brand
--                          (so we hide TL self-assigned brand tasks
--                           from APCs of that brand).
--   * Brand-viewer (TL/owner of brand) → see all brand tasks
--                                        (so TLs still see their
--                                         own self-assigned tasks).
--
-- We split the brand check: TLs get the broad view, APCs get the
-- narrowed view. Done with two EXISTS branches.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.can_view_task(b_id uuid, a_id uuid, c_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    -- Boss / OL / developer always see everything
    public.is_boss(uid)
    or exists (select 1 from public.profiles p
               where p.id = uid and p.role in ('ol','developer') and p.is_active = true)
    -- Direct involvement
    or a_id = uid
    or c_id = uid
    -- Brand task: TL who owns the brand sees all of it
    or (b_id is not null and exists (
        select 1 from public.brands b
        where b.id = b_id and b.owner_id = uid
    ))
    -- Brand task: APC / PCTL on the brand only see brand tasks
    -- whose assignee is themselves an APC or PCTL. TL self-assigned
    -- (or Boss/OL self-assigned) brand tasks are hidden by this
    -- branch — TLs/Boss/OL still see them via the branches above.
    or (b_id is not null and exists (
        select 1
          from public.profiles asg
         where asg.id = a_id
           and asg.role in ('apc','pctl')
           and (
                exists (
                  select 1 from public.brand_assignments ba
                   where ba.brand_id = b_id and ba.user_id = uid
                )
                or exists (
                  select 1 from public.pctl_brand_selections s
                   where s.brand_id = b_id and s.pctl_id = uid
                )
           )
    ));
$$;
grant execute on function public.can_view_task(uuid, uuid, uuid, uuid) to authenticated;
