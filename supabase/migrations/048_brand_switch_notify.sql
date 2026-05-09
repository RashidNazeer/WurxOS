-- ============================================================
-- WurxOS v2 — Migration 048: opt-in notifications on brand switch
--
-- Two changes, both driven by user feedback:
--
--   1. Scope — when a brand's APC is switched, only notify the new
--      APC and their Team Lead. The old APC(s) and old TL lose
--      visibility automatically via brand RLS, so paging them here
--      adds noise without useful signal.
--
--   2. Opt-in — brand_switch_apc now accepts a `p_notify` flag
--      (default FALSE). Notifications only fire when the caller
--      explicitly requests them. This matches the UX rule that
--      notifications should never be sent implicitly; the person
--      doing the action has to tick a box.
--
-- The request-approval path (OL submits, Boss approves) carries the
-- same flag via a new `notify_on_approve` column on
-- brand_switch_requests; the decision trigger passes it through.
-- ============================================================

-- --------------------------------------------------------------
-- 1. brand_switch_apc — new signature + scoped + opt-in notify
--    We drop the old function before recreating; the signature
--    changed, so CREATE OR REPLACE can't be used directly.
-- --------------------------------------------------------------
drop function if exists public.brand_switch_apc(uuid, uuid, text);

create or replace function public.brand_switch_apc(
  p_brand   uuid,
  p_new_apc uuid,
  p_note    text default null,
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
  v_old_tl   uuid;
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

  select coalesce(array_agg(user_id), '{}')
    into v_old_apcs
    from public.brand_assignments
    where brand_id = p_brand;
  v_old_tl := v_brand.owner_id;

  perform set_config('wurxos.bypass_owner_guard', 'on', true);
  update public.brands
     set owner_id = v_new_tl
   where id = p_brand;
  perform set_config('wurxos.bypass_owner_guard', 'off', true);

  delete from public.brand_assignments where brand_id = p_brand;
  insert into public.brand_assignments (brand_id, user_id)
    values (p_brand, p_new_apc)
    on conflict do nothing;

  if array_length(v_old_apcs, 1) > 0 then
    update public.tasks
       set assignee_id = p_new_apc
     where brand_id = p_brand
       and status <> 'done'
       and assignee_id = any (v_old_apcs);
    get diagnostics v_reassigned = row_count;
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'brand.switch_apc', 'brands', p_brand,
    jsonb_build_object(
      'owner_id',      v_old_tl,
      'assigned_apcs', v_old_apcs
    ),
    jsonb_build_object(
      'owner_id',         v_new_tl,
      'assigned_apcs',    array[p_new_apc],
      'new_apc',          p_new_apc,
      'tasks_reassigned', v_reassigned,
      'notified',         p_notify,
      'note',             p_note
    )
  );

  -- Notifications — scoped to the incoming side (new APC + new TL)
  -- and gated by the explicit opt-in flag.
  if p_notify then
    declare
      v_actor_name   text := public.profile_display_name(v_caller);
      v_brand_name   text := v_brand.brand_name;
      v_new_apc_name text := public.profile_display_name(p_new_apc);
      v_title text := 'Brand assigned';
      v_body  text;
      v_targets uuid[];
      v_target  uuid;
    begin
      v_body := v_actor_name || ' assigned "' || v_brand_name || '" to ' || v_new_apc_name
                || case when v_reassigned > 0
                        then ' · ' || v_reassigned || ' open task' || (case when v_reassigned = 1 then '' else 's' end) || ' reassigned'
                        else ''
                   end;

      v_targets := array(
        select distinct x from unnest(array[p_new_apc, v_new_tl]) x
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
  end if;

  return p_brand;
end;
$$;
grant execute on function public.brand_switch_apc(uuid, uuid, text, boolean) to authenticated;

-- --------------------------------------------------------------
-- 2. brand_switch_requests — carry the notify flag through the
--    OL-submit → Boss-approve flow so the eventual switch fires
--    (or doesn't) per the requester's original choice.
-- --------------------------------------------------------------
alter table public.brand_switch_requests
  add column if not exists notify_on_approve boolean not null default false;

-- --------------------------------------------------------------
-- 3. Approval trigger — pass notify flag through to brand_switch_apc
-- --------------------------------------------------------------
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
      perform public.brand_switch_apc(
        new.brand_id,
        new.to_apc_id,
        coalesce(nullif(new.decision_note, ''), new.reason),
        new.notify_on_approve
      );
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
