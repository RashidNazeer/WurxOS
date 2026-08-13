-- ============================================================
-- WurxOS v2 — Migration 319: Brand Switcher approval fails with
-- "DELETE requires a WHERE clause".
--
-- SYMPTOM: the Boss opens Brand Switcher → Pending, clicks Approve on a
-- request (Biostime Shop US → Ali Hamza's team), and the page shows
-- "DELETE requires a WHERE clause". The request stays pending, so the switch
-- silently never happens.
--
-- CAUSE: that message is raised by the `safeupdate` extension, which rejects
-- ANY unqualified UPDATE/DELETE — including inside a SECURITY DEFINER
-- function. The chain is:
--   approve  → UPDATE brand_switch_requests.status = 'approved'
--            → bsr trigger → brand_switch_apc()
--            → UPDATE brands.owner_id  (the switch retargets the brand's TL
--              to the new APC's manager)
--            → trigger brands_cascade_owner_to_apcs
--            → cascade_brand_owner_to_apcs() runs
--                  delete from tmp_eligible_apcs;      ← no WHERE
--   and the whole transaction aborts.
--
-- It only bites when the switch CHANGES THE BRAND'S OWNER — i.e. when the new
-- APC sits under a different TL. Moving a brand between two APCs on the same
-- team never fires the cascade, which is why this looked intermittent.
--
-- FIX: empty the scratch table with TRUNCATE instead. TRUNCATE is not an
-- UPDATE/DELETE, so the guard doesn't apply; `delete ... where true` would
-- also pass, but TRUNCATE is the honest way to say "empty this temp table".
-- The clear is NOT redundant despite `on commit drop`: when one transaction
-- changes several brands' owners the trigger fires more than once and the
-- table survives between firings, so stale rows would leak across brands.
--
-- Body is otherwise mig 191's VERBATIM — only that one statement changes.
-- Idempotent.
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
    truncate table tmp_eligible_apcs;   -- mig 319: was an unqualified DELETE
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
