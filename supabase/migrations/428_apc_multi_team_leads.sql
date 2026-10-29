-- ============================================================
-- WurxOS v2 — Migration 428: APCs across several Team Leads, and leave / WFH
-- that needs every one of those Team Leads.
--
-- THE GAP: profiles.reports_to is ONE column, so an APC had exactly one TL even
-- when they run brands for two. Abrahim runs JoyMode (Ali Hamza's brand) AND Inno
-- Supps (Haider Ali's); Haider's team page did not list him, his brand form pruned
-- him from his own brand's APC picker, and his leave went to Ali Hamza alone.
--
-- THE MODEL -- nothing new is stored for membership
--   brands.owner_id        the brand's Team Lead. The ONLY source for "which TL
--                          does this brand belong to".
--   brand_assignments      who runs the brand. The source of truth for which teams
--                          an APC works across.
--   apc_team_leads (VIEW)  derived: the APC's reports_to PLUS the owner of every
--                          live (active, permanent) brand they hold. It cannot
--                          drift because there is nothing to keep in step.
--   profiles.reports_to    unchanged. Still the APC's manager for attendance,
--                          incentives and performance, and still keeps an APC with
--                          no brands yet on their TL's team.
--
-- LEAVE / WFH (one table, one workflow: WFH is leave_requests.type = 'wfh')
--   An APC whose live brands span TWO OR MORE Team Leads needs all of them.
--   leave_request_approvers holds one row per required TL on the SAME request;
--   the request flips to approved only when every row is approved, and to
--   rejected as soon as any row rejects -- in one UPDATE, so the coverage trigger
--   and the quota maths fire exactly once. Everyone else (including every APC on
--   one team) keeps today's chain untouched.
--
--   POLICY for later changes: the required approvers are a SNAPSHOT taken at
--   submit time and never silently recalculated -- not when a brand is reassigned
--   and not when an approver is deactivated. A new request routes to whoever
--   holds the brands then. A stuck request is the Boss's to decide (the Boss can
--   always act, and that decision is final).
--
-- brand_assign_apc / brand_switch_apc / team_move_brand used to stamp the brand's
-- owner (or the APC's reports_to) from the APC's reports_to, which is exactly the
-- "TL from the APC's profile" the model rules out. See section 2.
--
-- The patched functions are the LIVE bodies (pg_get_functiondef), each patch
-- asserted to match exactly once. Idempotent.
-- ============================================================

-- ---- 1. who works under which TL (derived) ------------------------------------------
create or replace view public.apc_team_leads as
  select p.id as apc_id, p.reports_to as tl_id
    from public.profiles p
   where p.role in ('apc','ipc') and p.reports_to is not null
     and p.is_active and p.deleted_at is null
  union
  select ba.user_id, b.owner_id
    from public.brand_assignments ba
    join public.brands   b on b.id = ba.brand_id and b.status <> 'inactive'
    join public.profiles p on p.id = ba.user_id and p.role in ('apc','ipc') and p.is_active and p.deleted_at is null
    join public.profiles o on o.id = b.owner_id and o.role in ('tl','pctl') and o.is_active and o.deleted_at is null
   where ba.expires_at is null;      -- temporary cover is leave cover, not a team

comment on view public.apc_team_leads is
  'Derived (mig 428): every Team Lead an APC/IPC works under = their reports_to + the owner of each live permanent brand they hold. Runs with the owner''s rights on purpose: it exposes ids only, the same visibility profiles already have.';
revoke all on public.apc_team_leads from public, anon;
grant select on public.apc_team_leads to authenticated, service_role;

create or replace function public.apc_tl_ids(p_apc uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(tl_id), '{}'::uuid[]) from public.apc_team_leads where apc_id = p_apc;
$$;

-- Who owns a brand this APC takes over in a swap: the brand's current owner when
-- it is already one of the APC's TLs, else the APC's reports_to (the old rule).
create or replace function public.apc_brand_owner(p_apc uuid, p_current_owner uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select case
    when p_current_owner is not null and p_current_owner = any (public.apc_tl_ids(p_apc)) then p_current_owner
    else (select reports_to from public.profiles where id = p_apc)
  end;
$$;

-- The Team Leads whose BRANDS an APC runs right now (reports_to deliberately not
-- included): the people whose work a leave actually affects, each with the brands
-- that go into the snapshot a request stores.
create or replace function public.apc_brand_team_leads(p_apc uuid)
returns table (tl_id uuid, brands jsonb)
language sql stable security definer set search_path = public
as $$
  select b.owner_id,
         jsonb_agg(jsonb_build_object('id', b.id, 'name', b.brand_name) order by b.brand_name)
    from public.brand_assignments ba
    join public.brands   b on b.id = ba.brand_id and b.status <> 'inactive'
    join public.profiles o on o.id = b.owner_id and o.role in ('tl','pctl') and o.is_active and o.deleted_at is null
   where ba.user_id = p_apc and ba.expires_at is null
   group by b.owner_id;
$$;

do $g$
declare f text;
begin
  foreach f in array array['apc_tl_ids(uuid)','apc_brand_owner(uuid,uuid)','apc_brand_team_leads(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);   -- by name: see mig 359
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $g$;

-- ---- 2. live functions, patched ----------------------------------------------------------
-- brand_assign_apc: the brand keeps its Team Lead -- the APC joins that team by holding the brand
CREATE OR REPLACE FUNCTION public.brand_assign_apc(p_brand uuid, p_new_apc uuid, p_note text DEFAULT NULL::text, p_notify boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller     uuid := auth.uid();
  v_is_mgr     bool;
  v_brand      public.brands%rowtype;
  v_new_apc    public.profiles%rowtype;
  v_new_tl     uuid;
  v_replaced   uuid[];
  v_kept       uuid[];
  v_tasks_moved     int := 0;
  v_reports_moved   int := 0;
  v_resources_moved int := 0;
begin
  -- Authz mirrors brand_switch_apc: Boss, OL, Developer.
  v_is_mgr := public.is_boss(v_caller)
    or exists (
      select 1 from public.profiles p
      where p.id = v_caller and p.role in ('ol','developer') and p.is_active
    );
  if not v_is_mgr then
    raise exception 'only Boss/OL can assign brand APCs' using errcode = '42501';
  end if;

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  select * into v_new_apc from public.profiles
    where id = p_new_apc and is_active = true and deleted_at is null;
  if not found then raise exception 'new APC not found or inactive'; end if;
  if v_new_apc.role not in ('apc','ipc') then
    raise exception 'target user is not an APC/IPC (got %)', v_new_apc.role;
  end if;
  v_new_tl := v_brand.owner_id;  -- mig 428: assigning an APC never re-owns the brand; its TL is its own team
  if v_new_tl is null then
    raise exception 'target APC has no Team Lead (reports_to is null)';
  end if;

  -- Already this brand's permanent assignee: nothing to do, and a silent
  -- success would write an audit row claiming a move that did not happen.
  if exists (
    select 1 from public.brand_assignments
     where brand_id = p_brand and user_id = p_new_apc and expires_at is null
  ) then
    raise exception '% is already assigned to this brand', coalesce(v_new_apc.display_name, 'This APC');
  end if;

  -- The seat being filled: permanent, same role as the target, not the target.
  select coalesce(array_agg(ba.user_id order by ba.assigned_at), '{}')
    into v_replaced
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id
   where ba.brand_id = p_brand
     and ba.user_id <> p_new_apc
     and ba.expires_at is null
     and p.role = v_new_apc.role;

  -- Recorded for the audit row only — the people this deliberately leaves alone.
  select coalesce(array_agg(ba.user_id order by ba.assigned_at), '{}')
    into v_kept
    from public.brand_assignments ba
   where ba.brand_id = p_brand
     and ba.user_id <> p_new_apc
     and not (ba.user_id = any (v_replaced));

  -- Both flags are transaction-local (third arg true), so they cannot leak
  -- into anything else this connection does.
  perform set_config('wurxos.skip_owner_cascade', 'on', true);
  perform set_config('wurxos.bypass_owner_guard', 'on', true);

  -- Assignments FIRST, owner second. With the cascade skipped the order no
  -- longer changes the outcome, but it is the order that stays correct if
  -- someone later removes the skip — the cascade would then see the new
  -- assignee rather than the departing one (the ordering behind the
  -- reports_to drift in brand_switch_apc and team_move_brand).
  delete from public.brand_assignments
   where brand_id = p_brand
     and user_id = any (v_replaced);

  -- An upsert, because the target may already hold TEMPORARY cover on this
  -- brand; being made its APC turns that into a permanent assignment.
  insert into public.brand_assignments (brand_id, user_id, assigned_by, assigned_at, expires_at)
  values (p_brand, p_new_apc, v_caller, now(), null)
  on conflict (brand_id, user_id)
  do update set expires_at  = null,
                assigned_by = excluded.assigned_by,
                assigned_at = excluded.assigned_at;

  update public.brands
     set owner_id = v_new_tl
   where id = p_brand
     and owner_id is distinct from v_new_tl;

  perform set_config('wurxos.bypass_owner_guard', 'off', true);
  perform set_config('wurxos.skip_owner_cascade', 'off', true);

  -- Content follows the brand (migs 138/170/176), for this brand only.
  if array_length(v_replaced, 1) > 0 then
    with moved as (
      update public.tasks
         set assignee_id = p_new_apc,
             notify      = false
       where brand_id = p_brand
         and status <> 'done'
         and (assignee_id = any (v_replaced) or created_by = any (v_replaced))
       returning 1
    )
    select count(*) into v_tasks_moved from moved;

    with moved as (
      update public.reports
         set author_id = p_new_apc
       where brand_id = p_brand
         and author_id = any (v_replaced)
       returning 1
    )
    select count(*) into v_reports_moved from moved;

    with moved as (
      update public.resources
         set created_by = p_new_apc
       where brand_id = p_brand
         and created_by = any (v_replaced)
       returning 1
    )
    select count(*) into v_resources_moved from moved;

    update public.agenda_tasks
       set assignee_id = p_new_apc,
           notify      = false
     where brand_id = p_brand
       and status <> 'completed'
       and (assignee_id = any (v_replaced) or created_by = any (v_replaced));

    update public.agenda_resources
       set created_by = p_new_apc
     where brand_id = p_brand
       and created_by = any (v_replaced);
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'brand.assign_apc', 'brands', p_brand,
    jsonb_build_object('owner_id', v_brand.owner_id, 'replaced_apcs', v_replaced),
    jsonb_build_object(
      'owner_id',        v_new_tl,
      'assigned_apc',    p_new_apc,
      'kept_assignees',  v_kept,
      'tasks_moved',     v_tasks_moved,
      'reports_moved',   v_reports_moved,
      'resources_moved', v_resources_moved,
      'notified',        p_notify,
      'note',            p_note
    )
  );

  -- Opt-in, incoming side only — the mig 048 rule. The replaced APC loses
  -- visibility through RLS on its own; paging them adds noise, not signal.
  if p_notify then
    declare
      v_actor_name text := public.profile_display_name(v_caller);
      v_body       text;
      v_target     uuid;
    begin
      v_body := v_actor_name || ' assigned "' || v_brand.brand_name || '" to '
                || coalesce(v_new_apc.display_name, 'you')
                || case when v_tasks_moved > 0
                        then ' · ' || v_tasks_moved || ' open task'
                             || (case when v_tasks_moved = 1 then '' else 's' end) || ' moved'
                        else '' end;
      foreach v_target in array array(
        select distinct x from unnest(array[p_new_apc, v_new_tl]) x
         where x is not null and x <> v_caller
      ) loop
        perform public.emit_notification(
          v_target, v_caller, 'brand', 'brand.assigned',
          'Brand assigned', v_body,
          'brand', p_brand, '/brands/' || p_brand::text
        );
      end loop;
    end;
  end if;

  return p_brand;
end;
$function$;

-- brand_switch_apc: the swap re-owns each moved brand per brand, keeping a TL the new holder already works under
CREATE OR REPLACE FUNCTION public.brand_switch_apc(p_brand uuid, p_new_apc uuid, p_note text DEFAULT NULL::text, p_notify boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  v_tasks_moved     int := 0;
  v_reports_moved   int := 0;
  v_resources_moved int := 0;
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
  v_new_tl := public.apc_brand_owner(p_new_apc, v_brand.owner_id);  -- mig 428
  if v_new_tl is null then
    raise exception 'target APC has no Team Lead (reports_to is null)';
  end if;

  -- mig 360: permanent, same role as the target (see section header).
  select ba.user_id into v_old_apc
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id
    where ba.brand_id = p_brand
      and ba.user_id <> p_new_apc
      and ba.expires_at is null
      and p.role = v_new_apc.role
    order by ba.assigned_at asc
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

  -- X → Y (old APC's brands now belong to new APC)
  if array_length(v_x_to_y, 1) > 0 then
    foreach v_brand_id in array v_x_to_y loop
      select * into v_brand_row from public.brands where id = v_brand_id;

      v_new_tl := public.apc_brand_owner(p_new_apc, v_brand_row.owner_id);  -- mig 428: per brand
      update public.brands
         set owner_id = v_new_tl
       where id = v_brand_id;

      delete from public.brand_assignments where brand_id = v_brand_id;
      insert into public.brand_assignments (brand_id, user_id)
        values (v_brand_id, p_new_apc)
        on conflict do nothing;

      if v_old_apc is not null then
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

        with moved as (
          update public.reports
             set author_id = p_new_apc
           where brand_id = v_brand_id
             and author_id = v_old_apc
           returning 1
        )
        select v_reports_moved + count(*) into v_reports_moved from moved;

        with moved as (
          update public.resources
             set created_by = p_new_apc
           where brand_id = v_brand_id
             and created_by = v_old_apc
           returning 1
        )
        select v_resources_moved + count(*) into v_resources_moved from moved;

        -- Agenda module: move open agenda tasks + agenda resources.
        update public.agenda_tasks
           set assignee_id = p_new_apc,
               notify      = false
         where brand_id = v_brand_id
           and status <> 'completed'
           and (assignee_id = v_old_apc or created_by = v_old_apc);

        update public.agenda_resources
           set created_by = p_new_apc
         where brand_id = v_brand_id
           and created_by = v_old_apc;
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

  -- Y → X (new APC's brands swap to old APC — the symmetric case)
  if array_length(v_y_to_x, 1) > 0 and v_old_apc is not null then
    foreach v_brand_id in array v_y_to_x loop
      continue when v_brand_id = any (v_x_to_y);

      select * into v_brand_row from public.brands where id = v_brand_id;

      v_old_tl := public.apc_brand_owner(v_old_apc, v_brand_row.owner_id);  -- mig 428: per brand
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

      with moved as (
        update public.reports
           set author_id = v_old_apc
         where brand_id = v_brand_id
           and author_id = p_new_apc
         returning 1
      )
      select v_reports_moved + count(*) into v_reports_moved from moved;

      with moved as (
        update public.resources
           set created_by = v_old_apc
         where brand_id = v_brand_id
           and created_by = p_new_apc
         returning 1
      )
      select v_resources_moved + count(*) into v_resources_moved from moved;

      -- Agenda module: symmetric move back to the old APC.
      update public.agenda_tasks
         set assignee_id = v_old_apc,
             notify      = false
       where brand_id = v_brand_id
         and status <> 'completed'
         and (assignee_id = p_new_apc or created_by = p_new_apc);

      update public.agenda_resources
         set created_by = v_old_apc
       where brand_id = v_brand_id
         and created_by = p_new_apc;

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

  raise notice '[brand_switch_apc] tasks=% reports=% resources=%', v_tasks_moved, v_reports_moved, v_resources_moved;
  return p_brand;
end;
$function$;

-- team_move_brand: a pinned APC who still holds brands under their reports_to is not re-pointed
CREATE OR REPLACE FUNCTION public.team_move_brand(p_brand uuid, p_new_tl uuid, p_new_apc uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller   uuid := auth.uid();
  v_brand    public.brands%rowtype;
  v_new_tl   public.profiles%rowtype;
  v_new_apc  public.profiles%rowtype;
  v_old_tl   uuid;
  v_old_apcs uuid[];
  v_reassigned int := 0;
  v_apc_old_reports_to uuid;
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
    -- Previously this raised if v_new_apc.reports_to <> p_new_tl,
    -- forcing the caller to update reports_to manually first. That
    -- gap is what created the bug. Now we ALIGN reports_to here.
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

    -- ALIGN reports_to. This is the missing piece. If the pinned APC
    -- already reports to the new TL, no-op; otherwise update and audit.
    v_apc_old_reports_to := v_new_apc.reports_to;
    if v_apc_old_reports_to is distinct from p_new_tl and exists (
      select 1 from public.brand_assignments ba join public.brands b on b.id = ba.brand_id
       where ba.user_id = p_new_apc and ba.expires_at is null and b.status <> 'inactive'
         and b.id <> p_brand and b.owner_id = v_apc_old_reports_to
    ) then
      -- mig 428: still runs brands for their reports_to, so this is a second team
      -- (derived from the brand they now hold), not a move. Leave reports_to alone.
      null;
    elsif v_apc_old_reports_to is distinct from p_new_tl then
      update public.profiles
         set reports_to = p_new_tl, updated_at = now()
       where id = p_new_apc;

      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        v_caller, 'team.move_brand.align_reports_to', 'profiles', p_new_apc,
        jsonb_build_object('reports_to', v_apc_old_reports_to),
        jsonb_build_object('reports_to', p_new_tl, 'reason', 'auto-aligned via team_move_brand')
      );
    end if;

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
$function$;

-- team_move_apc_to_tl: brands owned by the APC's OTHER team leads stay put when their reports_to moves
CREATE OR REPLACE FUNCTION public.team_move_apc_to_tl(p_apc uuid, p_new_tl uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller uuid := auth.uid();
  v_apc    public.profiles%rowtype;
  v_new_tl public.profiles%rowtype;
  v_old_tl uuid;
  v_moved  int := 0;
  v_brand  record;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can move APCs';
  end if;

  select * into v_apc from public.profiles where id = p_apc;
  if not found                       then raise exception 'APC not found'; end if;
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

  -- 1. Move the person.
  update public.profiles
     set reports_to = p_new_tl, updated_at = now()
   where id = p_apc;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'team.move_apc', 'profiles', p_apc,
    jsonb_build_object('reports_to', v_old_tl),
    jsonb_build_object('reports_to', p_new_tl)
  );

  -- 2. NEW: their brands follow them. Sole-assignee brands only (see header).
  perform set_config('wurxos.bypass_owner_guard', 'on', true);
  for v_brand in
    select b.id, b.owner_id
      from public.brands b
      join public.brand_assignments ba on ba.brand_id = b.id
     where ba.user_id = p_apc
       and b.owner_id is distinct from p_new_tl
       and (v_old_tl is null or b.owner_id = v_old_tl)   -- mig 428: only the old team's brands travel
       and (select count(*) from public.brand_assignments x where x.brand_id = b.id) = 1
  loop
    update public.brands
       set owner_id = p_new_tl, updated_at = now()
     where id = v_brand.id;
    v_moved := v_moved + 1;

    insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
    values (
      v_caller, 'team.move_apc_brand', 'brands', v_brand.id,
      jsonb_build_object('owner_id', v_brand.owner_id),
      jsonb_build_object('owner_id', p_new_tl, 'moved_with_apc', p_apc)
    );
  end loop;
  perform set_config('wurxos.bypass_owner_guard', 'off', true);

  -- 3. Notify everyone involved.
  declare
    v_actor   text := public.profile_display_name(v_caller);
    v_apc_nm  text := public.profile_display_name(p_apc);
    v_new_nm  text := public.profile_display_name(p_new_tl);
    v_body    text;
    v_targets uuid[];
    v_t       uuid;
  begin
    v_body := v_actor || ' moved ' || v_apc_nm || ' under ' || v_new_nm;
    if v_moved > 0 then
      v_body := v_body || ' (' || v_moved || ' brand'
             || case when v_moved = 1 then '' else 's' end || ' moved with them)';
    end if;

    v_targets := array(
      select distinct x from unnest(array[p_apc, p_new_tl, v_old_tl]) x
      where x is not null and x <> v_caller
    );
    foreach v_t in array v_targets loop
      perform public.emit_notification(
        v_t, v_caller, 'team', 'team.apc_moved',
        'Team change',
        v_body,
        'profiles', p_apc, '/team-management'
      );
    end loop;
  end;

  return p_apc;
end;
$function$;

-- ---- 3. leave / WFH needing several Team Leads ----------------------------------------
create table if not exists public.leave_request_approvers (
  request_id  uuid not null references public.leave_requests(id) on delete cascade,
  approver_id uuid not null references public.profiles(id),
  brands      jsonb not null default '[]'::jsonb,       -- [{id,name}] this TL's brands the APC held at submit time
  decision    text  not null default 'pending'
              check (decision in ('pending','approved','rejected','superseded')),
  forward     boolean not null default false,            -- approved AND asked to escalate to the next level
  decided_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  primary key (request_id, approver_id)
);
create index if not exists leave_request_approvers_approver_idx on public.leave_request_approvers(approver_id, decision);

comment on table public.leave_request_approvers is
  'One row per Team Lead a leave/WFH request needs (APC whose live brands span 2+ TLs). A snapshot taken at submit time; never recalculated. superseded = the request was decided without this TL (a peer rejected, or the Boss decided).';

alter table public.leave_request_approvers enable row level security;
-- Supabase grants every new table to anon/authenticated by default (see mig 359).
-- Reads only, and only signed-in: all writes go through the security-definer functions.
revoke all on public.leave_request_approvers from public, anon;
revoke insert, update, delete, truncate on public.leave_request_approvers from authenticated;
grant select on public.leave_request_approvers to authenticated;
grant all on public.leave_request_approvers to service_role;

create or replace function public.leave_is_approver(p_request uuid, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.leave_request_approvers where request_id = p_request and approver_id = p_uid);
$$;
revoke all on function public.leave_is_approver(uuid, uuid) from public, anon;
grant execute on function public.leave_is_approver(uuid, uuid) to authenticated, service_role;

-- Read-only for everyone: the requester, every TL on the request (so each sees the
-- others' decisions), the Boss, OL and developer. Writes happen only inside
-- leave_decide / the seed trigger (security definer); there is no write policy.
drop policy if exists leave_approvers_select on public.leave_request_approvers;
create policy leave_approvers_select on public.leave_request_approvers
  for select to authenticated using (
    approver_id = auth.uid()
    or public.leave_is_approver(request_id, auth.uid())
    or exists (select 1 from public.leave_requests r where r.id = request_id and r.requester_id = auth.uid())
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active and p.role in ('ol','developer'))
  );

-- Seed on submit. Only when 2+ distinct TLs own the APC's live brands; otherwise
-- there are no rows and every function below behaves exactly as before.
-- Named to sort BEFORE leave_notify_ai (same-event triggers fire alphabetically),
-- so the insert notification can fan out to the rows.
create or replace function public.leave_seed_approvers()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status <> 'pending' then return new; end if;
  if not exists (select 1 from public.profiles where id = new.requester_id and role in ('apc','ipc')) then return new; end if;
  if (select count(*) from public.apc_brand_team_leads(new.requester_id)) < 2 then return new; end if;

  insert into public.leave_request_approvers (request_id, approver_id, brands)
  select new.id, t.tl_id, t.brands from public.apc_brand_team_leads(new.requester_id) t
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists leave_approvers_seed_ai on public.leave_requests;
create trigger leave_approvers_seed_ai
  after insert on public.leave_requests
  for each row execute function public.leave_seed_approvers();

-- The chain's resolved approver. For a request that needs several TLs there is no
-- single approver at level 1: returning null also closes the leave_update policy,
-- which would otherwise let reports_to approve the row directly and skip the rest.
create or replace function public.leave_current_approver(p_request_id uuid)
returns uuid
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_req       record;
  v_cur       uuid;
  v_i         int;
  v_boss      uuid;
begin
  select requester_id, current_level, status
    into v_req
    from public.leave_requests
    where id = p_request_id;

  if not found or v_req.status <> 'pending' then return null; end if;

  -- mig 428: several TLs decide this one together (leave_decide); nobody alone.
  if v_req.current_level = 1
     and exists (select 1 from public.leave_request_approvers where request_id = p_request_id) then
    return null;
  end if;

  select id into v_boss from public.profiles
   where role = 'boss' and is_active = true
   order by created_at asc limit 1;

  -- Ads Managers: straight to the Boss, whoever they report to.
  if exists (select 1 from public.profiles where id = v_req.requester_id and role = 'ads_manager') then
    return v_boss;
  end if;

  v_cur := v_req.requester_id;
  for v_i in 1..v_req.current_level loop
    select reports_to into v_cur from public.profiles where id = v_cur;
    if v_cur is null then
      return v_boss;  -- chain ended early, Boss is the final arbiter
    end if;
  end loop;

  -- If we climbed the full ladder and the person is the same as the
  -- requester (possible on Boss self-requests), return Boss itself.
  if v_cur = v_req.requester_id then return v_boss; end if;
  return v_cur;
end;
$function$;

drop policy if exists leave_select on public.leave_requests;
create policy leave_select on public.leave_requests
  for select using (
    auth.uid() = requester_id
    or auth.uid() = public.leave_current_approver(id)
    or auth.uid() = public.leave_approver(requester_id)
    or public.leave_is_approver(id, auth.uid())          -- mig 428: every required TL, before AND after deciding
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

create or replace function public.leave_decide(p_request_id uuid, p_action text, p_note text default null)
returns public.leave_requests
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_req         public.leave_requests;
  v_me          uuid := auth.uid();
  v_approver    uuid;
  v_name        text;
  v_decisions   jsonb;
  v_new_level   int;
  v_requester   public.profiles%rowtype;
  v_me_role     text;
  v_me_active   boolean := false;
  v_authorized  boolean := false;
  v_multi       boolean;
  v_boss        boolean;
  v_row         public.leave_request_approvers;
  v_outstanding int;
  v_escalate    boolean;
  v_other       uuid;
  v_label       text;
  v_brands      text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  -- The lock that makes "everyone approved" a single, race-free decision: two TLs
  -- approving at the same instant queue here and the second one sees the first.
  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found                  then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'  then raise exception 'request already decided (status=%)', v_req.status; end if;

  v_boss  := public.is_boss(v_me);
  v_multi := v_req.current_level = 1
             and exists (select 1 from public.leave_request_approvers where request_id = p_request_id);
  v_approver := public.leave_current_approver(p_request_id);

  -- (1) Boss can always act, and the Boss's decision is final
  if v_boss then
    v_authorized := true;
  -- (1b) several TLs: only a TL who still has a pending row on this request
  elsif v_multi then
    select * into v_row from public.leave_request_approvers
     where request_id = p_request_id and approver_id = v_me and decision = 'pending' for update;
    v_authorized := found;
  -- (2) The chain's resolved approver can act
  elsif v_approver = v_me then
    v_authorized := true;
  else
    -- (3) Any active OL can act on a TL/PCTL level-1 request
    select * into v_requester from public.profiles where id = v_req.requester_id;
    if found and v_req.current_level = 1 and v_requester.role in ('tl', 'pctl') then
      select role, (is_active = true and deleted_at is null)
        into v_me_role, v_me_active
        from public.profiles
       where id = v_me;
      if v_me_active and v_me_role = 'ol' then
        v_authorized := true;
      end if;
    end if;
  end if;

  if not v_authorized then
    raise exception 'not authorized to decide this request';
  end if;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');
  v_decisions := v_req.decisions || jsonb_build_array(jsonb_build_object(
    'level',   v_req.current_level,
    'action',  p_action,
    'by',      v_me,
    'by_name', v_name,
    'at',      to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'note',    p_note
  ));

  -- ===== several Team Leads: record this TL's decision against the same request =====
  if v_multi and not v_boss then
    if p_action not in ('approve', 'reject', 'forward') then raise exception 'invalid action: %', p_action; end if;

    update public.leave_request_approvers
       set decision   = case when p_action = 'reject' then 'rejected' else 'approved' end,
           forward    = (p_action = 'forward'),
           decided_at = now(),
           note       = p_note
     where request_id = p_request_id and approver_id = v_me;

    v_label := coalesce(v_req.other_title, case v_req.type when 'wfh' then 'WFH' when 'half_leave' then 'half-day leave' else v_req.type || ' leave' end);

    if p_action = 'reject' then
      -- Any rejection is final. The TLs who had not decided are superseded, not approved.
      update public.leave_request_approvers set decision = 'superseded'
       where request_id = p_request_id and decision = 'pending';
      update public.leave_requests
         set status = 'rejected', decided_by = v_me, decided_at = now(),
             decision_note = p_note, decisions = v_decisions
       where id = p_request_id
       returning * into v_req;
      for v_other in select approver_id from public.leave_request_approvers
                      where request_id = p_request_id and approver_id <> v_me loop
        perform public.emit_notification(v_other, v_me, 'leave', 'leave.rejected_by_peer',
          'Leave request rejected',
          v_name || ' rejected ' || public.profile_display_name(v_req.requester_id) || '''s ' || v_label || ' request.',
          'leave', p_request_id, '/leave/approvals');
      end loop;
      return v_req;
    end if;

    select count(*) filter (where decision = 'pending'), coalesce(bool_or(forward), false)
      into v_outstanding, v_escalate
      from public.leave_request_approvers where request_id = p_request_id;

    if v_outstanding > 0 then
      -- Still waiting on someone: the request stays pending at level 1. The decision
      -- is appended so the row changes and anything subscribed to it refreshes.
      update public.leave_requests set decisions = v_decisions
       where id = p_request_id returning * into v_req;
      perform public.emit_notification(v_req.requester_id, v_me, 'leave', 'leave.partially_approved',
        'Leave partly approved',
        v_name || ' approved your ' || v_label || ' (' || v_outstanding || ' approval' || case when v_outstanding = 1 then '' else 's' end || ' still to come).',
        'leave', p_request_id, '/leave');
    elsif v_escalate then
      -- Every TL has approved and at least one asked to escalate: only now does it move up.
      v_new_level := v_req.current_level + 1;
      update public.leave_requests set current_level = v_new_level, decisions = v_decisions
       where id = p_request_id returning * into v_req;
    else
      update public.leave_requests
         set status = 'approved', decided_by = v_me, decided_at = now(),
             decision_note = p_note, decisions = v_decisions
       where id = p_request_id
       returning * into v_req;
      -- Tell every required TL what is now settled and which of their brands are covered.
      for v_other in select approver_id from public.leave_request_approvers where request_id = p_request_id loop
        select string_agg(x ->> 'name', ', ' order by x ->> 'name') into v_brands
          from public.leave_request_approvers a, jsonb_array_elements(a.brands) x
         where a.request_id = p_request_id and a.approver_id = v_other;
        if v_other <> v_me then
          perform public.emit_notification(v_other, v_me, 'leave', 'leave.fully_approved',
            'Leave approved',
            public.profile_display_name(v_req.requester_id) || '''s ' || v_label || ' is approved by all Team Leads'
              || coalesce(' — not working on ' || v_brands, '') || '.',
            'leave', p_request_id, '/leave/approvals');
        end if;
      end loop;
    end if;
    return v_req;
  end if;

  -- ===== existing single-chain behaviour =====
  -- A Boss decision on a several-TL request is final: nobody is left to decide.
  if v_multi then
    update public.leave_request_approvers set decision = 'superseded'
     where request_id = p_request_id and decision = 'pending';
  end if;

  if p_action = 'approve' then
    update public.leave_requests
       set status        = 'approved',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'reject' then
    update public.leave_requests
       set status        = 'rejected',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'forward' then
    v_new_level := v_req.current_level + 1;
    if v_new_level > 3 then raise exception 'already at top of approval chain'; end if;
    update public.leave_requests
       set current_level = v_new_level,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  else
    raise exception 'invalid action: %', p_action;
  end if;

  return v_req;
end;
$function$;

-- Insert notification: fan out to every required TL when the request needs several.
create or replace function public.leave_notify_on_insert()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_requester_role text;
  v_name           text;
  v_label          text;
  v_title          text;
  v_body           text;
  v_recipient      uuid;
begin
  select role into v_requester_role
    from public.profiles
   where id = new.requester_id;

  v_name  := public.profile_display_name(new.requester_id);
  v_label := case new.type
    when 'wfh'        then 'WFH'
    when 'medical'    then 'medical leave'
    when 'emergency'  then 'emergency leave'
    when 'half_leave' then 'half-day leave'
    when 'other'      then coalesce(new.other_title, 'time off')
    else new.type
  end;
  v_title := 'New leave request';
  v_body  := v_name || ' requested ' || v_label || ' ('
    || to_char(new.start_date, 'Mon DD')
    || case when new.end_date <> new.start_date then ' – ' || to_char(new.end_date, 'Mon DD') else '' end
    || ')';

  -- TL/PCTL submissions at level 1 → fan out to ALL active OLs.
  -- Mirrors mig 193's broadened auth rule.
  if v_requester_role in ('tl', 'pctl') and new.current_level = 1 then
    for v_recipient in
      select id from public.profiles
       where role = 'ol'
         and is_active = true
         and deleted_at is null
         and id <> new.requester_id
    loop
      perform public.emit_notification(
        v_recipient, new.requester_id, 'leave', 'leave.requested',
        v_title, v_body,
        'leave', new.id, '/leave/approvals'
      );
    end loop;
    return new;
  end if;

  -- mig 428: every Team Lead the request needs, with the brands it affects.
  if exists (select 1 from public.leave_request_approvers where request_id = new.id) then
    for v_recipient in select approver_id from public.leave_request_approvers where request_id = new.id loop
      perform public.emit_notification(
        v_recipient, new.requester_id, 'leave', 'leave.requested',
        v_title,
        v_body || ' — needs approval from all of their Team Leads'
          || coalesce(' (your brands: ' || (select string_agg(x ->> 'name', ', ' order by x ->> 'name')
                from public.leave_request_approvers a, jsonb_array_elements(a.brands) x
               where a.request_id = new.id and a.approver_id = v_recipient) || ')', ''),
        'leave', new.id, '/leave/approvals'
      );
    end loop;
    return new;
  end if;

  -- All other roles use the chain-resolved approver (APC → TL,
  -- IPC → PCTL, OL → Boss, etc.).
  v_recipient := public.leave_current_approver(new.id);
  if v_recipient is null or v_recipient = new.requester_id then return new; end if;
  perform public.emit_notification(
    v_recipient, new.requester_id, 'leave', 'leave.requested',
    v_title, v_body,
    'leave', new.id, '/leave/approvals'
  );
  return new;
end;
$function$;


-- ---- 4. verification (structure; behaviour is covered by the rollback test) ---------------
do $verify$
declare n int;
begin
  -- every active APC/IPC with a TL is on that TL's team
  select count(*) into n from public.profiles p
   where p.role in ('apc','ipc') and p.is_active and p.deleted_at is null and p.reports_to is not null
     and not exists (select 1 from public.apc_team_leads v where v.apc_id = p.id and v.tl_id = p.reports_to);
  if n <> 0 then raise exception 'mig 428: % APC(s) missing from their reports_to team', n; end if;

  -- invariant: whoever runs a live permanent brand is on its Team Lead's team
  select count(*) into n
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id and p.role in ('apc','ipc') and p.is_active and p.deleted_at is null
    join public.brands b on b.id = ba.brand_id and b.status <> 'inactive'
    join public.profiles o on o.id = b.owner_id and o.role in ('tl','pctl') and o.is_active
   where ba.expires_at is null
     and not exists (select 1 from public.apc_team_leads v where v.apc_id = p.id and v.tl_id = b.owner_id);
  if n <> 0 then raise exception 'mig 428: % brand holding(s) are not on their brand''s TL team', n; end if;

  if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                  where s.nspname = 'public' and p.proname = 'brand_switch_apc'
                    and pg_get_functiondef(p.oid) like '%apc_brand_owner%') then
    raise exception 'mig 428: brand_switch_apc was not patched';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                  where s.nspname = 'public' and p.proname = 'leave_decide'
                    and pg_get_functiondef(p.oid) like '%leave_request_approvers%') then
    raise exception 'mig 428: leave_decide was not replaced';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.leave_request_approvers'::regclass) then
    raise exception 'mig 428: leave_request_approvers has no RLS';
  end if;
  if has_table_privilege('anon', 'public.apc_team_leads', 'SELECT')
     or has_table_privilege('anon', 'public.leave_request_approvers', 'SELECT')
     or has_function_privilege('anon', 'public.leave_is_approver(uuid,uuid)', 'EXECUTE') then
    raise exception 'mig 428: anon can reach the new objects';
  end if;
  raise notice '428 verified: % derived team links.', (select count(*) from public.apc_team_leads);
end $verify$;
