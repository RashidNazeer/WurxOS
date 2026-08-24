-- ============================================================
-- WurxOS v2 — Migration 332: approving a report now SHARES it with the client
-- by default. Withholding becomes the deliberate act, not publishing.
--
-- Until now the tick had to be set by hand on every single report even after
-- approval, which is busywork on the common path: nearly every approved report
-- is meant for the client. Flipped so approval publishes, and an OL unticks the
-- rare one that should be held back.
--
-- EXISTING REPORTS ARE NOT TOUCHED. Explicitly requested, and the rule is
-- written to make that structural rather than a promise: it fires only on a
-- TRANSITION into 'approved' during an UPDATE. A report already sitting at
-- 'approved' is not transitioning, so nothing about it changes — no backfill,
-- no sweep. Today's ticks stay exactly as they are.
--
-- THE HARD PART: not overriding a human. If an OL deliberately unticks an
-- approved report, then it is reopened for a fix and re-approved, a naive
-- "approved implies shared" would quietly republish something they had chosen
-- to withhold. So the rule only applies while nobody has expressed an opinion.
--
-- Three markers, each answering a different question:
--   shared_with_client      is it visible to the client right now
--   share_auto_withdrawn    did WE remove it because the report left approved
--                           (mig 327 — provisional, restored on re-approval)
--   share_manual_override   has a HUMAN ever moved this tick (new here)
--
-- On a transition into 'approved', in order:
--   1. auto-withdrawn earlier  -> restore it (mig 327 behaviour, unchanged)
--   2. no human has ever decided -> share it (THE NEW DEFAULT)
--   3. a human has decided      -> leave it alone, whatever they chose
--
-- Idempotent.
-- ============================================================

alter table public.reports
  add column if not exists share_manual_override boolean not null default false;

comment on column public.reports.share_manual_override is
  'True once a person has explicitly set or cleared shared_with_client. Suppresses the share-on-approval default so a deliberate decision to withhold survives a reopen and re-approval.';

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
    and not new.shared_with_client then

    if coalesce(old.share_auto_withdrawn, false) then
      -- Back to approved after a provisional withdrawal: republish it.
      new.shared_with_client   := true;
      new.share_auto_withdrawn := false;

    elsif not coalesce(old.share_manual_override, false) then
      -- Nobody has ever touched this tick, so the default applies: approving
      -- publishes. Note this is the ONLY branch that is new, and it cannot
      -- reach a report that is already approved.
      new.shared_with_client := true;
    end if;
    -- else: a person decided to withhold this one. Respect it, every time.
  end if;

  return new;
end;
$fn$;

-- The role guard already fires whenever a human moves the flag (and refuses
-- anyone who is not Boss/OL). Record that fact so the default above steps
-- aside from then on.
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
    -- Turning it OFF while the report is not approved is the automatic
    -- withdrawal, not a decision, and must stay open to whoever may return a
    -- report (authors and TLs included) or returns start failing for them.
    v_needs_check := not (
      new.shared_with_client = false and new.status is distinct from 'approved'
    );
  end if;

  if v_needs_check then
    if v_uid is not null
       and not public.is_boss(v_uid)
       and not exists (select 1 from public.profiles p
                       where p.id = v_uid and p.role in ('ol', 'developer') and p.is_active = true) then
      raise exception
        'Only an Operations Lead or the Boss can change whether a report is shared with the client.'
        using errcode = 'insufficient_privilege';
    end if;
    -- A human moved it: this decision outranks any pending automatic restore,
    -- and from now on the share-on-approval default leaves this report alone.
    new.share_auto_withdrawn  := false;
    new.share_manual_override := true;
  end if;

  return new;
end;
$fn$;
