-- ============================================================
-- WurxOS v2 — Migration 142: rewrite cross-APC brand tasks creator → TL
--
-- Background: migration 141 fixed brand tasks where an APC was
-- creator AND assignee (self-assigned). It missed the case where
-- one APC created a brand task and assigned it to another APC.
-- The product rule: APCs can't assign to other APCs — assignment
-- to APCs comes from their TL. So we rewrite created_by to that
-- APC's TL (assignee.reports_to) and turn on `notify`.
--
-- Personal tasks (brand_id IS NULL) are NOT touched.
-- Tasks already created by the assignee's TL are no-ops.
-- Tasks where assignee.reports_to is NULL fall back to no-op.
--
-- Safe to re-run.
-- ============================================================

update public.tasks t
   set created_by = a.reports_to,
       notify     = true
  from public.profiles a
 where t.brand_id is not null
   and t.assignee_id = a.id
   and a.role = 'apc'
   and a.reports_to is not null
   and t.assignee_id <> t.created_by                   -- different people
   and exists (
        select 1
          from public.profiles c
         where c.id = t.created_by
           and c.role = 'apc'                          -- creator is also an APC
   )
   and t.created_by <> a.reports_to;                   -- not already TL
