-- ============================================================
-- WurxOS v2 — Migration 049: bilateral APC swap + audit fix
--
-- Two fixes:
--
--   1. audit_log.action — the original CHECK constraint only
--      accepted {insert, update, delete}, which broke any domain
--      event like 'brand.switch_apc'. We drop the constraint so
--      the action column is free-form (app-layer convention is
--      '<entity>.<verb>'). Entity/actor/timestamp still required.
--
--   2. brand_switch_apc is now a *bilateral swap*: picking new
--      APC Y for a brand currently held by APC X moves ALL of X's
--      brands to Y and vice versa. This matches the word "switch"
--      in the UI — both APCs end up with each other's book of
--      business, not just one side. Per-brand consequences still
--      apply to every affected brand: owner_id retargets to the
--      new APC's TL, open tasks reassign, and audit rows record
--      each individual brand move.
--
--      If X has no other brands, this degenerates to the old
--      single-brand move; if Y has no brands, X ends up idle (same
--      as before). If no old APC is currently assigned to the
--      picked brand, the swap still works by moving just that one
--      brand to Y.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Free-form audit action
-- --------------------------------------------------------------
alter table public.audit_log
  drop constraint if exists audit_log_action_check;

-- --------------------------------------------------------------
-- 2. brand_switch_apc — bilateral swap
-- --------------------------------------------------------------
drop function if exists public.brand_switch_apc(uuid, uuid, text, boolean);

