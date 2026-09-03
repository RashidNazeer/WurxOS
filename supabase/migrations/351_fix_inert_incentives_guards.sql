-- ============================================================
-- WurxOS v2 — Migration 351: the incentives guards have never fired. Fix them.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
-- Both incentives_guard (mig 132) and incentives_guard_commission (mig 336)
-- open with:
--
--     if pg_has_role(current_user, 'service_role', 'member') then return new; end if;
--
-- meaning to say "let server-side tooling through". But both are SECURITY
-- DEFINER owned by postgres, and inside a SECURITY DEFINER function
-- `current_user` is the FUNCTION OWNER, not the caller. postgres IS a member of
-- service_role, so that test is true for every caller, always. The first line
-- has been returning early for everyone since the day it was written. Neither
-- guard has ever enforced anything.
--
-- ── WHAT THAT LEFT OPEN ────────────────────────────────────────────────────
-- inc_update RLS permits `auth.uid() = user_id`, so an employee may UPDATE
-- their own incentives row. incentives_guard was the ONLY thing stopping them
-- from setting verified, payout_cleared and basic_salary on it. Reproduced on
-- the demo project with an ordinary login and three plain PostgREST calls: all
-- three columns took the new values, no error.
--
-- incentives_guard_commission was likewise the only thing protecting a
-- Commission Based Tier line's benchmark / achieved / percentage — the three
-- numbers that decide what that line pays (mig 333/336) — from being rewritten
-- by the person being paid.
--
-- It also explains why verified_by / verified_at were never recorded (fixed for
-- the RPCs in mig 350): the stamping lives BELOW that early return.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Two bypasses, both meaning something real:
--
--   1. `wurxos.trusted_write` — a TRANSACTION-LOCAL flag set by the four
--      SECURITY DEFINER RPCs that carry their own, stricter authority checks:
--      inc_verify, inc_clear_payout, inc_reset_and_roll and set_user_salary.
--      Each sets it only AFTER its own gate has passed. A client cannot set a
--      GUC: PostgREST executes no arbitrary SQL and set_config lives in
--      pg_catalog, so it is not callable as an RPC. set_config(..., is_local
--      => true) scopes it to the transaction, so it cannot leak across a
--      pooled connection.
--
--   2. `auth.uid() is null` — no end-user identity at all: a migration, a
--      backup, psql, or a service-key call. anon also has no uid, but anon
--      cannot pass inc_update RLS in the first place (every branch needs a
--      uid), so it never reaches the trigger.
--
-- The guard BODIES are otherwise reproduced verbatim from mig 132 / 301 / 336.
-- The policy does not change; it starts being applied.
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ──────────────────────────────────────
-- The guard still refuses a raw client UPDATE that flips `verified` on an
-- ol/developer/boss row — including an OL's own. Mig 350 let an OL verify OL
-- incentives, but only THROUGH inc_verify, which stamps the actor and notifies
-- the Boss. A raw table write would do neither, so the direct path stays shut
-- and the RPC remains the single audited route. The UI already uses it
-- everywhere (Boss and OL both call verifyIncentives / clearIncentivePayout).
--
-- ── ONE INVARIANT MOVED, NOT LOST ──────────────────────────────────────────
-- "cannot clear payout before verification" lived in the guard. Now that
-- inc_clear_payout announces a trusted write, it would skip that check — so the
-- check is repeated inside the RPC. It has never actually held (the guard was
-- inert), and BossIncentivesPage's own comment claims "inc_clear_payout RPC
-- requires verified=true (server-side)". This makes that comment true.
-- inc_reset_and_roll's p_force_clear path is a separate function and is
-- untouched: forcing an unverified month closed at rollover is deliberate.
--
-- Idempotent.
-- ============================================================

-- ── 1. incentives_guard — mig 301 body, correct bypass ──────────────────────
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
  -- A trusted RPC that has already run its own authority check. NOT
  -- pg_has_role(current_user, ...) — inside a SECURITY DEFINER function that
  -- describes the owner (postgres, a service_role member) and is therefore
  -- true for everybody. That was the bug this migration exists to fix.
  if coalesce(current_setting('wurxos.trusted_write', true), '') = 'on' then
    return new;
  end if;

  -- No end-user identity: a migration, a backup, psql, or a service-key call.
  if auth.uid() is null then
    return new;
  end if;

  if not v_is_admin then
    if new.verified         is distinct from old.verified         then raise exception 'only admin can verify'; end if;
    if new.payout_cleared   is distinct from old.payout_cleared   then raise exception 'only admin can clear payout'; end if;
    if new.basic_salary     is distinct from old.basic_salary     then raise exception 'only admin can edit salary'; end if;
  end if;

  -- mig 301: a non-Boss admin (OL / Developer) may NOT flip verified /
  -- payout_cleared / basic_salary on an OL / Developer / Boss row — INCLUDING
  -- their own. mig 350 let an OL verify an OL row, but only through inc_verify
  -- (which records the actor and tells the Boss); the raw path stays shut.
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

