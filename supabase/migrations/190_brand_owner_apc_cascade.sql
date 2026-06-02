-- ============================================================
-- WurxOS v2 — Migration 190: brand-owner / APC reports_to cascade
--
-- Three things shipped here, addressing a long-standing desync:
--
--  1. admin_reassign_orphaned_brands(p_orphan, p_new_owner) RPC
--     Reassigns every brand owned by p_orphan to p_new_owner, with
--     the owner-guard bypass GUC set in the same transaction so the
--     trigger from mig 025 doesn't reject it. Boss-only at the
--     authz layer, plus service_role bypass for the delete-user
--     Edge Function. Replaces the missing sync_bypass_owner_guard()
--     RPC that delete-user (supabase/functions/delete-user/index.ts)
--     called but no migration ever created — fixing the silent
--     failure where deleted users left orphaned brands behind.
--
--  2. brands_cascade_owner_to_apcs trigger
--     When a brand's owner_id changes, automatically update
--     profiles.reports_to for every APC/IPC whose ONLY active
--     brand assignment is this brand. Multi-brand APCs are skipped
--     (we don't know which of their TLs should be the manager).
--     This closes the gap that surfaced when Mushammir Qamar's
--     brands were transferred via the brand-switch flow but the
--     APCs working on them kept reporting to him — visible as a
--     stale Team Hierarchy view.
--
--  3. sync_bypass_owner_guard() RPC (compatibility shim)
--     The delete-user Edge Function's existing
--     `admin.rpc('sync_bypass_owner_guard').catch(() => {})` line
--     references a function that doesn't exist. We add it as a
--     no-op so old function versions stop logging RPC-not-found
--     errors. Real work now happens inside
--     admin_reassign_orphaned_brands which we point the function
--     at in a follow-up Edge Function deploy.
-- ============================================================

-- ── 1. sync_bypass_owner_guard (no-op shim) ────────────────────
create or replace function public.sync_bypass_owner_guard()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No-op. Historical name; real bypass now happens inline inside
  -- admin_reassign_orphaned_brands(). Kept so old Edge Function
  -- versions don't log function-not-found errors.
  return;
end;
$$;
grant execute on function public.sync_bypass_owner_guard() to authenticated, service_role;

-- ── 2. admin_reassign_orphaned_brands ─────────────────────────
create or replace function public.admin_reassign_orphaned_brands(
  p_orphan    uuid,
  p_new_owner uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  -- service_role (Edge Function) OR active Boss (UI-initiated) may
  -- run this.
  if not pg_has_role(current_user, 'service_role', 'member')
     and not public.is_boss(auth.uid()) then
    raise exception 'only Boss can reassign brand ownership';
  end if;
  if p_orphan is null or p_new_owner is null then
    raise exception 'both p_orphan and p_new_owner are required';
  end if;
  if p_orphan = p_new_owner then
    return 0;
  end if;

  -- Bypass the brand-owner trigger (mig 025) for the duration of
  -- this transaction. The bypass is gated to admin callers above,
  -- so this is safe.
  perform set_config('wurxos.bypass_owner_guard', 'on', true);

  with updated as (
    update public.brands
       set owner_id = p_new_owner, updated_at = now()
     where owner_id = p_orphan
     returning id
  )
  select count(*)::int into v_count from updated;

  if v_count > 0 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
    values (
      auth.uid(), 'brand.reassign_orphaned', 'profiles', p_orphan,
      jsonb_build_object('previous_owner', p_orphan),
      jsonb_build_object('new_owner', p_new_owner, 'brands_reassigned', v_count)
    );
  end if;

  return v_count;
end;
$$;
grant execute on function public.admin_reassign_orphaned_brands(uuid, uuid) to authenticated, service_role;

-- ── 3. Auto-cascade trigger: brand owner change → APC reports_to ──
create or replace function public.cascade_brand_owner_to_apcs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
begin
  if old.owner_id is distinct from new.owner_id
     and new.owner_id is not null then

    -- For each APC/IPC currently assigned to this brand, update
    -- their reports_to to the new owner — but only if this is their
    -- ONLY active brand assignment. Multi-brand APCs are left
    -- untouched because we can't infer which TL should own them.
    with eligible as (
      select ba.user_id
        from public.brand_assignments ba
        join public.profiles p on p.id = ba.user_id
       where ba.brand_id = new.id
         and p.role in ('apc', 'ipc')
         and p.is_active = true
         and p.deleted_at is null
         and (select count(*) from public.brand_assignments where user_id = ba.user_id) = 1
    )
    update public.profiles
       set reports_to = new.owner_id, updated_at = now()
     where id in (select user_id from eligible)
       and reports_to is distinct from new.owner_id;
    get diagnostics v_updated = row_count;

    if v_updated > 0 then
      insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
      values (
        auth.uid(), 'brand.cascade_apc_reports_to', 'brands', new.id,
        jsonb_build_object('previous_owner', old.owner_id, 'new_owner', new.owner_id),
        jsonb_build_object('apcs_reassigned', v_updated)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists brands_cascade_owner_to_apcs on public.brands;
create trigger brands_cascade_owner_to_apcs
  after update of owner_id on public.brands
  for each row execute function public.cascade_brand_owner_to_apcs();