create or replace function public.brand_switch_apc(
  p_brand   uuid,
  p_new_apc uuid,
  p_note    text    default null,
  p_notify  boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_is_mgr   bool;
  v_brand    public.brands%rowtype;
  v_new_apc  public.profiles%rowtype;
  v_new_tl   uuid;

  -- "Old primary APC" = the first assignee on the clicked brand.
  -- If the brand has no APC yet, the swap collapses to a one-way
  -- move of just this brand to the new APC.
  v_old_apc  uuid;
  v_old_tl   uuid;

  -- Brand sets that will flip owners. `x_to_y` holds brand ids
  -- currently managed by the old APC (will move to new APC).
  -- `y_to_x` holds brand ids currently managed by the new APC
  -- (will move to old APC).
  v_x_to_y uuid[];
  v_y_to_x uuid[];

  v_tasks_moved int := 0;
  v_brand_id uuid;
  v_brand_row public.brands%rowtype;
begin
  -- Authz: Boss, OL, Developer only.
  v_is_mgr := public.is_boss(v_caller)
    or exists (
      select 1 from public.profiles p
      where p.id = v_caller and p.role in ('ol','developer') and p.is_active
    );
  if not v_is_mgr then
    raise exception 'only Boss/OL can switch brand APCs';
  end if;

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  select * into v_new_apc from public.profiles
    where id = p_new_apc and is_active = true;
  if not found then raise exception 'new APC not found or inactive'; end if;
  if v_new_apc.role not in ('apc','ipc') then
    raise exception 'target user is not an APC/IPC (got %)', v_new_apc.role;
  end if;
  v_new_tl := v_new_apc.reports_to;
  if v_new_tl is null then
    raise exception 'target APC has no Team Lead (reports_to is null)';
  end if;

  -- Pick the "other side" APC from the clicked brand's current
  -- assignees. Deterministic enough: any one of them — tests and
  -- real usage only ever have one primary APC per brand anyway.
  select user_id into v_old_apc
    from public.brand_assignments
    where brand_id = p_brand
      and user_id <> p_new_apc
    order by created_at asc
    limit 1;

  -- If the picked brand has no APC yet, there's nothing on Y's
  -- side to send back — just assign this one brand to Y and exit
  -- via the same pipeline (with an empty x_to_y list other than
  -- the clicked brand).
  if v_old_apc is null then
    v_x_to_y := array[p_brand];
    v_y_to_x := '{}'::uuid[];
    v_old_tl := v_brand.owner_id;
  else
    select reports_to into v_old_tl
      from public.profiles where id = v_old_apc;

    -- Full bilateral swap: everything X manages moves to Y,
    -- everything Y manages moves to X. The clicked brand is
    -- naturally in the first set.
    select coalesce(array_agg(distinct brand_id), '{}')
      into v_x_to_y
      from public.brand_assignments
      where user_id = v_old_apc;

    select coalesce(array_agg(distinct brand_id), '{}')
      into v_y_to_x
      from public.brand_assignments
      where user_id = p_new_apc;
  end if;

  -- Apply the swap one brand at a time so owner_id and task
  -- reassignment can use the correct "new TL" per brand.
  perform set_config('wurxos.bypass_owner_guard', 'on', true);

  -- X → Y (these go to v_new_apc / v_new_tl)
  if array_length(v_x_to_y, 1) > 0 then
    foreach v_brand_id in array v_x_to_y loop
      select * into v_brand_row from public.brands where id = v_brand_id;

      update public.brands
         set owner_id = v_new_tl
       where id = v_brand_id;

      delete from public.brand_assignments
        where brand_id = v_brand_id and user_id = coalesce(v_old_apc, '00000000-0000-0000-0000-000000000000'::uuid);
      -- Also drop any other assignees so the brand ends up with just
      -- the new APC. We only track a single primary APC per brand.
      delete from public.brand_assignments where brand_id = v_brand_id;
      insert into public.brand_assignments (brand_id, user_id)
        values (v_brand_id, p_new_apc)
        on conflict do nothing;

      if v_old_apc is not null then
        with moved as (
          update public.tasks
             set assignee_id = p_new_apc
           where brand_id = v_brand_id
             and status <> 'done'
             and assignee_id = v_old_apc
           returning 1
        )
        select v_tasks_moved + count(*) into v_tasks_moved from moved;
      end if;

      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        v_caller, 'brand.switch_apc', 'brands', v_brand_id,
        jsonb_build_object('assigned_apc', v_old_apc, 'owner_id', v_brand_row.owner_id),
        jsonb_build_object(
          'assigned_apc', p_new_apc,
          'owner_id',     v_new_tl,
          'swap_side',    'x_to_y',
          'notified',     p_notify,
          'note',         p_note
        )
      );
    end loop;
  end if;

  -- Y → X (these go to v_old_apc / v_old_tl). Only runs when the
  -- picked brand had an APC to swap with.
  if array_length(v_y_to_x, 1) > 0 and v_old_apc is not null then
    foreach v_brand_id in array v_y_to_x loop
      -- Skip if we already flipped this one in the X→Y leg (can
      -- happen only if X and Y both shared a brand — rare).
      continue when v_brand_id = any (v_x_to_y);

      select * into v_brand_row from public.brands where id = v_brand_id;

      update public.brands
         set owner_id = v_old_tl
       where id = v_brand_id;

      delete from public.brand_assignments where brand_id = v_brand_id;
      insert into public.brand_assignments (brand_id, user_id)
        values (v_brand_id, v_old_apc)
        on conflict do nothing;

      with moved as (
        update public.tasks
           set assignee_id = v_old_apc
         where brand_id = v_brand_id
           and status <> 'done'
           and assignee_id = p_new_apc
         returning 1
      )
      select v_tasks_moved + count(*) into v_tasks_moved from moved;

      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        v_caller, 'brand.switch_apc', 'brands', v_brand_id,
        jsonb_build_object('assigned_apc', p_new_apc, 'owner_id', v_brand_row.owner_id),
        jsonb_build_object(
          'assigned_apc', v_old_apc,
          'owner_id',     v_old_tl,
          'swap_side',    'y_to_x',
          'notified',     p_notify,
          'note',         p_note
        )
      );
    end loop;
  end if;

  perform set_config('wurxos.bypass_owner_guard', 'off', true);

  -- Notifications — opt-in. We notify each side's new APC + new TL
  -- (if different from the caller). Only one ping per user even if
  -- they received several brands.
  if p_notify then
    declare
      v_actor_name text := public.profile_display_name(v_caller);
      v_to_y_count int := coalesce(array_length(v_x_to_y, 1), 0);
      v_to_x_count int := coalesce(array_length(v_y_to_x, 1), 0);
      v_body text;
      v_targets uuid[];
      v_target  uuid;
    begin
      -- Notify the Y side
      if v_to_y_count > 0 then
        v_body := v_actor_name || ' assigned ' || v_to_y_count || ' brand'
                  || (case when v_to_y_count = 1 then '' else 's' end)
                  || ' to you.';
        v_targets := array(
          select distinct x from unnest(array[p_new_apc, v_new_tl]) x
          where x is not null and x <> v_caller
        );
        foreach v_target in array v_targets loop
          perform public.emit_notification(
            v_target, v_caller, 'brand', 'brand.switched',
            'Brand assignments updated', v_body,
            'brand', p_brand, '/brands'
          );
        end loop;
      end if;

      -- Notify the X side (only if the swap actually moved brands back)
      if v_to_x_count > 0 and v_old_apc is not null then
        v_body := v_actor_name || ' assigned ' || v_to_x_count || ' brand'
                  || (case when v_to_x_count = 1 then '' else 's' end)
                  || ' to you.';
        v_targets := array(
          select distinct x from unnest(array[v_old_apc, v_old_tl]) x
          where x is not null and x <> v_caller
        );
        foreach v_target in array v_targets loop
          perform public.emit_notification(
            v_target, v_caller, 'brand', 'brand.switched',
            'Brand assignments updated', v_body,
            'brand', p_brand, '/brands'
          );
        end loop;
      end if;
    end;
  end if;

  return p_brand;
end;
$$;
grant execute on function public.brand_switch_apc(uuid, uuid, text, boolean) to authenticated;
