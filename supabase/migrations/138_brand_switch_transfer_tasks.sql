-- ============================================================
-- Migration 138 — Brand-switch: transfer brand tasks created
-- by departing APC to receiving APC (regardless of current
-- assignee), plus one-shot data fix for already-switched brands.
--
-- Symptom (reported 2026-05-08): when a brand is switched from
-- APC A to APC B, tasks A had created for that brand remain
-- visible to B but B can't edit/update progress because
-- assignee_id is still A (RLS update policy needs assignee or
-- creator or admin).
--
-- The existing brand_switch_apc (mig 052) only reassigned tasks
-- that were `assignee_id = v_old_apc`. Tasks created by old APC
-- but assigned to someone else (TL, brand owner, no one) stayed
-- attached to the old assignee.
--
-- New rule (per user 2026-05-08): "all tasks created by old APC
-- regarding the brand (not general/personal) should be editable
-- by the new APC, and the owner should be new APC."
--
-- Fix:
--   1. Patch brand_switch_apc to ALSO transfer tasks where
--      created_by = v_old_apc AND brand_id = (the switching brand),
--      regardless of current assignee.
--   2. One-shot data fix: for every currently-assigned brand,
--      reassign any brand-scoped task created by a previous APC
--      (no longer in the brand's assignment list) to the current
--      APC if that APC is now responsible for the brand.
-- ============================================================

-- 1. Updated brand_switch_apc
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

  v_old_apc  uuid;
  v_old_tl   uuid;

  v_x_to_y uuid[];
  v_y_to_x uuid[];

  v_tasks_moved int := 0;
  v_brand_id uuid;
  v_brand_row public.brands%rowtype;
begin
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

  select user_id into v_old_apc
    from public.brand_assignments
    where brand_id = p_brand
      and user_id <> p_new_apc
    order by assigned_at asc
    limit 1;

  if v_old_apc is null then
    v_x_to_y := array[p_brand];
    v_y_to_x := '{}'::uuid[];
    v_old_tl := v_brand.owner_id;
  else
    select reports_to into v_old_tl
      from public.profiles where id = v_old_apc;

    select coalesce(array_agg(distinct brand_id), '{}')
      into v_x_to_y
      from public.brand_assignments
      where user_id = v_old_apc;

    select coalesce(array_agg(distinct brand_id), '{}')
      into v_y_to_x
      from public.brand_assignments
      where user_id = p_new_apc;
  end if;

  perform set_config('wurxos.bypass_owner_guard', 'on', true);

  -- X → Y
  if array_length(v_x_to_y, 1) > 0 then
    foreach v_brand_id in array v_x_to_y loop
      select * into v_brand_row from public.brands where id = v_brand_id;

      update public.brands
         set owner_id = v_new_tl
       where id = v_brand_id;

      delete from public.brand_assignments where brand_id = v_brand_id;
      insert into public.brand_assignments (brand_id, user_id)
        values (v_brand_id, p_new_apc)
        on conflict do nothing;

      if v_old_apc is not null then
        -- Transfer brand-scoped tasks: anything assigned to old APC
        -- OR created by old APC for this brand. Brand owner remains
        -- updateable via brand_owner clause in tasks_update RLS.
        with moved as (
          update public.tasks
             set assignee_id = p_new_apc,
                 notify      = false
           where brand_id = v_brand_id
             and status <> 'done'
             and (assignee_id = v_old_apc or created_by = v_old_apc)
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

  -- Y → X
  if array_length(v_y_to_x, 1) > 0 and v_old_apc is not null then
    foreach v_brand_id in array v_y_to_x loop
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
           set assignee_id = v_old_apc,
               notify      = false
         where brand_id = v_brand_id
           and status <> 'done'
           and (assignee_id = p_new_apc or created_by = p_new_apc)
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

  if p_notify then
    declare
      v_actor_name text := public.profile_display_name(v_caller);
      v_to_y_count int := coalesce(array_length(v_x_to_y, 1), 0);
      v_to_x_count int := coalesce(array_length(v_y_to_x, 1), 0);
      v_body text;
      v_targets uuid[];
      v_target  uuid;
    begin
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

-- 2. One-shot data fix for already-switched brands
--
-- For every brand currently assigned to ONE APC, find brand-scoped
-- tasks (status <> 'done') whose assignee or creator is some user
-- who is NOT in that brand's current assignments and whose role is
-- APC/IPC (i.e. former APC of that brand). Reassign to the current
-- APC. Set notify=false to suppress the trigger.
do $$
declare
  v_count int := 0;
begin
  with current_apc_per_brand as (
    select ba.brand_id,
           ba.user_id as current_apc
      from public.brand_assignments ba
      join public.profiles p on p.id = ba.user_id
      where p.role in ('apc','ipc')
        and p.is_active = true
        and p.deleted_at is null
  ),
  task_owners as (
    -- Distinct (task_id, current_apc) pairs needing fix
    select t.id as task_id, c.current_apc
      from public.tasks t
      join current_apc_per_brand c on c.brand_id = t.brand_id
     where t.brand_id is not null
       and t.status <> 'done'
       and (
         (t.assignee_id is not null
          and t.assignee_id <> c.current_apc
          and exists (
            select 1 from public.profiles p
            where p.id = t.assignee_id
              and p.role in ('apc','ipc')
              and not exists (
                select 1 from public.brand_assignments ba
                where ba.brand_id = t.brand_id
                  and ba.user_id = t.assignee_id
              )
          ))
         or
         (t.created_by is not null
          and t.created_by <> c.current_apc
          and exists (
            select 1 from public.profiles p
            where p.id = t.created_by
              and p.role in ('apc','ipc')
              and not exists (
                select 1 from public.brand_assignments ba
                where ba.brand_id = t.brand_id
                  and ba.user_id = t.created_by
              )
          ))
       )
  )
  update public.tasks t
     set assignee_id = task_owners.current_apc,
         notify      = false
    from task_owners
   where t.id = task_owners.task_id;
  get diagnostics v_count = row_count;
  raise notice 'Reassigned % brand-scoped tasks to current APC', v_count;
end;
$$;
