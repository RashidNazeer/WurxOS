-- ============================================================
-- WurxOS v2 — Migration 191: extend brand-owner cascade to keep
-- tasks.created_by in sync for self-assigned APC brand tasks.
--
-- Background: mig 141 (2026-05-08) bulk-rewrote
-- public.tasks.created_by for APC self-assigned brand tasks to point
-- at the APC's TL of the moment, so the "Notify TL" UI label could
-- read the cached snapshot directly. Mig 150 added a server-side
-- re-route so the actual notification email/push always reaches the
-- assignee's CURRENT reports_to. But the UI label code in
-- CreateTaskModal.jsx and TaskDetailModal.jsx still reads the cached
-- creator name, so when an APC is moved to a new TL, the modal label
-- lies until the snapshot is refreshed.
--
-- Mig 190's cascade trigger handles profiles.reports_to but does
-- NOT touch tasks.created_by, leaving the cached label stale even
-- after the relationship updates.
--
-- This migration extends the cascade to also rewrite the matching
-- task rows when a brand's owner changes. Scoping is intentionally
-- conservative so cross-team / boss-created tasks are not affected:
--   * Only tasks where brand_id = the brand being switched
--   * Only tasks whose previous created_by was the previous owner
--     (guarantees the row was using the mig 141 snapshot, not a
--     genuine third-party creation)
--   * Only tasks whose assignee is one of the APCs the cascade
--     just moved (single-brand APCs by the same gate as mig 190)
-- ============================================================

create or replace function public.cascade_brand_owner_to_apcs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_profiles int := 0;
  v_updated_tasks    int := 0;
begin
  if old.owner_id is distinct from new.owner_id
     and new.owner_id is not null then

    -- Build the eligible-APC set: single-brand APC/IPCs assigned
    -- to THIS brand.
    create temp table if not exists tmp_eligible_apcs (user_id uuid primary key) on commit drop;
    delete from tmp_eligible_apcs;
    insert into tmp_eligible_apcs
      select ba.user_id
        from public.brand_assignments ba
        join public.profiles p on p.id = ba.user_id
       where ba.brand_id = new.id
         and p.role in ('apc', 'ipc')
         and p.is_active = true
         and p.deleted_at is null
         and (select count(*) from public.brand_assignments where user_id = ba.user_id) = 1;

    -- (1) reports_to cascade (same as mig 190).
    update public.profiles
       set reports_to = new.owner_id, updated_at = now()
     where id in (select user_id from tmp_eligible_apcs)
       and reports_to is distinct from new.owner_id;
    get diagnostics v_updated_profiles = row_count;

    -- (2) tasks.created_by cascade — NEW in mig 191. Only touches
    -- tasks where the previous created_by equals the previous brand
    -- owner, AND the assignee is in our eligible APC set. That two-
    -- condition gate keeps boss/OL-created cross-team tasks safe.
    update public.tasks
       set created_by = new.owner_id, updated_at = now()
     where brand_id = new.id
       and created_by = old.owner_id
       and assignee_id in (select user_id from tmp_eligible_apcs);
    get diagnostics v_updated_tasks = row_count;

    if v_updated_profiles > 0 or v_updated_tasks > 0 then
      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        auth.uid(), 'brand.cascade_apc_reports_to', 'brands', new.id,
        jsonb_build_object('previous_owner', old.owner_id, 'new_owner', new.owner_id),
        jsonb_build_object(
          'apcs_reassigned',  v_updated_profiles,
          'tasks_rewritten',  v_updated_tasks
        )
      );
    end if;
  end if;
  return new;
end;
$$;
