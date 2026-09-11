-- ============================================================
-- WurxOS v2 — Migration 360: assign a brand to an APC WITHOUT swapping.
--
-- Until now the Brand Switcher had one action. Picking APC2 for a brand held
-- by APC1 ran brand_switch_apc, which is a BILATERAL SWAP (mig 049): every
-- brand APC1 holds goes to APC2 and every brand APC2 holds goes to APC1.
--
--   APC1 = {b1}, APC2 = {b2}. Switch b1 to APC2:
--     swap   (existing)  →  APC2 = {b1}       APC1 = {b2}
--     assign (this mig)  →  APC2 = {b1, b2}   APC1 = {}
--
-- An OL who only wanted to hand one brand over had no way to do it: the swap
-- took APC2's own book of business away as a side effect. This adds the
-- one-way action alongside the swap; the swap is unchanged in what it moves.
--
-- Four parts:
--   1. brand_assign_apc()               — the new one-way RPC
--   2. brand_switch_requests.mode       — the OL→Boss request carries which one
--   3. bsr_apply_decision()             — approval dispatches on that mode
--   4. cascade_brand_owner_to_apcs()    — honours a skip flag (assign sets it)
--   5. brand_switch_apc() old-APC pick  — same-role permanent assignee only
--
-- Safe to re-run.
-- ============================================================


-- ============================================================
-- 1. brand_assign_apc — move ONE brand to a new APC
-- ============================================================
--
-- ── WHO IS REPLACED ────────────────────────────────────────────────────────
-- Only the brand's PERMANENT assignees in the SAME ROLE as the target — i.e.
-- assigning an APC replaces the brand's APC, and nothing else on the brand is
-- touched:
--
--   * IPCs stay. Since mig 359 an IPC sees a brand only through a
--     brand_assignments row, and can_view_brand reads that table for every
--     role — so deleting "all assignments on the brand", which is what
--     brand_switch_apc does, silently revokes every IPC's access to the brand,
--     its reports, tasks, resources, agenda and checkpoints.
--   * Temporary cover stays. A row with expires_at set is time-boxed leave
--     cover (mig 210); it ends on its own schedule and is not the APC being
--     replaced.
--
-- ── WHY THE OWNER CASCADE IS SKIPPED ───────────────────────────────────────
-- Changing brands.owner_id fires cascade_brand_owner_to_apcs (mig 190), which
-- sets reports_to = new owner for every APC/IPC whose ONLY brand is this one.
-- Here that is wrong in every case it would touch:
--   * the target already reports to the new owner (owner IS their TL) — no-op;
--   * a kept IPC reports to a PCTL, and would be moved under an affiliate TL;
--   * kept temporary cover would be moved onto another team.
-- This RPC sets every relationship itself, so it tells the cascade to stand
-- down for the length of this transaction. Every other caller is unaffected:
-- the flag is unset for them and the cascade behaves exactly as before.
--
-- ── WHAT MOVES WITH THE BRAND ──────────────────────────────────────────────
-- Same rule as the swap (migs 138/170/176), applied to this brand only: open
-- tasks, reports, brand resources, open agenda tasks and agenda resources held
-- by the replaced APC(s) move to the target. An assign and a swap must not
-- disagree about what "this brand now belongs to someone else" means.
-- ============================================================

