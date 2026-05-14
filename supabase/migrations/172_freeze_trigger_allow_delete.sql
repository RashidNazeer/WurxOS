-- ============================================================
-- WurxOS v2 — Migration 172: relax the brand-inactive freeze
-- trigger to allow DELETE so cascades work.
--
-- Problem (reported 2026-05-14): user reports that when Muhammad
-- Arslan (OL) deletes a brand, the brand goes but the tasks on
-- that brand may persist — and indeed, the mig 171 BEFORE DELETE
-- trigger raises "Cannot delete task — its brand is inactive" for
-- every cascade DELETE that fires when the brand row is removed.
-- Within the same transaction the brand row is still visible as
-- 'inactive' to the trigger's SELECT, so the cascade rolls back.
--
-- New behaviour:
--   * INSERT block — kept. No new tasks can be added to an inactive
--     brand (mig 171's design intent).
--   * UPDATE block — kept. Frozen tasks can't have their status,
--     title, etc. changed by anyone (incl. realtime-cached UIs).
--   * DELETE block — REMOVED. The UI already hides the delete
--     button on frozen tasks (TaskRow + TaskKanban), and the bulk
--     action filters out frozen rows before sending. So the only
--     remaining DELETE paths are:
--       - FK cascade from brands DELETE → we want this to work
--       - Admin / service-role cleanup → we want this to work
--     Both are now allowed.
--
-- Resources behave correctly already (no freeze trigger on
-- resources, ON DELETE CASCADE on resources.brand_id), so they
-- cascade out cleanly. No resource trigger to touch.
--
-- Idempotent (CREATE OR REPLACE).
-- ============================================================

create or replace function public._tasks_freeze_on_inactive_brand()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_status text;
  v_bypass       text;
begin
  begin
    v_bypass := current_setting('wurxos.bypass_owner_guard', true);
  exception when others then
    v_bypass := null;
  end;
  if coalesce(v_bypass, '') = 'on' then
    return coalesce(new, old);
  end if;

  -- DELETE — always allowed. The brand-delete cascade (ON DELETE
  -- CASCADE on tasks.brand_id) and admin cleanup both pass through.
  -- UI hides the delete button on frozen tasks, so accidental user
  -- deletes are still prevented at the surface level.
  if tg_op = 'DELETE' then
    return old;
  end if;

  -- UPDATE — block ALL writes when the task's CURRENT brand is
  -- inactive. Also block moving a task ONTO an inactive brand.
  if tg_op = 'UPDATE' then
    if old.brand_id is not null then
      select status into v_brand_status from public.brands where id = old.brand_id;
      if v_brand_status = 'inactive' then
        raise exception 'Cannot modify task — its brand is inactive. Reactivate the brand to edit its tasks.'
          using errcode = 'P0001';
      end if;
    end if;
    if new.brand_id is not null and new.brand_id is distinct from old.brand_id then
      select status into v_brand_status from public.brands where id = new.brand_id;
      if v_brand_status = 'inactive' then
        raise exception 'Cannot move task to an inactive brand.'
          using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;

  -- INSERT — block creating new tasks for an inactive brand.
  if new.brand_id is null then return new; end if;
  select status into v_brand_status from public.brands where id = new.brand_id;
  if v_brand_status = 'inactive' then
    raise exception 'Cannot create task for an inactive brand. Reactivate the brand first.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
