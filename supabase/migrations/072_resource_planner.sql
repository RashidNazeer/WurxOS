-- ============================================================
-- Migration 072 — Resource Planner (Boss)
--
-- Port of v1's `/boss/resource-planner` feature: a single global
-- config document + Boss-only computed views of headcount vs. brand
-- load per department.
--
-- What this migration adds:
--   1. Optional `employment_type` + `start_date` columns on profiles
--      (used by the "Current Team" tab — nullable so existing rows
--      don't need backfilling).
--   2. `resource_planner_config` singleton table (row-id 'default')
--      holding planning parameters + per-role capacity.
--   3. Boss-only RLS on the config table.
--   4. `get_planner_config()` / `save_planner_config(patch)` RPCs
--      that read & patch-merge the singleton. They're SECURITY
--      DEFINER so the app doesn't need direct table grants.
-- ============================================================

-- --------------------------------------------------------------
-- 1. Profile extensions (optional, Boss-managed elsewhere)
-- --------------------------------------------------------------
alter table public.profiles
  add column if not exists employment_type text,
  add column if not exists start_date      date;

-- --------------------------------------------------------------
-- 2. resource_planner_config — single shared row per org
-- --------------------------------------------------------------
create table if not exists public.resource_planner_config (
  id                         text primary key default 'default',
  planning_year              int         not null default extract(year from now())::int,
  planning_quarter           text        not null default 'Q1'
                               check (planning_quarter in ('Q1','Q2','Q3','Q4')),
  target_new_brands_per_month numeric    not null default 2,
  planning_horizon_months    int         not null default 1
                               check (planning_horizon_months between 1 and 12),
  max_utilization_target     int         not null default 85
                               check (max_utilization_target between 0 and 100),
  min_buffer_headcount       int         not null default 2
                               check (min_buffer_headcount between 0 and 50),
  churn_rate                 numeric     not null default 5,
  role_capacity              jsonb       not null default jsonb_build_object(
    'boss', jsonb_build_object('department','Leadership','maxBrands',27,'maxHours',40,'notes','Oversight'),
    'ol',   jsonb_build_object('department','Operations','maxBrands',15,'maxHours',40,'notes','Internal ops + SOPs'),
    'tl',   jsonb_build_object('department','Team Leads','maxBrands',6,'maxHours',40,'notes','Task tracking + execution'),
    'pctl', jsonb_build_object('department','Paid Collab','maxBrands',12,'maxHours',40,'notes','Paid Collab management'),
    'apc',  jsonb_build_object('department','Account Management','maxBrands',5,'maxHours',40,'notes','Primary workflow manager'),
    'ipc',  jsonb_build_object('department','Paid Collab','maxBrands',5,'maxHours',40,'notes','Paid Collab coordinator')
  ),
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references public.profiles(id) on delete set null
);

-- Guard the singleton: only id='default' is meaningful.
create or replace function public.rpc_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rpc_touch_trg on public.resource_planner_config;
create trigger rpc_touch_trg before update on public.resource_planner_config
  for each row execute function public.rpc_touch();

-- Seed the default row if missing.
insert into public.resource_planner_config (id)
values ('default')
on conflict (id) do nothing;

-- --------------------------------------------------------------
-- 3. RLS — Boss-only (developer also has read/write for debugging)
-- --------------------------------------------------------------
alter table public.resource_planner_config enable row level security;

drop policy if exists "rpc_select_boss" on public.resource_planner_config;
create policy "rpc_select_boss" on public.resource_planner_config for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

drop policy if exists "rpc_update_boss" on public.resource_planner_config;
create policy "rpc_update_boss" on public.resource_planner_config for update
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  )
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

-- INSERT / DELETE are blocked — there's always exactly one row.
drop policy if exists "rpc_insert_block" on public.resource_planner_config;
create policy "rpc_insert_block" on public.resource_planner_config for insert
  with check (false);

drop policy if exists "rpc_delete_block" on public.resource_planner_config;
create policy "rpc_delete_block" on public.resource_planner_config for delete
  using (false);

-- --------------------------------------------------------------
-- 4. RPCs — get + patch-merge save
-- --------------------------------------------------------------
create or replace function public.get_planner_config()
returns public.resource_planner_config
language sql
security definer
set search_path = public
as $$
  select * from public.resource_planner_config where id = 'default';
$$;

grant execute on function public.get_planner_config() to authenticated;

-- Patch-merge: each argument is optional; NULL means "don't touch".
-- role_capacity is a jsonb patch; we jsonb_merge-style overlay so
-- callers can update one role without resending the whole object.
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
  v_is_allowed boolean;
  v_row public.resource_planner_config;
  v_new_rc jsonb;
  v_role_key text;
begin
  v_is_allowed := public.is_boss(v_uid)
    or exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'developer' and p.is_active = true);
  if not v_is_allowed then
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

grant execute on function public.save_planner_config(
  int, text, numeric, int, int, int, numeric, jsonb
) to authenticated;
