-- ============================================================
-- WurxOS v2 — Migration 045: Switch a brand's APC
--
-- Lets a Boss / OL / Developer reassign a brand from its current
-- APC(s) to a new APC (or IPC). Semantics the user asked for:
--   * the brand's assigned APC(s) are replaced by the new one,
--   * the brand's owner_id is updated to the new APC's reports_to
--     (their Team Lead) — so downstream notifications and brand
--     visibility naturally route to the new TL instead of the old,
--   * all open (non-done) tasks on this brand that were assigned
--     to an old APC are reassigned to the new APC,
--   * resources, reports, activity and history stay with the brand,
--   * a single audit row captures the switch and every involved
--     party (old APC, old TL, new APC, new TL) is notified.
-- ============================================================

create or replace function public.brand_switch_apc(
  p_brand uuid,
  p_new_apc uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid := auth.uid();
  v_is_mgr  bool;
  v_brand   public.brands%rowtype;
  v_new_apc public.profiles%rowtype;
  v_new_tl  uuid;
  v_old_tl  uuid;
  v_old_apcs uuid[];
  v_reassigned int := 0;
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

  -- Load the target brand.
  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  -- Load + validate the incoming APC/IPC.
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

  -- Snapshot current assignees so we know who to reassign tasks for.
  select coalesce(array_agg(user_id), '{}')
    into v_old_apcs
    from public.brand_assignments
    where brand_id = p_brand;
  v_old_tl := v_brand.owner_id;

  -- Update brand ownership (bypass the owner-change guard from 025 —
  -- this is an admin action, not a regular profile edit).
  perform set_config('wurxos.bypass_owner_guard', 'on', true);
  update public.brands
     set owner_id = v_new_tl
   where id = p_brand;
  perform set_config('wurxos.bypass_owner_guard', 'off', true);

  -- Replace APC assignments.
  delete from public.brand_assignments where brand_id = p_brand;
  insert into public.brand_assignments (brand_id, user_id)
    values (p_brand, p_new_apc)
    on conflict do nothing;

  -- Reassign open tasks on this brand that were held by the old APC(s).
  if array_length(v_old_apcs, 1) > 0 then
    update public.tasks
       set assignee_id = p_new_apc
     where brand_id = p_brand
       and status <> 'done'
       and assignee_id = any (v_old_apcs);
    get diagnostics v_reassigned = row_count;
  end if;

  -- Audit.
  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'brand.switch_apc', 'brands', p_brand,
    jsonb_build_object(
      'owner_id',      v_old_tl,
      'assigned_apcs', v_old_apcs
    ),
    jsonb_build_object(
      'owner_id',      v_new_tl,
      'assigned_apcs', array[p_new_apc],
      'new_apc',       p_new_apc,
      'tasks_reassigned', v_reassigned,
      'note',          p_note
    )
  );

  -- Notifications. Category = 'brand', action = 'brand.switched'.
  declare
    v_actor_name text := public.profile_display_name(v_caller);
    v_brand_name text := v_brand.brand_name;
    v_new_apc_name text := public.profile_display_name(p_new_apc);
    v_title text := 'Brand switched';
    v_body  text;
    v_targets uuid[];
    v_target uuid;
  begin
    v_body := v_actor_name || ' assigned "' || v_brand_name || '" to ' || v_new_apc_name
              || case when v_reassigned > 0
                      then ' · ' || v_reassigned || ' open task' || (case when v_reassigned = 1 then '' else 's' end) || ' reassigned'
                      else ''
                 end;

    v_targets := array(
      select distinct x from unnest(array[
        p_new_apc, v_new_tl, v_old_tl
      ] || v_old_apcs) x
      where x is not null and x <> v_caller
    );

    foreach v_target in array v_targets loop
      perform public.emit_notification(
        v_target, v_caller, 'brand', 'brand.switched',
        v_title, v_body,
        'brand', p_brand, '/brands/' || p_brand::text
      );
    end loop;
  end;

  return p_brand;
end;
$$;
grant execute on function public.brand_switch_apc(uuid, uuid, text) to authenticated;
