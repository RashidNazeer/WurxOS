-- ============================================================
-- WurxOS v2 — Migration 301: an OL cannot change an OL's (or any admin's)
-- incentives. Only the Boss verifies / clears / edits OL-tier payroll.
--
-- Context: the OL Incentives page gains an "OL Incentives" section so an OL can
-- SEE both OLs' plans (read-only) and a combined payout that finally includes
-- the OLs. Viewing is already allowed by RLS (inc_select: an active OL reads
-- every row). But WRITING was wide open:
--   * inc_update RLS (mig 213) let any active OL UPDATE ANY row.
--   * inc_verify (mig 059) / inc_clear_payout (mig 293) gated only on
--     "caller is Boss or active OL/developer" — never on WHOSE row it is.
-- So an OL could verify, clear the payout of, or edit another OL's row — or
-- their OWN — straight through PostgREST / the RPCs, no UI needed. A read-only
-- section alone would not enforce the rule. This closes it at the source.
--
-- New invariant (Boss is unaffected and can still do everything):
--   An OL / Developer may verify / clear-payout / edit-salary an incentives row
--   ONLY when the target user is NOT an ol / developer / boss. Their OWN row is
--   included in that block — an OL records progress on their own plan but does
--   NOT verify or pay it; the Boss does (the "Boss Verified" model the My
--   Incentives card already shows). APC / IPC / TL management is untouched.
--
-- Enforced in FOUR layers, matching how each write path reaches the table:
--   1. inc_update RLS      — blocks the OL from UPDATEing another admin's row
--      at all (direct PostgREST). Their own row stays writable (progress).
--   2. incentives_guard    — the client UPDATE path (user JWT, not service_role)
--      still can't flip verified / payout_cleared / basic_salary on ANY admin
--      row, incl. their own (closes a raw self-verify on the own-row RLS branch).
--   3. inc_verify / inc_clear_payout — the SECURITY DEFINER RPCs run as a
--      service_role member, so the guard's service_role short-circuit skips them
--      (mig 132/256): the block is therefore repeated inside each RPC.
--   4. inc_insert RLS      — the guard is BEFORE UPDATE only (there is NO before-
--      insert trigger), and the old inc_insert (mig 213) gated on the caller's
--      role alone. So an OL could raw-INSERT a fabricated verified+paid, inflated
--      row for a row-less (user, month) — their own future month, the other OL,
--      or the Boss — sidestepping layers 1-3 entirely. inc_insert now forbids an
--      OL from creating an admin-target row OR a pre-flagged verified/paid row.
--      Boss stays unrestricted. (Adversarial review of this change, finding
--      "OL can fabricate an admin payroll row via raw INSERT".)
--
-- Idempotent. Every function reproduces its latest body verbatim (mig 213 / 132 /
-- 059 / 293) with ONLY the admin-target block added.
-- ============================================================

-- ── 1. RLS: an OL may UPDATE a row only for a NON-admin target (or their own). ──
drop policy if exists "inc_update" on public.incentives;
create policy "inc_update"
  on public.incentives for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or (
      exists (select 1 from public.profiles me
               where me.id = auth.uid() and me.role = 'ol' and me.is_active = true)
      and not exists (select 1 from public.profiles tgt
                       where tgt.id = incentives.user_id
                         and tgt.role in ('ol','developer','boss'))
    )
  )
  with check (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or (
      exists (select 1 from public.profiles me
               where me.id = auth.uid() and me.role = 'ol' and me.is_active = true)
      and not exists (select 1 from public.profiles tgt
                       where tgt.id = incentives.user_id
                         and tgt.role in ('ol','developer','boss'))
    )
  );

-- ── 1b. RLS INSERT: an OL may CREATE a plan ONLY for a NON-admin target, and
--        NEVER pre-flagged verified / paid. There is no BEFORE INSERT trigger, so
--        this policy is the only gate on the INSERT path (savePlan/upsert land
--        here for a brand-new (user, month)). Boss branch stays unrestricted. ──
drop policy if exists "inc_insert" on public.incentives;
create policy "inc_insert"
  on public.incentives for insert
  with check (
    public.is_boss(auth.uid())
    or (
      exists (select 1 from public.profiles me
               where me.id = auth.uid() and me.role = 'ol' and me.is_active = true)
      and not exists (select 1 from public.profiles tgt
                       where tgt.id = incentives.user_id
                         and tgt.role in ('ol','developer','boss'))
      and coalesce(incentives.verified, false)       = false
      and coalesce(incentives.payout_cleared, false) = false
    )
  );

-- ── 2. Guard (mig 132 body verbatim + admin-target block). Runs on the client
--       UPDATE path; the service_role short-circuit still lets the sync + the
--       SECURITY DEFINER RPCs through unchanged. ──
create or replace function public.incentives_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_boss  bool := public.is_boss(auth.uid());
  v_is_admin bool := v_is_boss or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
  );
  v_target_admin bool;