create or replace function public.brand_assign_apc(
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
  v_new_tl := v_new_apc.reports_to;
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
$$;

comment on function public.brand_assign_apc(uuid, uuid, text, boolean) is
  'One-way brand move: the brand goes to p_new_apc, who keeps every brand they already hold; the replaced same-role permanent assignee(s) lose this brand only. IPCs and temporary cover on the brand are left in place. Contrast brand_switch_apc, which swaps both APCs'' whole portfolios.';

-- anon BY NAME: Supabase grants EXECUTE on every new function and
-- "revoke from public" does not undo that (see mig 359).
do $g$
begin
  revoke all on function public.brand_assign_apc(uuid, uuid, text, boolean) from public;
  revoke all on function public.brand_assign_apc(uuid, uuid, text, boolean) from anon;
  grant execute on function public.brand_assign_apc(uuid, uuid, text, boolean) to authenticated;
  grant execute on function public.brand_assign_apc(uuid, uuid, text, boolean) to service_role;
end;
$g$;


-- ============================================================
-- 2. brand_switch_requests.mode — the request carries which action
-- ============================================================
-- Defaults to 'swap' so every row that already exists keeps the meaning it was
-- created with: those requests were written when swap was the only action, and
-- the person who approves them was shown a swap.
alter table public.brand_switch_requests
  add column if not exists mode text not null default 'swap';

do $c$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'brand_switch_requests_mode_check'
       and conrelid = 'public.brand_switch_requests'::regclass
  ) then
    alter table public.brand_switch_requests
      add constraint brand_switch_requests_mode_check check (mode in ('swap', 'assign'));
  end if;
end;
$c$;

comment on column public.brand_switch_requests.mode is
  'swap = brand_switch_apc (both APCs exchange whole portfolios); assign = brand_assign_apc (this brand only, target keeps their own).';


-- ============================================================
-- 3. bsr_apply_decision — dispatch on mode
-- ============================================================
-- Mig 048's body VERBATIM except the to_apc_id branch, which now picks the RPC
-- from the request's mode instead of always swapping.
create or replace function public.bsr_apply_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_brand text;
begin
  if old.status is distinct from new.status and new.status = 'approved' then
    if new.to_apc_id is not null then
      if new.mode = 'assign' then
        perform public.brand_assign_apc(
          new.brand_id,
          new.to_apc_id,
          coalesce(nullif(new.decision_note, ''), new.reason),
          new.notify_on_approve
        );
      else
        perform public.brand_switch_apc(
          new.brand_id,
          new.to_apc_id,
          coalesce(nullif(new.decision_note, ''), new.reason),
          new.notify_on_approve
        );
      end if;
    elsif new.to_owner_id is not null then
      perform set_config('wurxos.bypass_owner_guard', 'on', true);
      update public.brands set owner_id = new.to_owner_id where id = new.brand_id;
      perform set_config('wurxos.bypass_owner_guard', 'off', true);
    end if;

    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_approved',
      'Brand switch approved',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was approved.',
      'brand', new.brand_id, '/brand-switcher'
    );
  elsif old.status is distinct from new.status and new.status = 'rejected' then
    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_rejected',
      'Brand switch rejected',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was rejected.',
      'brand', new.brand_id, '/brand-switcher'
    );
  end if;
  return new;
end;
$$;


-- ============================================================
-- 4. cascade_brand_owner_to_apcs — honour wurxos.skip_owner_cascade
-- ============================================================
-- Mig 319's body VERBATIM plus one early return. The flag is set only by
-- brand_assign_apc, transaction-locally; for every other caller it is unset
-- and the cascade runs exactly as it did.
create or replace function public.cascade_brand_owner_to_apcs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_profiles int := 0;
  v_updated_tasks    int := 0;
