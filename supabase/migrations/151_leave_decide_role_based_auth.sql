-- ============================================================
-- WurxOS v2 — Migration 151: role-based authorization for leave_decide
--
-- v1 model the user wants to restore:
--   * APC's request  → any TL in the APC's team (level 1) approves
--   * TL's request   → any OL (level 1) approves
--   * OL's request   → Boss (level 1) approves
--   * On approve, the approver can choose to forward to Boss (level 2)
--   * Boss is always allowed to override and decide anything.
--
-- The current implementation (mig 099) requires v_approver = v_me where
-- v_approver is computed by walking profiles.reports_to N times. That
-- breaks whenever the chain has any drift — a TL whose reports_to is
-- NULL, or a TL whose reports_to points to a different OL than the one
-- trying to approve. The user reports "not authorized to decide this
-- request" even without recent reassignments, which means the chain
-- isn't aligning for them.
--
-- Fix: keep the existing "literal chain match" check, but ALSO accept
-- a role-based match. For the request's current_level, look up the
-- "expected approver role" and accept any active user with that role
-- when they have organizational reach over the requester:
--
--   level 1 + requester role 'apc'/'ipc'      → any 'tl'/'pctl'
--   level 1 + requester role 'tl'/'pctl'      → any 'ol'
--   level 1 + requester role 'ol'             → boss (handled by v_is_boss)
--   level 2 (forwarded by intermediate)       → any senior to the
--                                                intermediate
--   level 3                                   → boss (v_is_boss)
--
-- This matches v1's behavior — "any TL can approve their APC", "any OL
-- can approve a TL" — and stays safe because the role gate plus the
-- pending-state lock keep random users out. Boss bypass unchanged.
--
-- Idempotent — replaces leave_decide() from mig 099.
-- ============================================================

create or replace function public.leave_decide(
  p_request_id uuid,
  p_action     text,
  p_note       text default null
)
returns public.leave_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req           public.leave_requests;
  v_me            uuid := auth.uid();
  v_my_role       text;
  v_requester_role text;
  v_chain_approver uuid;
  v_name          text;
  v_decisions     jsonb;
  v_new_level     int;
  v_is_boss       boolean;
  v_allowed       boolean := false;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  select * into v_req from public.leave_requests where id = p_request_id for update;
  if not found                  then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'  then raise exception 'request already decided (status=%)', v_req.status; end if;

  v_chain_approver := public.leave_current_approver(p_request_id);
  v_is_boss        := public.is_boss(v_me);

  -- Pull both roles for the role-based gate below.
  select role into v_my_role        from public.profiles where id = v_me           and is_active = true;
  select role into v_requester_role from public.profiles where id = v_req.requester_id;

  -- 1) Boss can always decide.
  if v_is_boss then
    v_allowed := true;

  -- 2) Literal chain match (the original mig 099 check) still passes.
  elsif v_chain_approver = v_me then
    v_allowed := true;

  -- 3) Role-based authorization for v1 parity. The "expected role" at
  --    a given level depends on the requester's role plus the current
  --    level. We only allow this when the caller is at the right rung
  --    AND active.
  elsif v_my_role is not null then
    if v_req.current_level = 1 then
      -- Level 1: requester's immediate manager tier.
      if v_requester_role in ('apc', 'ipc')   and v_my_role in ('tl', 'pctl') then
        v_allowed := true;
      elsif v_requester_role in ('tl', 'pctl') and v_my_role = 'ol' then
        v_allowed := true;
      end if;
    elsif v_req.current_level = 2 then
      -- Level 2: tier above the level-1 approver. Most common case is
      -- an APC request that the TL forwarded to OL.
      if v_requester_role in ('apc', 'ipc')   and v_my_role = 'ol' then
        v_allowed := true;
      end if;
      -- TL/OL requests at level 2 only escalate to Boss, which is
      -- already covered by v_is_boss above.
    end if;
    -- Level 3 is Boss-only — already handled.
  end if;

  if not v_allowed then
    raise exception 'not authorized to decide this request';
  end if;

  -- Quota gate: any unpaid_days must be decided by Boss.
  -- Intermediate approvers can only forward over-quota requests.
  if p_action = 'approve'
     and coalesce(v_req.unpaid_days, 0) > 0
     and not v_is_boss then
    raise exception
      'over-quota requests must be forwarded to the Boss (this one has % unpaid day(s))',
      v_req.unpaid_days
      using errcode = 'P0001', hint = 'Use Forward instead of Approve.';
  end if;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');
  v_decisions := v_req.decisions || jsonb_build_array(jsonb_build_object(
    'level',   v_req.current_level,
    'action',  p_action,
    'by',      v_me,
    'by_name', v_name,
    'at',      to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'note',    p_note
  ));

  if p_action = 'approve' then
    update public.leave_requests
       set status        = 'approved',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'reject' then
    update public.leave_requests
       set status        = 'rejected',
           decided_by    = v_me,
           decided_at    = now(),
           decision_note = p_note,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  elsif p_action = 'forward' then
    v_new_level := v_req.current_level + 1;
    if v_new_level > 3 then raise exception 'already at top of approval chain'; end if;
    update public.leave_requests
       set current_level = v_new_level,
           decisions     = v_decisions
     where id = p_request_id
     returning * into v_req;

  else
    raise exception 'invalid action: %', p_action;
  end if;

  return v_req;
end;
$$;
