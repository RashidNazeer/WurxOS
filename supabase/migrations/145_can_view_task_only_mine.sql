-- ============================================================
-- WurxOS v2 — Migration 145: APCs/PCTLs see ONLY their own brand
-- tasks — co-APCs on the same brand no longer see each other's
-- assignments.
--
-- Background: migration 143 narrowed the brand-viewer branch so
-- TL self-assigned tasks were hidden from APCs, but it still
-- exposed all brand tasks where the assignee was any APC. With
-- multiple APCs on a single brand (e.g. Biostime) that meant
-- Ahmad saw Ali → Saim, etc. The new rule: a brand task is
-- visible to a lower role only when they are the assignee or
-- the creator. TL/owner of the brand still sees everything.
--
-- Read rule:
--   Boss/OL/developer        → all tasks
--   TL who owns the brand    → all brand tasks for that brand
--   Anyone (APC/PCTL/etc.)   → only tasks where they are
--                              assignee_id OR created_by
--   Personal task            → only assignee/creator (unchanged)
--
-- This collapses the brand-viewer branch into the existing direct
-- involvement check — simpler, and matches the user's mental model.
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
    -- Direct involvement: assigned to or created by uid
    or a_id = uid
    or c_id = uid
    -- TL who owns the brand sees ALL tasks for that brand
    or (b_id is not null and exists (
        select 1 from public.brands b
        where b.id = b_id and b.owner_id = uid
    ));
$$;
grant execute on function public.can_view_task(uuid, uuid, uuid, uuid) to authenticated;
