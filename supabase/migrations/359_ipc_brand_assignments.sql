-- ============================================================
-- WurxOS v2 — Migration 359: OL and PCTL allocate brands to IPCs
--
-- WHY THIS EXISTS
-- An IPC sees a brand only if a row links them in brand_assignments —
-- can_view_brand (316:145) reads that table for every role, and it gates the
-- brand row itself plus reports, tasks, resources, credentials, agenda, Euka
-- metrics and weekly checkpoints. Fharkhan could not see Dr Tobias for exactly
-- that reason: no row existed, and nobody except the Boss or the brand owner
-- could create one. This gives OL and PCTL a supported way to manage it.
--
-- Safe to re-run.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
-- It does not let a PCTL touch an IPC who does not report to them, and it does
-- not replace a user's whole assignment set on every save. Both were in the
-- first draft of this feature and both are load-bearing:
--
--   * brand_assignments is a company-wide permission table, not this screen's
--     private state. An OL, the Boss and a brand owner all write to it. A
--     delete-then-reinsert save silently discards whatever any of them did
--     between the page loading and the button being pressed.
--   * The table carries assigned_at, assigned_by and expires_at. expires_at is
--     how time-boxed leave cover is expressed. Re-inserting every row on every
--     save rewrites the audit columns and converts cover into permanent access.
--
-- So the setter DIFFS: it adds what is missing, removes what was deselected,
-- and leaves untouched rows exactly as they are, with their history intact.
--
-- SCOPING NOTE, measured before choosing it: all four active IPCs report to the
-- single active PCTL, and pctl_brand_selections is EMPTY. Migration 017's
-- pctl_can_assign() additionally requires a row in that table, so reusing it
-- verbatim would make this feature assign nothing at all. The IPC scope is
-- enforced (reports_to); the brand scope deliberately is not, because the whole
-- point is allocating any brand the department needs.
-- ============================================================

-- ── 1. Who may write brand_assignments ─────────────────────────────────────
-- The PCTL branch is scoped to their OWN IPCs. The first draft checked only
-- that the TARGET is an ipc, with no brand and no reports_to predicate, which
-- let any PCTL grant or revoke any brand for any IPC in the company — and the
-- DELETE side of that is the sharp end, because one lead could silently undo
-- an OL's allocations with a single request.
create or replace function public.can_allocate_to_ipc(p_target uuid, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_actor is not null
    and exists (
      select 1 from public.profiles t
      where t.id = p_target and t.role = 'ipc'
        and t.is_active = true and t.deleted_at is null
    )
    and (
      public.is_boss(p_actor)
      or exists (
        select 1 from public.profiles a
        where a.id = p_actor and a.is_active = true and a.deleted_at is null
          and (
            a.role = 'ol'
            -- A PCTL manages the IPCs who report to them, and no others.
            or (a.role = 'pctl' and exists (
                  select 1 from public.profiles t2
                  where t2.id = p_target and t2.reports_to = p_actor))
          )
      )
    );
$$;

comment on function public.can_allocate_to_ipc(uuid, uuid) is
  'May p_actor allocate brands to IPC p_target? Boss and OL: any active IPC. PCTL: only IPCs reporting to them. The target must be an ACTIVE, non-deleted IPC — is_active and deleted_at are both checked here so the policy and the RPC cannot disagree, which they did in the first draft.';

drop policy if exists "brand_assignments_write" on public.brand_assignments;
create policy "brand_assignments_write"
  on public.brand_assignments for insert
  with check (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'ol' and p.is_active = true
    )
    or exists (
      select 1 from public.brands b
      where b.id = brand_assignments.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
    or public.can_allocate_to_ipc(brand_assignments.user_id, auth.uid())
  );

drop policy if exists "brand_assignments_delete" on public.brand_assignments;
create policy "brand_assignments_delete"
  on public.brand_assignments for delete
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'ol' and p.is_active = true
    )
    or exists (
      select 1 from public.brands b
      where b.id = brand_assignments.brand_id
        and public.can_edit_brand(b.owner_id, auth.uid())
    )
    or public.can_allocate_to_ipc(brand_assignments.user_id, auth.uid())
  );

-- ── 2. IPCs may read Brand Analytics for brands assigned to them ────────────
-- Policies OR together, so this only widens read access, and only to metrics
-- for brands the IPC can already see.
drop policy if exists bmm_select_ipc_assigned on public.brand_monthly_metrics;
create policy bmm_select_ipc_assigned on public.brand_monthly_metrics for select
  using (
    exists (
      select 1
        from public.profiles p
        join public.brand_assignments ba
          on ba.user_id = p.id
         and ba.brand_id = brand_monthly_metrics.brand_id
       where p.id = auth.uid()
         and p.role = 'ipc'
         and p.is_active = true
    )
  );