begin
  -- mig 360: a caller that sets every relationship itself opts out.
  if coalesce(current_setting('wurxos.skip_owner_cascade', true), 'off') = 'on' then
    return new;
  end if;

  if old.owner_id is distinct from new.owner_id
     and new.owner_id is not null then

    -- Build the eligible-APC set: single-brand APC/IPCs assigned
    -- to THIS brand.
    create temp table if not exists tmp_eligible_apcs (user_id uuid primary key) on commit drop;
    truncate table tmp_eligible_apcs;   -- mig 319: was an unqualified DELETE
    insert into tmp_eligible_apcs
      select ba.user_id
        from public.brand_assignments ba
        join public.profiles p on p.id = ba.user_id
       where ba.brand_id = new.id
         and p.role in ('apc', 'ipc')
         and p.is_active = true
         and p.deleted_at is null
         and (select count(*) from public.brand_assignments where user_id = ba.user_id) = 1;

    -- (1) reports_to cascade (same as mig 190).
    update public.profiles
       set reports_to = new.owner_id, updated_at = now()
     where id in (select user_id from tmp_eligible_apcs)
       and reports_to is distinct from new.owner_id;
    get diagnostics v_updated_profiles = row_count;

    -- (2) tasks.created_by cascade — NEW in mig 191. Only touches
    -- tasks where the previous created_by equals the previous brand
    -- owner, AND the assignee is in our eligible APC set. That two-
    -- condition gate keeps boss/OL-created cross-team tasks safe.
    update public.tasks
       set created_by = new.owner_id, updated_at = now()
     where brand_id = new.id
       and created_by = old.owner_id
       and assignee_id in (select user_id from tmp_eligible_apcs);
    get diagnostics v_updated_tasks = row_count;

    if v_updated_profiles > 0 or v_updated_tasks > 0 then
      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        auth.uid(), 'brand.cascade_apc_reports_to', 'brands', new.id,
        jsonb_build_object('previous_owner', old.owner_id, 'new_owner', new.owner_id),
        jsonb_build_object(
          'apcs_reassigned',  v_updated_profiles,
          'tasks_rewritten',  v_updated_tasks
        )
      );
    end if;
  end if;
  return new;
end;
$$;


-- ============================================================
-- 5. brand_switch_apc — pick the swap partner the way the UI shows it
-- ============================================================
-- Mig 176's body VERBATIM except the query that picks the old APC.
--
-- It took the EARLIEST-assigned user on the brand, of any role and any expiry.
-- While swap was the only action that was harmless in practice: swap deletes
-- every assignment on each brand it moves, so a switched brand was always left
-- holding exactly one row. brand_assign_apc keeps IPCs and temporary cover, and
-- those usually predate the APC who was just assigned — so after one Assign,
-- the next Swap on that brand would have taken the IPC (or the cover) as "the
-- old APC" and exchanged THEIR entire portfolio. Adding Assign without this
-- change would have made the existing action worse.
--
-- The partner is now the earliest PERMANENT assignee in the SAME ROLE as the
-- target — the APC being swapped with. On a brand with one permanent APC and
-- nobody else, the common case, this selects exactly who it always did.
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
  v_new_tl := v_new_apc.reports_to;
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
$$;
grant execute on function public.brand_switch_apc(uuid, uuid, text, boolean) to authenticated;


-- ============================================================
-- VERIFY — structure only; behaviour is covered by the rollback test
-- ============================================================
do $v$
declare v int;
begin
  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'brand_assign_apc';
  if v <> 1 then raise exception '360: brand_assign_apc missing (found %)', v; end if;

  select count(*) into v from information_schema.columns
   where table_schema = 'public' and table_name = 'brand_switch_requests' and column_name = 'mode';
  if v <> 1 then raise exception '360: brand_switch_requests.mode missing'; end if;

  -- Existing requests must keep the only meaning they could have had.
  select count(*) into v from public.brand_switch_requests where mode <> 'swap';
  if v <> 0 then raise exception '360: % pre-existing request(s) are not mode=swap', v; end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cascade_brand_owner_to_apcs'
       and pg_get_functiondef(p.oid) like '%wurxos.skip_owner_cascade%'
  ) then raise exception '360: cascade does not honour the skip flag'; end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'bsr_apply_decision'
       and pg_get_functiondef(p.oid) like '%brand_assign_apc%'
  ) then raise exception '360: approval trigger does not dispatch to brand_assign_apc'; end if;

  -- The anon grant is exactly what mig 359 warns about.
  if has_function_privilege('anon', 'public.brand_assign_apc(uuid, uuid, text, boolean)', 'EXECUTE') then
    raise exception '360: anon can execute brand_assign_apc';
  end if;

  raise notice '360: brand_assign_apc ready; requests carry a mode; cascade honours the skip flag; swap partner is same-role permanent';
end;
$v$;
