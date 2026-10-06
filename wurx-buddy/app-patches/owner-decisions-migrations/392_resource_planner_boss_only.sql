-- ============================================================
-- WurxOS v2 — Migration 392: Resource Planner is Boss-only
--
-- Owner decision (2026-10). Mig 072 let an active Developer read and save the
-- planner config "for debugging". Since mig 212 Developers no longer see
-- brands, so their planner figures were wrong anyway. The route guard is now
-- Boss-only (App.jsx), and the config table and RPCs follow. Idempotent.
-- ============================================================

drop policy if exists "rpc_select_boss" on public.resource_planner_config;
create policy "rpc_select_boss" on public.resource_planner_config for select
  using (public.is_boss(auth.uid()));

drop policy if exists "rpc_update_boss" on public.resource_planner_config;
create policy "rpc_update_boss" on public.resource_planner_config for update
  using (public.is_boss(auth.uid()))
  with check (public.is_boss(auth.uid()));

-- Was open to any signed-in user (SECURITY DEFINER, no check): nothing for
-- anyone but the Boss now.
create or replace function public.get_planner_config()
returns public.resource_planner_config
language sql
security definer
set search_path = public
as $$
  select * from public.resource_planner_config
   where id = 'default' and public.is_boss(auth.uid());
$$;
revoke execute on function public.get_planner_config() from public, anon;
grant execute on function public.get_planner_config() to authenticated;

create or replace function public.save_planner_config(
  p_planning_year                 int     default null,
  p_planning_quarter              text    default null,
  p_target_new_brands_per_month   numeric default null,
  p_planning_horizon_months       int     default null,
  p_max_utilization_target        int     default null,
  p_min_buffer_headcount          int     default null,
  p_churn_rate                    numeric default null,
  p_role_capacity_patch           jsonb   default null
)
returns public.resource_planner_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.resource_planner_config;
  v_new_rc jsonb;
  v_role_key text;
begin
  if not public.is_boss(v_uid) then
    raise exception 'Only Boss can update resource planner config';
  end if;

  -- Deep-merge role_capacity: per-role overlay so callers can
  -- patch a single role field (e.g. apc.maxBrands) without
  -- clobbering the rest of that role's sub-object.
  select role_capacity into v_new_rc from public.resource_planner_config where id = 'default';
  if p_role_capacity_patch is not null then
    for v_role_key in select jsonb_object_keys(p_role_capacity_patch) loop
      v_new_rc := jsonb_set(
        v_new_rc,
        array[v_role_key],
        coalesce(v_new_rc->v_role_key, '{}'::jsonb) || (p_role_capacity_patch->v_role_key)
      );
    end loop;
  end if;

  update public.resource_planner_config
     set planning_year                = coalesce(p_planning_year, planning_year),
         planning_quarter             = coalesce(p_planning_quarter, planning_quarter),
         target_new_brands_per_month  = coalesce(p_target_new_brands_per_month, target_new_brands_per_month),
         planning_horizon_months      = coalesce(p_planning_horizon_months, planning_horizon_months),
         max_utilization_target       = coalesce(p_max_utilization_target, max_utilization_target),
         min_buffer_headcount         = coalesce(p_min_buffer_headcount, min_buffer_headcount),
         churn_rate                   = coalesce(p_churn_rate, churn_rate),
         role_capacity                = v_new_rc,
         updated_by                   = v_uid
   where id = 'default'
  returning * into v_row;

  return v_row;
end;
$$;
revoke execute on function public.save_planner_config(int, text, numeric, int, int, int, numeric, jsonb) from public, anon;
grant execute on function public.save_planner_config(int, text, numeric, int, int, int, numeric, jsonb) to authenticated;
