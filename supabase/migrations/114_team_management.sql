-- ============================================================
-- 114 — Team Management RPCs
--
-- Boss / OL / Developer admin actions:
--
--   * team_move_apc_to_tl(p_apc, p_new_tl)
--       Move an APC (or IPC) under a new Team Lead. Updates
--       profiles.reports_to. Does NOT touch the APC's brand
--       assignments — those follow the APC.
--
--   * team_move_brand(p_brand, p_new_tl, p_new_apc?)
--       Move a brand to a different TL. Optionally pin which APC
--       under that TL will handle it; pass NULL to leave the brand
--       unassigned (no APC). Reassigns the brand's open tasks to
--       the new APC if one is provided; otherwise tasks are
--       unassigned (left on the old APC, but they should resolve
--       themselves manually since the brand has moved teams).
--       Bypasses the brands_block_owner_change trigger.
--
--   * team_move_ipc_to_pctl(p_ipc, p_new_pctl)
--       Move an IPC under a new PCTL. Same as APC↔TL but for the
--       paid-collab side.
--
--   * brand_deactivate(p_brand) / brand_reactivate(p_brand)
--       Helpers that flip brands.status. Deactivation does NOT
--       delete brand_assignments — they stay (soft cleanup), and
--       the UI filters them out wherever the brand is inactive.
--       Reactivating restores the team automatically.
--
-- All notifications are emitted to the people directly affected
-- (old / new team), and one audit_log row is recorded per action.
-- ============================================================

-- ── Helper: shared authorization check ────────────────────────
create or replace function public._team_mgr_authz(p_caller uuid)
returns boolean
language sql
stable
as $$
  select
    public.is_boss(p_caller)
    or exists (
      select 1 from public.profiles p
      where p.id = p_caller and p.is_active = true
        and p.role in ('ol','developer')
    );
$$;

-- ════════════════════════════════════════════════════════════════
-- 1. team_move_apc_to_tl
-- ════════════════════════════════════════════════════════════════
create or replace function public.team_move_apc_to_tl(
  p_apc    uuid,
  p_new_tl uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_apc      public.profiles%rowtype;
  v_new_tl   public.profiles%rowtype;
  v_old_tl   uuid;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can move APCs';
  end if;

  select * into v_apc from public.profiles where id = p_apc;
  if not found              then raise exception 'APC not found'; end if;
  if v_apc.role not in ('apc','ipc') then
    raise exception 'target user is not an APC/IPC (got %)', v_apc.role;
  end if;

  select * into v_new_tl from public.profiles where id = p_new_tl;
  if not found                          then raise exception 'new TL not found'; end if;
  if v_new_tl.is_active is not true     then raise exception 'new TL is inactive'; end if;
  if v_new_tl.role not in ('tl','pctl') then
    raise exception 'target supervisor is not a TL/PCTL (got %)', v_new_tl.role;
  end if;

  v_old_tl := v_apc.reports_to;
  if v_old_tl is not distinct from p_new_tl then
    return p_apc;  -- no-op
  end if;

  update public.profiles
     set reports_to = p_new_tl, updated_at = now()
   where id = p_apc;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'team.move_apc', 'profiles', p_apc,
    jsonb_build_object('reports_to', v_old_tl),
    jsonb_build_object('reports_to', p_new_tl)
  );

  -- Notify involved parties.
  declare
    v_actor   text := public.profile_display_name(v_caller);
    v_apc_nm  text := public.profile_display_name(p_apc);
    v_new_nm  text := public.profile_display_name(p_new_tl);
    v_targets uuid[];
    v_t       uuid;
  begin
    v_targets := array(
      select distinct x from unnest(array[p_apc, p_new_tl, v_old_tl]) x
      where x is not null and x <> v_caller
    );
    foreach v_t in array v_targets loop
      perform public.emit_notification(
        v_t, v_caller, 'team', 'team.apc_moved',
        'Team change',
        v_actor || ' moved ' || v_apc_nm || ' under ' || v_new_nm,
        'profiles', p_apc, '/team-management'
      );
    end loop;
  end;

  return p_apc;
