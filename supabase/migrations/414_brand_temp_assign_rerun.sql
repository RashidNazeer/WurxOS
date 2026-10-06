-- Re-apply 407_brand_temp_assign.sql under a free version number.
--
-- WHY: two migrations were numbered 407 - 407_ai_ingest_quiet_hours.sql and
-- 407_brand_temp_assign.sql. The Supabase CLI keys its ledger on the numeric
-- prefix, so only one of them could ever be recorded. Quiet hours took the
-- slot, and production was verified on 2026-10-06 to have
-- ai_ingest_quiet_now()/ai_ingest_next_allowed_at() but NO
-- brand_temp_assignments table and no brand_temp_assign() function, while the
-- Brand Switcher temporary-cover UI was already live. The CLI considered 407
-- done, so it would never have run this file.
--
-- The body below is 407_brand_temp_assign.sql verbatim. It is fully
-- re-runnable (create table if not exists / create or replace function /
-- drop policy if exists before create policy / enable RLS is a no-op when
-- already enabled), so applying it where it HAS somehow run changes nothing.
-- 407_brand_temp_assign.sql is kept in place so already-migrated databases
-- keep matching their history.
-- ============================================================
-- WurxOS v2 â€” Migration 407: temporary brand cover with automatic return.
--
-- â”€â”€ THE GAP THIS FILLS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- mig 210 already has an `expires_at` on brand_assignments, but it is purely
-- ADDITIVE: a cron deletes the row at expiry and nothing else happens. It was
-- built for "add a second pair of hands alongside the usual APC" â€” the usual
-- APC is never removed, so there is nothing to "return."
--
-- What is being asked for here is different: an APC is going on leave, the
-- WHOLE brand hands to someone else for the duration, and it comes back to
-- the original APC by itself when the window ends. That requires remembering
-- who to give it back to, which mig 210's model has no place to put.
--
-- â”€â”€ DESIGN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- brand_temp_assignments is the memory: one row per active (or finished) cover,
-- holding exactly who it was taken from and who is covering. The handover
-- itself reuses brand_assign_apc's exact rule for "who gets replaced"
-- (permanent, same role as the target) â€” but ONLY when that is exactly one
-- person. With zero, there is nothing to cover for (use Assign). With two or
-- more, there is no single person to hand it back to, so this refuses rather
-- than guess â€” Assign or Swap first to get the brand down to one APC.
--
-- Mechanically, the handover at start and the return at end are each exactly
-- a brand_assign_apc in miniature (reassignments + content transfer), run in
-- opposite directions. brands.owner_id is deliberately left untouched in both
-- directions â€” mirroring mig 210's existing cover, which also never touches
-- it: a covering APC does not have to belong to the same TL's team, and
-- visibility already comes from brand_assignments (can_view_brand), not
-- ownership.
--
-- Every mutation is an RPC (brand_temp_assign / brand_temp_revert_one); the
-- table has a SELECT policy only, so a client can read but never hand-edit
-- the cover record.
-- ============================================================

create table if not exists public.brand_temp_assignments (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null references public.brands(id) on delete cascade,
  original_apc_id  uuid not null references public.profiles(id),
  covering_apc_id  uuid not null references public.profiles(id),
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz not null,
  note             text,
  status           text not null default 'active'
                     check (status in ('active', 'reverted', 'cancelled')),
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  reverted_at      timestamptz,
  reverted_by      uuid references public.profiles(id) on delete set null,
  constraint brand_temp_assignments_window check (ends_at > starts_at)
);

create index if not exists brand_temp_assignments_active_idx
  on public.brand_temp_assignments(status, ends_at) where status = 'active';
create index if not exists brand_temp_assignments_brand_idx
  on public.brand_temp_assignments(brand_id);

alter table public.brand_temp_assignments enable row level security;

-- Managers see everything; the two people involved can see their own row
-- (so an APC can tell, from their own side, who is covering their brand and
-- until when, or that they are the one covering and for how much longer).
drop policy if exists "bta_select" on public.brand_temp_assignments;
create policy "bta_select"
  on public.brand_temp_assignments for select
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active
    )
    or original_apc_id = auth.uid()
    or covering_apc_id = auth.uid()
  );
-- No insert/update/delete policies: only the SECURITY DEFINER RPCs below write it.