-- ── 2. incentives_guard_commission — mig 336 body, correct bypass ───────────
create or replace function public.incentives_guard_commission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('wurxos.trusted_write', true), '') = 'on' then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;

  if public.is_boss(auth.uid())
     or exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true) then
    return new;
  end if;

  -- Everyone else: the benchmark, the achieved figure and the percentage are
  -- whatever they already were. An APC or TL saving their own progress touches
  -- none of them, so an honest save is byte-identical and nothing is refused.
  if public._commission_fingerprint(new.incentives) is distinct from public._commission_fingerprint(old.incentives) then
    new.incentives := public._commission_restore(new.incentives, old.incentives);
  end if;
  if public._commission_fingerprint(new.bonuses) is distinct from public._commission_fingerprint(old.bonuses) then
    new.bonuses := public._commission_restore(new.bonuses, old.bonuses);
  end if;

  return new;
end;
$$;

-- ── 3. The two payout RPCs announce their trusted write (mig 350 bodies) ────
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
  v_paid        boolean;
  v_is_boss     boolean := public.is_boss(v_me);
  v_boss        uuid;
begin
  if not (v_is_boss or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can verify'; end if;

  select p.role, i.payout_cleared into v_target_role, v_paid
    from public.incentives i join public.profiles p on p.id = i.user_id
   where i.id = p_id;

  if not v_is_boss then
    if v_target_role in ('developer','boss') then
      raise exception 'only Boss can verify developer/boss incentives';
    end if;
    if v_target_role = 'ol' then
      if not exists (
        select 1 from public.profiles p
         where p.id = v_me and p.role = 'ol' and p.is_active = true
      ) then
        raise exception 'only an Operations Lead or the Boss can verify OL incentives';
      end if;
      if coalesce(v_paid, false) then
        raise exception 'the Boss has already cleared this payout — only the Boss can change its verification now';
      end if;
    end if;
  end if;

  -- Authority established above. Announce it so the row trigger stands aside
  -- (mig 351); transaction-local, so it cannot outlive this call.
  perform set_config('wurxos.trusted_write', 'on', true);

  update public.incentives
     set verified       = p_verified,
         payout_cleared = case when p_verified then payout_cleared else false end,
         verified_by    = case when p_verified then v_me  else null end,
         verified_at    = case when p_verified then now() else null end,
         payout_cleared_by = case when p_verified then payout_cleared_by else null end,
         payout_cleared_at = case when p_verified then payout_cleared_at else null end
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  if p_verified then
    if v_row.user_id <> v_me then
      perform public.emit_notification(
        v_row.user_id, v_me, 'system', 'incentives.verified',
        'Incentives verified',
        'Your ' || v_row.month || ' incentives have been verified.',
        'incentives', v_row.id, '/incentives'
      );
    end if;

    if not v_is_boss and v_target_role = 'ol' then
      for v_boss in
        select p.id from public.profiles p
         where p.role = 'boss' and p.is_active = true and p.deleted_at is null
      loop
        perform public.emit_notification(
          v_boss, v_me, 'system', 'incentives.verified',
          'OL incentives verified',
          coalesce(public.profile_display_name(v_me), 'An Operations Lead')
            || ' verified '
            || case when v_row.user_id = v_me then 'their own'
                    else coalesce(public.profile_display_name(v_row.user_id), 'an OL') || '''s' end
            || ' ' || v_row.month || ' incentives. The payout is still yours to clear.',
          'incentives', v_row.id, '/incentives'
        );
      end loop;
    end if;
  end if;

  return v_row;
end;
$$;
grant execute on function public.inc_verify(uuid, boolean) to authenticated;

create or replace function public.inc_clear_payout(p_id uuid, p_cleared boolean)
returns public.incentives
language plpgsql security definer set search_path = public
as $$
declare
  v_me          uuid := auth.uid();
  v_row         public.incentives;
  v_target_role text;
  v_verified    boolean;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can clear payout'; end if;

  select p.role, i.verified into v_target_role, v_verified
    from public.incentives i join public.profiles p on p.id = i.user_id
   where i.id = p_id;
  if not public.is_boss(v_me) and v_target_role in ('ol','developer','boss') then
    raise exception 'only Boss can clear OL/admin payout';
  end if;

  -- mig 351: this invariant used to live in incentives_guard, which never ran.
  -- The RPC now bypasses that trigger deliberately, so the rule is enforced
  -- here instead of quietly disappearing. (inc_reset_and_roll's p_force_clear
  -- is a different function and still closes an unverified month on purpose.)
  if p_cleared and not coalesce(v_verified, false) then
    raise exception 'cannot clear payout before verification';
  end if;

  perform set_config('wurxos.trusted_write', 'on', true);

  update public.incentives
     set payout_cleared    = p_cleared,
         payout_cleared_by = case when p_cleared then v_me  else null end,
         payout_cleared_at = case when p_cleared then now() else null end
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

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

-- ── 4. The two long Boss-only RPCs, patched IN PLACE ───────────────────────
-- inc_reset_and_roll and set_user_salary carry months of accumulated changes
-- (the freeze chain, salary history). Retyping either risks silently dropping
-- something, so the set_config line is inserted immediately after each one's
-- OWN authority check — the technique mig 335/345/347 used.
do $trusted$
declare
  v_specs constant text[][] := array[
    array['public.inc_reset_and_roll(text, text, boolean)',
          $a$if not public.is_boss(v_me) then raise exception 'only Boss can reset & roll'; end if;$a$],
    array['public.set_user_salary(uuid, numeric, text, numeric, text, date)',
          $a$raise exception 'only Boss can change salary';
  end if;$a$]
  ];
  v_fn    text;
  v_anchor text;
  v_old   text;
  v_cnt   int;
  i       int;
begin
  for i in 1 .. array_length(v_specs, 1) loop
    v_fn     := v_specs[i][1];
    v_anchor := v_specs[i][2];
    v_old    := replace(pg_get_functiondef(v_fn::regprocedure), chr(13), '');

    if position('wurxos.trusted_write' in v_old) > 0 then
      raise notice 'mig 351: % already announces a trusted write — skipping', v_fn;
      continue;
    end if;

    v_cnt := (length(v_old) - length(replace(v_old, v_anchor, ''))) / length(v_anchor);
    if v_cnt <> 1 then
      raise exception 'mig 351: expected exactly one authority check in %, found % — refusing to guess', v_fn, v_cnt;
    end if;

    execute replace(
      v_old, v_anchor,
      v_anchor || chr(10) ||
      '  -- mig 351: Boss-only established above; stand the row trigger down.' || chr(10) ||
      '  perform set_config(''wurxos.trusted_write'', ''on'', true);'
    );

    if position('wurxos.trusted_write' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 351: % was not updated', v_fn;
    end if;
    raise notice 'mig 351: % now announces its trusted write', v_fn;
  end loop;
end;
$trusted$;

-- ── 5. Verification: prove the guard actually refuses, end to end ──────────
-- Source-string checks would be theatre here — the whole defect was a guard
-- whose text looked perfect and never ran. So this impersonates a real
-- employee (their own uid in request.jwt.claims, role authenticated) and tries
-- the exact write that was open. Every attempt is wrapped in a block that
-- raises a sentinel, so nothing it does survives whatever the outcome.
do $behaviour$
declare
  v_uid    uuid;
  v_id     uuid;
  v_fired  boolean;
  v_honest boolean;
  v_err    text;
begin
  select i.user_id, i.id into v_uid, v_id
    from public.incentives i
    join public.profiles p on p.id = i.user_id
   where p.role in ('apc','ipc','tl') and p.is_active = true
   order by i.month desc
   limit 1;

  if v_uid is null then
    raise notice 'mig 351: no APC/IPC/TL incentives row to test against — enforcement UNVERIFIED';
    return;
  end if;

  -- Setting the claims is enough: the guard reads auth.uid(), which comes from
  -- them. Deliberately NO `set local role authenticated` — a row trigger fires
  -- for the table owner too, so the role switch would test nothing extra, and
  -- it leaves the session as `authenticated`, which then cannot write
  -- supabase_migrations and rolls the whole migration back.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- (a) The hole: an employee flipping their own verified flag must be refused.
  begin
    update public.incentives
       set verified = not coalesce(verified, false)
     where id = v_id;
    raise exception 'GUARD_INERT';           -- rolls the write back either way
  exception when others then
    v_fired := (sqlerrm <> 'GUARD_INERT');
  end;

  -- (b) The honest path every APC uses daily must still go through. A guard
  --     that blocks ordinary progress saves would be worse than the hole.
  begin
    update public.incentives
       set last_updated_by = v_uid, updated_at = now()
     where id = v_id;
    raise exception 'ROLLBACK_OK';
  exception when others then
    if sqlerrm = 'ROLLBACK_OK' then v_honest := true;
    else v_honest := false; v_err := sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', '', true);

  if not v_fired then
    raise exception 'mig 351: an employee can STILL self-verify — the guard is still inert';
  end if;
  if not v_honest then
    raise exception 'mig 351: the guard now blocks an ordinary progress save (%) — too broad', v_err;
  end if;

  raise notice 'mig 351: guard live — self-verify refused, ordinary saves unaffected';
end;
$behaviour$;
