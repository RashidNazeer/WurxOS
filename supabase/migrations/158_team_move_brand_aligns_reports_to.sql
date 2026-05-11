-- ============================================================
-- WurxOS v2 — Migration 158: team_move_brand must align APC.reports_to
--
-- User report: when a brand is moved to a new TL (with the same APC
-- pinned), the APC's profiles.reports_to still points at the OLD TL.
-- Downstream consequences:
--   * Clock-in / time-edit approval requests route to the old TL
--     because the trigger reads apc.reports_to to find the approver.
--   * Notifications fire to the old TL.
--   * The Performance and Team pages render the wrong supervisor.
--   * In the user's words: "APC submitted clock-in edit request,
--     new TL can't see it; old TL still gets routed."
--
-- Root cause: team_move_brand (mig 114) updates brands.owner_id and
-- brand_assignments, but never touches profiles.reports_to for the
-- APC being pinned. The dedicated team_move_apc_to_tl does it
-- correctly; team_move_brand was the gap.
--
-- This migration:
--   1. Rewrites team_move_brand to also set the pinned APC's
--      reports_to = p_new_tl when it differs.
--   2. Backfills: for every APC whose ONLY brand assignment is to a
--      brand owned by a different TL than their current reports_to,
--      align reports_to to that brand's owner. Safe because the case
--      we're fixing is "you moved a brand and forgot to update
--      reports_to" — the brand's owner is the authoritative truth.
--
-- Idempotent.
-- ============================================================

-- 1. Rewrite team_move_brand
create or replace function public.team_move_brand(
  p_brand   uuid,
  p_new_tl  uuid,
  p_new_apc uuid default null,
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
    if v_apc_old_reports_to is distinct from p_new_tl then
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
$$;
grant execute on function public.team_move_brand(uuid, uuid, uuid, text) to authenticated;

-- 2. One-time backfill: align reports_to for APCs whose current brand
--    assignment points to a brand owned by a different TL than their
--    recorded reports_to. We only touch APC/IPC roles.
--
-- For APCs with EXACTLY ONE active brand assignment, the brand owner
-- IS their TL. For APCs with multiple brands across different TLs,
-- we don't touch them (ambiguous) and emit a NOTICE so you can review
-- them manually.
do $$
declare
  r record;
  v_count_aligned int := 0;
  v_count_ambiguous int := 0;
begin
  for r in
    with apc_brands as (
      select
        ba.user_id as apc_id,
        array_agg(distinct b.owner_id) filter (where b.owner_id is not null) as brand_owners
      from public.brand_assignments ba
      join public.brands b on b.id = ba.brand_id and b.status = 'active'
      join public.profiles p on p.id = ba.user_id
      where p.role in ('apc', 'ipc') and p.is_active = true
      group by ba.user_id
    )
    select
      ab.apc_id,
      ab.brand_owners,
      p.reports_to,
      array_length(ab.brand_owners, 1) as owner_count
    from apc_brands ab
    join public.profiles p on p.id = ab.apc_id
    where ab.brand_owners is not null
      and array_length(ab.brand_owners, 1) >= 1
  loop
    if r.owner_count = 1 and (r.reports_to is distinct from r.brand_owners[1]) then
      update public.profiles
         set reports_to = r.brand_owners[1], updated_at = now()
       where id = r.apc_id;
      v_count_aligned := v_count_aligned + 1;

      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        null, 'team.backfill_reports_to', 'profiles', r.apc_id,
        jsonb_build_object('reports_to', r.reports_to),
        jsonb_build_object('reports_to', r.brand_owners[1], 'reason', 'mig 158 backfill')
      );
    elsif r.owner_count > 1 then
      v_count_ambiguous := v_count_ambiguous + 1;
      raise notice '[mig 158] APC % has brands across multiple TLs (%); reports_to=% left untouched',
        r.apc_id, r.brand_owners, r.reports_to;
    end if;
  end loop;

  raise notice '[mig 158] aligned reports_to for % APCs; % APCs left untouched (multi-TL brands)',
    v_count_aligned, v_count_ambiguous;
end;
$$;
