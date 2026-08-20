-- ============================================================
-- WurxOS v2 — Migration 327: two defects found by adversarial review of
-- migrations 322-326, both confirmed against the live database.
--
-- ── A. anon can reach agenda_start_presenting, and the check is NULL-unsafe
--
-- Two compounding mistakes in mig 324:
--   1. Postgres grants EXECUTE on a new function to PUBLIC by default. 324
--      granted to `authenticated` but never revoked PUBLIC, so `anon` could
--      call it. Proven: an unauthenticated POST returned P0001 "meeting not
--      found" — a BODY error, meaning execution was reached.
--   2. For anon, auth.uid() is NULL, and the on-behalf check read
--          if not (v_m.tl_id = v_uid or is_boss(v_uid) or exists(...)) then raise
--      `tl_id = NULL` is NULL, so the disjunction is NULL, `not NULL` is NULL,
--      and `if NULL then` does NOT fire. The raise was skipped entirely.
--
-- Together: an unauthenticated caller who knew an ongoing meeting id and an
-- APC id on that team could start a presentation for them. Both halves are
-- required for the hole and both are closed: the check is made NULL-safe so an
-- unknown caller is refused rather than waved through, and EXECUTE is revoked
-- from public/anon so it cannot be reached at all.
--
-- ── B. reopening an approved report permanently unpublished it
--
-- 322's auto-unshare had no counterpart on re-approval. The everyday OL flow
--     approved+shared → reopen for a fix → re-approve
-- stripped shared_with_client on the way down and never restored it, so a
-- client silently lost a report they were already reading and nothing in the
-- UI said so. Confirmed live: approve+share → verified → approved left
-- shared=false.
--
-- Fix: remember WHY the tick came off. An automatic withdrawal is provisional
-- and is restored when the report returns to 'approved'. A deliberate untick by
-- a Boss/OL is a decision and must survive any number of status changes, so the
-- role guard clears the marker whenever a human moves the flag. The guard runs
-- first (BEFORE triggers fire alphabetically: g < u), so a human decision in
-- the same statement always wins over the automatic marker.
--
-- Idempotent.
-- ============================================================

-- ── A ────────────────────────────────────────────────────────────────
create or replace function public.agenda_start_presenting(p_meeting uuid, p_apc uuid default null)
returns public.agenda_presentations
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid    uuid := auth.uid();
  v_target uuid := coalesce(p_apc, auth.uid());
  v_m      public.agenda_meetings;
  v_row    public.agenda_presentations;
  v_onbehalf boolean := coalesce(p_apc, auth.uid()) is distinct from auth.uid();
begin
  -- No caller identity means no authority, whatever else is true.
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_m from public.agenda_meetings where id = p_meeting;
  if not found then raise exception 'meeting not found'; end if;
  if v_m.status <> 'ongoing' then raise exception 'meeting is not ongoing'; end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_target and p.role = 'apc' and p.reports_to = v_m.tl_id
  ) then
    raise exception 'that person is not an APC of this team';
  end if;

  if v_onbehalf then
    -- coalesce(): a NULL comparison must read as "no permission", never as
    -- "unknown, carry on". That was the bug in 324.
    if not coalesce(
         v_m.tl_id = v_uid
         or public.is_boss(v_uid)
         or exists (select 1 from public.profiles p
                    where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true),
         false) then
      raise exception 'only this team''s Team Lead, an Operations Lead or the Boss can start a presentation for someone else';
    end if;
  end if;

  if exists (select 1 from public.agenda_presentations
             where meeting_id = p_meeting and apc_id = v_target and status = 'done') then
    raise exception '% already presented in this meeting',
      case when v_onbehalf then 'that APC' else 'you have' end;
  end if;

  if exists (select 1 from public.agenda_presentations
             where meeting_id = p_meeting and status = 'presenting' and apc_id <> v_target) then
    raise exception 'another APC is currently presenting';
  end if;

  insert into public.agenda_presentations (meeting_id, apc_id, status, started_at, started_by)
  values (p_meeting, v_target, 'presenting', now(), v_uid)
  on conflict (meeting_id, apc_id) do update
    set status = 'presenting',
        started_at = coalesce(public.agenda_presentations.started_at, now()),
        started_by = v_uid, ended_at = null, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$fn$;

revoke execute on function public.agenda_start_presenting(uuid, uuid) from public, anon;
grant  execute on function public.agenda_start_presenting(uuid, uuid) to authenticated;

-- ── B ────────────────────────────────────────────────────────────────
alter table public.reports
  add column if not exists share_auto_withdrawn boolean not null default false;

comment on column public.reports.share_auto_withdrawn is
  'True when shared_with_client came off AUTOMATICALLY because the report left approved. Restored on re-approval. A deliberate untick by Boss/OL clears it so the decision sticks.';

create or replace function public.reports_unshare_on_unapprove()
returns trigger
language plpgsql
as $fn$
begin
  if new.shared_with_client and new.status is distinct from 'approved' then
    if tg_op = 'UPDATE' and old.shared_with_client then
      -- Provisional withdrawal: it goes back when the report is approved again.
      new.shared_with_client   := false;
      new.share_auto_withdrawn := true;
    else
      raise exception
        'This report cannot be shared with the client until it is approved (current status: %).', new.status
        using errcode = 'check_violation';
    end if;

  elsif tg_op = 'UPDATE'
    and new.status = 'approved' and old.status is distinct from 'approved'
    and coalesce(old.share_auto_withdrawn, false)
    and not new.shared_with_client then
    -- Back to approved after a provisional withdrawal: republish it.
    new.shared_with_client   := true;
    new.share_auto_withdrawn := false;
  end if;

  return new;
end;
$fn$;

create or replace function public.reports_guard_share_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_needs_check boolean := false;
begin
  if tg_op = 'INSERT' then
    v_needs_check := new.shared_with_client;
  elsif new.shared_with_client is distinct from old.shared_with_client then
    v_needs_check := not (
      new.shared_with_client = false and new.status is distinct from 'approved'
    );
  end if;

  if v_needs_check then
    if v_uid is not null
       and not public.is_boss(v_uid)
       and not exists (select 1 from public.profiles p
                       where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true) then
      raise exception
        'Only an Operations Lead or the Boss can change whether a report is shared with the client.'
        using errcode = 'insufficient_privilege';
    end if;
    -- A human moved the flag: that decision outranks any pending automatic
    -- restore, so forget the marker. Runs before the unshare trigger (g < u).
    new.share_auto_withdrawn := false;
  end if;

  return new;
end;
$fn$;