-- ============================================================
-- 1. brand_temp_assign â€” hand the brand over, remembering who to return it to
-- ============================================================
create or replace function public.brand_temp_assign(
  p_brand     uuid,
  p_covering  uuid,
  p_ends_at   timestamptz,
  p_note      text    default null,
  p_notify    boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller    uuid := auth.uid();
  v_is_mgr    bool;
  v_brand     public.brands%rowtype;
  v_covering  public.profiles%rowtype;
  v_originals uuid[];
  v_original  uuid;
  v_row_id    uuid;
  v_tasks_moved int := 0;
  v_reports_moved int := 0;
  v_resources_moved int := 0;
begin
  v_is_mgr := public.is_boss(v_caller)
    or exists (
      select 1 from public.profiles p
      where p.id = v_caller and p.role in ('ol','developer') and p.is_active
    );
  if not v_is_mgr then
    raise exception 'only Boss/OL can set up temporary brand cover' using errcode = '42501';
  end if;

  if p_ends_at <= now() then
    raise exception 'the return date must be in the future';
  end if;

  select * into v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;

  select * into v_covering from public.profiles
    where id = p_covering and is_active = true and deleted_at is null;
  if not found then raise exception 'covering APC not found or inactive'; end if;
  if v_covering.role not in ('apc','ipc') then
    raise exception 'target user is not an APC/IPC (got %)', v_covering.role;
  end if;

  if exists (
    select 1 from public.brand_temp_assignments
     where brand_id = p_brand and status = 'active'
  ) then
    raise exception 'this brand already has an active temporary cover â€” end it first';
  end if;

  -- Same guard as brand_assign_apc: a silent success here would claim a
  -- handover that did not happen, and would otherwise cover-for whoever ELSE
  -- is on the brand instead of flagging the mistake.
  if exists (
    select 1 from public.brand_assignments
     where brand_id = p_brand and user_id = p_covering and expires_at is null
  ) then
    raise exception '% is already assigned to this brand', coalesce(v_covering.display_name, 'This APC');
  end if;

  -- Same rule as brand_assign_apc: permanent, same role as the target, not the
  -- target. Unlike Assign, a cover needs exactly ONE person to hand back to.
  select coalesce(array_agg(ba.user_id), '{}')
    into v_originals
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id
   where ba.brand_id = p_brand
     and ba.user_id <> p_covering
     and ba.expires_at is null
     and p.role = v_covering.role;

  if array_length(v_originals, 1) is null then
    raise exception 'nobody currently holds this brand to cover for â€” use Assign instead';
  elsif array_length(v_originals, 1) > 1 then
    raise exception 'this brand has % current %s â€” temporary cover needs exactly one; use Assign or Swap first',
      array_length(v_originals, 1), v_covering.role;
  end if;
  v_original := v_originals[1];

  insert into public.brand_temp_assignments
    (brand_id, original_apc_id, covering_apc_id, ends_at, note, created_by)
  values (p_brand, v_original, p_covering, p_ends_at, p_note, v_caller)
  returning id into v_row_id;

  delete from public.brand_assignments
   where brand_id = p_brand and user_id = v_original;

  insert into public.brand_assignments (brand_id, user_id, assigned_by, assigned_at, expires_at)
  values (p_brand, p_covering, v_caller, now(), null)
  on conflict (brand_id, user_id)
  do update set expires_at = null, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at;

  -- Content follows the brand for the duration â€” same rule as brand_assign_apc.
  with moved as (
    update public.tasks
       set assignee_id = p_covering, notify = false
     where brand_id = p_brand and status <> 'done'
       and (assignee_id = v_original or created_by = v_original)
     returning 1
  )
  select count(*) into v_tasks_moved from moved;

  with moved as (
    update public.reports set author_id = p_covering
     where brand_id = p_brand and author_id = v_original
     returning 1
  )
  select count(*) into v_reports_moved from moved;

  with moved as (
    update public.resources set created_by = p_covering
     where brand_id = p_brand and created_by = v_original
     returning 1
  )
  select count(*) into v_resources_moved from moved;

  update public.agenda_tasks
     set assignee_id = p_covering, notify = false
   where brand_id = p_brand and status <> 'completed'
     and (assignee_id = v_original or created_by = v_original);

  update public.agenda_resources set created_by = p_covering
   where brand_id = p_brand and created_by = v_original;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'brand.temp_assign', 'brands', p_brand,
    jsonb_build_object('original_apc', v_original),
    jsonb_build_object(
      'covering_apc', p_covering, 'ends_at', p_ends_at, 'temp_assignment_id', v_row_id,
      'tasks_moved', v_tasks_moved, 'reports_moved', v_reports_moved, 'resources_moved', v_resources_moved,
      'notified', p_notify, 'note', p_note
    )
  );

  if p_notify then
    declare
      v_actor_name text := public.profile_display_name(v_caller);
      v_original_tl uuid;
      v_covering_tl uuid := v_covering.reports_to;
      v_body text;
      v_target uuid;
    begin
      select reports_to into v_original_tl from public.profiles where id = v_original;
      v_body := v_actor_name || ' covered "' || v_brand.brand_name || '" with '
                || coalesce(v_covering.display_name, 'a teammate')
                || ' until ' || to_char(p_ends_at at time zone 'Asia/Karachi', 'Mon DD') || '.';
      foreach v_target in array array(
        select distinct x from unnest(array[p_covering, v_covering_tl, v_original, v_original_tl]) x
         where x is not null and x <> v_caller
      ) loop
        perform public.emit_notification(
          v_target, v_caller, 'brand', 'brand.temp_assigned',
          'Temporary brand cover', v_body,
          'brand', p_brand, '/brand-switcher'
        );
      end loop;
    end;
  end if;

  return v_row_id;
