-- ============================================================
-- WurxOS v2 — Migration 171: freeze tasks while brand is inactive
--
-- User intent: when a brand's status flips to 'inactive', every
-- brand-scoped task for that brand should be effectively frozen —
-- not visible in normal todo/in-progress/done buckets, not deletable,
-- not editable, and not auto-reset by the recurring-task cron.
-- When the brand returns to 'active' the tasks behave normally again.
--
-- Frozen state is derived (not stored on the task). The task keeps
-- its current status; the brand's status is what gates writes.
-- That means reactivating a brand restores everything without any
-- data migration.
--
-- This migration:
--   1. Adds a BEFORE INSERT/UPDATE/DELETE trigger on tasks that
--      raises when the row's brand is inactive. INSERTs of new
--      tasks pointing at an inactive brand are also blocked.
--   2. Admin operations that already use the `wurxos.bypass_owner_guard`
--      session config (brand_switch_apc, reassign_owned_brands, etc.)
--      are exempt from the freeze — those operations need to move
--      tasks/brands around regardless of activity status.
--   3. reset_recurring_tasks (cron job) filters out tasks whose
--      brand is inactive, so daily/weekly/monthly resets don't
--      try to flip them through the frozen-write barrier.
--
-- Idempotent.
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
  -- Admin ops set wurxos.bypass_owner_guard=on. Same flag used by
  -- brand_switch_apc and reassign_owned_brands to move tasks/brands
  -- regardless of permission gates; honour it here too.
  begin
    v_bypass := current_setting('wurxos.bypass_owner_guard', true);
  exception when others then
    v_bypass := null;
  end;
  if coalesce(v_bypass, '') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.brand_id is null then return old; end if;
    select status into v_brand_status from public.brands where id = old.brand_id;
    if v_brand_status = 'inactive' then
      raise exception 'Cannot delete task — its brand is inactive. Reactivate the brand to edit its tasks.'
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- UPDATE — block ALL writes to a task whose CURRENT brand is
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

drop trigger if exists trg_tasks_freeze_on_inactive_brand on public.tasks;
create trigger trg_tasks_freeze_on_inactive_brand
  before insert or update or delete on public.tasks
  for each row execute function public._tasks_freeze_on_inactive_brand();

-- ============================================================
-- reset_recurring_tasks: skip inactive-brand tasks
-- ============================================================
create or replace function public.reset_recurring_tasks()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tasks t
  set status = 'todo',
      next_reset_at = public.compute_next_reset(t.assignee_id, t.category),
      due_date = case
        when public.compute_next_reset(t.assignee_id, t.category) is null then t.due_date
        else (public.compute_next_reset(t.assignee_id, t.category) - interval '1 day')::date
      end,
      updated_at = now()
  where t.category in ('daily','weekly','monthly')
    and t.next_reset_at is not null
    and t.next_reset_at <= now()
    -- New: skip tasks whose brand is currently inactive. Once the
    -- brand is reactivated the task picks up its normal cadence on
    -- the next cron tick.
    and (
      t.brand_id is null
      or exists (
        select 1 from public.brands b
        where b.id = t.brand_id and b.status = 'active'
      )
    );
end;
$$;
