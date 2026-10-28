-- ============================================================
-- WurxOS v2 — Migration 428: an APC can work under more than one Team Lead.
--
-- THE GAP: profiles.reports_to is ONE column, so an APC has exactly one TL.
-- Real teams are not that tidy -- Abrahim runs JoyMode (Ali Hamza's brand) AND
-- Inno Supps (Haider Ali's). Until now he showed only under Ali Hamza, Haider's
-- team page did not list him, and Haider's brand form silently pruned him from
-- his own brand's APC picker.
--
-- THE MODEL
--   brands.owner_id       = the brand's Team Lead. Unchanged, and the ONLY
--                           source for "which TL does this brand belong to".
--   profiles.reports_to   = the APC's PRIMARY TL. Unchanged: attendance, leave,
--                           incentive and performance routing all walk it, and
--                           moving them would change TL scores and approvers.
--   apc_team_leads (new)  = EVERY TL an APC works under, primary included. Team
--                           lists, brand pickers and the org chart read this. A
--                           trigger keeps the primary row in step with reports_to
--                           so the two cannot drift.
--
-- THE TRAP THIS FIXES: brand_assign_apc / brand_switch_apc / team_move_brand all
-- stamp brands.owner_id (or reports_to) from the target APC's reports_to. With one
-- TL per APC that was right; with two, assigning Abrahim to Haider's brand would
-- re-own it to Ali Hamza. Each now keeps the brand's current owner when it is one
-- of the APC's TLs and falls back to reports_to otherwise -- a single-team APC
-- behaves exactly as before.
--
-- The patched functions are the LIVE bodies (pg_get_functiondef), each patch
-- asserted to match exactly once -- not the migration files that first built them.
-- Idempotent.
-- ============================================================

-- ---- 1. table ---------------------------------------------------------------
create table if not exists public.apc_team_leads (
  apc_id      uuid not null references public.profiles(id) on delete cascade,
  tl_id       uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid references public.profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (apc_id, tl_id)
);
create index if not exists apc_team_leads_tl_idx on public.apc_team_leads(tl_id);

comment on table public.apc_team_leads is
  'Every Team Lead an APC/IPC works under, primary (profiles.reports_to) included. Written only by the sync trigger and add_apc_tl/remove_apc_tl.';

alter table public.apc_team_leads enable row level security;
-- Same visibility as profiles (any signed-in user): these rows are names a team
-- page already shows. No write policy, so writes go through the RPCs below only.
drop policy if exists apc_team_leads_select on public.apc_team_leads;
create policy apc_team_leads_select on public.apc_team_leads
  for select to authenticated using (true);

-- ---- 2. helpers -------------------------------------------------------------
create or replace function public.apc_tl_ids(p_apc uuid)
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(tl_id), '{}'::uuid[]) from public.apc_team_leads where apc_id = p_apc;
$$;

-- Who owns a brand this APC is being given: the brand's current owner when it is
-- already one of the APC's TLs, else the APC's primary TL (the old rule).
create or replace function public.apc_brand_owner(p_apc uuid, p_current_owner uuid)
returns uuid
language sql stable security definer set search_path = public
as $$
  select case
    when p_current_owner is not null and exists (
      select 1 from public.apc_team_leads where apc_id = p_apc and tl_id = p_current_owner
    ) then p_current_owner
    else (select reports_to from public.profiles where id = p_apc)
  end;
$$;

-- ---- 3. keep the primary link in step with reports_to ---------------------------
create or replace function public.sync_apc_primary_tl()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.role not in ('apc','ipc') or new.reports_to is null then return new; end if;

  insert into public.apc_team_leads (apc_id, tl_id) values (new.id, new.reports_to)
  on conflict do nothing;

  -- A move: the old primary stops being a link, unless this person still
  -- permanently holds a live brand that TL owns -- they still work under them.
  if tg_op = 'UPDATE' and old.reports_to is not null and old.reports_to <> new.reports_to then
    delete from public.apc_team_leads l
     where l.apc_id = new.id and l.tl_id = old.reports_to
       and not exists (
         select 1 from public.brand_assignments ba join public.brands b on b.id = ba.brand_id
          where ba.user_id = new.id and ba.expires_at is null
            and b.status <> 'inactive' and b.owner_id = old.reports_to);
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sync_apc_primary_tl on public.profiles;
create trigger profiles_sync_apc_primary_tl
  after insert or update of reports_to, role on public.profiles
  for each row execute function public.sync_apc_primary_tl();

-- ---- 3b. a TL who owns a brand an APC holds is one of that APC's TLs --------------
-- Brand ownership and assignment change through many paths (BrandForm, the assign
-- modal, the RPCs below). Linking here, not in each path, is what keeps "the APC
-- works a live brand under TL X" and "the APC is on X's team" from drifting.
--
-- DEFERRED to commit, and re-reading current state rather than trusting NEW: the
-- swap and move RPCs change brands.owner_id BEFORE they delete and re-insert the
-- assignments, so a trigger acting on the row it was fired for would link the
-- OUTGOING APC (and any IPC) to the incoming owner's team. At commit the brand has
-- one owner and one set of holders, whatever order the statements ran in.
-- Drop a TL's DERIVED links that have lost their cause. Never the primary
-- (reports_to) and never a link a Boss/OL added by hand (assigned_by set).
create or replace function public.prune_derived_tl_links(p_tl uuid)
returns void
language sql security definer set search_path = public
as $$
  delete from public.apc_team_leads l
   using public.profiles p
   where l.tl_id = p_tl and l.assigned_by is null
     and p.id = l.apc_id and p.reports_to is distinct from l.tl_id
     and not exists (
       select 1 from public.brand_assignments ba join public.brands b on b.id = ba.brand_id
        where ba.user_id = l.apc_id and ba.expires_at is null
          and b.status <> 'inactive' and b.owner_id = l.tl_id);
$$;

create or replace function public.link_holder_to_brand_owner()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_brand uuid;
begin
  if tg_table_name = 'brands' then v_brand := new.id; else v_brand := new.brand_id; end if;
  insert into public.apc_team_leads (apc_id, tl_id)
  select ba.user_id, b.owner_id
    from public.brands b
    join public.brand_assignments ba on ba.brand_id = b.id and ba.expires_at is null   -- temp cover is not a team
    join public.profiles p on p.id = ba.user_id and p.role in ('apc','ipc')
    join public.profiles o on o.id = b.owner_id and o.role in ('tl','pctl')
   where b.id = v_brand and b.status <> 'inactive'
  on conflict do nothing;

  -- A brand that left a TL (new owner, or gone inactive) may have been the only
  -- thing tying its holders to that team.
  if tg_table_name = 'brands' then
    perform public.prune_derived_tl_links(old.owner_id);
    perform public.prune_derived_tl_links(new.owner_id);
  end if;
  return null;
end;
$$;

drop trigger if exists brand_assignments_link_tl on public.brand_assignments;
create constraint trigger brand_assignments_link_tl
  after insert or update of expires_at on public.brand_assignments
  deferrable initially deferred
  for each row execute function public.link_holder_to_brand_owner();

drop trigger if exists brands_link_holders_to_owner on public.brands;
create constraint trigger brands_link_holders_to_owner
  after update of owner_id, status on public.brands
  deferrable initially deferred
  for each row execute function public.link_holder_to_brand_owner();

-- The other half: when a holding goes away the link it caused goes with it --
-- but only a DERIVED link. The primary TL (reports_to) and any link a Boss/OL
-- added by hand (assigned_by set) are never removed here. BrandSwitcher changes
-- the owner and drops the APCs in two separate requests, so deferral alone
-- cannot cover it.
create or replace function public.unlink_holder_from_brand_owner()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.expires_at is not null then return old; end if;
  delete from public.apc_team_leads l
   using public.brands b, public.profiles p
   where b.id = old.brand_id and l.apc_id = old.user_id and l.tl_id = b.owner_id
     and p.id = old.user_id and p.reports_to is distinct from l.tl_id
     and l.assigned_by is null
     and not exists (
       select 1 from public.brand_assignments ba join public.brands b2 on b2.id = ba.brand_id
        where ba.user_id = old.user_id and ba.expires_at is null and ba.brand_id <> old.brand_id
          and b2.status <> 'inactive' and b2.owner_id = l.tl_id);
  return old;
end;
$$;

drop trigger if exists brand_assignments_unlink_tl on public.brand_assignments;
create trigger brand_assignments_unlink_tl
  after delete on public.brand_assignments
  for each row execute function public.unlink_holder_from_brand_owner();

-- ---- 4. backfill (triggers are not retroactive) -------------------------------
-- (a) everybody's primary TL
insert into public.apc_team_leads (apc_id, tl_id)
select id, reports_to from public.profiles
 where role in ('apc','ipc') and reports_to is not null and deleted_at is null
on conflict do nothing;
-- (b) a TL who owns a live brand the APC permanently holds. Temporary cover
-- (expires_at set) is time-boxed leave cover, not a team.
insert into public.apc_team_leads (apc_id, tl_id)
select distinct ba.user_id, b.owner_id
  from public.brand_assignments ba
  join public.profiles p on p.id = ba.user_id and p.role in ('apc','ipc') and p.is_active and p.deleted_at is null
  join public.brands b on b.id = ba.brand_id and b.status <> 'inactive'
  join public.profiles o on o.id = b.owner_id and o.role in ('tl','pctl') and o.is_active
 where ba.expires_at is null
on conflict do nothing;

-- ---- 5. RPCs: link / unlink (Boss/OL) -------------------------------------------
create or replace function public.add_apc_tl(p_apc uuid, p_tl uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_apc public.profiles%rowtype;
  v_tl  public.profiles%rowtype;
  v_added int;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can assign team leads' using errcode = '42501';
  end if;
  select * into v_apc from public.profiles where id = p_apc and is_active and deleted_at is null;
  if not found or v_apc.role not in ('apc','ipc') then raise exception 'APC not found, inactive, or not an APC/IPC'; end if;
  select * into v_tl from public.profiles where id = p_tl and is_active and deleted_at is null;
  if not found or v_tl.role not in ('tl','pctl') then raise exception 'Team Lead not found, inactive, or not a TL/PCTL'; end if;

  -- An existing DERIVED link (assigned_by null) is upgraded to explicit, so the
  -- brand-drop cleanup never removes something a person chose.
  insert into public.apc_team_leads (apc_id, tl_id, assigned_by) values (p_apc, p_tl, v_caller)
  on conflict (apc_id, tl_id) do update set assigned_by = excluded.assigned_by, assigned_at = now()
   where public.apc_team_leads.assigned_by is null;
  get diagnostics v_added = row_count;
  if v_added = 0 then return p_apc; end if;   -- already linked: no audit row for a non-event

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (v_caller, 'team.apc_link_tl', 'profiles', p_apc,
          jsonb_build_object('team_leads', (select coalesce(jsonb_agg(tl_id), '[]'::jsonb) from public.apc_team_leads where apc_id = p_apc and tl_id <> p_tl)),
          jsonb_build_object('added_tl', p_tl));

  if p_tl <> v_caller then
    perform public.emit_notification(p_tl, v_caller, 'team', 'team.apc_linked', 'Team change',
      public.profile_display_name(v_caller) || ' added ' || coalesce(v_apc.display_name, 'an APC') || ' to your team',
      'profiles', p_apc, case when v_tl.role = 'tl' then '/tl/team' end);
  end if;
  return p_apc;
end;
$$;

create or replace function public.remove_apc_tl(p_apc uuid, p_tl uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_primary uuid;
  v_held text;
begin
  if not public._team_mgr_authz(v_caller) then
    raise exception 'only Boss/OL can assign team leads' using errcode = '42501';
  end if;
  select reports_to into v_primary from public.profiles where id = p_apc;
  if v_primary = p_tl then
    raise exception 'That is this APC''s primary Team Lead -- use Reassign Team Lead to move them instead.';
  end if;

  select string_agg(b.brand_name, ', ' order by b.brand_name) into v_held
    from public.brand_assignments ba join public.brands b on b.id = ba.brand_id
   where ba.user_id = p_apc and ba.expires_at is null and b.status <> 'inactive' and b.owner_id = p_tl;
  if v_held is not null then
    raise exception 'Still manages % for this Team Lead -- move or reassign those brands first.', v_held;
  end if;

  delete from public.apc_team_leads where apc_id = p_apc and tl_id = p_tl;
  if not found then return p_apc; end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (v_caller, 'team.apc_unlink_tl', 'profiles', p_apc,
          jsonb_build_object('removed_tl', p_tl), jsonb_build_object('primary_tl', v_primary));
  return p_apc;
end;
$$;

do $g$
declare f text;
begin
  foreach f in array array['add_apc_tl(uuid,uuid)','remove_apc_tl(uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke all on function public.%s from anon', f);   -- by name: see mig 359
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $g$;

-- ---- 6. live functions, patched --------------------------------------------------
-- brand_assign_apc: keep the brand's TL when it is one of the target APC's TLs
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
  v_new_tl := public.apc_brand_owner(p_new_apc, v_brand.owner_id);  -- mig 428
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

-- brand_switch_apc: the swap re-owns each moved brand per brand, not from reports_to
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

-- team_move_brand: a pinned APC who still holds brands under their primary TL gains a link, not a new reports_to
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
      -- mig 428: still holds brands under their primary TL, so this is a second
      -- team, not a move. Link instead of re-pointing reports_to.
      with ins as (
        insert into public.apc_team_leads (apc_id, tl_id, assigned_by)
        values (p_new_apc, p_new_tl, v_caller) on conflict do nothing returning 1
      )
      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      select v_caller, 'team.apc_link_tl', 'profiles', p_new_apc,
             jsonb_build_object('primary_tl', v_apc_old_reports_to),
             jsonb_build_object('added_tl', p_new_tl, 'via', 'team_move_brand')
        from ins;
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

-- team_move_apc_to_tl: brands owned by the APC's OTHER team leads stay put when the primary moves
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

-- ---- 7. verification (structure + backfill; behaviour is covered by the rollback test) ----
do $verify$
declare n int; r record;
begin
  -- every active APC/IPC with a primary TL has that link
  select count(*) into n from public.profiles p
   where p.role in ('apc','ipc') and p.reports_to is not null and p.deleted_at is null
     and not exists (select 1 from public.apc_team_leads l where l.apc_id = p.id and l.tl_id = p.reports_to);
  if n <> 0 then raise exception 'mig 428: % APC(s) are missing their primary-TL link', n; end if;

  -- invariant: a live permanent brand's owner is always one of the holder's TLs
  select count(*) into n
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id and p.role in ('apc','ipc') and p.is_active and p.deleted_at is null
    join public.brands b on b.id = ba.brand_id and b.status <> 'inactive'
    join public.profiles o on o.id = b.owner_id and o.role in ('tl','pctl') and o.is_active
   where ba.expires_at is null
     and not exists (select 1 from public.apc_team_leads l where l.apc_id = p.id and l.tl_id = b.owner_id);
  if n <> 0 then raise exception 'mig 428: % brand holding(s) have an owner the APC is not linked to', n; end if;

  for r in select proname from (values ('brand_assign_apc'),('brand_switch_apc')) v(proname) loop
    if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                    where s.nspname = 'public' and p.proname = r.proname
                      and pg_get_functiondef(p.oid) like '%apc_brand_owner%') then
      raise exception 'mig 428: % was not patched', r.proname;
    end if;
  end loop;
  if not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                  where s.nspname = 'public' and p.proname = 'team_move_brand'
                    and pg_get_functiondef(p.oid) like '%apc_team_leads%') then
    raise exception 'mig 428: team_move_brand was not patched';
  end if;
  if has_function_privilege('anon', 'public.add_apc_tl(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.remove_apc_tl(uuid,uuid)', 'EXECUTE') then
    raise exception 'mig 428: anon can execute the team-lead RPCs';
  end if;
  raise notice '428 verified: % links.', (select count(*) from public.apc_team_leads);
end $verify$;