end;
$$;

comment on function public.brand_temp_assign(uuid, uuid, timestamptz, text, boolean) is
  'Hands one brand to a covering APC/IPC until p_ends_at, remembering the single current permanent same-role holder so brand_temp_revert_one (run by the sweep cron, or early by a manager) can give it back. Refuses when the brand does not have exactly one such holder.';

do $g$
begin
  revoke all on function public.brand_temp_assign(uuid, uuid, timestamptz, text, boolean) from public;
  revoke all on function public.brand_temp_assign(uuid, uuid, timestamptz, text, boolean) from anon;
  grant execute on function public.brand_temp_assign(uuid, uuid, timestamptz, text, boolean) to authenticated;
end;
$g$;


-- ============================================================
-- 2. brand_temp_revert_one â€” give it back (used by the sweep AND by an early return)
-- ============================================================
create or replace function public.brand_temp_revert_one(p_id uuid, p_early boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_is_mgr bool;
  v_row    public.brand_temp_assignments%rowtype;
  v_brand  public.brands%rowtype;
  v_tasks_moved int := 0;
  v_reports_moved int := 0;
  v_resources_moved int := 0;
begin
  select * into v_row from public.brand_temp_assignments where id = p_id and status = 'active';
  if not found then
    if p_early then raise exception 'this cover is not active'; end if;
    return;  -- sweep: silently skip a row another sweep tick already handled
  end if;

  -- The sweep calls this with no auth context (cron has none); an early
  -- return is a real user action and must be a manager.
  if p_early then
    v_is_mgr := public.is_boss(v_caller)
      or exists (
        select 1 from public.profiles p
        where p.id = v_caller and p.role in ('ol','developer') and p.is_active
      );
    if not v_is_mgr then
      raise exception 'only Boss/OL can end a temporary cover early' using errcode = '42501';
    end if;
  end if;

  select * into v_brand from public.brands where id = v_row.brand_id;

  -- Defensive: only move the seat back if the covering APC is still actually
  -- in it. If a manager already moved the brand elsewhere (Assign/Swap) while
  -- the cover was active, there is nothing here to undo.
  if exists (
    select 1 from public.brand_assignments
     where brand_id = v_row.brand_id and user_id = v_row.covering_apc_id and expires_at is null
  ) then
    delete from public.brand_assignments
     where brand_id = v_row.brand_id and user_id = v_row.covering_apc_id;

    insert into public.brand_assignments (brand_id, user_id, assigned_by, assigned_at, expires_at)
    values (v_row.brand_id, v_row.original_apc_id, v_row.created_by, now(), null)
    on conflict (brand_id, user_id)
    do update set expires_at = null, assigned_at = excluded.assigned_at;

    with moved as (
      update public.tasks
         set assignee_id = v_row.original_apc_id, notify = false
       where brand_id = v_row.brand_id and status <> 'done'
         and (assignee_id = v_row.covering_apc_id or created_by = v_row.covering_apc_id)
       returning 1
    )
    select count(*) into v_tasks_moved from moved;

    with moved as (
      update public.reports set author_id = v_row.original_apc_id
       where brand_id = v_row.brand_id and author_id = v_row.covering_apc_id
       returning 1
    )
    select count(*) into v_reports_moved from moved;

    with moved as (
      update public.resources set created_by = v_row.original_apc_id
       where brand_id = v_row.brand_id and created_by = v_row.covering_apc_id
       returning 1
    )
    select count(*) into v_resources_moved from moved;

    update public.agenda_tasks
       set assignee_id = v_row.original_apc_id, notify = false
     where brand_id = v_row.brand_id and status <> 'completed'
       and (assignee_id = v_row.covering_apc_id or created_by = v_row.covering_apc_id);

    update public.agenda_resources set created_by = v_row.original_apc_id
     where brand_id = v_row.brand_id and created_by = v_row.covering_apc_id;
  end if;

  update public.brand_temp_assignments
     set status = case when p_early then 'cancelled' else 'reverted' end,
         reverted_at = now(),
         reverted_by = v_caller
   where id = p_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, case when p_early then 'brand.temp_assign_ended_early' else 'brand.temp_assign_reverted' end,
    'brands', v_row.brand_id,
    jsonb_build_object('covering_apc', v_row.covering_apc_id),
    jsonb_build_object(
      'original_apc', v_row.original_apc_id, 'temp_assignment_id', p_id,
      'tasks_moved', v_tasks_moved, 'reports_moved', v_reports_moved, 'resources_moved', v_resources_moved
    )
  );

  declare
    v_actor_name text := coalesce(public.profile_display_name(v_caller), 'WurxOS');
    v_original_tl uuid;
    v_body text;
    v_target uuid;
  begin
    select reports_to into v_original_tl from public.profiles where id = v_row.original_apc_id;
    v_body := case when p_early
      then v_actor_name || ' ended the temporary cover on "' || coalesce(v_brand.brand_name, '?') || '" early â€” it is back with you.'
      else '"' || coalesce(v_brand.brand_name, '?') || '" is back with you â€” the temporary cover period ended.'
    end;
    -- v_caller is NULL when the sweep cron runs this (no auth context) â€” the
    -- `x <> v_caller` exclusion must not drop every target in that case, the
    -- way it would with a plain NULL comparison.
    foreach v_target in array array(
      select distinct x from unnest(array[v_row.original_apc_id, v_original_tl, v_row.covering_apc_id]) x
       where x is not null and (v_caller is null or x <> v_caller)
    ) loop
      perform public.emit_notification(
        v_target, v_caller, 'brand', 'brand.temp_assign_ended',
        'Brand cover ended', v_body,
        'brand', v_row.brand_id, '/brand-switcher'
      );
    end loop;
  end;