end;
$$;
grant execute on function public.team_move_apc_to_tl(uuid, uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 2. team_move_brand — move brand to new TL, optionally pin APC
-- ════════════════════════════════════════════════════════════════
create or replace function public.team_move_brand(
  p_brand   uuid,
  p_new_tl  uuid,
  p_new_apc uuid default null,  -- NULL = leave brand unassigned
  p_note    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_brand    public.brands%rowtype;
  v_new_tl   public.profiles%rowtype;
  v_new_apc  public.profiles%rowtype;
  v_old_tl   uuid;
  v_old_apcs uuid[];
  v_reassigned int := 0;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can move brands';
  end if;

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  select * into v_new_tl from public.profiles where id = p_new_tl;
  if not found                          then raise exception 'new TL not found'; end if;
  if v_new_tl.is_active is not true     then raise exception 'new TL is inactive'; end if;
  if v_new_tl.role not in ('tl','pctl') then
    raise exception 'new owner must be a TL/PCTL (got %)', v_new_tl.role;
  end if;

  if p_new_apc is not null then
    select * into v_new_apc from public.profiles where id = p_new_apc;
    if not found                          then raise exception 'new APC not found'; end if;
    if v_new_apc.is_active is not true    then raise exception 'new APC is inactive'; end if;
    if v_new_apc.role not in ('apc','ipc') then
      raise exception 'pinned assignee must be an APC/IPC (got %)', v_new_apc.role;
    end if;
    if v_new_apc.reports_to is distinct from p_new_tl then
      raise exception 'APC % does not report to TL %', p_new_apc, p_new_tl;
    end if;
  end if;

  v_old_tl := v_brand.owner_id;
  select coalesce(array_agg(user_id), '{}')
    into v_old_apcs
    from public.brand_assignments
    where brand_id = p_brand;

  -- Update owner_id (bypass owner-change guard).
  perform set_config('wurxos.bypass_owner_guard', 'on', true);
  update public.brands
     set owner_id = p_new_tl, updated_at = now()
   where id = p_brand;
  perform set_config('wurxos.bypass_owner_guard', 'off', true);

  -- Replace assignments.
  delete from public.brand_assignments where brand_id = p_brand;
  if p_new_apc is not null then
    insert into public.brand_assignments (brand_id, user_id)
      values (p_brand, p_new_apc)
      on conflict do nothing;

    -- Reassign open tasks held by old APCs.
    if array_length(v_old_apcs, 1) > 0 then
      update public.tasks
         set assignee_id = p_new_apc, updated_at = now()
       where brand_id = p_brand
         and status <> 'done'
         and assignee_id = any (v_old_apcs);
      get diagnostics v_reassigned = row_count;
    end if;
  end if;
  -- If p_new_apc is null, brand goes unassigned. Old APCs keep their
  -- open tasks until the new TL assigns them out.

  -- Audit.
  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'team.move_brand', 'brands', p_brand,
    jsonb_build_object('owner_id', v_old_tl, 'assigned_apcs', v_old_apcs),
    jsonb_build_object(
      'owner_id', p_new_tl,
      'assigned_apcs', case when p_new_apc is null then '{}'::uuid[] else array[p_new_apc] end,
      'tasks_reassigned', v_reassigned,
      'note', p_note
    )
  );

  -- Notify.
  declare
    v_actor   text := public.profile_display_name(v_caller);
    v_brand_n text := v_brand.brand_name;
    v_new_tl_n text := public.profile_display_name(p_new_tl);
    v_new_apc_n text := case when p_new_apc is null then null else public.profile_display_name(p_new_apc) end;
    v_body    text;
    v_targets uuid[];
    v_t       uuid;
  begin
    if p_new_apc is null then
      v_body := v_actor || ' moved "' || v_brand_n || '" to ' || v_new_tl_n || '''s team (unassigned)';
    else
      v_body := v_actor || ' moved "' || v_brand_n || '" to ' || v_new_tl_n || ' / ' || v_new_apc_n;
    end if;
    if v_reassigned > 0 then
      v_body := v_body || ' · ' || v_reassigned || ' open task' || (case when v_reassigned = 1 then '' else 's' end) || ' reassigned';
    end if;

    v_targets := array(
      select distinct x from unnest(array[p_new_tl, p_new_apc, v_old_tl] || v_old_apcs) x
      where x is not null and x <> v_caller
    );
    foreach v_t in array v_targets loop
      perform public.emit_notification(
        v_t, v_caller, 'brand', 'brand.moved',
        'Brand moved', v_body,
        'brand', p_brand, '/brands/' || p_brand::text
      );
    end loop;
  end;

  return p_brand;
end;
$$;
grant execute on function public.team_move_brand(uuid, uuid, uuid, text) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 3. team_move_ipc_to_pctl — same as APC↔TL but for paid-collab
-- ════════════════════════════════════════════════════════════════
-- Implemented as a thin wrapper over team_move_apc_to_tl since the
-- shape is identical (IPCs have role='ipc' and report_to a PCTL).
create or replace function public.team_move_ipc_to_pctl(
  p_ipc      uuid,
  p_new_pctl uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ipc public.profiles%rowtype;
  v_pct public.profiles%rowtype;
begin
  -- Validate roles before delegating (the inner function accepts apc/tl
  -- for the generic case; here we want IPC -> PCTL specifically).
  select * into v_ipc from public.profiles where id = p_ipc;
  if not found              then raise exception 'IPC not found'; end if;
  if v_ipc.role <> 'ipc'    then raise exception 'target user is not an IPC (got %)', v_ipc.role; end if;

  select * into v_pct from public.profiles where id = p_new_pctl;
  if not found              then raise exception 'new PCTL not found'; end if;
  if v_pct.role <> 'pctl'   then raise exception 'target supervisor is not a PCTL (got %)', v_pct.role; end if;

  return public.team_move_apc_to_tl(p_ipc, p_new_pctl);
end;
$$;
grant execute on function public.team_move_ipc_to_pctl(uuid, uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- 4. brand_deactivate / brand_reactivate
-- ════════════════════════════════════════════════════════════════
create or replace function public.brand_deactivate(p_brand uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_brand  public.brands%rowtype;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can deactivate brands';
  end if;

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;
  if v_brand.status = 'inactive' then return p_brand; end if;

  update public.brands
     set status = 'inactive', updated_at = now()
   where id = p_brand;

  -- Soft cleanup: brand_assignments stay so reactivation auto-restores
  -- the team. The UI filters inactive brands out of pickers.

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'brand.deactivated', 'brands', p_brand,
    jsonb_build_object('status', v_brand.status),
    jsonb_build_object('status', 'inactive')
  );

  return p_brand;
end;
$$;
grant execute on function public.brand_deactivate(uuid) to authenticated;

create or replace function public.brand_reactivate(p_brand uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_brand  public.brands%rowtype;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can reactivate brands';
  end if;

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;
  if v_brand.status = 'active' then return p_brand; end if;

  update public.brands
     set status = 'active', updated_at = now()
   where id = p_brand;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'brand.reactivated', 'brands', p_brand,
    jsonb_build_object('status', v_brand.status),
    jsonb_build_object('status', 'active')
  );

  return p_brand;
end;
$$;
grant execute on function public.brand_reactivate(uuid) to authenticated;
