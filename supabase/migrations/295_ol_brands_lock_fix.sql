-- ============================================================
-- 295 — OL incentive-brands: fix the denominator-lock (re-review of mig 294).
--
-- Mig 294's _oib_lock_after_verify keyed the lock on the CURRENT Karachi month,
-- but the exploitable window is the JUST-CLOSED month between verify and payout:
--   1. Boss runs inc_verify on July  -> verified=true, payout_cleared=false,
--      and the ol_brands % is NOT frozen (freeze happens only at payout).
--   2. Because applyOlBrandsAutofill re-computes the % LIVE for any not-yet-PAID
--      row (_isPaid checks payout_cleared only), July's % still tracks the OL's
--      live brand set.
--   3. The OL trims the non-hitting brands from their set (mig 294 lock checked
--      only the *August* row, which is unverified -> NOT blocked).
--   4. Boss runs inc_clear_payout/inc_reset_and_roll for July -> the freeze
--      snapshots the INFLATED live % -> OL paid an incentive they didn't earn.
--
-- Correct rule: lock the OL's set whenever the OL has ANY incentive row that is
-- VERIFIED but NOT yet PAID — that is exactly the set of rows whose % is still
-- recomputed live from this set and will be frozen at the (later) payout. A PAID
-- row is already frozen in JSONB (set-independent); an UNVERIFIED row isn't
-- Boss-approved yet (manual verification is the agreed backstop there). Boss and
-- service/migration (null auth.uid()) bypass.
--
-- Also: replace the client's non-atomic delete-then-insert with a single
-- transactional RPC so a verify landing mid-write can't wipe the set (TOCTOU).
-- ============================================================

create or replace function public._oib_lock_after_verify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ol uuid := coalesce(new.ol_id, old.ol_id);
begin
  if auth.uid() is null or public.is_boss(auth.uid()) then
    return coalesce(new, old);
  end if;
  -- Any verified-but-unpaid incentive row for this OL depends on the live set.
  if exists (
    select 1 from public.incentives i
     where i.user_id = v_ol
       and i.verified = true
       and coalesce(i.payout_cleared, false) = false
  ) then
    raise exception 'Your incentive brands are locked — a verified incentive that is awaiting payout depends on this brand set. Ask the Boss to adjust it.'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;
-- Trigger itself is unchanged (created in mig 294); the function body is swapped.

-- Atomic set-replace: DELETE + INSERT in ONE transaction, so the lock either
-- blocks the whole change (set unchanged) or applies it — never a partial/empty
-- state. Authz mirrors the oib_write RLS (SECURITY DEFINER bypasses RLS, so the
-- check is in-body); the lock trigger still fires inside this transaction.
create or replace function public.ol_set_incentive_brands(p_ol uuid, p_brand_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not (public.is_boss(auth.uid())
      or (p_ol = auth.uid() and exists (
            select 1 from public.profiles pr where pr.id = auth.uid() and pr.role = 'ol' and pr.is_active)))
  then raise exception 'not authorised to set incentive brands'; end if;

  delete from public.ol_incentive_brands where ol_id = p_ol;

  if p_brand_ids is not null and array_length(p_brand_ids, 1) is not null then
    insert into public.ol_incentive_brands (ol_id, brand_id)
      select p_ol, b_id from unnest(p_brand_ids) as b_id
    on conflict do nothing;
  end if;
end;
$$;
revoke execute on function public.ol_set_incentive_brands(uuid, uuid[]) from public, anon;
grant  execute on function public.ol_set_incentive_brands(uuid, uuid[]) to authenticated;

-- Self-check: confirm the lock now targets verified-but-unpaid rows.
do $$
declare v_src text;
begin
  select pg_get_functiondef('public._oib_lock_after_verify()'::regprocedure) into v_src;
  if position('verified = true' in v_src) = 0 or position('payout_cleared' in v_src) = 0 then
    raise exception 'FAIL: _oib_lock_after_verify not keyed on verified-but-unpaid';
  end if;
  if position('to_char' in v_src) > 0 then
    raise exception 'FAIL: _oib_lock_after_verify still references a current-month check';
  end if;
  raise notice 'OK: OL brand-set lock now targets verified-but-unpaid rows (all months).';
end $$;
