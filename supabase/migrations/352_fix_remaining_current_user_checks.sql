-- ============================================================
-- WurxOS v2 — Migration 352: the same current_user defect, everywhere else.
--
-- Mig 351 fixed the two incentives guards. Three more SECURITY DEFINER
-- functions test `pg_has_role(current_user, 'service_role', 'member')`, which
-- inside a SECURITY DEFINER function describes the OWNER (postgres, a
-- service_role member) and is therefore always true:
--
--   admin_reassign_orphaned_brands  — written as
--       if not pg_has_role(...) and not is_boss(auth.uid()) then raise
--     The first operand is always `not true` = false, so the AND is false and
--     THE EXCEPTION NEVER RAISES. Any logged-in user could reassign brand
--     ownership — and the function then sets wurxos.bypass_owner_guard, so it
--     also stands down the mig 025 owner-change trigger while doing it.
--
--   set_user_hire_date              — identical shape, identical result. Any
--     logged-in user could rewrite anyone's start_date, which drives the salary
--     anniversary sweep (mig 188).
--
--   _brand_write_block_check        — the plain `if X then return new` shape,
--     so it returns early for everyone and mig 115's inactive-brand write block
--     has never fired on reports, tasks, campaigns, product_campaigns or
--     brand_products.
--
-- ── WHY NOT THE SAME PREDICATE AS MIG 351 ──────────────────────────────────
-- The guards in mig 351 fall back to `auth.uid() is null` because a trigger
-- must let migrations, backups and psql through, and anon can never reach those
-- tables (RLS needs a uid on every branch).
--
-- These two RPCs are different: anon holds EXECUTE on them (Supabase grants it
-- by default — mig 348), and anon has no uid. Reusing `auth.uid() is null` here
-- would have turned a logged-in-user hole into an ANONYMOUS one. So they get a
-- precise test of the caller's JWT role instead, and anon's grant is revoked as
-- well — the check and the grant are two independent mechanisms, deliberately.
--
-- ── BEHAVIOUR CHANGE, STATED PLAINLY ───────────────────────────────────────
-- The inactive-brand block starts working. It is BEFORE INSERT only on all five
-- tables, so editing an existing draft report on a brand that has just been
-- deactivated still works; only NEW records are refused, and Boss/OL/Developer
-- are exempt as mig 115 intended. The UI already gates creation on
-- `brand.status === 'active'`, so this is defence-in-depth catching up with
-- what the screens already say.
--
-- Idempotent.
-- ============================================================

-- ── 1. What "the service role called this" actually means ───────────────────
-- PostgREST puts the caller's JWT in request.jwt.claims; a service-key call
-- carries role=service_role. Unlike pg_has_role(current_user, ...) this
-- describes the CALLER, which is the whole point.
create or replace function public.is_service_role()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) = 'service_role';
$$;

-- Never needed by a client: every caller is a SECURITY DEFINER function running
-- as the owner, which needs no grant.
revoke all on function public.is_service_role() from public;
revoke all on function public.is_service_role() from anon;
revoke all on function public.is_service_role() from authenticated;

-- ── 2. Patch the three IN PLACE ─────────────────────────────────────────────
-- Retyping them would risk dropping accumulated changes (the owner-guard
-- bypass, the salary-history chain), so only the broken expression is replaced
-- — the mig 335/345/347 technique, with a strict one-match check.
do $fix$
declare
  v_broken constant text := $b$pg_has_role(current_user, 'service_role', 'member')$b$;
  v_specs  constant text[][] := array[
    -- RPC: caller must be the service role or the Boss. anon must NOT qualify,
    -- so no uid-is-null fallback here.
    array['public.admin_reassign_orphaned_brands(uuid, uuid)', 'public.is_service_role()'],
    array['public.set_user_hire_date(uuid, date)',             'public.is_service_role()'],
    -- Trigger: must also let migrations / psql / backups through, and anon
    -- cannot reach these tables (RLS blocks every anon insert).
    array['public._brand_write_block_check()',
          '(public.is_service_role() or auth.uid() is null)']
  ];
  v_fn  text;
  v_new text;
  v_old text;
  v_cnt int;
  i     int;
