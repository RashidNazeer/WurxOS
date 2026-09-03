-- ============================================================
-- WurxOS v2 — Migration 350: an Operations Lead verifies OL incentives,
-- their own included. Requested by the Boss.
--
-- ── WHAT THIS REVERSES, AND WHAT IT KEEPS ──────────────────────────────────
-- Mig 301 blocked an OL from verifying / clearing / editing-salary on any
-- ol / developer / boss row, their own included, across four layers. The
-- reasoning was segregation of duties: an OL records progress on their own
-- plan but does not sign it off.
--
-- In practice the Boss never got to it — measured 2026-09-04, NOT ONE OL row
-- has ever been verified (both OLs, July and August, all false). A control
-- nobody exercises is not a control; it is a queue. The Boss has asked for the
-- verification step to move to the OLs with self-verification understood and
-- accepted.
--
-- So this relaxes exactly ONE thing and nothing else:
--   RELAXED  an active OL may verify / un-verify a row whose target role is
--            'ol' — including their own.
--   KEPT     clearing the payout stays the Boss's (inc_clear_payout is
--            untouched in authority). Verification says the figures are right;
--            releasing the money is still a second person. This was the Boss's
--            explicit choice.
--   KEPT     developer / boss target rows stay Boss-only.
--   KEPT     inc_update / inc_insert RLS. An OL still cannot edit another OL's
--            items, change an OL salary, or fabricate an OL row. The relaxation
--            lives only inside the SECURITY DEFINER RPC, so every OL
--            verification goes through the one audited path — a raw PostgREST
--            UPDATE flipping `verified` is still refused by incentives_guard.
--   KEPT     a developer may not verify OL rows (they could not before either;
--            the developer role is being wound down, not widened).
--
-- ── NEW: ONCE PAID, ONLY THE BOSS ──────────────────────────────────────────
-- inc_verify resets payout_cleared to false when un-verifying. Without a guard
-- that is a back door around "payout stays with the Boss": an OL could
-- un-verify a row the Boss had already cleared and erase the payout mark. It
-- releases no money, but it lets an OL undo the Boss's record. So an OL may
-- verify or un-verify an OL row only while payout_cleared is false.
--
-- ── THE PREREQUISITE BUG THIS ALSO FIXES ───────────────────────────────────
-- verified_by / verified_at were NEVER being recorded. Measured on production:
-- 98 verified rows, 0 with verified_by, 0 with verified_at; 1 cleared payout,
-- 0 with payout_cleared_by.
--
-- Cause: incentives_guard stamps those columns, but it opens with a
-- service_role short-circuit (mig 132) that returns early — and inc_verify /
-- inc_clear_payout are SECURITY DEFINER running as a service_role member, so
-- they take that early return and the stamping block below it never runs.
-- Neither RPC set the columns itself. The UI has been reading
-- `verifier:verified_by(display_name)` into a permanently blank field.
--
-- That was cosmetic while only the Boss could verify. It is NOT cosmetic once
-- an OL can verify their own pay: without it the Boss cannot tell their own
-- sign-off from a self-sign-off. Accountability is the entire basis on which
-- this relaxation is safe, so both RPCs now stamp the actor and time
-- themselves.
--
-- Existing rows are deliberately NOT backfilled: who verified them is genuinely
-- unknown, and NULL says that honestly.
--
-- ── AND THE BOSS IS TOLD ───────────────────────────────────────────────────
-- When anyone other than the Boss verifies an OL row, every active Boss gets a
-- notification naming the verifier and the OL. Prevention has been traded for
-- review, so review needs to actually reach someone. Reuses the existing
-- 'system' / 'incentives.verified' category+action so no notification
-- preference, bell or prefs screen needs a new entry.
--
-- Both functions reproduce their mig 301 bodies verbatim apart from the changes
-- described above. Idempotent.
-- ============================================================

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
    -- Developer and Boss rows remain the Boss's alone (mig 301 unchanged).
    if v_target_role in ('developer','boss') then
      raise exception 'only Boss can verify developer/boss incentives';
    end if;

    -- mig 350: an OL row — including the caller's own — may be verified by an
    -- active OL. A developer may not: they were blocked before and the role is
    -- being wound down.
    if v_target_role = 'ol' then
      if not exists (
        select 1 from public.profiles p
         where p.id = v_me and p.role = 'ol' and p.is_active = true
      ) then
        raise exception 'only an Operations Lead or the Boss can verify OL incentives';
      end if;

      -- Un-verifying resets payout_cleared, so allowing it after the Boss has
      -- paid would let an OL erase the Boss's payout record.
      if coalesce(v_paid, false) then
        raise exception 'the Boss has already cleared this payout — only the Boss can change its verification now';
      end if;
    end if;
  end if;

  update public.incentives
     set verified       = p_verified,
         payout_cleared = case when p_verified then payout_cleared else false end,
         -- Stamp here rather than relying on incentives_guard: this function
         -- runs as a service_role member and takes the guard's early return,
         -- which is why 98 rows carry a verified flag and no verifier.
         verified_by    = case when p_verified then v_me  else null end,
         verified_at    = case when p_verified then now() else null end,
         payout_cleared_by = case when p_verified then payout_cleared_by else null end,
         payout_cleared_at = case when p_verified then payout_cleared_at else null end
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  if p_verified then
    -- Telling someone their own click succeeded is noise; an OL verifying
    -- their own row does not need a notification about it.
    if v_row.user_id <> v_me then
      perform public.emit_notification(
        v_row.user_id, v_me, 'system', 'incentives.verified',
        'Incentives verified',
        'Your ' || v_row.month || ' incentives have been verified.',
        'incentives', v_row.id, '/incentives'
      );
    end if;

    -- mig 350: OL-tier verification no longer passes through the Boss, so it
    -- is reported to them instead.
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

