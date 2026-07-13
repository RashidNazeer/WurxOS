-- ============================================================
-- WurxOS v2 — Migration 242: moving an APC brings their brands along
--
-- The mirror of migration 158. Mig 158 fixed team_move_brand: moving a
-- BRAND to a new TL now also aligns the pinned APC's profiles.reports_to.
-- The OTHER direction was still a gap:
--
--   team_move_apc_to_tl (mig 114) updates profiles.reports_to but never
--   touches brands.owner_id. So after "Reassign APC Lead", the APC sits
--   under the NEW TL while every brand they work is still OWNED by the
--   OLD TL. Same class of downstream damage mig 158 documented, mirrored:
--     * the old TL keeps brand-level visibility/edit rights (owner_id
--       drives can_view_brand / can_edit_brand),
--     * the new TL — who actually manages the APC — does not own the
--       brand and can't act on it,
--     * report verification / approvals / notifications keep routing by
--       the wrong TL,
--   and the UI literally promises "Their assigned brands move with them",
--   which was only half true (the brand_assignment follows the person;
--   the brand's owner did not).
--   In practice the Boss had to remember to ALSO move each brand by hand
--   in Brand Switcher afterwards.
--
-- This migration rewrites team_move_apc_to_tl to move the APC's brands
-- with them.
--
-- GUARD — sole assignee only. A brand is only re-owned if the APC being
-- moved is its ONLY assignee. A brand shared with another APC (who may
-- report to a different TL) is ambiguous: re-owning it would strand that
-- other APC under a foreign TL, and would make the mig-190
-- brands_cascade_owner_to_apcs trigger drag them along too. Shared brands
-- are therefore left alone (move them explicitly in Brand Switcher).
--
-- Interaction with existing triggers (both handled):
--   * brands_block_owner_change (mig 025) rejects owner_id changes from
--     non-Boss callers → we set the wurxos.bypass_owner_guard GUC around
--     the update, exactly as team_move_brand does.
--   * brands_cascade_owner_to_apcs (mig 190) fires AFTER owner_id changes
--     and sets reports_to for single-brand APCs on that brand. Because we
--     set reports_to = p_new_tl FIRST, that cascade is a no-op here (its
--     update is guarded by `reports_to is distinct from new.owner_id`).
--     No loop, no fight.
--
-- Return type is unchanged (uuid) so existing callers keep working.
-- Idempotent.
-- ============================================================

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
$$;