end;
$$;

comment on function public.brand_temp_revert_one(uuid, boolean) is
  'Gives a covered brand back to its original APC: reverses brand_temp_assign exactly (assignment + moved content). p_early=true is a manager ending it ahead of schedule (status=cancelled); p_early=false is the sweep cron processing a naturally-expired row (status=reverted).';

do $g$
begin
  revoke all on function public.brand_temp_revert_one(uuid, boolean) from public;
  revoke all on function public.brand_temp_revert_one(uuid, boolean) from anon;
  grant execute on function public.brand_temp_revert_one(uuid, boolean) to authenticated;
  grant execute on function public.brand_temp_revert_one(uuid, boolean) to service_role;
end;
$g$;


-- ============================================================
-- 3. The sweep â€” processes every cover whose return date has passed
-- ============================================================
create or replace function public.sweep_brand_temp_assignments()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in
    select id from public.brand_temp_assignments
     where status = 'active' and ends_at <= now()
  loop
    perform public.brand_temp_revert_one(v_id, false);
  end loop;
end;
$$;

revoke all on function public.sweep_brand_temp_assignments() from public, anon, authenticated;
grant execute on function public.sweep_brand_temp_assignments() to service_role;

-- Same 15-minute cadence as expire_brand_assignments (mig 210) â€” a cover is
-- day-granular, so this is far more often than it needs to be.
select cron.schedule('sweep-brand-temp-assignments', '*/15 * * * *',
  $$select public.sweep_brand_temp_assignments();$$);


-- ============================================================
-- VERIFY
-- ============================================================
do $v$
declare v int;
begin
  select count(*) into v from information_schema.tables
   where table_schema = 'public' and table_name = 'brand_temp_assignments';
  if v <> 1 then raise exception '407: brand_temp_assignments table missing'; end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'brand_temp_assignments';
  if v <> 1 then raise exception '407: expected exactly 1 policy (select-only), found %', v; end if;

  select count(*) into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('brand_temp_assign', 'brand_temp_revert_one', 'sweep_brand_temp_assignments');
  if v <> 3 then raise exception '407: expected 3 functions, found %', v; end if;

  if has_function_privilege('anon', 'public.brand_temp_assign(uuid, uuid, timestamptz, text, boolean)', 'EXECUTE') then
    raise exception '407: anon can execute brand_temp_assign';
  end if;

  select count(*) into v from cron.job where jobname = 'sweep-brand-temp-assignments';
  if v <> 1 then raise exception '407: sweep cron not scheduled'; end if;

  raise notice '407: temporary brand cover with automatic return is ready';
end;
$v$;