begin
  for i in 1 .. array_length(v_specs, 1) loop
    v_fn  := v_specs[i][1];
    v_new := v_specs[i][2];
    v_old := replace(pg_get_functiondef(v_fn::regprocedure), chr(13), '');

    if position('is_service_role' in v_old) > 0 then
      raise notice 'mig 352: % already fixed — skipping', v_fn;
      continue;
    end if;

    v_cnt := (length(v_old) - length(replace(v_old, v_broken, ''))) / length(v_broken);
    if v_cnt <> 1 then
      raise exception 'mig 352: expected exactly one current_user test in %, found % — refusing to guess', v_fn, v_cnt;
    end if;

    execute replace(v_old, v_broken, v_new);

    if position('is_service_role' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 352: % was not updated', v_fn;
    end if;
    raise notice 'mig 352: % now tests the CALLER, not the owner', v_fn;
  end loop;
end;
$fix$;

-- ── 3. anon holds EXECUTE on these by default. Take it back. ────────────────
-- Supabase's default privileges grant anon EXECUTE on every new function, and
-- revoking from PUBLIC does not remove an explicit grant (mig 348). These four
-- all bypass RLS by design.
do $grants$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.admin_reassign_orphaned_brands(uuid, uuid)',
    'public.set_user_hire_date(uuid, date)',
    'public.inc_verify(uuid, boolean)',
    'public.inc_clear_payout(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from anon', v_fn);
    execute format('revoke all on function %s from public', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$grants$;

-- ── 4. Verification — behavioural, as an actual non-admin employee ─────────
do $verify$
declare
  v_uid   uuid;
  v_brand uuid;
  v_msg   text;
  v_ok    boolean;
begin
  foreach v_msg in array array[
    'public.admin_reassign_orphaned_brands(uuid, uuid)',
    'public.set_user_hire_date(uuid, date)',
    'public.inc_verify(uuid, boolean)',
    'public.inc_clear_payout(uuid, boolean)'
  ] loop
    if has_function_privilege('anon', v_msg, 'execute') then
      raise exception 'mig 352: anon still holds execute on %', v_msg;
    end if;
    if not has_function_privilege('authenticated', v_msg, 'execute') then
      raise exception 'mig 352: authenticated lost execute on % — the UI would break', v_msg;
    end if;
  end loop;

  select p.id into v_uid
    from public.profiles p
   where p.role in ('apc','ipc','tl') and p.is_active = true
   limit 1;
  if v_uid is null then
    raise notice 'mig 352: no non-admin employee to impersonate — enforcement UNVERIFIED';
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  -- Claims only, no role switch: these RPCs read auth.uid(), and the trigger
  -- in (c) fires for the table owner too, so switching role tests nothing
  -- extra -- while leaving the session unable to write supabase_migrations,
  -- which rolls the entire migration back on commit.

  -- (a) Brand reassignment. Two random uuids, so even an unguarded call
  --     matches no rows — but the point is that it must be REFUSED outright.
  begin
    perform public.admin_reassign_orphaned_brands(gen_random_uuid(), gen_random_uuid());
    v_ok := false;
  exception when others then
    v_ok := (sqlerrm like '%only Boss can reassign%');
    if not v_ok then v_msg := sqlerrm; end if;
  end;
  if not v_ok then
    raise exception 'mig 352: an ordinary employee can still reassign brand ownership (%)', coalesce(v_msg, 'no error raised');
  end if;

  -- (b) Hire date. A random uuid distinguishes the two outcomes cleanly:
  --     refused = 'only Boss can set hire date'; inert = it gets past the gate
  --     and complains 'user not found' instead.
  begin
    perform public.set_user_hire_date(gen_random_uuid(), current_date);
    v_ok := false;
  exception when others then
    v_ok := (sqlerrm like '%only Boss can set hire date%');
    if not v_ok then v_msg := sqlerrm; end if;
  end;
  if not v_ok then
    raise exception 'mig 352: an ordinary employee can still set hire dates (%)', coalesce(v_msg, 'no error raised');
  end if;

  -- (c) The inactive-brand write block, if there is an inactive brand to test.
  select id into v_brand from public.brands where status <> 'active' limit 1;
  if v_brand is not null then
    begin
      insert into public.tasks (brand_id, title, created_by)
      values (v_brand, 'mig 352 probe', v_uid);
      v_ok := false;
    exception when others then
      v_ok := (sqlerrm like '%inactive%');
      if not v_ok then v_msg := sqlerrm; end if;
    end;
    if not v_ok then
      raise exception 'mig 352: the inactive-brand write block still does not fire (%)', coalesce(v_msg, 'insert succeeded');
    end if;
  end if;

  perform set_config('request.jwt.claims', '', true);

  raise notice 'mig 352: caller-based checks live — brand reassignment, hire dates and the inactive-brand block all enforce again';
end;
$verify$;