-- ── inc_clear_payout: authority UNCHANGED (Boss only for admin rows). The one
--    change is that it now records who cleared the payout, for the same reason
--    inc_verify does. Body otherwise verbatim from mig 301, freeze chain intact.
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
  -- mig 350 deliberately leaves this alone — verification moved to the OLs,
  -- releasing the money did not.
  select p.role into v_target_role
    from public.incentives i join public.profiles p on p.id = i.user_id
   where i.id = p_id;
  if not public.is_boss(v_me) and v_target_role in ('ol','developer','boss') then
    raise exception 'only Boss can clear OL/admin payout';
  end if;

  update public.incentives
     set payout_cleared    = p_cleared,
         payout_cleared_by = case when p_cleared then v_me  else null end,
         payout_cleared_at = case when p_cleared then now() else null end
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

-- ── Verification ────────────────────────────────────────────────────────────
do $verify$
declare
  v_src text;
begin
  v_src := pg_get_functiondef('public.inc_verify(uuid, boolean)'::regprocedure);

  -- The relaxation is in.
  if position('only an Operations Lead or the Boss can verify OL incentives' in v_src) = 0 then
    raise exception 'mig 350: inc_verify did not pick up the OL relaxation';
  end if;
  -- The stamping is in — without it the Boss cannot tell a self-sign-off from
  -- their own, which is the only reason this relaxation is acceptable.
  if position('verified_by    = case when p_verified then v_me' in v_src) = 0 then
    raise exception 'mig 350: inc_verify does not stamp verified_by';
  end if;
  -- Developer/boss rows are still Boss-only.
  if position('only Boss can verify developer/boss incentives' in v_src) = 0 then
    raise exception 'mig 350: inc_verify lost the developer/boss block';
  end if;
  -- The paid-row back door is closed.
  if position('the Boss has already cleared this payout' in v_src) = 0 then
    raise exception 'mig 350: inc_verify lost the already-paid guard';
  end if;

  v_src := pg_get_functiondef('public.inc_clear_payout(uuid, boolean)'::regprocedure);
  -- Payout authority must NOT have moved.
  if position('only Boss can clear OL/admin payout' in v_src) = 0 then
    raise exception 'mig 350: inc_clear_payout lost the Boss-only payout block — the money control is gone';
  end if;
  if position('_inc_freeze_ol_brands_items' in v_src) = 0
     or position('_inc_freeze_attendance_items' in v_src) = 0 then
    raise exception 'mig 350: inc_clear_payout lost the attendance/ol_brands freeze chain';
  end if;
  if position('payout_cleared_by = case when p_cleared then v_me' in v_src) = 0 then
    raise exception 'mig 350: inc_clear_payout does not stamp payout_cleared_by';
  end if;

  -- mig 301's other three layers must still be standing. Only the RPC moved.
  if position($q$only Boss can verify OL/admin incentives$q$
              in pg_get_functiondef('public.incentives_guard()'::regprocedure)) = 0 then
    raise exception 'mig 350: incentives_guard lost its admin-row block — a raw UPDATE could self-verify';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'incentives' and policyname = 'inc_insert'
       and qual is null and with_check like '%verified%'
  ) then
    raise exception 'mig 350: inc_insert no longer guards against a fabricated verified row';
  end if;

  raise notice 'mig 350: an active OL can now verify OL incentives (their own included); payout stays with the Boss, and every verification records its actor';
end;
$verify$;
