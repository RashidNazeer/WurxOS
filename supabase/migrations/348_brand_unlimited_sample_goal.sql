-- ============================================================
-- WurxOS v2 — Migration 348: a brand may have an UNLIMITED sample goal.
--
-- ── THE PROBLEM ────────────────────────────────────────────────────────────
-- Some clients sign a contract with no cap on free-sample approvals — "send as
-- many as you can" rather than "500 a month". Klassy Network is the first.
--
-- Until now the only way to express a sample goal was
-- brand_products.monthly_sample_goal (mig 217): one integer per product. An
-- unlimited brand therefore had two bad options — leave every product blank,
-- which is indistinguishable from "nobody has set the goal yet", or invent a
-- number, which then appears in the client's weekly and monthly report as
-- "412 / 500", a target that does not exist. Neither is honest.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- ONE brand-level flag, set once instead of product by product. When it is on:
--   • the weekly / bi-weekly / monthly report views drop the sample-goal
--     progress bars entirely (per-product AND overall) and say "Unlimited"
--     once, so the reader knows the bar is absent by design, not by omission;
--   • Brand Analytics shows the Sample Approvals goal as "Unlimited" and stops
--     computing a percentage against a target that isn't there;
--   • the per-product goal inputs are disabled — but the numbers already
--     stored are LEFT ALONE. Turning the flag back off restores the old
--     targets rather than silently discarding them, which matters because a
--     contract can revert and nobody would remember the old numbers.
--
-- The per-product/overall COUNT-VALIDATION warnings are deliberately untouched.
-- An unlimited goal removes the target, not the arithmetic: a report whose
-- per-product samples don't add up to the overall figure still says so. That
-- check has never had anything to do with the goal.
--
-- ── WHY AN RPC AND NOT JUST THE COLUMN ─────────────────────────────────────
-- brands_update (mig 004) is gated on can_edit_brand: Boss, OL, developer, or
-- the brand's owner. But the people who actually maintain sample goals are the
-- APC/IPC assigned to the brand — mig 218's month-end reminder is addressed to
-- exactly them, and bpd_update (mig 069) already lets them write every
-- per-product goal. Widening brands_update to brand assignees would hand them
-- every other column on that row — owner_id, the managed-by-us statuses, tier,
-- currency — in order to get one boolean.
--
-- So the flag is written through a SECURITY DEFINER function whose authority
-- MIRRORS bpd_update, the policy that already governs sample goals, and which
-- can touch nothing but this one column. The table policy is unchanged, and
-- brands already carries the generic audit_record() trigger (mig 028), so every
-- flip is recorded with its actor and before/after row.
--
-- Idempotent. Reversible: drop the function, drop the column.
-- ============================================================

-- ── 1. The flag ─────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT false: every existing brand keeps the numeric-goal behaviour
-- it has today, and the report views never have to reason about a third state.
alter table public.brands
  add column if not exists unlimited_sample_goal boolean not null default false;

comment on column public.brands.unlimited_sample_goal is
  'Contract has no cap on free-sample approvals. Suppresses sample-goal progress '
  'in reports and Brand Analytics; per-product monthly_sample_goal values are '
  'retained but ignored while this is true. Written via '
  'set_brand_unlimited_sample_goal(), not directly.';

-- ── 2. The one write path ───────────────────────────────────────────────────
create or replace function public.set_brand_unlimited_sample_goal(
  p_brand_id  uuid,
  p_unlimited boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_found boolean;
begin
  -- SECURITY DEFINER functions are callable by anon unless revoked, and the
  -- grant below closes that door — but a null uid must fail loudly here too,
  -- because a definer function that falls through to the UPDATE would write as
  -- the table owner with nobody's authority behind it.
  if v_uid is null then
    raise exception 'set_brand_unlimited_sample_goal: not authenticated';
  end if;

  -- owner_id may legitimately be null, so a separate found-flag is needed:
  -- "v_owner is null" cannot distinguish an ownerless brand from no brand.
  select b.owner_id, true into v_owner, v_found
    from public.brands b
   where b.id = p_brand_id;

  if not coalesce(v_found, false) then
    raise exception 'set_brand_unlimited_sample_goal: brand not found';
  end if;

  -- Authority mirrors bpd_update (mig 069) exactly: Boss / OL / developer /
  -- brand owner, or anyone assigned to the brand. Assignments are NOT filtered
  -- on expires_at, matching bpd_update — a temporary cover who can edit the
  -- per-product goals can also set this one. Diverging here would be a
  -- surprise, not a safeguard.
  if not (
    public.can_edit_brand(v_owner, v_uid)
    or exists (
      select 1 from public.brand_assignments ba
       where ba.brand_id = p_brand_id
         and ba.user_id  = v_uid
    )
  ) then
    raise exception 'set_brand_unlimited_sample_goal: not permitted on this brand';
  end if;

  update public.brands
     set unlimited_sample_goal = coalesce(p_unlimited, false)
   where id = p_brand_id;

  return coalesce(p_unlimited, false);
end;
$$;

-- Supabase ships `alter default privileges in schema public grant all on
-- functions to anon, authenticated, service_role`, so a newly created function
-- arrives with an EXPLICIT grant to anon. Revoking from PUBLIC does not remove
-- an explicit grant — anon has to be named. The first run of this migration
-- proved it: the verification block below caught anon holding execute on a
-- function that bypasses RLS, and refused to record the migration.
revoke all on function public.set_brand_unlimited_sample_goal(uuid, boolean) from public;
revoke all on function public.set_brand_unlimited_sample_goal(uuid, boolean) from anon;
grant execute on function public.set_brand_unlimited_sample_goal(uuid, boolean) to authenticated;

-- ── 3. Verification ─────────────────────────────────────────────────────────
do $verify$
declare
  v_cnt int;
  v_ok  boolean;
begin
  select count(*) into v_cnt
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'brands'
     and column_name  = 'unlimited_sample_goal';
  if v_cnt <> 1 then
    raise exception 'mig 348: brands.unlimited_sample_goal was not created';
  end if;

  -- The grant must not leak to anon: this function bypasses RLS by design.
  select has_function_privilege('anon',
    'public.set_brand_unlimited_sample_goal(uuid, boolean)', 'execute') into v_ok;
  if v_ok then
    raise exception 'mig 348: anon can call the setter — it bypasses RLS';
  end if;

  select has_function_privilege('authenticated',
    'public.set_brand_unlimited_sample_goal(uuid, boolean)', 'execute') into v_ok;
  if not v_ok then
    raise exception 'mig 348: authenticated cannot call the setter — the toggle would be dead';
  end if;

  -- Prove the uid gate actually fires. A migration runs with no JWT, so
  -- auth.uid() is null and the call must be refused. If it ever succeeds, the
  -- guard has been lost and the function writes with nobody's authority.
  begin
    perform public.set_brand_unlimited_sample_goal(
      (select id from public.brands limit 1), true);
    raise exception 'mig 348: the setter accepted a call with no authenticated user';
  exception
    when others then
      -- Re-raise anything that is NOT the expected refusal, including the
      -- failure message above (which does not contain this phrase).
      if position('not authenticated' in sqlerrm) = 0 then raise; end if;
  end;

  select count(*) into v_cnt from public.brands where unlimited_sample_goal;
  raise notice 'mig 348: unlimited sample goal ready — % brand(s) currently flagged', v_cnt;
end;
$verify$;