begin
  -- service_role is the v1→v2 sync (or the payout RPCs, which run as a
  -- service_role member). Always allowed — unchanged from mig 132.
  if pg_has_role(current_user, 'service_role', 'member') then
    return new;
  end if;

  if not v_is_admin then
    if new.verified         is distinct from old.verified         then raise exception 'only admin can verify'; end if;
    if new.payout_cleared   is distinct from old.payout_cleared   then raise exception 'only admin can clear payout'; end if;
    if new.basic_salary     is distinct from old.basic_salary     then raise exception 'only admin can edit salary'; end if;
  end if;

  -- mig 301: a non-Boss admin (OL / Developer) may NOT flip verified /
  -- payout_cleared / basic_salary on an OL / Developer / Boss row — INCLUDING
  -- their own (their own-row RLS branch would otherwise let this through). Only
  -- the Boss verifies / pays OL-tier payroll.
  if v_is_admin and not v_is_boss then
    select (p.role in ('ol','developer','boss')) into v_target_admin
      from public.profiles p where p.id = new.user_id;
    if coalesce(v_target_admin, false) then
      if new.verified         is distinct from old.verified         then raise exception 'only Boss can verify OL/admin incentives'; end if;
      if new.payout_cleared   is distinct from old.payout_cleared   then raise exception 'only Boss can clear OL/admin payout'; end if;
      if new.basic_salary     is distinct from old.basic_salary     then raise exception 'only Boss can change OL/admin salary'; end if;
    end if;
  end if;

  -- Cannot flip payout_cleared unless the row is also verified.
  if new.payout_cleared is true and new.verified is false then
    raise exception 'cannot clear payout before verification';
  end if;

  -- Stamp verified_by / cleared_by on the transition.
  if old.verified is distinct from new.verified and new.verified then
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;
  if old.payout_cleared is distinct from new.payout_cleared and new.payout_cleared then
    new.payout_cleared_by := auth.uid();
    new.payout_cleared_at := now();
  end if;

  return new;
end;
$$;

-- ── 3a. inc_verify (mig 059 body verbatim + admin-target block). ──
create or replace function public.inc_verify(p_id uuid, p_verified boolean)
returns public.incentives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me          uuid := auth.uid();
  v_row         public.incentives;
  v_target_role text;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can verify'; end if;

  -- mig 301: an OL / Developer may not verify an OL / Developer / Boss row
  -- (their own included). Only the Boss verifies OL-tier payroll.
  select p.role into v_target_role
    from public.incentives i join public.profiles p on p.id = i.user_id
   where i.id = p_id;
  if not public.is_boss(v_me) and v_target_role in ('ol','developer','boss') then
    raise exception 'only Boss can verify OL/admin incentives';
  end if;

  update public.incentives
     set verified       = p_verified,
         payout_cleared = case when p_verified then payout_cleared else false end
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  if p_verified then
    perform public.emit_notification(
      v_row.user_id, v_me, 'system', 'incentives.verified',
      'Incentives verified',
      'Your ' || v_row.month || ' incentives have been verified.',
      'incentives', v_row.id, '/incentives'
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.inc_verify(uuid, boolean) to authenticated;

-- ── 3b. inc_clear_payout (mig 293 body verbatim + admin-target block). Keeps the
--        attendance + ol_brands freeze chain intact. ──
create or replace function public.inc_clear_payout(p_id uuid, p_cleared boolean)
returns public.incentives
language plpgsql security definer set search_path = public
as $$
declare
  v_me          uuid := auth.uid();
  v_row         public.incentives;
  v_target_role text;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can clear payout'; end if;

  -- mig 301: an OL / Developer may not clear an OL / Developer / Boss payout.
  select p.role into v_target_role
    from public.incentives i join public.profiles p on p.id = i.user_id
   where i.id = p_id;
  if not public.is_boss(v_me) and v_target_role in ('ol','developer','boss') then
    raise exception 'only Boss can clear OL/admin payout';
  end if;

  update public.incentives
     set payout_cleared = p_cleared
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  -- FREEZE on turn-on: snapshot attendance % AND ol-brands % into the JSONB.
  if p_cleared then
    update public.incentives
       set incentives = public._inc_freeze_ol_brands_items(
                          public._inc_freeze_attendance_items(incentives, month, user_id), month, user_id),
           bonuses    = public._inc_freeze_ol_brands_items(
                          public._inc_freeze_attendance_items(bonuses,    month, user_id), month, user_id)
     where id = p_id
     returning * into v_row;
  end if;

  if p_cleared then
    perform public.emit_notification(
      v_row.user_id, v_me, 'system', 'incentives.paid',
      'Payout cleared',
      'Your ' || v_row.month || ' payout has been cleared.',
      'incentives', v_row.id, '/incentives'
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.inc_clear_payout(uuid, boolean) to authenticated;
