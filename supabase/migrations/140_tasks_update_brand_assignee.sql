-- ============================================================
-- Migration 140 — Brand co-coordinators can update brand tasks
--
-- User clarification (2026-05-08): "all tasks that belong to brand
-- should go to the new apc … any current apc/coordinator of the
-- brand should be able to update its tasks." Personal/general tasks
-- (brand_id IS NULL) stay strictly creator+assignee-only.
--
-- Existing tasks_update (mig 006) allowed update only by assignee
-- / creator / boss-tier / brand owner. So if Saim (Biostime APC)
-- assigned a task to himself, and later Ahmad Raza is also added
-- as a Biostime APC, Ahmad could VIEW the task (can_view_task
-- includes can_view_brand) but couldn't UPDATE it.
--
-- Fix: extend tasks_update to also allow any user who is currently
-- in brand_assignments for the task's brand. SELECT/INSERT/DELETE
-- policies unchanged. Personal tasks (brand_id IS NULL) are NOT
-- affected — the new branch checks `brand_id IS NOT NULL`.
-- ============================================================

-- One-shot data fix: where a brand-scoped task has an assignee who is
-- INACTIVE / soft-deleted, AND the brand has at least one active APC,
-- reassign to that APC. Notify=false so the trigger doesn't spam.
update public.tasks t
   set assignee_id = (
         select ba.user_id
           from public.brand_assignments ba
           join public.profiles ap on ap.id = ba.user_id
          where ba.brand_id = t.brand_id
            and ap.role in ('apc','ipc')
            and ap.is_active = true
            and ap.deleted_at is null
          order by ap.display_name
          limit 1
       ),
       notify = false
  from public.profiles assignee
 where t.brand_id is not null
   and t.assignee_id = assignee.id
   and (assignee.is_active = false or assignee.deleted_at is not null)
   and t.status <> 'done'
   and exists (
     select 1 from public.brand_assignments ba2
     join public.profiles ap2 on ap2.id = ba2.user_id
     where ba2.brand_id = t.brand_id
       and ap2.role in ('apc','ipc')
       and ap2.is_active = true
       and ap2.deleted_at is null
   );

drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update"
  on public.tasks for update
  using (
    auth.uid() = assignee_id
    or auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
        select 1 from public.brands b
        where b.id = brand_id and b.owner_id = auth.uid()
    ))
    -- NEW: any current brand assignee (APC/IPC of the brand)
    or (brand_id is not null and exists (
        select 1 from public.brand_assignments ba
        where ba.brand_id = tasks.brand_id and ba.user_id = auth.uid()
    ))
  )
  with check (
    auth.uid() = assignee_id
    or auth.uid() = created_by
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or (brand_id is not null and exists (
        select 1 from public.brands b
        where b.id = brand_id and b.owner_id = auth.uid()
    ))
    or (brand_id is not null and exists (
        select 1 from public.brand_assignments ba
        where ba.brand_id = tasks.brand_id and ba.user_id = auth.uid()
    ))
  );
