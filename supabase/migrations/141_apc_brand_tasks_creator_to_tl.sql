-- ============================================================
-- Migration 141 — Rewrite "APC created AND self-assigned" brand
-- tasks so the creator is the APC's TL.
--
-- User asked (2026-05-08): for any brand-scoped task an APC
-- created and assigned to themselves, change:
--     created_by → that APC's Team Lead (profiles.reports_to)
--     assignee_id stays the APC
-- so the displayed "assigned by → assigned to" shows TL → APC.
-- The APC keeps doing the work; the TL is the upstream owner.
--
-- Side benefit: tasks_notify_on_update (mig 050) already notifies
-- `created_by` when status changes, so any time the APC marks a
-- task done, the TL automatically gets a `task.status_changed`
-- notification — assuming the row's `notify` column is true. We
-- set notify=true on the rewritten rows so the next status flip
-- pings the TL.
--
-- Targets:
--   * brand_id IS NOT NULL          (brand-scoped only)
--   * assignee_id = created_by      (APC self-assigned)
--   * assignee role IN ('apc','ipc')
--   * assignee.reports_to IS NOT NULL  (else we'd null the creator)
-- ============================================================

do $$
declare
  v_count int;
begin
  with apcs as (
    select id, reports_to
      from public.profiles
     where role in ('apc','ipc')
       and reports_to is not null
  )
  update public.tasks t
     set created_by = a.reports_to,
         notify     = true                -- enable TL notifications on next status change
    from apcs a
   where t.brand_id is not null
     and t.assignee_id = a.id
     and t.created_by = a.id;
  get diagnostics v_count = row_count;
  raise notice 'Rewrote % brand tasks: created_by APC -> TL', v_count;
end;
$$;