-- ── 3. The setter: a DIFF, not a replacement ───────────────────────────────
create or replace function public.ipc_set_brand_assignments(p_ipc_id uuid, p_brand_ids uuid[])
returns table (added int, removed int, unchanged int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_want  uuid[] := coalesce(p_brand_ids, '{}'::uuid[]);
  v_added int := 0;
  v_removed int := 0;
  v_unchanged int := 0;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not public.can_allocate_to_ipc(p_ipc_id, v_actor) then
    raise exception 'not authorised to allocate brands to this IPC' using errcode = '42501';
  end if;

  -- Unknown brand ids are an error, not something to drop quietly: the first
  -- draft filtered them out with "where exists", so a stale page could report
  -- success while silently assigning fewer brands than the operator selected.
  if exists (
    select 1 from unnest(v_want) b
    where not exists (select 1 from public.brands br where br.id = b)
  ) then
    raise exception 'one or more selected brands no longer exist — reload and try again';
  end if;

  select count(*) into v_unchanged
    from public.brand_assignments ba
   where ba.user_id = p_ipc_id and ba.brand_id = any(v_want);

  -- REMOVE only what was actually deselected. The delete is bounded by both
  -- axes; it can never reach a row the operator did not see.
  with gone as (
    delete from public.brand_assignments ba
     where ba.user_id = p_ipc_id
       and not (ba.brand_id = any(v_want))
    returning 1
  )
  select count(*) into v_removed from gone;

  -- ADD only what is missing. Rows that already exist are left completely
  -- alone, so assigned_at, assigned_by and expires_at survive — an
  -- unrelated save can no longer turn time-boxed cover into permanent access.
  with fresh as (
    insert into public.brand_assignments (brand_id, user_id, assigned_by)
    select b, p_ipc_id, v_actor
      from unnest(v_want) as b
     where not exists (
       select 1 from public.brand_assignments ba
        where ba.user_id = p_ipc_id and ba.brand_id = b
     )
    returning 1
  )
  select count(*) into v_added from fresh;

  return query select v_added, v_removed, v_unchanged;
end;
$$;

comment on function public.ipc_set_brand_assignments(uuid, uuid[]) is
  'Diffs an IPC brand allocation: adds what is missing, removes what was deselected, leaves existing rows untouched so assigned_at/assigned_by/expires_at survive. Returns the counts so the caller can report what actually changed rather than assuming.';

-- anon BY NAME. Supabase grants it EXECUTE on every new function and
-- "revoke from public" does not undo that.
do $g$
begin
  revoke all on function public.ipc_set_brand_assignments(uuid, uuid[]) from public;
  revoke all on function public.ipc_set_brand_assignments(uuid, uuid[]) from anon;
  grant execute on function public.ipc_set_brand_assignments(uuid, uuid[]) to authenticated;
  grant execute on function public.ipc_set_brand_assignments(uuid, uuid[]) to service_role;

  revoke all on function public.can_allocate_to_ipc(uuid, uuid) from public;
  revoke all on function public.can_allocate_to_ipc(uuid, uuid) from anon;
  grant execute on function public.can_allocate_to_ipc(uuid, uuid) to authenticated;
  grant execute on function public.can_allocate_to_ipc(uuid, uuid) to service_role;
end;
$g$;


-- ============================================================
-- VERIFY — the scoping rules, stated as assertions
-- ============================================================
do $v$
declare
  v_ol uuid; v_pctl uuid; v_ipc uuid; v_other_ipc uuid; v_apc uuid;
begin
  select id into v_ol   from public.profiles where role = 'ol'   and is_active limit 1;
  select id into v_pctl from public.profiles where role = 'pctl' and is_active limit 1;
  select id into v_apc  from public.profiles where role = 'apc'  and is_active limit 1;
  select id into v_ipc  from public.profiles
   where role = 'ipc' and is_active and reports_to = v_pctl limit 1;
  select id into v_other_ipc from public.profiles
   where role = 'ipc' and is_active and (reports_to is distinct from v_pctl) limit 1;

  if v_ol is null or v_pctl is null or v_ipc is null then
    raise notice 'not enough roles present to verify — skipped';
    return;
  end if;

  if not public.can_allocate_to_ipc(v_ipc, v_ol) then
    raise exception 'an OL must be able to allocate to any active IPC';
  end if;
  if not public.can_allocate_to_ipc(v_ipc, v_pctl) then
    raise exception 'a PCTL must be able to allocate to their own IPC';
  end if;
  if v_other_ipc is not null and public.can_allocate_to_ipc(v_other_ipc, v_pctl) then
    raise exception 'a PCTL must NOT be able to allocate to an IPC who reports elsewhere';
  end if;
  if v_apc is not null and public.can_allocate_to_ipc(v_apc, v_ol) then
    raise exception 'the target must be an IPC — an APC was accepted';
  end if;
  if public.can_allocate_to_ipc(v_ipc, v_apc) then
    raise exception 'an APC must not be able to allocate brands';
  end if;
  if public.can_allocate_to_ipc(v_ipc, null) then
    raise exception 'an unauthenticated caller was accepted';
  end if;

  raise notice 'VERIFIED: OL any IPC · PCTL own IPCs only · non-IPC targets and non-lead actors refused';
end;
$v$;
